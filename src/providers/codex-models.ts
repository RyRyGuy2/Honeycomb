import { runProcess } from "../service/process.js";
import type { ModelCatalog } from "../shared/contracts.js";
import { asRecord } from "../shared/records.js";
import { codex, parseCodexModel } from "./codex.js";
import { checkProvider, providerEnvironment } from "./index.js";

export function parseCodexCatalog(output: string): ModelCatalog["models"] {
  const payload: unknown = JSON.parse(output);
  const entries = asRecord(payload)?.models;
  if (!Array.isArray(entries)) throw new Error("Codex returned an unreadable model catalog.");

  const models = new Map<string, ModelCatalog["models"][number]>();
  for (const entry of entries) {
    const model = asRecord(entry);
    if (!model || (model.visibility !== undefined && model.visibility !== "list")) continue;
    let id: string;
    try {
      id = parseCodexModel(model.slug);
    } catch {
      continue;
    }
    if (!id || models.has(id)) continue;
    const title = model.display_name;
    models.set(id, { id, name: typeof title === "string" && title.trim() ? title : id, available: true, online: false });
  }
  return [...models.values()];
}

export async function listCodexModels(selected: string, signal?: AbortSignal): Promise<ModelCatalog> {
  const { connector, executable } = await checkProvider(codex, signal);
  if (!executable) return { models: [], selected, localError: connector.detail || "Install Codex to load its models." };

  for (const flags of [[], ["--bundled"]]) {
    signal?.throwIfAborted();
    const result = await runProcess({
      file: executable.file,
      args: [...executable.args, "debug", "models", ...flags],
      env: providerEnvironment(codex),
      timeoutMs: flags.length ? 6_000 : 10_000,
      outputLimit: 8 * 1024 * 1024,
      signal,
    });
    if (result.code !== 0) continue;
    try {
      const models = parseCodexCatalog(result.output);
      if (models.length) return {
        models, selected,
        localError: flags.length ? "Showing the model catalog bundled with your Codex CLI." : undefined,
      };
    } catch {
      // Older Codex versions may return a different format.
    }
  }
  return { models: [], selected, localError: "Codex couldn’t load its model list. You can use the default or refresh after updating the CLI." };
}
