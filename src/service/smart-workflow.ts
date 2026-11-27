import { randomUUID } from "node:crypto";
import type {
  ProjectFolder, Run, RunDiff, SmartChoice, SmartOrchestrator, SmartRunRequest, SmartSettings, WorkflowAgentStep, WorkflowRun,
} from "../shared/contracts.js";
import { addRunUsage, boundedText, MAX_FREEBUFF_REPLY, runSummary, workflowStepPrompt } from "../shared/workflows.js";
import { asRecord } from "../shared/records.js";
import type { WorkflowStepResult } from "../shared/workflows.js";
import {
  freebuffDirective, isAutomaticSmartConnector, MAX_SMART_ATTEMPTS, parseSmartAction, smartCandidates, smartCoordinatorPrompt, smartEffort,
} from "./smart-routing.js";
import type { SmartCatalogEntry, SmartDelegation } from "./smart-routing.js";
import type { WorkflowRunService } from "./workflow-runner.js";
import { remainingPercent } from "./connector-quota.js";

const COORDINATE: SmartDelegation = {
  action: "delegate", title: "Coordinate", prompt: "", strength: "coding", mode: "chat", edit: false,
  model: "", effort: "", reason: "", inputs: [],
};
const STEP_TIMEOUT = 5 * 60_000;
const QUOTA_ERROR = /rate.?limit|too many requests|quota|\b429\b/i;

function runError(run: Run) {
  const errors = run.events.flatMap((event) => event.type === "error" ? [event.text] : []);
  return boundedText(errors.at(-1) ?? runSummary(run), 1_000);
}

export function createSmartWorkflows(options: {
  runs: WorkflowRunService;
  available: (settings: SmartSettings, refreshQuota?: boolean) => Promise<SmartCatalogEntry[]>;
  openCodeEfforts?: (model: string) => Promise<string[]>;
  canStart: () => boolean;
  save: (runs: readonly WorkflowRun[]) => Promise<boolean>;
  publish: (run: WorkflowRun) => void;
  notify: (run: WorkflowRun) => void;
  inspectChanges: (run: WorkflowRun) => Promise<string>;
}) {
  const records: WorkflowRun[] = [];
  let active: { run: WorkflowRun; task?: Promise<void>; providerRunId?: string; limited: Set<string>; stopped: boolean } | undefined;
  type Activity = NonNullable<typeof active>;

  function touch(run: WorkflowRun) {
    run.revision++;
    const saved = options.save(records);
    options.publish(run);
    return saved;
  }

  function find(id: unknown) {
    return records.find((run) => run.id === id);
  }

  function requireRun(id: unknown) {
    const run = find(id);
    if (!run?.smart) throw new Error("This Smart workflow is no longer recorded.");
    return run as WorkflowRun & { smart: NonNullable<WorkflowRun["smart"]> };
  }

  function newRun(request: SmartRunRequest, folder: ProjectFolder | undefined, context: string, settings: SmartSettings) {
    const id = `smart-${randomUUID()}`;
    const messages: unknown = JSON.parse(context || "[]");
    const current = freebuffDirective(request.goal);
    const earlier = Array.isArray(messages) ? messages.flatMap((message) => {
      const user = asRecord(message)?.user;
      const directive = typeof user === "string" ? freebuffDirective(user) : "default";
      return directive === "default" ? [] : [directive];
    }).at(-1) : undefined;
    return {
      id, workflowId: id, workflowName: "Smart workflow",
      definition: { id, name: "Smart workflow", description: "", steps: [] },
      folder, goal: request.goal, status: "running", startedAt: new Date().toISOString(), currentIndex: 0,
      steps: [], revision: 0,
      smart: {
        access: request.access, context, settings, freebuffDirective: current === "default" ? earlier ?? "default" : current,
        selection: {}, attempts: 0, orchestrator: request.orchestrator,
      },
    } satisfies WorkflowRun;
  }

  function occupy(run: WorkflowRun): Activity {
    if (active || options.runs.hasActiveRun() || !options.canStart()) throw new Error("Finish or stop the current run first.");
    return active = { run, limited: new Set(), stopped: false };
  }

  function results(run: WorkflowRun): WorkflowStepResult[] {
    return run.steps.flatMap((entry, index) => {
      const step = run.definition.steps[index];
      if (step?.kind !== "agent") return [];
      const source = entry.runId ? options.runs.runById(entry.runId) : undefined;
      return [{
        stepId: step.id, title: step.title, status: entry.status, output: step.output,
        summary: boundedText(entry.freebuffReply ?? entry.detail ?? (source ? runSummary(source) : ""), 1_200),
      }];
    });
  }

  async function invoke(activity: Activity, project: ProjectFolder | undefined, request: unknown) {
    if (activity.stopped) throw new Error("The Smart workflow was stopped.");
    const id = options.runs.start(project, request);
    activity.providerRunId = id;
    try {
      return await options.runs.waitForRun(id);
    } finally {
      activity.providerRunId = undefined;
    }
  }

  async function withEffort(choice: SmartChoice, task: SmartDelegation) {
    if (choice.connector !== "opencode" || choice.effort || !options.openCodeEfforts) return choice;
    const efforts = await options.openCodeEfforts(choice.model).catch(() => []);
    return { ...choice, effort: smartEffort(task, efforts) };
  }

  async function next(activity: Activity, catalog: readonly SmartCatalogEntry[], repair?: string) {
    const { run } = activity;
    const smart = run.smart!;
    let available = catalog;
    for (let attempt = 0; attempt < 2; attempt++) {
      const automatic = available.filter((entry) => isAutomaticSmartConnector(entry.connector));
      const selected = smart.orchestrator;
      let coordinator: SmartOrchestrator | undefined;
      if (selected && !activity.limited.has(selected.connector)) {
        const entry = automatic.find(({ connector }) => connector === selected.connector);
        if (!entry) throw new Error("The selected orchestrator connector is unavailable.");
        if (remainingPercent(entry.quota, selected.model || entry.catalog.selected) === 0) activity.limited.add(selected.connector);
        else coordinator = selected;
      }
      if (!coordinator) {
        const route = smartCandidates(smart, automatic, COORDINATE, [...activity.limited])[0];
        if (!route || !isAutomaticSmartConnector(route.connector)) break;
        coordinator = { ...await withEffort(route, COORDINATE), connector: route.connector };
      }
      smart.orchestrator = coordinator;
      const response = await invoke(activity, undefined, {
        providerId: coordinator.connector, mode: "chat", modelOverride: coordinator.model, effort: coordinator.effort,
        workflowPlanner: true, workflowRunId: run.id, timeoutMs: STEP_TIMEOUT,
        prompt: smartCoordinatorPrompt(run, available, results(run), repair),
      });
      run.usage = addRunUsage(run.usage, response.usage);
      if (activity.stopped) throw new Error("The Smart workflow was stopped.");
      if (response.status !== "failed" || !QUOTA_ERROR.test(runError(response))) return parseSmartAction(response);
      activity.limited.add(coordinator.connector);
      available = await options.available(smart.settings, true);
    }
    throw new Error("Smart needs an available automatic connector with sufficient quota to coordinate the workflow.");
  }

  function addWorker(run: WorkflowRun, step: WorkflowAgentStep) {
    run.definition.steps.push(step);
    run.currentIndex = run.steps.length;
    const result: WorkflowRun["steps"][number] = {
      stepId: step.id, status: "running", startedAt: new Date().toISOString(),
    };
    run.steps.push(result);
    return result;
  }

  async function delegate(activity: Activity, task: SmartDelegation, catalog: readonly SmartCatalogEntry[]) {
    const { run } = activity;
    const smart = run.smart!;
    const excluded = [...activity.limited];
    if (run.steps.some((step) => step.status === "skipped" && smart.selection[step.stepId]?.connector === "freebuff")) excluded.push("freebuff");
    let available = catalog;
    for (let retry = 0; retry < 2 && smart.attempts < MAX_SMART_ATTEMPTS; retry++) {
      const route = smartCandidates(smart, available, task, excluded)[0];
      if (!route) {
        if (retry) return "continue";
        throw new Error(`No available model matches the ${task.strength} step with the approved access and quota.`);
      }
      const choice = await withEffort(route, task);
      if (activity.stopped) return "cancelled";
      const earlier = results(run);
      const inputs = task.inputs.filter((id) => earlier.some((entry) => entry.stepId === id));
      const step: WorkflowAgentStep = {
        id: `step-${run.steps.length + 1}`, kind: "agent", title: task.title, providerId: choice.connector,
        model: choice.model, effort: choice.effort, mode: task.mode, edit: task.edit,
        prompt: task.finishWithReply
          ? `Complete and verify the whole task. Reply directly to the user with the result, checks you ran, and any limitations.\n\n${task.prompt}`
          : task.prompt,
        inputs, output: "", timeoutMs: STEP_TIMEOUT,
      };
      const record = addWorker(run, step);
      smart.selection[step.id] = choice;
      smart.attempts++;
      const prompt = workflowStepPrompt(step, earlier.filter((entry) => inputs.includes(entry.stepId)), smart.answer, boundedText(run.goal ?? "", 2_000));
      if (choice.connector === "freebuff") {
        record.status = "waiting";
        smart.pending = { kind: "freebuff", stepId: step.id, prompt, finishWithReply: task.finishWithReply };
        run.status = "waiting";
        if (await touch(run)) {
          if (!activity.stopped && run.status === "waiting") options.notify(run);
        } else {
          delete smart.pending;
          record.status = "failed";
          throw new Error("Could not save the Freebuff handoff.");
        }
        return "waiting";
      }
      void touch(run);
      let directReply = "";
      try {
        const workerId = options.runs.start(run.folder, {
          providerId: choice.connector, mode: task.mode, edit: task.edit, prompt,
          modelOverride: choice.model, effort: choice.effort, timeoutMs: STEP_TIMEOUT, workflowRunId: run.id,
          ...(run.worktree && task.mode === "code" ? { worktreeId: run.worktree.id } : {}),
        });
        activity.providerRunId = record.runId = workerId;
        void touch(run);
        const completed = await options.runs.waitForRun(workerId);
        record.status = completed.status === "completed" ? "completed" : completed.status === "cancelled" ? "cancelled" : "failed";
        record.usage = completed.usage;
        if (completed.worktree && completed.worktree.state !== "discarded") {
          run.worktree = completed.worktree;
          if (completed.diff) run.diff = completed.diff;
        }
        if (record.status === "failed") record.detail = runError(completed);
        if (record.status === "completed" && task.finishWithReply) {
          directReply = boundedText(completed.events.flatMap((event) => event.type === "message" ? [event.text] : []).join("\n\n"), 12_000);
        }
      } catch (error) {
        record.status = "failed";
        record.detail = boundedText(error instanceof Error ? error.message : String(error), 1_000);
      } finally {
        activity.providerRunId = undefined;
      }
      record.finishedAt = new Date().toISOString();
      run.usage = addRunUsage(run.usage, record.usage);
      if (record.status === "failed" && task.edit && run.worktree && !activity.stopped) {
        record.detail = boundedText(`${record.detail ?? ""}\nPartial changes: ${await options.inspectChanges(run)}`, 1_200);
      }
      const limited = record.status === "failed" && QUOTA_ERROR.test(record.detail ?? "");
      if (limited) activity.limited.add(choice.connector);
      void touch(run);
      if (activity.stopped || record.status === "cancelled") return "cancelled";
      if (directReply) {
        smart.reply = directReply;
        smart.replyFrom = choice.connector;
        return "completed";
      }
      if (record.status === "completed" || task.edit) return "continue";
      if (limited) {
        excluded.push(choice.connector);
        available = await options.available(smart.settings, true);
      } else {
        excluded.push(`${choice.connector}:${choice.model}`);
      }
    }
    return "continue";
  }

  async function drive(activity: Activity) {
    const { run } = activity;
    const smart = run.smart!;
    try {
      while (!activity.stopped) {
        run.currentIndex = run.steps.length;
        void touch(run);
        const catalog = await options.available(smart.settings);
        let repair = "";
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const action = await next(activity, catalog, repair);
            if (action.action === "finish") {
              smart.reply = action.reply;
              run.status = "completed";
              return;
            }
            if (action.action === "ask") {
              smart.pending = { kind: "question", question: action.reply };
              run.status = "waiting";
              return;
            }
            if (smart.attempts >= MAX_SMART_ATTEMPTS) throw new Error("Worker limit reached. Summarize what completed.");
            const outcome = await delegate(activity, action, catalog);
            if (outcome === "continue") break;
            if (outcome === "cancelled" || outcome === "completed") run.status = outcome;
            return;
          } catch (error) {
            if (activity.stopped) break;
            if (attempt) throw error;
            repair = boundedText(error instanceof Error ? error.message : String(error), 1_000);
          }
        }
      }
      run.status = "cancelled";
    } catch (error) {
      run.status = "failed";
      run.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (activity.stopped) run.status = "cancelled";
      if (run.status !== "waiting") {
        delete smart.pending;
        run.finishedAt = new Date().toISOString();
      }
      active = undefined;
      await touch(run);
    }
  }

  function resume(id: unknown) {
    const run = requireRun(id);
    if (run.status !== "waiting" || run.smart.pending) throw new Error("This workflow is not ready to resume.");
    const activity = occupy(run);
    run.status = "running";
    activity.task = drive(activity);
  }

  function pendingFreebuff(id: unknown) {
    const run = requireRun(id);
    const pending = run.smart.pending;
    const step = run.definition.steps.find((entry) => entry.id === (pending?.kind === "freebuff" ? pending.stepId : undefined));
    const record = run.steps.find((entry) => entry.stepId === step?.id);
    if (run.status !== "waiting" || pending?.kind !== "freebuff" || step?.kind !== "agent" || !record) {
      throw new Error("This Smart workflow is not waiting for Freebuff.");
    }
    return { run, pending, step, record };
  }

  function advanceWhenIdle(run: WorkflowRun) {
    void touch(run);
    if (!active && !options.runs.hasActiveRun() && options.canStart()) resume(run.id);
  }

  return {
    history: () => records,
    find,
    busy: () => Boolean(active),
    restore(saved: readonly WorkflowRun[]) {
      for (const run of saved) {
        if (!run.smart) continue;
        if (run.status === "running" || run.status === "stopping") {
          run.status = "interrupted";
          run.finishedAt = new Date().toISOString();
          for (const step of run.steps) if (step.status === "running") step.status = "cancelled";
          run.revision++;
        }
        records.push(run);
      }
    },
    start(request: SmartRunRequest, folder: ProjectFolder | undefined, context: string, settings: SmartSettings) {
      const run = newRun(request, folder, context, settings);
      const activity = occupy(run);
      records.unshift(run);
      activity.task = drive(activity);
      return run.id;
    },
    async preview(request: SmartRunRequest, folder: ProjectFolder | undefined, context: string, settings: SmartSettings) {
      const activity = occupy(newRun(request, folder, context, settings));
      let release!: () => void;
      activity.task = new Promise((resolve) => { release = resolve; });
      try {
        const catalog = await options.available(settings);
        const action = await next(activity, catalog);
        const orchestrator = activity.run.smart?.orchestrator;
        if (action.action !== "delegate") return { reply: action.reply, orchestrator };
        const choice = smartCandidates(activity.run.smart!, catalog, action, [...activity.limited])[0];
        return choice ? { choice: await withEffort(choice, action), orchestrator }
          : { reply: "No available model matches the step with the approved access and quota.", orchestrator };
      } finally {
        active = undefined;
        release();
      }
    },
    answer(id: unknown, value: unknown) {
      const run = requireRun(id);
      if (run.status !== "waiting" || run.smart.pending?.kind !== "question") throw new Error("This workflow is not waiting for an answer.");
      const answer = typeof value === "string" ? value.trim() : "";
      if (!answer || answer.length > 2_000 || answer.includes("\0")) throw new Error("Enter an answer of up to 2,000 characters.");
      const directive = freebuffDirective(answer);
      if (directive !== "default" && run.smart.freebuffDirective !== "exclude") run.smart.freebuffDirective = directive;
      run.smart.answer = boundedText(`${run.smart.answer ?? ""}\nQuestion: ${run.smart.pending.question}\nAnswer: ${answer}`, 4_000);
      delete run.smart.pending;
      advanceWhenIdle(run);
    },
    resume,
    pendingFreebuff,
    async attachFreebuffWorktree(id: unknown, worktree: NonNullable<WorkflowRun["worktree"]>) {
      const { run } = pendingFreebuff(id);
      run.worktree = worktree;
      if (!await touch(run)) throw new Error("Could not save the workflow worktree.");
    },
    replyFreebuff(id: unknown, value: unknown, reportedModel: unknown, diff?: RunDiff) {
      const { run, pending, record } = pendingFreebuff(id);
      const reply = typeof value === "string" ? value.trim() : "";
      if (!reply || reply.length > MAX_FREEBUFF_REPLY || reply.includes("\0")) throw new Error("Enter a completed Freebuff reply.");
      if (typeof reportedModel === "string" && reportedModel.trim() && reportedModel.length <= 200 && !/[\u0000-\u001f]/.test(reportedModel)) {
        record.detail = `Model used: ${reportedModel.trim()}`;
      }
      record.freebuffReply = reply;
      if (diff) run.diff = diff;
      record.status = "completed";
      record.finishedAt = new Date().toISOString();
      delete run.smart.pending;
      if (pending.finishWithReply) {
        run.smart.reply = reply;
        run.smart.replyFrom = "freebuff";
        run.status = "completed";
        run.finishedAt = record.finishedAt;
        void touch(run);
        return;
      }
      advanceWhenIdle(run);
    },
    reroute(id: unknown) {
      const { run, record } = pendingFreebuff(id);
      record.status = "skipped";
      record.detail = "The user requested an automatic connector.";
      record.finishedAt = new Date().toISOString();
      delete run.smart.pending;
      advanceWhenIdle(run);
    },
    async stop(id: unknown) {
      const run = requireRun(id);
      if (active?.run === run) {
        const { task, providerRunId } = active;
        if (run.status === "waiting") {
          const step = run.steps[run.currentIndex];
          if (step?.status === "waiting") {
            step.status = "cancelled";
            step.finishedAt = new Date().toISOString();
          }
        }
        active.stopped = true;
        run.status = "stopping";
        void touch(run);
        if (providerRunId) options.runs.stop(providerRunId);
        await task;
      } else if (run.status === "waiting") {
        const step = run.steps[run.currentIndex];
        if (step?.status === "waiting") {
          step.status = "cancelled";
          step.finishedAt = new Date().toISOString();
        }
        delete run.smart.pending;
        run.status = "cancelled";
        run.finishedAt = new Date().toISOString();
        await touch(run);
      }
    },
    async shutdown() {
      const activity = active;
      if (!activity) return;
      if (activity.run.status !== "waiting") {
        activity.stopped = true;
        if (activity.providerRunId) options.runs.stop(activity.providerRunId);
      }
      await activity.task;
    },
    setWorktreeState(id: string, state: NonNullable<WorkflowRun["worktree"]>["state"]) {
      for (const run of records) {
        if (run.worktree?.id !== id) continue;
        run.worktree.state = state;
        void touch(run);
      }
    },
  };
}
