import type {
  Run, RunUsage, WorkflowAgentStep, WorkflowDefinition, WorkflowGateStep, WorkflowProviderId, WorkflowStep,
} from "./contracts.js";
import { CLI_PROVIDER_IDS } from "./contracts.js";
import { supportsWorktreeEditing } from "./editing.js";

export const WORKFLOW_PROVIDERS: readonly WorkflowProviderId[] = [...CLI_PROVIDER_IDS, "freebuff"];
export const MAX_WORKFLOW_STEPS = 20;
export const MAX_STEP_PROMPT = 4_000;
export const MAX_HANDOFF = 3_500;
export const MAX_WORKFLOW_GOAL = 2_000;
export const MAX_GATE_FEEDBACK = 2_000;
export const MAX_FREEBUFF_REPLY = 16_000;
export const MAX_STEP_INPUTS = 8;
export const MAX_GATE_REVISIONS = 5;
export const MIN_STEP_TIMEOUT_MS = 30_000;
export const MAX_STEP_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_STEP_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_GATE_REVISIONS = 2;

const MAX_ID = 64;
const MAX_NAME = 80;
const MAX_DESCRIPTION = 400;
const MAX_TITLE = 80;
const MAX_MODEL = 200;
const MAX_EFFORT = 40;
const MAX_OUTPUT = 60;
const WORKFLOW_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

const AGENT_KEYS = [
  "id", "kind", "title", "providerId", "model", "effort", "mode", "edit", "prompt", "inputs", "output", "timeoutMs",
] as const;
const GATE_KEYS = ["id", "kind", "title", "feedbackStepId", "judgeStepId", "maxRevisions"] as const;

function fail(message: string): never {
  throw new Error(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

/** Workflow JSON is data. Anything outside the published fields is refused. */
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${label} contains an unsupported field "${key}".`);
  }
}

function text(value: unknown, label: string, limit: number, required = false) {
  if (value === undefined || value === null) {
    if (required) fail(`${label} is required.`);
    return "";
  }
  if (typeof value !== "string") fail(`${label} must be text.`);
  const trimmed = value.trim();
  if (required && !trimmed) fail(`${label} is required.`);
  if (value.includes("\0")) fail(`${label} contains an unsupported character.`);
  if (trimmed.length > limit) fail(`${label} must be ${limit} characters or fewer.`);
  return trimmed;
}

function providerId(value: unknown, label: string): WorkflowProviderId {
  const id = WORKFLOW_PROVIDERS.find((entry) => entry === value);
  if (!id) fail(`${label} must use a supported workflow connector.`);
  return id;
}

export function isWorkflowId(value: unknown): value is string {
  return typeof value === "string" && WORKFLOW_ID.test(value);
}

/** A blank model keeps the connector default, so only the field shape is checked. */
export function validateWorkflow(value: unknown): WorkflowDefinition {
  const root = record(value, "The workflow");
  onlyKeys(root, ["id", "name", "description", "steps"], "The workflow");
  const id = text(root.id, "Workflow id", MAX_ID, true);
  if (!WORKFLOW_ID.test(id)) fail("Workflow ids use lowercase letters, numbers and dashes.");
  const name = text(root.name, "Workflow name", MAX_NAME, true);
  const description = text(root.description, "Workflow description", MAX_DESCRIPTION);
  if (!Array.isArray(root.steps) || !root.steps.length) fail("A workflow needs at least one step.");
  if (root.steps.length > MAX_WORKFLOW_STEPS) fail(`A workflow can have at most ${MAX_WORKFLOW_STEPS} steps.`);

  const steps: WorkflowStep[] = [];
  const seen = new Set<string>();
  let agents = 0;
  for (const [index, raw] of root.steps.entries()) {
    const label = `Step ${index + 1}`;
    const step = record(raw, label);
    if (step.kind !== "agent" && step.kind !== "gate") fail(`${label} must be an agent step or a review gate.`);
    onlyKeys(step, step.kind === "agent" ? AGENT_KEYS : GATE_KEYS, label);
    const id = text(step.id, `${label} id`, MAX_ID, true);
    if (!WORKFLOW_ID.test(id)) fail(`${label} id uses lowercase letters, numbers and dashes.`);
    if (seen.has(id)) fail(`${label} reuses the id "${id}".`);
    const title = text(step.title, `${label} title`, MAX_TITLE, true);

    if (step.kind === "agent") {
      const provider = providerId(step.providerId, label);
      const mode = step.mode ?? (provider === "freebuff" ? "chat" : "code");
      if (mode !== "code" && mode !== "chat") fail(`${label} must use Code or Chat.`);
      const edit = step.edit === true;
      const model = text(step.model, `${label} model`, MAX_MODEL);
      const effort = text(step.effort, `${label} effort`, MAX_EFFORT);
      if (step.edit !== undefined && typeof step.edit !== "boolean") fail(`${label} edit must be true or false.`);
      if (edit && mode !== "code") fail(`${label} can only edit in Code mode.`);
      if (edit && !supportsWorktreeEditing(provider)) fail(`${label} uses a connector that cannot edit in a worktree.`);
      if (provider === "freebuff" && (mode !== "chat" || model || effort)) {
        fail(`${label} must use Chat for Freebuff. Choose its model and effort in Freebuff.`);
      }
      const rawInputs = step.inputs ?? [];
      if (!Array.isArray(rawInputs)) fail(`${label} inputs must be a list of earlier steps.`);
      if (rawInputs.length > MAX_STEP_INPUTS) fail(`${label} can take at most ${MAX_STEP_INPUTS} inputs.`);
      const inputs: string[] = [];
      for (const input of rawInputs) {
        if (typeof input !== "string" || !seen.has(input)) fail(`${label} can only take results from earlier steps.`);
        if (!inputs.includes(input)) inputs.push(input);
      }
      const timeoutMs = step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
      if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) ||
          timeoutMs < MIN_STEP_TIMEOUT_MS || timeoutMs > MAX_STEP_TIMEOUT_MS) {
        fail(`${label} timeout must be between 30 seconds and 30 minutes.`);
      }
      steps.push({
        id,
        kind: "agent",
        title,
        providerId: provider,
        model,
        effort,
        mode,
        edit,
        prompt: text(step.prompt, `${label} prompt`, MAX_STEP_PROMPT, true),
        inputs,
        output: text(step.output, `${label} output`, MAX_OUTPUT),
        timeoutMs,
      });
      agents++;
    } else {
      const feedbackStepId = text(step.feedbackStepId, `${label} feedback step`, MAX_ID, true);
      if (!seen.has(feedbackStepId)) fail(`${label} must send feedback to an earlier step.`);
      if (!steps.some((entry) => entry.id === feedbackStepId && entry.kind === "agent")) {
        fail(`${label} must send feedback to an earlier agent step.`);
      }
      const judgeStepId = text(step.judgeStepId, `${label} judge step`, MAX_ID);
      if (judgeStepId) {
        const judge = steps.at(-1);
        if (judge?.kind !== "agent" || judge.id !== judgeStepId || judge.providerId === "freebuff" || judge.edit) {
          fail(`${label} must follow a judging agent that runs automatically and cannot edit.`);
        }
        if (!judge.inputs.includes(feedbackStepId)) fail(`${label} requires the judge to take the worker's result as input.`);
        const workerIndex = steps.findIndex((entry) => entry.id === feedbackStepId);
        if (steps.slice(workerIndex).some((entry) => entry.kind === "gate")) {
          fail(`${label} cannot loop back across another review gate.`);
        }
      }
      const maxRevisions = step.maxRevisions ?? DEFAULT_GATE_REVISIONS;
      if (typeof maxRevisions !== "number" || !Number.isInteger(maxRevisions) ||
          maxRevisions < 0 || maxRevisions > MAX_GATE_REVISIONS) {
        fail(`${label} can allow at most ${MAX_GATE_REVISIONS} revisions.`);
      }
      steps.push({ id, kind: "gate", title, feedbackStepId, ...(judgeStepId ? { judgeStepId } : {}), maxRevisions });
    }
    seen.add(id);
  }
  if (!agents) fail("A workflow needs at least one agent step.");
  return { id, name, description, steps };
}

export function cloneWorkflow(workflow: WorkflowDefinition): WorkflowDefinition {
  return JSON.parse(JSON.stringify(workflow)) as WorkflowDefinition;
}

export function workflowRequiresProject(workflow: WorkflowDefinition) {
  return workflow.steps.some((step) => step.kind === "agent" && step.mode === "code");
}

export function resolveWorkflowCommand<T extends WorkflowDefinition>(argument: string, workflows: readonly T[]) {
  const input = argument.trim();
  if (!input) throw new Error("Use /workflow <name> <prompt> to run a saved workflow.");
  function normalize(name: string) {
    return name.trim().replace(/\s+/g, " ").toLowerCase();
  }
  function matches(name: string) {
    const key = normalize(name);
    const exact = workflows.find((workflow) => workflow.id === key);
    return exact ? [exact] : workflows.filter((workflow) => normalize(workflow.name) === key);
  }

  let candidates: T[] = [];
  let end = 0;
  if (input.startsWith('"')) {
    const quoted = /^"([^"]+)"(?=\s|$)/.exec(input);
    if (!quoted?.[1]) throw new Error("Close the quotes around the workflow name.");
    candidates = matches(quoted[1]);
    end = quoted[0].length;
  } else {
    // Try each word boundary so names with spaces can be used without quotes.
    for (const boundary of input.matchAll(/\s+|$/g)) {
      const endOfName = boundary.index;
      const name = input.slice(0, endOfName);
      if (normalize(name).length > MAX_NAME) break;
      const found = matches(name);
      if (!found.length) continue;
      candidates = found;
      end = endOfName;
    }
  }
  if (!candidates.length) throw new Error("No saved workflow matches that name. Use the workflow name or ID from Workflows.");
  if (candidates.length > 1) throw new Error(`More than one workflow has that name. Use its ID: ${candidates.map((workflow) => workflow.id).join(", ")}.`);
  const goal = text(input.slice(end), "Workflow prompt", MAX_WORKFLOW_GOAL, true);
  return { workflow: candidates[0]!, goal };
}

export function addRunUsage(previous: RunUsage | undefined, next: RunUsage = {}): RunUsage {
  const usage = { ...previous };
  for (const field of ["inputTokens", "outputTokens", "cachedTokens", "costUsd"] as const) {
    const value = next[field];
    if (typeof value === "number" && Number.isFinite(value)) usage[field] = (usage[field] ?? 0) + value;
  }
  return usage;
}

export function boundedText(value: string, limit: number) {
  const trimmed = value.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, Math.max(0, limit - 1)).trimEnd()}…` : trimmed;
}

/** A short, read-only description of what a step produced. */
export interface WorkflowStepResult {
  stepId: string;
  title: string;
  output: string;
  status: string;
  summary: string;
}

export function runSummary(run: Run, limit = 1_200) {
  const messages = run.events.map((event) => (event.type === "message" ? event.text : "")).filter(Boolean);
  const errors = run.events.map((event) => (event.type === "error" ? event.text : "")).filter(Boolean);
  const text = (messages.length ? messages.join("\n\n") : errors.join("\n\n")).trim();
  return boundedText(text || `${run.providerName} finished with status ${run.status}.`, limit);
}

/**
 * Builds a step prompt from its own text plus bounded earlier results and gate feedback.
 * Feedback sits before the results so a long handoff never pushes it out of the prompt.
 */
export function workflowStepPrompt(
  step: WorkflowAgentStep,
  results: readonly WorkflowStepResult[] = [],
  feedback?: string,
  goal?: string,
) {
  const sections = [step.prompt];
  if (goal) sections.push(`User's workflow prompt:\n${goal}`);
  const feedbackText = feedback ? boundedText(feedback, Math.floor(MAX_HANDOFF / 3)) : "";
  if (feedbackText) sections.push(`Feedback from the review gate:\n${feedbackText}`);
  if (results.length) {
    const share = Math.max(200, Math.floor((MAX_HANDOFF - feedbackText.length) / results.length));
    const lines = ["Earlier step results:"];
    for (const result of results) {
      lines.push(`### ${result.title}${result.output ? ` (${result.output})` : ""} — ${result.status}`);
      lines.push(boundedText(result.summary, share) || "No result text was recorded.");
    }
    sections.push(lines.join("\n"));
  }
  return boundedText(sections.join("\n\n"), MAX_STEP_PROMPT + MAX_HANDOFF);
}
