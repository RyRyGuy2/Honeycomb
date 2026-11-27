import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { mergeOpenCodeModels } from "../dist/providers/opencode-models.js";
import { codexQuotaWindows, openCodeGoQuotaWindows, remainingPercent } from "../dist/service/connector-quota.js";
import { createModelSubmissionDetector } from "../dist/service/freebuff-session.js";
import { freebuffDirective, parseSmartSettings, smartCandidates } from "../dist/service/smart-routing.js";
import { createSmartWorkflows } from "../dist/service/smart-workflow.js";

const connector = (id, ...models) => ({
  connector: id, catalog: {
    selected: models[0],
    models: models.map((id) => ({ id, name: id, available: true, online: false, efforts: ["low", "medium", "high"] })),
  },
});
const catalog = [
  connector("opencode", "opencode-go/fast-flash"),
  connector("codex", "codex-max"),
  connector("freebuff", "Freebuff Pro"),
];
const task = (fields = {}) => ({
  action: "delegate", title: "Gather evidence", prompt: "Inspect the evidence", strength: "coding",
  mode: "chat", edit: false, model: "", effort: "", reason: "", inputs: [], ...fields,
});
const request = { goal: "Resolve the reported issue", access: "chat",
  orchestrator: { connector: "opencode", model: "opencode-go/fast-flash", effort: "" },
};

function state(fields = {}) {
  return { access: "chat", settings: parseSmartSettings(undefined), freebuffDirective: "default", ...fields };
}

function quota(id, remaining) {
  return { connector: id, status: "available", windows: [{
    id: id === "codex" ? "codex:primary" : "opencode-go:rolling",
    remaining, unit: "percent", resetsAt: Date.now() + 300_000,
  }] };
}

test("normalizes rate limits per window and keeps shared OpenCode quota scoped to Go models", () => {
  const window = { usedPercent: 32, windowDurationMins: 60, resetsAt: 1900000000 };
  assert.deepEqual(codexQuotaWindows({ rateLimits: { primary: window } }), [{
    id: "codex:primary", label: "Codex", remaining: 68, unit: "percent", durationMinutes: 60, resetsAt: 1900000000000,
  }]);
  const usage = {
    rolling: { status: "ok", percent: 10, resetsAt: "2030-01-01T12:00:00.000Z" },
    weekly: { status: "rate-limited", percent: 98, resetsAt: "2030-01-07T00:00:00.000Z" },
  };
  const snapshot = { connector: "opencode", status: "available", windows: openCodeGoQuotaWindows({ usage }) };
  const now = Date.parse("2030-01-01T00:00:00Z");
  assert.equal(remainingPercent(snapshot, "opencode-go/fast-flash", now), 0);
  assert.equal(remainingPercent(snapshot, "anthropic/sonnet", now), undefined);
  assert.equal(remainingPercent({ ...snapshot, status: "stale" }, "opencode-go/fast-flash", now), undefined);
});

test("prefers OpenCode when capable, escalates for deep reasoning, and keeps explicit exclusions", () => {
  assert.equal(smartCandidates(state(), catalog, task())[0].connector, "opencode");
  assert.equal(smartCandidates(state(), catalog, task({ strength: "deep" }))[0].connector, "codex");
  const exhausted = [{ ...catalog[0], quota: quota("opencode", 0) }, ...catalog.slice(1)];
  assert.equal(smartCandidates(state(), exhausted, task())[0].connector, "codex");
  assert.equal(freebuffDirective("Use a strong model, but NO Freebuff"), "exclude");
  assert.deepEqual(smartCandidates(state({ freebuffDirective: "exclude" }), exhausted, task()).map(({ connector }) => connector), ["codex"]);
  assert.equal(smartCandidates(state({ freebuffDirective: "request" }), catalog, task())[0].connector, "freebuff");
  assert.deepEqual(smartCandidates(state({ access: "review" }), catalog, task({ mode: "code", edit: true })), []);
  assert.deepEqual(smartCandidates(state({ access: "review" }), catalog.slice(2), task({ mode: "code" })), []);
});

test("copies the Freebuff prompt only on the Enter submitting /model", () => {
  const input = createModelSubmissionDetector();
  assert.equal(input("login", false), false);
  assert.equal(input("\r", true), false);
  assert.equal(input("\x1b[200~/model\x1b[201~", false), false);
  assert.equal(input("\r", true), true);
  assert.equal(input("/model", false), false);
  assert.equal(input("\r", true), false);
  const pasted = createModelSubmissionDetector();
  assert.equal(pasted("/model\r", false), false);
  assert.equal(pasted("\r", true), false);
});

test("prefers an advertised free model when capable and preserves stronger models for harder work", () => {
  const opencode = connector("opencode");
  opencode.catalog.models = mergeOpenCodeModels("opencode/fast-flash\nopencode/pro", { data: [
    { id: "fast-flash", cost: { text: { input: { price: 0 }, output: { price: 0 } } } },
    { id: "pro", cost: { text: { input: { price: 3 }, output: { price: 10 } } } },
  ] });
  opencode.catalog.selected = "opencode/pro";
  const entries = [opencode, ...catalog.slice(1)];
  const settings = parseSmartSettings({ order: ["codex", "opencode"] });
  assert.equal(smartCandidates(state({ settings }), entries, task({ finishWithReply: true }))[0].model, "opencode/fast-flash");
  assert.equal(smartCandidates(state({ settings }), entries, task({ strength: "deep" }))[0].connector, "codex");
  const override = parseSmartSettings({ strengths: [{ connector: "codex", model: "codex-max", strengths: [], billing: "free" }],
    order: ["codex", "opencode"] });
  assert.equal(smartCandidates(state({ settings: override }), entries, task())[0].model, "codex-max");
});

function service(replies, entries = catalog, slots = { allowed: true }) {
  const requests = [];
  const saved = [];
  const notifications = [];
  const history = new Map();
  let busy = false;
  const smart = createSmartWorkflows({
    runs: {
      hasActiveRun: () => busy,
      start(folder, request) {
        assert.equal(busy, false);
        busy = true;
        requests.push({ ...request, folder });
        return String(requests.length);
      },
      async waitForRun(id) {
        await setImmediate();
        busy = false;
        const reply = replies.shift();
        assert.ok(reply);
        const run = { status: "completed", usage: { inputTokens: 10 }, events: [
          { type: "message", text: typeof reply === "string" ? reply : JSON.stringify(reply) },
        ], ...reply?.run };
        history.set(id, run);
        return run;
      },
      stop() {},
      runById: (id) => history.get(id),
    },
    async available() { return entries; },
    canStart: () => slots.allowed,
    async save(runs) { saved.push(structuredClone(runs)); return true; },
    publish() {},
    notify: ({ id }) => notifications.push(id),
    async inspectChanges() { return "modified app.ts"; },
  });
  return { smart, requests, saved, notifications };
}

async function waitFor(predicate) {
  for (let i = 0; i < 120; i++) {
    if (predicate()) return;
    await setImmediate();
  }
  assert.fail("The workflow did not transition.");
}

test("uses chat context, repairs malformed decisions, and adapts the next model to worker results", async () => {
  const { smart, requests } = service([
    "invalid draft", task(), "Import parsing is the bottleneck",
    task({ title: "Analyze parser design", strength: "deep", inputs: ["step-1"] }), "Reviewed cross-module behavior",
    { action: "finish", reply: "The parsing strategy needs a bounded cache." },
  ]);
  const id = smart.start(request, undefined, '[{"user":"This runs on Windows"}]', parseSmartSettings(undefined));
  await waitFor(() => smart.find(id)?.status === "completed");
  assert.equal(smart.find(id).smart.reply, "The parsing strategy needs a bounded cache.");
  assert.deepEqual(smart.find(id).definition.steps.map(({ providerId }) => providerId), ["opencode", "codex"]);
  assert.match(requests[0].prompt, /This runs on Windows/);
  assert.match(requests[1].prompt, /invalid JSON/);
  assert.match(requests[3].prompt, /Import parsing is the bottleneck/);
  assert.match(requests[4].prompt, /Import parsing is the bottleneck/);
  assert.equal(smart.find(id).usage.inputTokens, 60);
});

test("the composer selection controls the orchestrator while worker routing stays independent", async () => {
  const { smart, requests } = service([task(), "Verified", { action: "finish", reply: "Done." }]);
  const orchestrator = { connector: "codex", model: "codex-max", effort: "high" };
  const id = smart.start({ ...request, orchestrator }, undefined, "[]", parseSmartSettings(undefined));
  await waitFor(() => smart.find(id)?.status === "completed");
  assert.deepEqual(requests.map(({ providerId, modelOverride, effort }) => [providerId, modelOverride, effort]), [
    ["codex", "codex-max", "high"], ["opencode", "opencode-go/fast-flash", "medium"], ["codex", "codex-max", "high"],
  ]);
});

test("a straightforward edit returns the worker's verified reply without another orchestrator call", async () => {
  const { smart, requests } = service([task({ mode: "code", edit: true, finishWithReply: true }), "Added the icon. Typecheck passed."]);
  const id = smart.start({ ...request, access: "edit" }, { name: "Test", path: "C:/test" }, "[]", parseSmartSettings(undefined));
  await waitFor(() => smart.find(id)?.status === "completed");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].edit, true);
  assert.match(requests[1].prompt, /Complete and verify the whole task/);
  assert.equal(smart.find(id).smart.reply, "Added the icon. Typecheck passed.");
  assert.equal(smart.find(id).smart.replyFrom, "opencode");
});

test("switches both coordinator and worker away from a connector that reports a rate limit", async () => {
  const { smart, requests } = service([
    { run: { status: "failed", events: [{ type: "error", text: "Provider rate limit reached." }] } },
    task(), "The logs confirmed the issue.", { action: "finish", reply: "Evidence confirmed." },
  ]);
  const id = smart.start(request, undefined, "[]", parseSmartSettings(undefined));
  await waitFor(() => smart.find(id)?.status === "completed");
  assert.deepEqual(requests.map(({ providerId }) => providerId), ["opencode", "codex", "codex", "codex"]);
});

test("parks a Freebuff handoff across restart without sending another notification", async () => {
  const slots = { allowed: true };
  const first = service([task()], catalog, slots);
  const id = first.smart.start({ ...request, goal: "Use Freebuff to investigate" }, undefined, "[]", parseSmartSettings(undefined));
  await waitFor(() => !first.smart.busy() && first.notifications.length === 1);
  assert.equal(first.smart.pendingFreebuff(id).step.providerId, "freebuff");
  const second = service([{ action: "finish", reply: "Combined the manual findings." }], catalog, slots);
  second.smart.restore(first.saved.at(-1));
  assert.equal(second.smart.busy(), false);
  assert.deepEqual(second.notifications, []);
  slots.allowed = false;
  second.smart.replyFreebuff(id, "Manual findings", "Freebuff model");
  assert.equal(second.smart.find(id).status, "waiting");
  assert.equal(second.smart.find(id).smart.pending, undefined);
  slots.allowed = true;
  second.smart.resume(id);
  await waitFor(() => second.smart.find(id)?.status === "completed");
  assert.match(second.requests[0].prompt, /Manual findings/);
  assert.equal(second.smart.find(id).steps[0].detail, "Model used: Freebuff model");
  assert.deepEqual(second.notifications, []);
});

test("uses one worktree and supplies partial-change evidence before another edit", async () => {
  const project = { name: "Project", path: "C:/example" };
  const worktree = { id: "shared", path: "C:/tree", state: "active" };
  const { smart, requests } = service([
    task({ mode: "code", edit: true }),
    { run: { status: "failed", worktree, events: [{ type: "error", text: "Test run failed" }] } },
    task({ mode: "code", edit: true, inputs: ["step-1"] }),
    { run: { worktree } },
    { action: "finish", reply: "Repaired the remaining failure." },
  ]);
  const id = smart.start({ ...request, access: "edit" }, project, "[]", parseSmartSettings(undefined));
  await waitFor(() => smart.find(id)?.status === "completed");
  assert.equal(requests[3].worktreeId, "shared");
  assert.match(requests[2].prompt, /Partial changes: modified app.ts/);
  assert.match(requests[3].prompt, /Partial changes: modified app.ts/);
});
