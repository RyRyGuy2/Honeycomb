import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamClaude } from "../providers/claude.js";
import { parseCodexModel } from "../providers/codex.js";
import { checkProvider, providerEnvironment, providers } from "../providers/index.js";
import { parseEffort, streamCodexChat, streamCodexEdit, streamOpenCodeChat, streamProvider } from "../providers/stream.js";
import type { StreamEvent } from "../providers/stream.js";
import type { ProviderAdapter, ProviderUsageEvent } from "../providers/types.js";
import type {
  FinishedRunStatus, ProjectFolder, ProviderId, Run, RunEventData, RunUsage, WorktreeState,
} from "../shared/contracts.js";
import { compareTurns, conversationContext, conversationId, followUpPrompt, runMode } from "../shared/conversations.js";
import { supportsWorktreeEditing } from "../shared/editing.js";
import { asRecord } from "../shared/records.js";
import type { WorktreeManager } from "./worktree.js";

const MAX_PROMPT_LENGTH = 8_000;
const MAX_MESSAGE_LENGTH = 16_000;
const TIMEOUT_MS = 5 * 60_000;
const MIN_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
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

function parseTimeout(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new Error("A step time limit must be between 30 seconds and 30 minutes.");
  }
  return value;
}

function failureText(value: unknown, env: NodeJS.ProcessEnv, secrets: readonly string[] = []) {
  if (typeof value !== "string") return "";
  let text = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  for (const key of ["CODEX_API_KEY", "OPENAI_API_KEY", ...secrets]) {
    const secret = env[key];
    if (secret) text = text.replaceAll(secret, "[redacted]");
  }
  return displayText(text, 1_000);
}

export function createRunService(
  publish: (run: Run) => void,
  optionsForProvider: (provider: ProviderId) => { executable?: string; model?: string } = () => ({}),
  worktrees?: WorktreeManager,
) {
  const history: Run[] = [];
  const waiters = new Map<string, Array<(run: Run) => void>>();
  let active: ActiveRun | undefined;
  let closing = false;

  function conversation(id: string) {
    return history.filter((run) => conversationId(run) === id).sort(compareTurns);
  }

  function append(run: Run, event: RunEventData) {
    run.events.push({ ...event, runId: run.id, sequence: ++run.revision, at: new Date().toISOString() });
    publish(run);
  }

  function finish(run: Run, status: FinishedRunStatus, text: string) {
    active = undefined;
    run.status = status;
    run.finishedAt = new Date().toISOString();
    append(run, { type: "finished", status, text });
    const pending = waiters.get(run.id);
    if (!pending) return;
    waiters.delete(run.id);
    for (const resolve of pending) resolve(run);
  }

  async function execute(run: Run, provider: ProviderAdapter, prompt: string, signal: AbortSignal, effort?: string, chatModel?: string) {
    const env = providerEnvironment(provider);
    let worktreePath: string | undefined;
    const codexChat = run.mode === "chat" && provider.id === "codex";
    if (codexChat) {
      delete env.CODEX_API_KEY;
      delete env.OPENAI_API_KEY;
    }
    let providerNotice: string | undefined;
    const replies = new Map<string, Extract<Run["events"][number], { text: string }>>();
    let pendingUpdate: ReturnType<typeof setTimeout> | undefined;
    let isolatedDirectory: string | undefined;

    async function prepareWorktree() {
      if (!run.edit && !run.worktree) return;
      if (!worktrees) throw new Error("Editing in a worktree is not available in this build.");
      const project = run.folder?.path;
      if (!project) throw new Error("Choose a project folder first.");
      const existing = run.worktree;
      if (existing) {
        if (!(await worktrees.exists(existing))) {
          throw new Error("The worktree for this run is no longer available. Start a new run to create another.");
        }
        worktreePath = existing.path;
        const label = run.edit ? "Editing" : "Working";
        append(run, { type: "notice", text: `${label} in ${existing.branch} from ${existing.baseCommit.slice(0, 10)}.` });
        return;
      }
      if (!run.edit) return;
      append(run, { type: "notice", text: "Creating an editing branch and Git worktree…" });
      const created = await worktrees.create(project);
      run.worktree = { ...created };
      worktreePath = created.path;
      append(run, {
        type: "notice",
        text: `Created ${created.branch} from ${created.baseCommit.slice(0, 10)}.\nWorktree: ${created.path}`,
      });
    }

    async function attachDiff() {
      const worktree = run.worktree;
      if (!worktree || !worktreePath || !worktrees) return;
      try {
        const diff = await worktrees.diff(worktree);
        run.diff = diff;
        const count = diff.files.length;
        append(run, {
          type: "notice",
          text: count ? `Review ${count} changed ${count === 1 ? "file" : "files"} in ${worktree.branch}.`
            : "No file changes were recorded in the worktree.",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        append(run, { type: "error", text: failureText(message, env) || "Honeycomb could not read the worktree changes." });
      }
    }

    function receive(event: StreamEvent) {
        if (signal.aborted) return;
        if (event.type === "usage") {
          const usage = usageFrom(event);
          if (Object.keys(usage).length) {
            Object.assign(run.usage, usage);
            append(run, { type: "usage", ...usage });
          }
        } else if (event.type === "test_result") {
          const text = displayText(event.text, MAX_MESSAGE_LENGTH);
          if (text) append(run, { type: "test_result", text, passed: event.passed });
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
      const model = run.modelOverride ?? options.model;
      const { connector, executable } = await checkProvider(provider, signal, options.executable);
      if (signal.aborted) {
        await attachDiff();
        return finish(run, "cancelled", "Run stopped.");
      }
      if (!executable) throw new Error(connector.detail ?? provider.name + " was not found on PATH.");
      await prepareWorktree();
      if (run.mode === "chat") isolatedDirectory = await mkdtemp(join(tmpdir(), "honeycomb-chat-"));
      const transport = {
        ...executable, cwd: worktreePath ?? run.folder?.path ?? isolatedDirectory, env, timeoutMs: run.timeoutMs ?? TIMEOUT_MS, signal,
        onStderr(tail: string) {
          if (providerNotice || signal.aborted) return;
          providerNotice = provider.diagnoseStderr?.(tail);
          if (providerNotice) append(run, { type: "notice", text: providerNotice });
        },
      };
      if (codexChat) {
        await streamCodexChat(transport, prompt, chatModel, receive, effort);
      } else if (provider.id === "codex" && run.edit) {
        if (!worktreePath) throw new Error("Codex editing requires a Git worktree.");
        await streamCodexEdit({ ...transport, cwd: worktreePath }, prompt, model, receive, effort);
      } else if (provider.id === "claude") {
        await streamClaude(transport, prompt, {
          model, effort, chat: run.mode === "chat", edit: run.edit === true,
        }, receive);
      } else if (run.mode === "chat") {
        await streamOpenCodeChat(transport, prompt, model, connector.version, receive, effort);
      } else {
        await streamProvider(provider.id, transport, prompt, model, connector.version, receive, effort);
      }
      if (signal.aborted) {
        await attachDiff();
        return finish(run, "cancelled", "Run stopped.");
      }
      await attachDiff();
      finish(run, "completed", "Run completed.");
    } catch (error) {
      if (signal.aborted) {
        await attachDiff();
        return finish(run, "cancelled", "Run stopped.");
      }
      const message = error instanceof Error ? error.message : error;
      append(run, { type: "error", text: failureText(providerNotice ?? message, env, provider.secretEnvironment) || "The provider could not complete the run." });
      await attachDiff();
      finish(run, "failed", "Run failed.");
    } finally {
      clearTimeout(pendingUpdate);
      if (isolatedDirectory) await rm(isolatedDirectory, { recursive: true, force: true }).catch(console.error);
    }
  }

  return {
    runById(runId: string) {
      return history.find((run) => run.id === runId);
    },
    /** Resolves when the run reaches a finished status. */
    async waitForRun(runId: string) {
      const run = history.find((entry) => entry.id === runId);
      if (!run) throw new Error("This run is no longer recorded.");
      if (run.status !== "running" && run.status !== "stopping") return run;
      return new Promise<Run>((resolve) => {
        const pending = waiters.get(runId) ?? [];
        pending.push(resolve);
        waiters.set(runId, pending);
      });
    },
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
    conversation,
    async deleteChat(id: string, save: () => Promise<boolean>) {
      const turns = conversation(id);
      if (!turns.length) return false;
      if (active && conversationId(active.run) === id) {
        throw new Error("Stop the run before deleting this chat.");
      }
      for (let index = history.length - 1; index >= 0; index--) {
        const run = history[index];
        if (run && conversationId(run) === id) history.splice(index, 1);
      }
      if (await save()) return true;

      history.push(...turns);
      history.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      await save();
      throw new Error("Could not save chat history. The chat was kept.");
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
      if (!provider) throw new Error("Choose Codex, OpenCode or Claude Code.");
      const effort = parseEffort(payload?.effort, provider.id);
      const chatModel = mode === "chat" && provider.id === "codex" ? parseCodexModel(payload?.model ?? "") || undefined : undefined;
      const prompt = typeof payload?.prompt === "string" ? payload.prompt.trim() : "";
      if (!prompt || prompt.length > MAX_PROMPT_LENGTH || prompt.includes("\0")) {
        throw new Error(`Enter a task of 1 to ${MAX_PROMPT_LENGTH.toLocaleString("en-US")} characters.`);
      }

      const edit = payload?.edit === true;
      const thread = payload?.conversationId;
      if (thread !== undefined && typeof thread !== "string") throw new Error("Invalid chat.");
      if (edit && mode !== "code") throw new Error("Switch to Code to edit in a Git worktree.");
      if (edit && !supportsWorktreeEditing(provider.id)) {
        throw new Error("Choose Codex or Claude Code to edit in a Git worktree.");
      }
      const sharedWorktreeId = payload?.worktreeId;
      if (sharedWorktreeId !== undefined && typeof sharedWorktreeId !== "string") throw new Error("Invalid worktree.");
      const workflowRunId = payload?.workflowRunId;
      if (workflowRunId !== undefined && typeof workflowRunId !== "string") throw new Error("Invalid workflow run.");
      const modelValue = payload?.modelOverride;
      if (modelValue !== undefined && (typeof modelValue !== "string" || modelValue.length > 200 || modelValue.includes("\0"))) {
        throw new Error("Invalid model.");
      }
      const modelOverride = typeof modelValue === "string" ? modelValue.trim() : "";
      const timeoutValue = payload?.timeoutMs;
      const timeoutMs = timeoutValue === undefined ? undefined : parseTimeout(timeoutValue);
      const turns = thread === undefined ? [] : conversation(thread);
      const first = turns[0];
      if (thread !== undefined && !first) throw new Error("This chat is no longer saved.");
      if (turns.some((turn) => runMode(turn) !== mode || turn.folder?.path !== (mode === "code" ? folder?.path : undefined))) {
        throw new Error("Open this chat in its original workspace before continuing.");
      }
      if (first && turns.some((turn) => turn.providerId !== provider.id)) throw new Error(`Continue this chat with ${first.providerName}.`);
      const context = first ? conversationContext(turns) : undefined;
      // A shared worktree lets workflow steps with different connectors work in one checkout.
      // Otherwise a follow-up edit continues in the worktree its chat already opened, if it still exists.
      let worktree;
      if (sharedWorktreeId !== undefined) {
        if (mode !== "code") throw new Error("Switch to Code to work in a Git worktree.");
        const record = worktrees?.find(sharedWorktreeId);
        if (!record || record.state === "discarded") throw new Error("The workflow worktree is no longer available.");
        worktree = { id: record.id, branch: record.branch, path: record.path, baseCommit: record.baseCommit, state: record.state };
      } else if (edit) {
        worktree = turns.find((turn) => turn.worktree && turn.worktree.state !== "discarded")?.worktree;
      }
      const run: Run = {
        id: randomUUID(),
        ...(thread === undefined ? {} : { conversationId: thread, turnIndex: turns.length, context: context?.summary }),
        providerId: provider.id,
        providerName: provider.name,
        mode,
        folder: mode === "code" ? folder : undefined,
        ...(edit ? { edit: true } : {}),
        ...(worktree ? { worktree: { ...worktree } } : {}),
        ...(workflowRunId === undefined ? {} : { workflowRunId }),
        ...(modelOverride ? { modelOverride } : {}),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
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
      active.done = execute(run, provider, context?.summary.includedTurns ? followUpPrompt(prompt, context.transcript) : prompt,
        controller.signal, effort, chatModel);
      return run.id;
    },
    stop(runId: string) {
      if (active?.run.id !== runId || active.controller.signal.aborted) return;
      active.run.status = "stopping";
      append(active.run, { type: "stopping", text: "Stopping the provider." });
      active.controller.abort();
    },
    setWorktreeState(worktreeId: string, state: WorktreeState) {
      let changed = 0;
      for (const run of history) {
        if (run.worktree?.id !== worktreeId) continue;
        run.worktree = { ...run.worktree, state };
        run.revision++;
        publish(run);
        changed++;
      }
      return changed;
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
