import { randomUUID } from "node:crypto";
import { checkProvider, providerEnvironment, providers } from "../providers/index.js";
import { readJsonLines, runProcess } from "./process.js";

const MAX_RUNS = 20;
const MAX_EVENTS = 100;
const MAX_PROMPT_LENGTH = 8_000;
const MAX_MESSAGE_LENGTH = 16_000;
const TIMEOUT_MS = 5 * 60_000;

function displayText(value, limit) {
  if (typeof value !== "string") return "";
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
  return text.length > limit ? `${text.slice(0, limit)}\n…` : text;
}

function usageFrom(event) {
  const usage = {};
  for (const key of ["inputTokens", "outputTokens", "cachedTokens", "costUsd"]) {
    if (Number.isFinite(event[key]) && event[key] >= 0) usage[key] = event[key];
  }
  return usage;
}

function trackUsage(run, usage) {
  for (const [key, value] of Object.entries(usage)) {
    run.usage[key] = (run.usage[key] ?? 0) + value;
  }
}

function failureText(value, env) {
  if (typeof value !== "string") return "";
  let text = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  for (const key of ["CODEX_API_KEY", "OPENAI_API_KEY"]) {
    if (env[key]) text = text.replaceAll(env[key], "[redacted]");
  }
  return displayText(text, 1_000);
}

export function createRunService(publish) {
  const history = [];
  let active;
  let closing = false;

  function append(run, event) {
    run.events.push({ ...event, runId: run.id, sequence: ++run.revision, at: new Date().toISOString() });
    if (run.events.length > MAX_EVENTS) run.events.shift();
    publish(run);
  }

  function finish(run, status, text) {
    active = undefined;
    run.status = status;
    run.finishedAt = new Date().toISOString();
    append(run, { type: "finished", status, text });
  }

  async function execute(run, provider, signal) {
    const env = providerEnvironment(provider);
    let finalError;
    let diagnostic;
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
      const { connector, executable } = await checkProvider(provider, signal);
      if (signal.aborted) return finish(run, "cancelled", "Run stopped.");
      if (!executable) {
        throw new Error(connector.detail ?? `${provider.name} was not found on PATH.`);
      }

      const command = provider.command(run.prompt);
      const result = await runProcess({
        file: executable.file,
        args: [...executable.args, ...command.args],
        cwd: run.folder.path,
        env: { ...env, ...command.env },
        input: command.input,
        timeoutMs: TIMEOUT_MS,
        signal,
        stdout,
      });

      if (result.stopped === "cancelled") return finish(run, "cancelled", "Run stopped.");
      if (result.stopped === "timeout") throw new Error("The run reached its five-minute limit.");
      if (finalError) throw new Error(finalError);
      if (result.error) throw new Error(result.error);
      if (result.code !== 0) {
        throw new Error(diagnostic || result.stderr || `${provider.name} exited without completing the run.`);
      }
      if (!completed) {
        throw new Error(diagnostic || result.stderr || `${provider.name} exited without a completion event.`);
      }
      finish(run, "completed", "Run completed.");
    } catch (error) {
      append(run, { type: "error", text: failureText(error.message, env) || "The provider could not complete the run." });
      finish(run, "failed", "Run failed.");
    }
  }

  return {
    history() {
      return history;
    },
    start(folder, request) {
      if (closing) throw new Error("Honeycomb is closing.");
      if (active) throw new Error("Stop or finish the active run before starting another.");
      if (!folder) throw new Error("Choose a project folder first.");
      const provider = providers.get(request?.providerId);
      if (!provider) throw new Error("Choose Codex or OpenCode.");
      const prompt = typeof request.prompt === "string" ? request.prompt.trim() : "";
      if (!prompt || prompt.length > MAX_PROMPT_LENGTH || prompt.includes("\0")) {
        throw new Error(`Enter a task of 1 to ${MAX_PROMPT_LENGTH.toLocaleString("en-US")} characters.`);
      }

      const run = {
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
    stop(runId) {
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
