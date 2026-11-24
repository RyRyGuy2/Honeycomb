import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { runProcess } from "../service/process.js";
import { codex } from "./codex.js";
import { opencode } from "./opencode.js";

export const providers = new Map([
  [codex.id, codex],
  [opencode.id, opencode],
]);

const WINDOWS = process.platform === "win32";
const COMMON_ENVIRONMENT = [
  "PATH", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "ProgramFiles",
  "ProgramData", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOMEDRIVE",
  "HOMEPATH", "TEMP", "TMP", "TMPDIR", "HOME", "USER", "USERNAME", "SHELL",
  "LANG", "LC_ALL", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
  "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
];

export function providerEnvironment(provider) {
  const env = { NO_COLOR: "1" };
  for (const key of [...COMMON_ENVIRONMENT, ...(provider?.authEnvironment ?? [])]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

async function isFile(path, executable = false) {
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

export async function resolveExecutable(provider) {
  const override = process.env[provider.override];
  if (override) {
    const native = !WINDOWS || /\.exe$/i.test(override);
    if (native && isAbsolute(override) && await isFile(override, true)) {
      return { file: override, args: [] };
    }
    throw new Error(`${provider.override} must point to an absolute executable path.`);
  }

  const directories = pathDirectories();
  for (const directory of directories) {
    const file = join(directory, WINDOWS ? `${provider.id}.exe` : provider.id);
    if (await isFile(file, true)) return { file, args: [] };

    if (WINDOWS && await isFile(join(directory, `${provider.id}.cmd`))) {
      // Use the npm package's JS entry point without interpreting the command shim.
      const launcher = join(directory, "node_modules", ...provider.npmLauncher);
      if (!(await isFile(launcher))) continue;
      for (const nodeDirectory of [directory, ...directories]) {
        const node = join(nodeDirectory, "node.exe");
        if (await isFile(node)) return { file: node, args: [launcher] };
      }
    }
  }
  return null;
}

export async function checkProvider(provider, signal) {
  const connector = { id: provider.id, name: provider.name, status: "missing" };
  try {
    const executable = await resolveExecutable(provider);
    if (!executable) return { connector };

    const result = await runProcess({
      file: executable.file,
      args: [...executable.args, "--version"],
      env: { ...providerEnvironment(), ...provider.probeEnvironment },
      timeoutMs: 8_000,
      signal,
    });
    const version = result.output && provider.parseVersion(result.output);

    const detected = { ...connector, status: "detected", version };
    if (result.code !== 0 || !version) {
      return { connector: { ...connector, status: "unavailable", detail: "The CLI did not return a version." } };
    }
    const detail = provider.versionIssue?.(version);
    if (detail) {
      return { connector: { ...detected, status: "unavailable", detail } };
    }
    return { connector: detected, executable };
  } catch (error) {
    return { connector: { ...connector, status: "unavailable", detail: error.message } };
  }
}

export function inspectProviders() {
  return Promise.all([...providers.values()].map(async (provider) => {
    const { connector } = await checkProvider(provider);
    return connector;
  }));
}
