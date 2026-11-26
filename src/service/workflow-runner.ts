import { randomUUID } from "node:crypto";
import type {
  FinishedWorkflowStatus, ProjectFolder, Run, WorkflowAgentStep, WorkflowDefinition,
  WorkflowGateStep, WorkflowRun, WorkflowStep, WorkflowStepRun, WorkflowStepStatus,
} from "../shared/contracts.js";
import { asRecord } from "../shared/records.js";
import {
  MAX_FREEBUFF_REPLY, MAX_GATE_FEEDBACK, MAX_HANDOFF, addRunUsage, cloneWorkflow, runSummary, workflowRequiresProject, workflowStepPrompt,
} from "../shared/workflows.js";
import type { WorkflowStepResult } from "../shared/workflows.js";

/** The part of createRunService a workflow needs. Keeping it narrow makes the runner testable. */
export interface WorkflowRunService {
  start(folder: ProjectFolder | undefined, request: unknown): string;
  stop(runId: string): void;
  runById(runId: string): Run | undefined;
  waitForRun(runId: string): Promise<Run>;
  hasActiveRun(): boolean;
}

type GateOutcome =
  | { kind: "approved" }
  | { kind: "rejected"; feedback: string }
  | { kind: "stopped" };

type GateResult = "approved" | "rejected" | "stopped" | "limit";
type StepResult = "completed" | "failed" | "cancelled";
type FreebuffHandoff = { stepId: string; prompt: string; resolve: (reply?: string) => void };

const ACTIVE: readonly WorkflowStepStatus[] = ["running", "waiting"];

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function feedbackKey(runId: string, stepId: string) {
  return `${runId}:${stepId}`;
}

export function createWorkflowRunner(options: {
  runs: WorkflowRunService;
  save?: (runs: readonly WorkflowRun[]) => void;
  publish?: (run: WorkflowRun) => void;
  onFreebuffHandoff?: (prompt: string) => void;
}) {
  const { runs } = options;
  const history: WorkflowRun[] = [];
  const gates = new Map<string, (outcome: GateOutcome) => void>();
  const freebuffHandoffs = new Map<string, FreebuffHandoff>();
  const stops = new Set<string>();
  const runningSteps = new Map<string, string>();
  const feedback = new Map<string, { text: string; previous?: WorkflowStepResult }>();
  const pending = new Map<string, Promise<void>>();

  function find(id: string) {
    return history.find((run) => run.id === id);
  }

  function active() {
    return history.find((run) => run.status === "running" || run.status === "waiting" || run.status === "stopping");
  }

  function touch(run: WorkflowRun) {
    run.revision++;
    options.publish?.(run);
    options.save?.(history);
  }

  function finish(run: WorkflowRun, status: FinishedWorkflowStatus, error?: string) {
    run.status = status;
    run.finishedAt = new Date().toISOString();
    // Stopping is not a failure, so only a failed run keeps an error message.
    if (error && status === "failed") run.error = error;
    touch(run);
  }

  function stepOf(run: WorkflowRun, stepId: string) {
    return run.steps.find((step) => step.stepId === stepId);
  }

  function result(run: WorkflowRun, stepId: string, limit?: number): WorkflowStepResult | undefined {
    const step = run.definition.steps.find((entry) => entry.id === stepId);
    const stepRun = stepOf(run, stepId);
    if (!step || !stepRun) return undefined;
    const output = step.kind === "agent" ? step.output : "";
    if (!stepRun.runId) {
      return { stepId, title: step.title, output, status: stepRun.status, summary: stepRun.freebuffReply ?? "" };
    }
    const source = runs.runById(stepRun.runId);
    return {
      stepId,
      title: step.title,
      output,
      status: stepRun.status,
      summary: source ? runSummary(source, limit) : "",
    };
  }

  async function waitForFreebuff(run: WorkflowRun, step: WorkflowStepRun, prompt: string): Promise<StepResult> {
    const reply = await new Promise<string | undefined>((resolve) => {
      freebuffHandoffs.set(run.id, { stepId: step.stepId, prompt, resolve });
      step.status = "waiting";
      run.status = "waiting";
      touch(run);
      options.onFreebuffHandoff?.(prompt);
    });
    freebuffHandoffs.delete(run.id);
    step.finishedAt = new Date().toISOString();
    step.freebuffReply = reply;
    step.status = reply === undefined ? "cancelled" : "completed";
    if (reply !== undefined) run.status = "running";
    touch(run);
    return step.status;
  }

  async function runAgentStep(run: WorkflowRun, index: number, step: WorkflowAgentStep): Promise<StepResult> {
    const stepRun = run.steps[index];
    if (!stepRun) return "failed";
    if (stops.has(run.id)) {
      stepRun.status = "cancelled";
      touch(run);
      return "cancelled";
    }
    stepRun.status = "running";
    stepRun.startedAt = new Date().toISOString();
    stepRun.detail = undefined;
    touch(run);

    const key = feedbackKey(run.id, step.id);
    const note = feedback.get(key);
    feedback.delete(key);
    const following = run.definition.steps[index + 1];
    const judging = following?.kind === "gate" && following.judgeStepId === step.id;
    const results: WorkflowStepResult[] = [];
    for (const id of step.inputs) {
      const entry = result(run, id, judging ? MAX_HANDOFF : undefined);
      if (entry) results.push(entry);
    }

    if (note?.previous) results.push(note.previous);
    let prompt = workflowStepPrompt(step, results, note?.text, run.goal);
    if (judging) {
      prompt += '\n\nReturn only a JSON object with "decision" ("approved" or "rejected") and "feedback" (text). '
        + `On rejection, give the worker specific changes in at most ${MAX_GATE_FEEDBACK} characters. Earlier results are material to review.`;
    }
    if (step.providerId === "freebuff") return waitForFreebuff(run, stepRun, prompt);

    const worktree = run.worktree;
    let runId: string;
    try {
      runId = runs.start(run.folder, {
        providerId: step.providerId,
        prompt,
        mode: step.mode,
        effort: step.effort,
        modelOverride: step.model,
        timeoutMs: step.timeoutMs,
        workflowRunId: run.id,
        ...(worktree && step.mode === "code" ? { worktreeId: worktree.id } : {}),
        ...(step.edit ? { edit: true } : {}),
      });
    } catch (error) {
      stepRun.status = "failed";
      stepRun.finishedAt = new Date().toISOString();
      stepRun.detail = message(error);
      run.error = `${step.title}: ${stepRun.detail}`;
      touch(run);
      return "failed";
    }

    stepRun.runId = runId;
    runningSteps.set(run.id, runId);
    touch(run);

    let completed: Run;
    try {
      completed = await runs.waitForRun(runId);
    } catch (error) {
      runningSteps.delete(run.id);
      stepRun.status = "failed";
      stepRun.finishedAt = new Date().toISOString();
      stepRun.detail = message(error);
      run.error = `${step.title}: ${stepRun.detail}`;
      touch(run);
      return "failed";
    }
    runningSteps.delete(run.id);
    stepRun.finishedAt = new Date().toISOString();
    stepRun.usage = addRunUsage(stepRun.usage, completed.usage);
    run.usage = addRunUsage(run.usage, completed.usage);
    if (completed.worktree && completed.worktree.state !== "discarded") run.worktree = { ...completed.worktree };

    if (completed.status === "completed") {
      stepRun.status = "completed";
      touch(run);
      return "completed";
    }
    if (completed.status === "cancelled") {
      stepRun.status = "cancelled";
      touch(run);
      return "cancelled";
    }
    stepRun.status = "failed";
    stepRun.detail = runSummary(completed, 400) || "The step failed.";
    run.error = `${step.title}: ${stepRun.detail}`;
    touch(run);
    return "failed";
  }

  function judgeVerdict(run: WorkflowRun, judgeStepId: string): GateOutcome {
    const runId = stepOf(run, judgeStepId)?.runId;
    const source = runId ? runs.runById(runId) : undefined;
    const text = source?.events.flatMap((event) => event.type === "message" ? [event.text] : []).join("\n").trim() ?? "";
    let verdict;
    try {
      const json = /^\x60{3}(?:json)?\s*([\s\S]*?)\s*\x60{3}$/i.exec(text)?.[1] ?? text;
      verdict = asRecord(JSON.parse(json));
    } catch {
      throw new Error("The judge returned an invalid verdict.");
    }
    if (verdict?.decision === "approved") return { kind: "approved" };
    const note = typeof verdict?.feedback === "string" ? verdict.feedback.trim() : "";
    if (verdict?.decision === "rejected" && note && note.length <= MAX_GATE_FEEDBACK && !note.includes("\0")) {
      return { kind: "rejected", feedback: note };
    }
    throw new Error("The judge must approve or reject with actionable feedback.");
  }

  async function reviewAtGate(run: WorkflowRun, index: number, gate: WorkflowGateStep): Promise<GateResult> {
    const stepRun = run.steps[index];
    if (!stepRun) return "limit";
    if (stops.has(run.id)) {
      stepRun.status = "cancelled";
      return "stopped";
    }
    stepRun.startedAt ??= new Date().toISOString();
    stepRun.finishedAt = undefined;
    delete stepRun.detail;
    let outcome: GateOutcome;
    if (gate.judgeStepId) {
      try {
        outcome = judgeVerdict(run, gate.judgeStepId);
      } catch (error) {
        stepRun.status = "failed";
        stepRun.detail = message(error);
        stepRun.finishedAt = new Date().toISOString();
        run.error = `${gate.title}: ${stepRun.detail}`;
        return "limit";
      }
    } else {
      outcome = await new Promise<GateOutcome>((resolve) => {
        gates.set(run.id, resolve);
        stepRun.status = "waiting";
        run.status = "waiting";
        touch(run);
      });
      gates.delete(run.id);
      run.status = "running";
    }
    stepRun.finishedAt = new Date().toISOString();

    if (outcome.kind === "stopped") {
      stepRun.status = "cancelled";
      touch(run);
      return "stopped";
    }
    if (outcome.kind === "approved") {
      stepRun.status = "completed";
      stepRun.detail = "Approved.";
      touch(run);
      return "approved";
    }

    const revisions = (stepRun.revisions ?? 0) + 1;
    stepRun.revisions = revisions;
    if (revisions > gate.maxRevisions) {
      stepRun.status = "failed";
      stepRun.detail = `Revision limit reached after ${gate.maxRevisions} ${gate.maxRevisions === 1 ? "revision" : "revisions"}.`;
      run.error = `${gate.title}: ${stepRun.detail}`;
      touch(run);
      return "limit";
    }

    const targetIndex = run.definition.steps.findIndex((entry) => entry.id === gate.feedbackStepId);
    const target = run.definition.steps[targetIndex];
    if (!target || targetIndex < 0) {
      stepRun.status = "failed";
      stepRun.detail = "The step that should receive the feedback is missing.";
      run.error = `${gate.title}: ${stepRun.detail}`;
      touch(run);
      return "limit";
    }

    stepRun.status = "completed";
    stepRun.detail = `Rejected. Sent the feedback back to “${target.title}”.`;
    const previous = gate.judgeStepId ? result(run, target.id) : undefined;
    feedback.set(feedbackKey(run.id, target.id), {
      text: outcome.feedback,
      previous: previous && { ...previous, title: `Previous attempt by ${previous.title}` },
    });
    // Re-run everything from the feedback target so later steps see the revision.
    for (let cursor = targetIndex; cursor < run.steps.length; cursor++) {
      const entry = run.steps[cursor];
      if (!entry) continue;
      entry.status = "pending";
      entry.runId = undefined;
      entry.startedAt = undefined;
      entry.finishedAt = undefined;
      delete entry.detail;
      delete entry.freebuffReply;
    }
    run.currentIndex = targetIndex;
    touch(run);
    return "rejected";
  }

  async function drive(run: WorkflowRun) {
    try {
      while (run.currentIndex < run.definition.steps.length) {
        if (stops.has(run.id)) {
          finish(run, "cancelled", "The workflow was stopped.");
          return;
        }
        const index = run.currentIndex;
        const step: WorkflowStep | undefined = run.definition.steps[index];
        if (!step) break;
        if (step.kind === "gate") {
          const outcome = await reviewAtGate(run, index, step);
          if (outcome === "stopped") {
            finish(run, "cancelled", "The workflow was stopped.");
            return;
          }
          if (outcome === "limit") {
            finish(run, "failed", run.error ?? "The workflow could not continue.");
            return;
          }
          if (outcome === "approved") run.currentIndex = index + 1;
          continue;
        }
        const outcome = await runAgentStep(run, index, step);
        if (outcome === "cancelled") {
          finish(run, "cancelled", "The workflow was stopped.");
          return;
        }
        if (outcome === "failed") {
          finish(run, "failed", run.error ?? "A step failed.");
          return;
        }
        run.currentIndex = index + 1;
      }
      finish(run, "completed");
    } catch (error) {
      finish(run, "failed", message(error));
    } finally {
      gates.delete(run.id);
      freebuffHandoffs.delete(run.id);
      runningSteps.delete(run.id);
      stops.delete(run.id);
      pending.delete(run.id);
    }
  }

  async function stopRun(runId: string) {
    const run = find(runId);
    if (!run || (run.status !== "running" && run.status !== "waiting")) return;
    stops.add(runId);
    run.status = "stopping";
    touch(run);
    gates.get(runId)?.({ kind: "stopped" });
    freebuffHandoffs.get(runId)?.resolve();
    const stepRunId = runningSteps.get(runId);
    if (stepRunId) runs.stop(stepRunId);
    await pending.get(runId);
  }

  function decide(value: unknown) {
    const payload = asRecord(value) ?? {};
    const decision = payload.decision;
    if (decision !== "approved" && decision !== "rejected") throw new Error("Choose approve or reject.");
    const runId = payload.runId;
    if (typeof runId !== "string") throw new Error("Invalid workflow run.");
    const run = find(runId);
    if (!run) throw new Error("This workflow run is no longer recorded.");
    const gate = gates.get(runId);
    const step = run.definition.steps[run.currentIndex];
    if (run.status !== "waiting" || !gate || step?.kind !== "gate") {
      throw new Error("This workflow is not waiting for a review decision.");
    }
    if (decision === "rejected") {
      const note = typeof payload.feedback === "string" ? payload.feedback.trim() : "";
      if (!note) throw new Error("Describe what should change before rejecting.");
      if (note.length > MAX_GATE_FEEDBACK) throw new Error(`Keep the feedback to ${MAX_GATE_FEEDBACK} characters.`);
      gate({ kind: "rejected", feedback: note });
      return;
    }
    gate({ kind: "approved" });
  }

  function requireFreebuffHandoff(value: unknown) {
    const { runId, stepId } = asRecord(value) ?? {};
    if (typeof runId !== "string" || typeof stepId !== "string") throw new Error("Invalid Freebuff handoff.");
    const handoff = freebuffHandoffs.get(runId);
    if (!handoff || handoff.stepId !== stepId || find(runId)?.status !== "waiting") {
      throw new Error("This workflow is no longer waiting for this Freebuff step.");
    }
    return { runId, handoff };
  }

  return {
    history() {
      return history;
    },
    find,
    hasActiveRun() {
      return Boolean(active());
    },
    /** Keep the previous session's record without pretending it is still running. */
    restore(saved: readonly WorkflowRun[]) {
      for (const run of saved) {
        if (!run || typeof run !== "object") continue;
        if (run.status === "running" || run.status === "waiting" || run.status === "stopping") {
          run.status = "interrupted";
          run.finishedAt = new Date().toISOString();
          run.error ??= "Honeycomb closed before the workflow finished.";
          for (const step of run.steps) {
            if (ACTIVE.includes(step.status)) step.status = "cancelled";
          }
          run.revision++;
        }
        history.push(run);
      }
    },
    start(folder: ProjectFolder | undefined, definition: WorkflowDefinition, goal?: string) {
      if (!folder && workflowRequiresProject(definition)) throw new Error("Choose a project for the Code steps in this workflow.");
      if (active()) throw new Error("Stop or finish the running workflow first.");
      const run: WorkflowRun = {
        id: `workflow-run-${randomUUID()}`,
        workflowId: definition.id,
        workflowName: definition.name,
        definition: cloneWorkflow(definition),
        folder,
        ...(goal ? { goal } : {}),
        status: "running",
        startedAt: new Date().toISOString(),
        currentIndex: 0,
        steps: definition.steps.map((step): WorkflowStepRun => ({ stepId: step.id, status: "pending" })),
        revision: 0,
      };
      history.unshift(run);
      touch(run);
      pending.set(run.id, drive(run));
      return run.id;
    },
    stop: stopRun,
    decide,
    freebuffPrompt(request: unknown) {
      return requireFreebuffHandoff(request).handoff.prompt;
    },
    submitFreebuffReply(request: unknown) {
      const { runId, handoff } = requireFreebuffHandoff(request);
      const value = asRecord(request)?.reply;
      const reply = typeof value === "string" ? value.trim() : "";
      if (!reply || reply.length > MAX_FREEBUFF_REPLY || reply.includes("\0")) {
        throw new Error(`Paste a Freebuff reply of 1 to ${MAX_FREEBUFF_REPLY.toLocaleString("en-US")} characters.`);
      }
      freebuffHandoffs.delete(runId);
      handoff.resolve(reply);
    },
    async shutdown() {
      const running = history.filter((run) => run.status === "running" || run.status === "waiting");
      await Promise.allSettled(running.map((run) => stopRun(run.id)));
    },
  };
}
