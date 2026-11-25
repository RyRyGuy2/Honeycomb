import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRunService } from "../dist/service/runs.js";
import { createWorkspaceStore } from "../dist/service/workspace.js";

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
