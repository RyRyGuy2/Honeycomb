import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyFactoryReset, requestFactoryReset } from "../dist/service/factory-reset.js";

test("factory reset clears app state on startup and preserves project and worktree files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "honeycomb-reset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userData = join(root, "app");
  const project = join(root, "project");
  const worktree = join(userData, "worktrees", "project-test");
  const connector = join(userData, "connectors", "opencode");
  const workflows = join(userData, "workflows");
  for (const path of [project, worktree, connector, workflows]) await mkdir(path, { recursive: true });
  await writeFile(join(project, "project-file"), "project");
  await writeFile(join(worktree, "worktree-file"), "worktree");
  await writeFile(join(connector, "opencode"), "download");
  await writeFile(join(workflows, "saved-workflow.json"), "workflow");
  const files = ["workspace.json", "workflow-runs.json", "chat-connections.json", "chat-connections.json.tmp", "codex-model"];
  for (const name of files) await writeFile(join(userData, name), "saved");
  let clears = 0;
  const clearBrowserData = async () => { clears++; };

  await applyFactoryReset(userData, clearBrowserData);
  assert.equal(clears, 0);
  await requestFactoryReset(userData);
  assert.equal(await readFile(join(userData, "workspace.json"), "utf8"), "saved");
  await applyFactoryReset(userData, clearBrowserData);
  assert.equal(clears, 1);
  for (const name of [...files, "connectors", "workflows"]) await assert.rejects(access(join(userData, name)), { code: "ENOENT" });
  assert.equal(await readFile(join(project, "project-file"), "utf8"), "project");
  assert.equal(await readFile(join(worktree, "worktree-file"), "utf8"), "worktree");
  await applyFactoryReset(userData, clearBrowserData);
  assert.equal(clears, 1);
});

test("a reset interrupted by a browser storage error can finish on the next startup", async (t) => {
  const userData = await mkdtemp(join(tmpdir(), "honeycomb-reset-retry-"));
  t.after(() => rm(userData, { recursive: true, force: true }));
  const workspace = join(userData, "workspace.json");
  await writeFile(workspace, "saved");
  await requestFactoryReset(userData);
  await assert.rejects(applyFactoryReset(userData, async () => { throw Error("Browser storage is busy"); }), /storage is busy/);
  assert.equal(await readFile(workspace, "utf8"), "saved");
  await applyFactoryReset(userData, async () => {});
  await assert.rejects(access(workspace), { code: "ENOENT" });
});
