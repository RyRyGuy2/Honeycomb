import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { runProcess } from "../service/process.js";
import type { Connector } from "../shared/contracts.js";
import { antigravity } from "./antigravity.js";
import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { githubCopilot } from "./github-copilot.js";
import { opencode } from "./opencode.js";
import type { ProviderAdapter } from "./types.js";

export const providers = new Map<string, ProviderAdapter>([
  [codex.id, codex],
  [opencode.id, opencode],
  [claude.id, claude],
  [antigravity.id, antigravity],
  [githubCopilot.id, githubCopilot],
]);

interface Executable {
  file: string;
  args: string[];
}

interface ProviderCheck {
  connector: Connector;
  executable?: Executable;
}

const WINDOWS = process.platform === "win32";
const COMMON_ENVIRONMENT = [
  "PATH", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "ProgramFiles",
  "ProgramData", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOMEDRIVE",
  "HOMEPATH", "TEMP", "TMP", "TMPDIR", "HOME", "USER", "USERNAME", "SHELL",
  "LANG", "LC_ALL", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
  "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
];

export function providerEnvironment(provider?: ProviderAdapter): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NO_COLOR: "1" };
  for (const key of [...COMMON_ENVIRONMENT, ...(provider?.authEnvironment ?? [])]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

async function isFile(path: string, executable = false) {
  try {
    if (!(await stat(path)).isFile()) return false;
    if (executable && !WINDOWS) await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathDirectories() {
  return (process.env.PATH ?? "").split(delimiter)
    .map((directory) => directory.trim().replace(/^"(.*)"$/, "$1"))
    .filter(isAbsolute);
}

export async function resolveExecutable(provider: ProviderAdapter, managedOpenCode?: string): Promise<Executable | null> {
  const override = process.env[provider.override];
  if (override) {
    const native = !WINDOWS || /\.exe$/i.test(override);
    if (native && isAbsolute(override) && await isFile(override, true)) {
      return { file: override, args: [] };
    }
    throw new Error(`${provider.override} must point to an absolute executable path.`);
  }

  if (provider.id === "opencode" && managedOpenCode && await isFile(managedOpenCode, true)) {
    return { file: managedOpenCode, args: [] };
  }

  const directories = [...new Set([...pathDirectories(), ...(provider.installDirectories ?? []).filter(isAbsolute)])];
  const name = provider.executableName ?? provider.id;
  for (const directory of directories) {
    const file = join(directory, WINDOWS ? `${name}.exe` : name);
    if (await isFile(file, true)) return { file, args: [] };

    if (WINDOWS && await isFile(join(directory, `${name}.cmd`))) {
      // Use the npm package's entry point without interpreting the command shim.
      // Packages ship either a native executable or a JS launcher that needs node.
      for (const parts of provider.npmLaunchers) {
        const launcher = join(directory, "node_modules", ...parts);
        if (!(await isFile(launcher))) continue;
        if (/\.exe$/i.test(launcher)) return { file: launcher, args: [] };
        for (const nodeDirectory of [directory, ...directories]) {
          const node = join(nodeDirectory, "node.exe");
          if (await isFile(node)) return { file: node, args: [launcher] };
        }
      }
    }
  }
  return null;
}

export async function checkProvider(provider: ProviderAdapter, signal?: AbortSignal, managedOpenCode?: string): Promise<ProviderCheck> {
  const connector: Connector = { id: provider.id, name: provider.name, status: "missing" };
  try {
    const executable = await resolveExecutable(provider, managedOpenCode);
    if (!executable) return { connector };

    const result = await runProcess({
      file: executable.file,
      args: [...executable.args, "--version"],
      env: { ...providerEnvironment(), ...provider.probeEnvironment },
      timeoutMs: 8_000,
      signal,
    });
    const version = result.output && provider.parseVersion(result.output);

    if (result.code !== 0 || !version) {
      return { connector: { ...connector, status: "unavailable", detail: "The CLI did not return a version." } };
    }
    const detected: Connector = { ...connector, status: "detected", version, managed: executable.file === managedOpenCode };
    const detail = provider.versionIssue?.(version);
    if (detail) {
      return { connector: { ...detected, status: "unavailable", detail } };
    }
    if (provider.requiredHelpFlags?.length) {
      const help = await runProcess({
        file: executable.file,
        args: [...executable.args, "--help"],
        env: { ...providerEnvironment(), ...provider.probeEnvironment },
        timeoutMs: 8_000,
        outputLimit: 256 * 1024,
        signal,
      });
      if (help.code !== 0 || provider.requiredHelpFlags.some((flag) => !help.output.includes(flag))) {
        const issue = provider.helpIssue ?? `This ${provider.name} CLI is missing options Honeycomb needs.`;
        return { connector: { ...detected, status: "unavailable", detail: issue } };
      }
    }
    return { connector: detected, executable };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { connector: { ...connector, status: "unavailable", detail } };
  }
}

export function inspectProviders(managedOpenCode?: string) {
  return Promise.all([...providers.values()].map(async (provider) => {
    const { connector } = await checkProvider(provider, undefined, managedOpenCode);
    return connector;
  }));
}
