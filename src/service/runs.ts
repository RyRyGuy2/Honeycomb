import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCodexModel } from "../providers/codex.js";
import { checkProvider, providerEnvironment, providers } from "../providers/index.js";
import { parseEffort, streamCodexChat, streamOpenCodeChat, streamProvider } from "../providers/stream.js";
import type { StreamEvent } from "../providers/stream.js";
import type { ProviderAdapter, ProviderUsageEvent } from "../providers/types.js";
import type { FinishedRunStatus, ProjectFolder, ProviderId, Run, RunEventData, RunUsage } from "../shared/contracts.js";
import { asRecord } from "../shared/records.js";

const MAX_PROMPT_LENGTH = 8_000;
const MAX_MESSAGE_LENGTH = 16_000;
const TIMEOUT_MS = 5 * 60_000;
const USAGE_KEYS = ["inputTokens", "outputTokens", "cachedTokens", "costUsd"] as const;

interface ActiveRun {
  run: Run;
  controller: AbortController;
  done?: Promise<void>;
}

function displayText(value: unknown, limit: number) {
  if (typeof value !== "string") return "";
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
  return text.length > limit ? `${text.slice(0, limit)}\n…` : text;
}

function usageFrom(event: ProviderUsageEvent): RunUsage {
  const usage: RunUsage = {};
  for (const key of USAGE_KEYS) {
    const value = event[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) usage[key] = value;
  }
  return usage;
}

function failureText(value: unknown, env: NodeJS.ProcessEnv) {
  if (typeof value !== "string") return "";
  let text = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  for (const key of ["CODEX_API_KEY", "OPENAI_API_KEY"]) {
    const secret = env[key];
    if (secret) text = text.replaceAll(secret, "[redacted]");
  }
  return displayText(text, 1_000);
}

export function createRunService(
  publish: (run: Run) => void,
  optionsForProvider: (provider: ProviderId) => { executable?: string; model?: string } = () => ({}),
) {
  const history: Run[] = [];
  let active: ActiveRun | undefined;
  let closing = false;

  function append(run: Run, event: RunEventData) {
    run.events.push({ ...event, runId: run.id, sequence: ++run.revision, at: new Date().toISOString() });
    publish(run);
  }

  function finish(run: Run, status: FinishedRunStatus, text: string) {
    active = undefined;
    run.status = status;
    run.finishedAt = new Date().toISOString();
    append(run, { type: "finished", status, text });
  }

  async function execute(run: Run, provider: ProviderAdapter, signal: AbortSignal, effort?: string, chatModel?: string) {
    const env = providerEnvironment(provider);
    const codexChat = run.mode === "chat" && provider.id === "codex";
    if (codexChat) {
      delete env.CODEX_API_KEY;
      delete env.OPENAI_API_KEY;
    }
    let providerNotice: string | undefined;
    const replies = new Map<string, Extract<Run["events"][number], { text: string }>>();
    let pendingUpdate: ReturnType<typeof setTimeout> | undefined;
    let isolatedDirectory: string | undefined;
    function receive(event: StreamEvent) {
        if (signal.aborted) return;
        if (event.type === "usage") {
          const usage = usageFrom(event);
          if (Object.keys(usage).length) {
            Object.assign(run.usage, usage);
            append(run, { type: "usage", ...usage });
          }
        } else if ("id" in event) {
          const existing = replies.get(event.id);
          const text = event.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
          if (!text) return;
          const value = (event.type === "delta" ? (existing?.text ?? "") + text : text).slice(0, 1_000_000);
          if (existing) {
            if (existing.text === value) return;
            existing.text = value;
            run.revision++;
          } else {
            const message = {
              type: "message" as const, text: value, runId: run.id, sequence: ++run.revision, at: new Date().toISOString(),
            };
            replies.set(event.id, message);
            run.events.push(message);
          }
          pendingUpdate ??= setTimeout(() => {
            pendingUpdate = undefined;
            publish(run);
          }, 40);
        } else {
          const text = displayText(event.text, MAX_MESSAGE_LENGTH);
          if (text) append(run, { type: event.type, text });
        }
    }
    try {
      const options = optionsForProvider(provider.id);
      const { connector, executable } = await checkProvider(provider, signal, options.executable);
      if (signal.aborted) return finish(run, "cancelled", "Run stopped.");
      if (!executable) throw new Error(connector.detail ?? provider.name + " was not found on PATH.");
      if (run.mode === "chat") isolatedDirectory = await mkdtemp(join(tmpdir(), "honeycomb-chat-"));
      const transport = {
        ...executable, cwd: run.folder?.path ?? isolatedDirectory, env, timeoutMs: TIMEOUT_MS, signal,
        onStderr(tail: string) {
          if (providerNotice || signal.aborted) return;
          providerNotice = provider.diagnoseStderr?.(tail);
          if (providerNotice) append(run, { type: "notice", text: providerNotice });
        },
      };
      if (codexChat) {
        await streamCodexChat(transport, run.prompt, chatModel, receive, effort);
      } else if (run.mode === "chat") {
        await streamOpenCodeChat(transport, run.prompt, options.model, connector.version, receive, effort);
      } else {
        await streamProvider(provider.id, transport, run.prompt, options.model, connector.version, receive, effort);
      }
      if (signal.aborted) return finish(run, "cancelled", "Run stopped.");
      finish(run, "completed", "Run completed.");
    } catch (error) {
      if (signal.aborted) return finish(run, "cancelled", "Run stopped.");
      const message = error instanceof Error ? error.message : error;
      append(run, { type: "error", text: failureText(providerNotice ?? message, env) || "The provider could not complete the run." });
      finish(run, "failed", "Run failed.");
    } finally {
      clearTimeout(pendingUpdate);
      if (isolatedDirectory) await rm(isolatedDirectory, { recursive: true, force: true }).catch(console.error);
    }
  }

  return {
    restore(saved: Run[]) {
      for (const run of saved) {
        if (run.status === "running" || run.status === "stopping") {
          run.status = "failed";
          run.finishedAt = new Date().toISOString();
          run.events.push({
            type: "finished", status: "failed", text: "The app closed before the response finished.",
            at: run.finishedAt, runId: run.id, sequence: ++run.revision,
          });
        }
        history.push(run);
      }
    },
    history() {
      return history;
    },
    start(folder: ProjectFolder | undefined, request: unknown) {
      if (closing) throw new Error("Honeycomb is closing.");
      if (active) throw new Error("Stop or finish the active run before starting another.");
      const payload = asRecord(request);
      const mode = payload?.mode ?? "code";
      if (mode !== "code" && mode !== "chat") throw new Error("Choose Code or Chat.");
      if (mode === "code" && !folder) throw new Error("Choose a project folder first.");
      const providerId = payload?.providerId;
      const provider = typeof providerId === "string" ? providers.get(providerId) : undefined;
      if (!provider) throw new Error("Choose Codex or OpenCode.");
      const effort = parseEffort(payload?.effort, provider.id);
      const chatModel = mode === "chat" && provider.id === "codex" ? parseCodexModel(payload?.model ?? "") || undefined : undefined;
      const prompt = typeof payload?.prompt === "string" ? payload.prompt.trim() : "";
      if (!prompt || prompt.length > MAX_PROMPT_LENGTH || prompt.includes("\0")) {
        throw new Error(`Enter a task of 1 to ${MAX_PROMPT_LENGTH.toLocaleString("en-US")} characters.`);
      }

      const run: Run = {
        id: randomUUID(),
        providerId: provider.id,
        providerName: provider.name,
        mode,
        folder: mode === "code" ? folder : undefined,
        prompt,
        startedAt: new Date().toISOString(),
        status: "running",
        events: [],
        usage: {},
        revision: 0,
      };
      const controller = new AbortController();
      history.unshift(run);
      active = { run, controller };
      append(run, { type: "started", text: `Starting ${provider.name}.` });
      active.done = execute(run, provider, controller.signal, effort, chatModel);
      return run.id;
    },
    stop(runId: string) {
      if (active?.run.id !== runId || active.controller.signal.aborted) return;
      active.run.status = "stopping";
      append(active.run, { type: "stopping", text: "Stopping the provider." });
      active.controller.abort();
    },
    hasActiveRun() {
      return Boolean(active);
    },
    async shutdown() {
      closing = true;
      if (!active) return;
      active.controller.abort();
      await active.done;
    },
  };
}
