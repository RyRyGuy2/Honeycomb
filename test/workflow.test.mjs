import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkflowRunner } from "../dist/service/workflow-runner.js";
import { workflowPlanPrompt, workflowPlanReply } from "../dist/service/workflow-planner.js";
import { createWorkflowRunStore } from "../dist/service/workflow-runs.js";
import { createWorkflowStore } from "../dist/service/workflows.js";
import {
  MAX_HANDOFF, MAX_STEP_PROMPT, resolveWorkflowCommand, runSummary, validateWorkflow, workflowStepPrompt,
} from "../dist/shared/workflows.js";

const project = { name: "Example", path: process.cwd() };
const worktree = { id: "worktree-1", branch: "honeycomb/edit-1", path: "/tmp/example", baseCommit: "abcdef1234", state: "active" };

function agent(overrides = {}) {
  return {
    id: "plan", kind: "agent", title: "Plan", providerId: "codex", model: "", effort: "", mode: "code",
    edit: false, prompt: "Plan the work.", inputs: [], output: "plan", timeoutMs: 300_000, ...overrides,
  };
}

function gate(overrides = {}) {
  return { id: "review", kind: "gate", title: "Review plan", feedbackStepId: "plan", maxRevisions: 1, ...overrides };
}

function workflow(overrides = {}) {
  return { id: "plan-and-build", name: "Plan and build", description: "", steps: [agent(), gate()], ...overrides };
}

function fakeRuns() {
  const records = new Map();
  const waiting = new Map();
  const requests = [];
  let counter = 0;
  return {
    requests,
    start(folder, request) {
      const id = `run-${++counter}`;
      requests.push({ id, folder, request });
      records.set(id, {
        id, providerId: request.providerId, providerName: request.providerId, prompt: request.prompt,
        startedAt: new Date().toISOString(), status: "running", events: [], usage: {}, revision: 1,
      });
      return id;
    },
    stop(runId) {
      const run = records.get(runId);
      if (!run) return;
      run.status = "cancelled";
      const resolve = waiting.get(runId);
      waiting.delete(runId);
      resolve?.(run);
    },
    runById(runId) {
      return records.get(runId);
    },
    waitForRun(runId) {
      const run = records.get(runId);
      if (!run) return Promise.reject(new Error("missing run"));
      if (run.status !== "running" && run.status !== "stopping") return Promise.resolve(run);
      return new Promise((resolve) => waiting.set(runId, resolve));
    },
    hasActiveRun() {
      return [...records.values()].some((run) => run.status === "running" || run.status === "stopping");
    },
    finish(runId, status, options = {}) {
      const run = records.get(runId);
      assert.ok(run, `run ${runId} exists`);
      run.status = status;
      if (options.usage) run.usage = options.usage;
      if (options.worktree) run.worktree = { ...options.worktree };
      if (options.message) {
        run.events.push({
          type: "message", text: options.message, runId: run.id, sequence: run.events.length + 1, at: new Date().toISOString(),
        });
      }
      const resolve = waiting.get(runId);
      waiting.delete(runId);
      resolve?.(run);
      return run;
    },
  };
}

async function until(check, label = "condition") {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

test("validation keeps a blank model and trims the definition", () => {
  const parsed = validateWorkflow(workflow());
  assert.equal(parsed.steps[0].model, "");
  assert.equal(parsed.steps[0].effort, "");
  assert.equal(parsed.steps[0].inputs.length, 0);
  assert.equal(parsed.steps[1].maxRevisions, 1);
  assert.deepEqual(validateWorkflow({ ...workflow(), name: "  Spaced  " }).name, "Spaced");
});

test("the workflow planner validates available models and keeps the draft identity on revision", () => {
  const catalogs = new Map([["codex", ["gpt-example"]]]);
  const definition = { name: "Review docs", steps: [agent({ model: "gpt-example" }), gate()] };
  const usage = { inputTokens: 103, outputTokens: 72 };
  function reply(workflow) {
    const body = JSON.stringify({ reply: "Drafted a review workflow.", workflow });
    return { status: "completed", usage, events: [{ type: "message", text: "```json\n" + body + "\n```" }] };
  }
  const first = workflowPlanReply(reply(definition), catalogs);
  assert.equal(first.workflow.steps[0].model, "gpt-example");
  assert.deepEqual(first.usage, usage);
  assert.equal(workflowPlanReply(reply(definition), catalogs, first.workflow).workflow.id, first.workflow.id);
  assert.equal(workflowPlanReply(reply(null), catalogs).workflow, undefined);
  assert.throws(() => workflowPlanReply(reply({ ...definition, steps: [agent({ model: "invented-model" })] }), catalogs),
    /unavailable connector or model/);
  const prompt = workflowPlanPrompt("x".repeat(2_000), catalogs, first.workflow, "Earlier decision");
  assert.ok(prompt.length < 8_000);
  assert.match(prompt, /gpt-example/);
  assert.match(prompt, /Earlier decision/);
});

test("validation refuses fields that would turn a definition into a program", () => {
  assert.throws(() => validateWorkflow(workflow({ env: { TOKEN: "x" } })), /unsupported field "env"/);
  for (const extra of [
    { env: { SECRET: "x" } }, { executable: "rm" }, { command: "rm -rf" }, { apiKey: "x" }, { cwd: "/tmp" },
  ]) {
    assert.throws(() => validateWorkflow(workflow({ steps: [agent(extra)] })), /unsupported field/);
  }
  assert.throws(() => validateWorkflow(workflow({ steps: [agent({ shell: "rm -rf /" })] })), /unsupported field "shell"/);
});

test("validation enforces connectors, ordering and limits", () => {
  assert.throws(() => validateWorkflow(workflow({ steps: [agent({ providerId: "gemini" })] })), /Codex, OpenCode or Claude Code/);
  assert.equal(validateWorkflow(workflow({ steps: [agent({ edit: true, providerId: "opencode" })] })).steps[0].edit, true);
  assert.throws(() => validateWorkflow(workflow({ steps: [agent({ mode: "chat", edit: true })] })), /only edit in Code/);
  assert.throws(() => validateWorkflow(workflow({ steps: [gate({ feedbackStepId: "missing" })] })), /earlier step/);
  assert.throws(
    () => validateWorkflow(workflow({ steps: [agent({ inputs: ["review"] }), gate()] })),
    /earlier steps/,
  );
  assert.throws(() => validateWorkflow(workflow({ steps: [agent(), agent()] })), /reuses the id/);
  assert.throws(() => validateWorkflow(workflow({ steps: [agent({ id: "a", inputs: ["a"] })] })), /earlier steps/);
  assert.throws(() => validateWorkflow(workflow({ steps: [agent({ prompt: "x".repeat(MAX_STEP_PROMPT + 1) })] })), /characters or fewer/);
  assert.throws(() => validateWorkflow(workflow({ steps: [agent({ timeoutMs: 1_000 })] })), /30 seconds and 30 minutes/);
  assert.throws(() => validateWorkflow(workflow({ steps: [agent()], id: "../escape" })), /lowercase letters/);
});

test("handoff text is bounded and keeps gate feedback", () => {
  const results = Array.from({ length: 6 }, (_, index) => ({
    stepId: `step-${index}`, title: `Step ${index}`, output: "", status: "completed",
    summary: `result ${index} `.repeat(2_000),
  }));
  const feedback = "Tighten the migration plan. ".repeat(80);
  const prompt = workflowStepPrompt(agent({ prompt: "Plan it." }), results, feedback);
  assert.ok(prompt.length <= MAX_STEP_PROMPT + MAX_HANDOFF, `prompt was ${prompt.length}`);
  assert.match(prompt, /Feedback from the review gate:/);
  assert.match(prompt, /Tighten the migration plan/);
  assert.match(prompt, /Earlier step results:/);
  const bare = workflowStepPrompt(agent({ prompt: "Only the step." }));
  assert.equal(bare, "Only the step.");
  assert.equal(runSummary({ providerName: "Codex", status: "completed", events: [{ type: "message", text: "  the answer  " }] }), "the answer");
});

test("definitions save in the app workflow library without a project", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "honeycomb-workflows-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createWorkflowStore(() => directory);
  assert.deepEqual(await store.list(), []);

  const saved = await store.save(workflow());
  assert.equal(saved.name, "Plan and build");
  const file = join(directory, "workflows", "plan-and-build.json");
  const written = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(written, validateWorkflow(workflow()));
  assert.equal((await store.list()).length, 1);

  await writeFile(join(directory, "workflows", "broken.json"), "{}", "utf8");
  assert.equal((await store.list()).length, 1);
  await assert.rejects(store.remove("../plan-and-build"), /Invalid workflow/);
  assert.equal(await store.remove("plan-and-build"), true);
  assert.equal(await store.remove("plan-and-build"), false);
  assert.deepEqual(await store.list(), []);
  await assert.rejects(store.save(workflow({ steps: [agent({ command: "x" })] })), /unsupported field/);
});

test("the app imports project workflows once and keeps the original project files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "honeycomb-workflow-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const source = join(projectRoot, ".honeycomb", "workflows");
  await mkdir(source, { recursive: true });
  const file = join(source, "plan-and-build.json");
  const original = JSON.stringify(workflow());
  await writeFile(file, original, "utf8");
  const store = createWorkflowStore(() => join(root, "app"));
  await store.importLegacy([projectRoot]);
  assert.deepEqual((await store.list()).map((entry) => entry.id), ["plan-and-build"]);
  assert.equal(await readFile(file, "utf8"), original);
  await store.remove("plan-and-build");
  await store.importLegacy([projectRoot]);
  assert.deepEqual(await store.list(), []);
});

test("workflow commands resolve names and IDs and require a prompt", () => {
  const review = workflow({ id: "review", name: "Review" });
  const detailed = workflow({ id: "review-changes", name: "Review Changes" });
  assert.deepEqual(resolveWorkflowCommand("review CHANGES Check the importer", [review, detailed]), {
    workflow: detailed, goal: "Check the importer",
  });
  assert.equal(resolveWorkflowCommand('"Review" Changes matter', [review, detailed]).workflow, review);
  assert.equal(resolveWorkflowCommand("review-changes Check the importer", [review, detailed]).workflow, detailed);
  assert.throws(() => resolveWorkflowCommand("Review Changes", [review, detailed]), /Workflow prompt is required/);
  assert.throws(() => resolveWorkflowCommand("Unknown goal", [review, detailed]), /No saved workflow/);
  assert.throws(() => resolveWorkflowCommand("Same name goal", [
    { ...review, name: "Same name" }, { ...detailed, name: "Same name" },
  ]), /Use its ID/);
});

test("a Chat workflow runs without a project and gives the prompt to every subagent", async () => {
  const runs = fakeRuns();
  const runner = createWorkflowRunner({ runs });
  const definition = validateWorkflow(workflow({ steps: [
    agent({ mode: "chat" }),
    agent({ id: "check", mode: "chat", inputs: ["plan"] }),
  ] }));
  assert.throws(() => runner.start(undefined, validateWorkflow(workflow())), /Choose a project/);
  const id = runner.start(undefined, definition, "Focus on migration.");
  await until(() => runs.requests.length === 1);
  assert.equal(runs.requests[0].folder, undefined);
  assert.match(runs.requests[0].request.prompt, /User's workflow prompt:\nFocus on migration\./);
  runs.finish(runs.requests[0].id, "completed", { message: "Migration plan" });
  await until(() => runs.requests.length === 2);
  assert.match(runs.requests[1].request.prompt, /Focus on migration[\s\S]*Migration plan/);
  runs.finish(runs.requests[1].id, "completed");
  await until(() => runner.find(id).status === "completed");
  assert.equal(runner.find(id).goal, "Focus on migration.");
});

test("workflow run records round-trip through the userData store", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "honeycomb-workflow-runs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createWorkflowRunStore(() => join(directory, "workflow-runs.json"));
  const record = {
    id: "workflow-run-1", workflowId: "plan-and-build", workflowName: "Plan and build",
    definition: validateWorkflow(workflow()), folder: project, status: "completed",
    startedAt: "2026-01-01T00:00:00.000Z", currentIndex: 2, revision: 4,
    steps: [{ stepId: "plan", status: "completed" }, { stepId: "review", status: "completed" }],
  };
  assert.deepEqual(await store.load(), []);
  assert.equal(await store.save([record]), true);
  assert.deepEqual((await store.load()).map((run) => run.id), ["workflow-run-1"]);
  assert.equal(await store.save([{ ...record, folder: undefined, goal: "Review migration" }]), true);
  assert.equal((await store.load())[0].goal, "Review migration");
  await writeFile(join(directory, "workflow-runs.json"), "not json", "utf8");
  assert.deepEqual(await store.load(), []);
});

test("runner runs steps in order and hands results to the next step", async () => {
  const runs = fakeRuns();
  const runner = createWorkflowRunner({ runs });
  const id = runner.start(project, validateWorkflow(workflow({ steps: [agent(), gate()] })));
  const record = runner.find(id);
  assert.equal(record.status, "running");

  await until(() => runs.requests.length === 1, "the first step");
  const first = runs.requests[0];
  assert.equal(first.request.providerId, "codex");
  assert.equal(first.request.modelOverride, "");
  assert.equal(first.request.workflowRunId, id);
  assert.equal(first.request.edit, undefined);
  assert.equal(first.request.prompt, "Plan the work.");

  runs.finish(first.id, "completed", { message: "The plan is to add a migration." });
  await until(() => record.status === "waiting", "the review gate");
  assert.equal(record.steps[0].status, "completed");
  assert.equal(record.steps[1].status, "waiting");

  runner.decide({ runId: id, decision: "approved" });
  await until(() => record.status === "completed", "completion");
  assert.equal(record.currentIndex, 2);
});

test("rejection sends bounded feedback to the named earlier step", async () => {
  const runs = fakeRuns();
  const runner = createWorkflowRunner({ runs });
  const id = runner.start(project, validateWorkflow(workflow()));
  await until(() => runs.requests.length === 1);
  runs.finish(runs.requests[0].id, "completed", { message: "First plan.", usage: { inputTokens: 12, outputTokens: 6 } });
  await until(() => runner.find(id).status === "waiting");

  assert.throws(() => runner.decide({ runId: id, decision: "rejected" }), /Describe what should change/);
  assert.throws(() => runner.decide({ runId: "missing", decision: "approved" }), /no longer recorded/);

  runner.decide({ runId: id, decision: "rejected", feedback: "Split the migration into two steps." });
  await until(() => runs.requests.length === 2, "the re-run");
  assert.equal(runs.requests[1].request.prompt,
    "Plan the work.\n\nFeedback from the review gate:\nSplit the migration into two steps.");

  runs.finish(runs.requests[1].id, "completed", { message: "Second plan.", usage: { inputTokens: 18, outputTokens: 9 } });
  await until(() => runner.find(id).status === "waiting");
  runner.decide({ runId: id, decision: "rejected", feedback: "Still wrong." });
  await until(() => runner.find(id).status === "failed", "the revision limit");
  const record = runner.find(id);
  assert.match(record.error, /Revision limit reached/);
  assert.equal(record.steps[0].status, "completed");
  assert.equal(record.steps[1].status, "failed");
  assert.equal(record.steps[1].revisions, 2);
  assert.deepEqual(record.usage, { inputTokens: 30, outputTokens: 15 });
  assert.deepEqual(record.steps[0].usage, record.usage);
});

test("an edit step creates one worktree and later steps reuse it", async () => {
  const runs = fakeRuns();
  const runner = createWorkflowRunner({ runs });
  const definition = validateWorkflow(workflow({
    steps: [
      agent({ id: "plan", title: "Plan" }),
      gate({ feedbackStepId: "plan" }),
      agent({
        id: "build", title: "Build", providerId: "claude", model: "sonnet", edit: true,
        prompt: "Build it.", inputs: ["plan"],
      }),
      agent({ id: "polish", title: "Polish", providerId: "codex", prompt: "Polish it.", inputs: ["build"] }),
    ],
  }));
  const id = runner.start(project, definition);

  await until(() => runs.requests.length === 1);
  runs.finish(runs.requests[0].id, "completed", { message: "Plan ready." });
  await until(() => runner.find(id).status === "waiting");
  runner.decide({ runId: id, decision: "approved" });

  await until(() => runs.requests.length === 2, "the build step");
  const build = runs.requests[1].request;
  assert.equal(build.providerId, "claude");
  assert.equal(build.modelOverride, "sonnet");
  assert.equal(build.edit, true);
  assert.equal(build.worktreeId, undefined);
  assert.match(build.prompt, /Plan ready/);

  runs.finish(runs.requests[1].id, "completed", { worktree, message: "Built." });
  await until(() => runs.requests.length === 3, "the polish step");
  const polish = runs.requests[2].request;
  assert.equal(polish.worktreeId, worktree.id);
  assert.equal(polish.edit, undefined);
  assert.equal(polish.modelOverride, "");
  assert.match(polish.prompt, /Built/);
  assert.equal(runner.find(id).worktree.id, worktree.id);

  runs.finish(runs.requests[2].id, "completed");
  await until(() => runner.find(id).status === "completed");
});

test("stopping a waiting gate cancels the workflow", async () => {
  const runs = fakeRuns();
  const runner = createWorkflowRunner({ runs });
  const id = runner.start(project, validateWorkflow(workflow()));
  await until(() => runs.requests.length === 1);
  runs.finish(runs.requests[0].id, "completed");
  await until(() => runner.find(id).status === "waiting");

  await runner.stop(id);
  const record = runner.find(id);
  assert.equal(record.status, "cancelled");
  assert.equal(record.steps[1].status, "cancelled");
  assert.ok(record.finishedAt);
  assert.equal(runner.hasActiveRun(), false);
});

test("stopping a running step cancels the workflow and the step", async () => {
  const runs = fakeRuns();
  const runner = createWorkflowRunner({ runs });
  const id = runner.start(project, validateWorkflow(workflow()));
  await until(() => runs.requests.length === 1);

  await runner.stop(id);
  const record = runner.find(id);
  assert.equal(record.status, "cancelled");
  assert.equal(record.steps[0].status, "cancelled");
});

test("a failed step stops the workflow and records the reason", async () => {
  const runs = fakeRuns();
  const runner = createWorkflowRunner({ runs });
  const id = runner.start(project, validateWorkflow(workflow()));
  await until(() => runs.requests.length === 1);
  runs.finish(runs.requests[0].id, "failed", { message: "The connector crashed." });
  await until(() => runner.find(id).status === "failed");

  const record = runner.find(id);
  assert.equal(record.steps[0].status, "failed");
  assert.match(record.error, /Plan/);
  assert.match(record.steps[0].detail, /connector crashed/);
  assert.equal(runner.hasActiveRun(), false);
});

test("a start failure fails the step without starting another", async () => {
  const runs = fakeRuns();
  runs.start = () => { throw new Error("The workflow worktree is no longer available."); };
  const runner = createWorkflowRunner({ runs });
  const id = runner.start(project, validateWorkflow(workflow()));
  await until(() => runner.find(id).status === "failed");
  assert.match(runner.find(id).error, /worktree is no longer available/);
});

test("one workflow runs at a time and restored records are interrupted", async () => {
  const runs = fakeRuns();
  const runner = createWorkflowRunner({ runs });
  const id = runner.start(project, validateWorkflow(workflow()));
  assert.throws(() => runner.start(project, validateWorkflow(workflow({ id: "second" }))), /running workflow/);
  await until(() => runs.requests.length === 1);
  await runner.stop(id);

  const saved = {
    ...runner.find(id),
    status: "running",
    finishedAt: undefined,
    steps: [{ stepId: "plan", status: "running" }, { stepId: "review", status: "pending" }],
  };
  const reopened = createWorkflowRunner({ runs: fakeRuns() });
  reopened.restore([saved]);
  const [restored] = reopened.history();
  assert.equal(restored.status, "interrupted");
  assert.equal(restored.steps[0].status, "cancelled");
  assert.match(restored.error, /closed before the workflow finished/);
  assert.equal(reopened.hasActiveRun(), false);
});
