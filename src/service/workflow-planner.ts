import { randomUUID } from "node:crypto";
import type { CliProviderId, Run, WorkflowDefinition, WorkflowPlanReply } from "../shared/contracts.js";
import { asRecord } from "../shared/records.js";
import { boundedText, runSummary, validateWorkflow } from "../shared/workflows.js";

export const MAX_PLAN_GOAL = 2_000;
export type PlannerCatalog = ReadonlyMap<CliProviderId, readonly string[]>;

export function workflowPlanPrompt(goal: string, models: PlannerCatalog, previous?: WorkflowDefinition, history = "") {
  const available = [...models].map(([provider, ids]) => [
    provider, ids.filter((id) => id.length <= 80).slice(0, 4),
  ]);
  return [
    "Design a Honeycomb workflow that accomplishes the user's goal with the fewest useful subagents. You are drafting a plan only.",
    "Respond with one JSON object with exactly two fields: reply (a short explanation or clarifying question) and workflow (an object or null). Use null only when an answer is required before you can draft a safe, useful plan.",
    'The workflow object contains "name" (80 characters max), "description" (400 max), and "steps" (up to 20, ordered). Every id in a step must be unique and contain lowercase letters, digits, and dashes.',
    'A subagent step has {"id":"review","kind":"agent","title":"Reviewer","providerId":"codex","model":"","mode":"code","edit":false,"prompt":"Describe the task","inputs":[]}. Choose only listed connectors and model IDs. An empty model uses the connector default. Use "chat" for a project-free subagent.',
    'A human gate is {"id":"approve","kind":"gate","title":"Approve plan","feedbackStepId":"review","maxRevisions":2}. Gates can send feedback only to an earlier subagent. A subagent’s inputs must also be earlier subagent IDs.',
    "Use an edit step only when the goal requires changes. Give each subagent its own role, concrete output and acceptance criteria. Add a human review gate when it would improve the result. Use regular JSON and omit any other fields.",
    `Available connectors and example model IDs (each also has a default): ${JSON.stringify(available)}`,
    ...(history ? [`Earlier discussion:\n${boundedText(history, 700)}`] : []),
    ...(previous ? [`Earlier draft for revision:\n${boundedText(JSON.stringify(previous), 2_000)}`] : []),
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
    const available = models.get(step.providerId);
    if (!available || (step.model && !available.includes(step.model))) {
      throw new Error(`The planner chose an unavailable connector or model for “${step.title}”. Ask it to use an available model.`);
    }
    if (step.inputs.some((id) => !agents.has(id))) throw new Error(`“${step.title}” needs to take results from earlier subagents.`);
    agents.add(step.id);
  }
  return { reply, workflow, usage: run.usage };
}
