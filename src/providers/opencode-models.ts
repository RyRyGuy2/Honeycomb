import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../service/process.js";
import type { ModelCatalog } from "../shared/contracts.js";
import { asRecord } from "../shared/records.js";
import { checkProvider, providerEnvironment } from "./index.js";
import { isOpenCodeV2, opencode, parseOpenCodeModel } from "./opencode.js";
import { openCodeEfforts, streamOpenCodeChat } from "./stream.js";

const CATALOGS = ["https://opencode.ai/zen/v1/models", "https://opencode.ai/inference/v1/models"];

export function mergeOpenCodeModels(localOutput: string, catalog: unknown): ModelCatalog["models"] {
  const local = new Set<string>();
  for (const line of localOutput.split(/\r?\n/)) {
    try {
      const id = parseOpenCodeModel(line);
      if (id) local.add(id);
    } catch {
      // The CLI can also print startup notices.
    }
  }

  const remote = new Map<string, string>();
  const entries = asRecord(catalog)?.data;
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      const data = asRecord(entry);
      if (typeof data?.id !== "string" || data.id.includes("/") || (data.type && data.type !== "chat")) continue;
      try {
        const id = parseOpenCodeModel(`opencode/${data.id}`);
        remote.set(id, typeof data.name === "string" && data.name ? data.name : id);
      } catch {
        // Ignore entries that cannot be passed to the CLI.
      }
    }
  }

  return [...new Set([...local, ...remote.keys()])].sort().map((id) => ({
    id, name: remote.get(id) ?? id, available: local.has(id), online: remote.has(id),
  }));
}

async function listLocalModels(managedPath: string | undefined, signal?: AbortSignal) {
  const { connector, executable } = await checkProvider(opencode, signal, managedPath);
  if (!executable) throw new Error(connector.detail || "Install OpenCode to find configured models.");

  const result = await runProcess({
    file: executable.file,
    args: [...executable.args, "models", ...(isOpenCodeV2(connector.version) ? ["--standalone"] : ["--pure"])],
    env: { ...providerEnvironment(opencode), ...opencode.command("", undefined, connector.version).env },
    timeoutMs: 20_000,
    outputLimit: 256 * 1024,
    signal,
  });
  if (result.code !== 0) throw new Error("OpenCode couldn't list its configured models. Check its model setup and try again.");
  return result.output;
}

export async function listOpenCodeEfforts(managedPath: string | undefined, model: string, signal: AbortSignal) {
  const { connector, executable } = await checkProvider(opencode, signal, managedPath);
  if (!executable) return [];
  const directory = await mkdtemp(join(tmpdir(), "honeycomb-opencode-models-"));
  try {
    return await openCodeEfforts({
      ...executable, cwd: directory, env: providerEnvironment(opencode), timeoutMs: 15_000, signal,
    }, model, connector.version);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function listOnlineModels(signal?: AbortSignal) {
  const deadline = AbortSignal.timeout(10_000);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  for (const url of CATALOGS) {
    const response = await fetch(url, { signal: requestSignal, credentials: "omit" });
    if (response.ok) return response.json() as Promise<unknown>;
    await response.body?.cancel();
  }
  throw new Error("OpenCode's online catalog is unavailable.");
}

export async function listOpenCodeModels(
  managedPath: string | undefined, selected: string, signal?: AbortSignal,
): Promise<ModelCatalog> {
  const [local, online] = await Promise.allSettled([
    listLocalModels(managedPath, signal), listOnlineModels(signal),
  ]);
  return {
    models: mergeOpenCodeModels(local.status === "fulfilled" ? local.value : "", online.status === "fulfilled" ? online.value : undefined),
    selected,
    localError: local.status === "rejected" ? (local.reason instanceof Error ? local.reason.message : "Could not list configured models.") : undefined,
    onlineError: online.status === "rejected" ? "The online catalog could not be reached." : undefined,
  };
}

export async function testOpenCode(managedPath: string | undefined, model: string, signal?: AbortSignal) {
  const { connector, executable } = await checkProvider(opencode, signal, managedPath);
  if (!executable) throw new Error(connector.detail || "Install OpenCode to test the connector.");
  const directory = await mkdtemp(join(tmpdir(), "honeycomb-opencode-test-"));
  try {
    await streamOpenCodeChat({
      ...executable, cwd: directory, env: providerEnvironment(opencode), timeoutMs: 30_000, signal,
    }, "Reply with OK.", model, connector.version, () => {});
    signal?.throwIfAborted();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
