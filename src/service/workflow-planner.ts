import { randomUUID } from "node:crypto";
import type { ModelCatalog, Run, WorkflowDefinition, WorkflowPlanReply, WorkflowProviderId } from "../shared/contracts.js";
import { asRecord } from "../shared/records.js";
import { MAX_GATE_REVISIONS, boundedText, runSummary, validateWorkflow } from "../shared/workflows.js";

export const MAX_PLAN_GOAL = 2_000;
export const MAX_PLAN_PROMPT = 512_000;
export type PlannerCatalog = ReadonlyMap<WorkflowProviderId, {
  models: readonly Pick<ModelCatalog["models"][number], "id" | "efforts">[];
  defaultEfforts?: readonly string[];
}>;

export function workflowPlanPrompt(goal: string, models: PlannerCatalog, previous?: WorkflowDefinition, history = "") {
  const available = Object.fromEntries([...models].map(([provider, catalog]) => [provider, {
    models: catalog.models.map(({ id, efforts }) => efforts?.length ? { id, efforts } : id),
    defaultEfforts: catalog.defaultEfforts,
  }]));
  return [
    "Design a Honeycomb workflow that accomplishes the user's goal with the fewest useful subagents. You are drafting a plan only.",
    "Respond with one JSON object with exactly two fields: reply (a short explanation or clarifying question) and workflow (an object or null). Use null for informational questions that do not request a draft change, or when clarification is needed before you can draft a safe, useful plan.",
    'The workflow object contains "name" (80 characters max), "description" (400 max), and "steps" (up to 20, ordered). Every id in a step must be unique and contain lowercase letters, digits, and dashes.',
    'A subagent step has {"id":"review","kind":"agent","title":"Reviewer","providerId":"codex","model":"","effort":"","mode":"code","edit":false,"prompt":"Describe the task","inputs":[]}. Choose only listed connectors and exact model IDs. An empty model or effort uses the connector default. Use "chat" for a project-free subagent.',
    'Use the requested model and thinking effort when listed. Interpret "medium thinking" as "medium" and "extra high" as "xhigh". A model entry can list its supported efforts. The connector’s defaultEfforts apply to its default model and to entries without their own list. Missing effort metadata means support is unknown. If a requested choice is unavailable or its effort cannot be confirmed, explain it and ask before making that substitution. Preserve unrelated settings in follow-ups. Treat earlier planner replies as historical and use the current catalog to check availability.',
    'Freebuff is a manual subagent. Use it when the user asks for it. Set providerId to "freebuff", mode to "chat", edit to false, and leave model and effort blank. The user sends the copied prompt and pastes the reply into the workflow.',
    'A human gate is {"id":"approve","kind":"gate","title":"Approve plan","feedbackStepId":"review","maxRevisions":2}. Gates can send feedback only to an earlier subagent. A subagent’s inputs must also be earlier subagent IDs.',
    `For automatic judge-and-revise requests, use one worker, a non-editing judge that takes the worker as input, then a gate with judgeStepId set to the immediately preceding judge and feedbackStepId set to the worker. Honeycomb requests a structured verdict, continues on approval, or repeats the worker and judge with feedback before continuing. maxRevisions is a cap from 0 to ${MAX_GATE_REVISIONS}. Use the cap the user requests, or ${MAX_GATE_REVISIONS} when asked to repeat until approved without a stated cap. Explain the cap. Keep any final delivery step after the gate and give it the accepted worker result.`,
    "Match project access to the work. For implementing, fixing, or otherwise changing a project source tree, set the worker and any revision worker to mode code and edit true so they can edit in Honeycomb’s shared Git worktree. Set a judge that must inspect or verify those changes to mode code and edit false. A Chat step cannot see project files or the worktree. Use Chat for project-free planning or writing. Apply the same access rules when drafting a reusable coding workflow whose specific task will be supplied at runtime. When revising a draft for project work, correct any Chat steps that need project access. Respect explicit user restrictions on access.",
    "Give each subagent its own role, concrete output and acceptance criteria. Add a human review gate when it would improve the result. Use regular JSON and omit any other fields.",
    `Available connectors, model IDs and reported thinking efforts: ${JSON.stringify(available)}`,
    ...(history ? [`Earlier discussion:\n${boundedText(history, 700)}`] : []),
    ...(previous ? [`Earlier draft for revision:\n${JSON.stringify(previous)}`] : []),
    `User goal or follow-up:\n${goal}`,
  ].join("\n\n");
}

export function workflowPlanReply(run: Run, models: PlannerCatalog, previous?: WorkflowDefinition): WorkflowPlanReply {
  if (run.status !== "completed") throw new Error(runSummary(run));
  const text = run.events.flatMap((event) => event.type === "message" ? [event.text] : []).join("\n").trim();
  const json = /^\x60{3}(?:json)?\s*([\s\S]*?)\s*\x60{3}$/i.exec(text)?.[1] ?? text;
  let result;
  try {
    result = asRecord(JSON.parse(json));
  } catch {
    throw new Error("The planner returned an invalid draft. Ask it to try again.");
  }
  if (typeof result?.reply !== "string" || !result.reply.trim() || !Object.hasOwn(result, "workflow")) {
    throw new Error("The planner returned an incomplete draft. Ask it to try again.");
  }
  const reply = boundedText(result.reply, 4_000);
  if (result.workflow === null) return { reply, usage: run.usage };
  const fields = asRecord(result.workflow);
  if (!fields) throw new Error("The planner did not return a workflow.");
  const workflow = validateWorkflow({ ...fields, id: previous?.id ?? `workflow-${randomUUID()}` });
  const agents = new Set<string>();
  for (const step of workflow.steps) {
    if (step.kind !== "agent") continue;
    const catalog = models.get(step.providerId);
    const model = catalog?.models.find((entry) => entry.id === step.model);
    if (!catalog || (step.model && !model)) {
      throw new Error(`The planner chose an unavailable connector or model for “${step.title}”. Ask it to use an available model.`);
    }
    const efforts = model?.efforts ?? catalog.defaultEfforts;
    if (step.effort && efforts?.length && !efforts.includes(step.effort)) {
      throw new Error(`The planner chose an unsupported thinking effort for “${step.title}”.`);
    }
    if (step.inputs.some((id) => !agents.has(id))) throw new Error(`“${step.title}” needs to take results from earlier subagents.`);
    agents.add(step.id);
  }
  return { reply, workflow, usage: run.usage };
}
