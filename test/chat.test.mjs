import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRunService } from "../dist/service/runs.js";
import { createWorkspaceStore } from "../dist/service/workspace.js";
import { conversationContext, followUpPrompt } from "../dist/shared/conversations.js";

function savedTurn(prompt, options = {}) {
  return {
    id: "first-chat", providerId: "claude", providerName: "Claude Code", prompt, status: "completed",
    startedAt: "2026-01-01T12:00:00Z", revision: 2, usage: {},
    events: [
      { type: "tool_call", text: "Claude Code Read\nsrc/main/index.ts" },
      { type: "message", text: "The main entry point handles shutdown." },
    ],
    ...options,
  };
}

test("Chat does not attach the selected project to a run", async () => {
  const service = createRunService(() => {});
  assert.throws(() => service.start(undefined, { providerId: "opencode", prompt: "Example", mode: "code" }), /project folder/);
  service.start({ name: "Existing project", path: process.cwd() }, { providerId: "opencode", prompt: "Example", mode: "chat" });
  const [run] = service.history();
  assert.equal(run.mode, "chat");
  assert.equal(run.folder, undefined);
  await service.shutdown();
  assert.equal(run.status, "cancelled");
});

test("deleting a chat persists its removal and keeps other chats and the project", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "honeycomb-delete-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = { name: "Existing project", path: directory };
  const store = createWorkspaceStore(() => join(directory, "workspace.json"));
  const service = createRunService(() => {});
  const save = () => store.save({ folder: project, projects: [project], runs: service.history() });
  const projectRun = service.start(project, { providerId: "opencode", prompt: "Project chat" });
  await assert.rejects(service.deleteChat(projectRun, save), /Stop the run/);
  await service.shutdown();
  const [run] = service.history();
  service.restore([{ ...run, id: "general-chat", mode: "chat", folder: undefined, events: [], revision: 0 }]);
  assert.equal(await save(), true);

  await assert.rejects(service.deleteChat(projectRun, async () => false), /The chat was kept/);
  assert.equal(service.history().length, 2);
  assert.equal(await service.deleteChat(projectRun, save), true);
  assert.equal(await service.deleteChat(projectRun, save), false);
  const saved = await store.load();
  assert.deepEqual(saved.projects, [project]);
  assert.deepEqual(saved.runs.map((chat) => chat.id), ["general-chat"]);
});

test("a follow-up keeps its restored project chat and deleting it removes every turn", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "honeycomb-conversation-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = { name: "Example", path: directory };
  const first = savedTurn("Review the entry point", { folder: project });
  const unrelated = savedTurn("Independent chat", { id: "unrelated", mode: "chat" });
  const store = createWorkspaceStore(() => join(directory, "workspace.json"));
  await store.save({ folder: project, projects: [project], runs: [unrelated, first] });
  const service = createRunService(() => {});
  service.restore((await store.load()).runs);
  const request = { providerId: "claude", conversationId: first.id, prompt: "Why did you flag it?" };
  assert.throws(() => service.start(undefined, { ...request, mode: "chat" }), /original workspace/);
  assert.throws(() => service.start({ ...project, path: tmpdir() }, request), /original workspace/);
  assert.throws(() => service.start(project, { ...request, providerId: "codex" }), /Continue this chat with Claude Code/);

  const id = service.start(project, request);
  const save = () => store.save({ folder: project, projects: [project], runs: service.history() });
  await assert.rejects(service.deleteChat(first.id, save), /Stop the run/);
  await service.shutdown();
  const [root, followUp] = service.conversation(first.id);
  assert.equal(root.id, first.id);
  assert.equal(followUp.id, id);
  assert.equal(followUp.prompt, request.prompt);
  assert.deepEqual(followUp.context, { includedTurns: 1, omittedTurns: 0, shortenedTurns: 0 });
  await save();
  const reopened = createRunService(() => {});
  reopened.restore((await store.load()).runs);
  assert.deepEqual(reopened.conversation(first.id).map((run) => run.id), [first.id, id]);
  assert.equal(await reopened.deleteChat(first.id, () => store.save({ folder: project, projects: [project], runs: reopened.history() })), true);
  assert.deepEqual((await store.load()).runs.map((run) => run.id), [unrelated.id]);
});

test("follow-up context keeps recent turns and reports shortening and omissions", () => {
  const large = (label) => savedTurn(label.repeat(4_000), {
    events: [{ type: "message", text: label.repeat(6_000) }],
  });
  const latest = savedTurn("Which file was it?");
  const context = conversationContext([large("oldest"), large("middle"), large("recent"), latest]);
  assert.ok(context.transcript.length <= 16_000);
  assert.deepEqual(context.summary, { includedTurns: 3, omittedTurns: 1, shortenedTurns: 2 });
  const records = JSON.parse(context.transcript);
  assert.equal(records.at(-1).user, latest.prompt);
  assert.match(records.at(-1).toolCalls, /src\/main\/index.ts/);
  assert.match(records.at(-1).assistant, /handles shutdown/);
  assert.match(followUpPrompt("Why?", context.transcript), /Latest user message:\nWhy\?$/);
});

test("Freebuff context is saved separately from the user message and included with earlier chat turns", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "honeycomb-freebuff-chat-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = { name: "Example", path: directory };
  const store = createWorkspaceStore(() => join(directory, "workspace.json"));
  const freebuff = { prompt: "Investigate the tracking pipeline", reply: "The detector emits frame-level results." };
  const service = createRunService(() => {});
  const id = service.start(project, { providerId: "opencode", prompt: "Explain this response" }, freebuff);
  await service.shutdown();
  await store.save({ folder: project, projects: [project], runs: service.history() });

  const reopened = createRunService(() => {});
  reopened.restore((await store.load()).runs);
  const [run] = reopened.conversation(id);
  assert.equal(run.prompt, "Explain this response");
  assert.deepEqual(run.freebuffContext, freebuff);
  const received = followUpPrompt("Which stage?", conversationContext([run]).transcript, run.freebuffContext);
  assert.match(received, /"user":"Explain this response"/);
  assert.ok(received.includes(JSON.stringify(freebuff)));
  assert.match(received, /Latest user message:\nWhich stage\?$/);
  assert.equal(followUpPrompt("New chat"), "New chat");
});
