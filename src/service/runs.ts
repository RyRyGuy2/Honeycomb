import { randomUUID } from "node:crypto";
import { checkProvider, providerEnvironment, providers } from "../providers/index.js";
import type { ProviderAdapter, ProviderUsageEvent } from "../providers/types.js";
import type { FinishedRunStatus, ProjectFolder, ProviderId, Run, RunEventData, RunUsage } from "../shared/contracts.js";
import { asRecord } from "../shared/records.js";
import { readJsonLines, runProcess } from "./process.js";

const MAX_RUNS = 20;
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

function trackUsage(run: Run, usage: RunUsage) {
  for (const key of USAGE_KEYS) {
    const value = usage[key];
    if (value !== undefined) run.usage[key] = (run.usage[key] ?? 0) + value;
  }
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

  async function execute(run: Run, provider: ProviderAdapter, signal: AbortSignal) {
    const env = providerEnvironment(provider);
    let finalError: string | undefined;
    let diagnostic: string | undefined;
    let providerNotice: string | undefined;
    let completed = false;
    const stdout = readJsonLines((line) => {
      const update = provider.decode(line);
      if (!update || signal.aborted) return;

      finalError = update.failed ?? finalError;
      diagnostic = update.diagnostic ?? diagnostic;
      completed ||= Boolean(update.completed);
      if (!update.event) return;

      const { type } = update.event;
      if (type === "usage") {
        const usage = usageFrom(update.event);
        if (Object.keys(usage).length) {
          trackUsage(run, usage);
          append(run, { type, ...usage });
        }
        return;
      }
      const text = displayText(update.event.text, MAX_MESSAGE_LENGTH);
      if (text) append(run, { type, text });
    });

    try {
      const options = optionsForProvider(provider.id);
      const { connector, executable } = await checkProvider(provider, signal, options.executable);
      if (signal.aborted) return finish(run, "cancelled", "Run stopped.");
      if (!executable) {
        throw new Error(connector.detail ?? `${provider.name} was not found on PATH.`);
      }

      const command = provider.command(run.prompt, options.model, connector.version);
      const result = await runProcess({
        file: executable.file,
        args: [...executable.args, ...command.args],
        cwd: run.folder.path,
        env: { ...env, ...command.env },
        input: command.input,
        timeoutMs: TIMEOUT_MS,
        signal,
        stdout,
        onStderr(tail) {
          if (providerNotice || signal.aborted) return;
          providerNotice = provider.diagnoseStderr?.(tail);
          if (providerNotice) append(run, { type: "notice", text: providerNotice });
        },
      });

      if (result.stopped === "cancelled") return finish(run, "cancelled", "Run stopped.");
      if (finalError) throw new Error(finalError);
      if (result.stopped === "timeout") throw new Error(providerNotice || "The run reached its five-minute limit.");
      if (result.error) throw new Error(result.error);
      if (result.code !== 0) {
        throw new Error(providerNotice || diagnostic || result.stderr || `${provider.name} exited without completing the run.`);
      }
      if (!completed) {
        throw new Error(providerNotice || diagnostic || result.stderr || `${provider.name} exited without a completion event.`);
      }
      finish(run, "completed", "Run completed.");
    } catch (error) {
      const message = error instanceof Error ? error.message : error;
      append(run, { type: "error", text: failureText(message, env) || "The provider could not complete the run." });
      finish(run, "failed", "Run failed.");
    }
  }

  return {
    history() {
      return history;
    },
    start(folder: ProjectFolder | undefined, request: unknown) {
      if (closing) throw new Error("Honeycomb is closing.");
      if (active) throw new Error("Stop or finish the active run before starting another.");
      if (!folder) throw new Error("Choose a project folder first.");
      const payload = asRecord(request);
      const providerId = payload?.providerId;
      const provider = typeof providerId === "string" ? providers.get(providerId) : undefined;
      if (!provider) throw new Error("Choose Codex or OpenCode.");
      const prompt = typeof payload?.prompt === "string" ? payload.prompt.trim() : "";
      if (!prompt || prompt.length > MAX_PROMPT_LENGTH || prompt.includes("\0")) {
        throw new Error(`Enter a task of 1 to ${MAX_PROMPT_LENGTH.toLocaleString("en-US")} characters.`);
      }

      const run: Run = {
        id: randomUUID(),
        providerId: provider.id,
        providerName: provider.name,
        folder,
        prompt,
        startedAt: new Date().toISOString(),
        status: "running",
        events: [],
        usage: {},
        revision: 0,
      };
      const controller = new AbortController();
      history.unshift(run);
      if (history.length > MAX_RUNS) history.pop();
      active = { run, controller };
      append(run, { type: "started", text: `Starting ${provider.name}.` });
      active.done = execute(run, provider, controller.signal);
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
