import type {
  CliProviderId, Run, WorkflowAgentStep, WorkflowDefinition, WorkflowGateStep, WorkflowStep,
} from "./contracts.js";
import { supportsWorktreeEditing } from "./editing.js";

export const WORKFLOW_PROVIDERS: readonly CliProviderId[] = ["codex", "opencode", "claude"];
export const MAX_WORKFLOW_STEPS = 20;
export const MAX_STEP_PROMPT = 4_000;
export const MAX_HANDOFF = 3_500;
export const MAX_GATE_FEEDBACK = 2_000;
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
const GATE_KEYS = ["id", "kind", "title", "feedbackStepId", "maxRevisions"] as const;

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

function providerId(value: unknown, label: string): CliProviderId {
  const id = WORKFLOW_PROVIDERS.find((entry) => entry === value);
  if (!id) fail(`${label} must use Codex, OpenCode or Claude Code.`);
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
      const mode = step.mode ?? "code";
      if (mode !== "code" && mode !== "chat") fail(`${label} must use Code or Chat.`);
      const edit = step.edit === true;
      if (step.edit !== undefined && typeof step.edit !== "boolean") fail(`${label} edit must be true or false.`);
      if (edit && mode !== "code") fail(`${label} can only edit in Code mode.`);
      if (edit && !supportsWorktreeEditing(provider)) fail(`${label} uses a connector that cannot edit in a worktree.`);
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
        model: text(step.model, `${label} model`, MAX_MODEL),
        effort: text(step.effort, `${label} effort`, MAX_EFFORT),
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
      const maxRevisions = step.maxRevisions ?? DEFAULT_GATE_REVISIONS;
      if (typeof maxRevisions !== "number" || !Number.isInteger(maxRevisions) ||
          maxRevisions < 0 || maxRevisions > MAX_GATE_REVISIONS) {
        fail(`${label} can allow at most ${MAX_GATE_REVISIONS} revisions.`);
      }
      steps.push({ id, kind: "gate", title, feedbackStepId, maxRevisions });
    }
    seen.add(id);
  }
  if (!agents) fail("A workflow needs at least one agent step.");
  return { id, name, description, steps };
}

export function cloneWorkflow(workflow: WorkflowDefinition): WorkflowDefinition {
  return JSON.parse(JSON.stringify(workflow)) as WorkflowDefinition;
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
) {
  const sections = [step.prompt];
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
