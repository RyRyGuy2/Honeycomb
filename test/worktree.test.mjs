import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRunService } from "../dist/service/runs.js";
import { createWorktreeManager } from "../dist/service/worktree.js";

// Keep the tests independent of the developer's Git identity and global configuration.
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: join(tmpdir(), "honeycomb-worktree-test-gitconfig"),
  GIT_AUTHOR_NAME: "Honeycomb Test",
  GIT_AUTHOR_EMAIL: "honeycomb@example.test",
  GIT_COMMITTER_NAME: "Honeycomb Test",
  GIT_COMMITTER_EMAIL: "honeycomb@example.test",
};

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] });
}

async function exists(path) {
  return stat(path).then(() => true, () => false);
}

async function repositoryWithCommit(t) {
  const root = await mkdtemp(join(tmpdir(), "honeycomb-worktree-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "project");
  await mkdir(repository, { recursive: true });
  git(repository, "init", "-q", "-b", "main");
  await writeFile(join(repository, "app.txt"), "hello\n");
  git(repository, "add", "-A");
  git(repository, "commit", "-q", "-m", "Initial commit");
  return { root, repository };
}

test("an edit gets a dedicated branch and worktree from the current commit", async (t) => {
  const { root, repository } = await repositoryWithCommit(t);
  const base = git(repository, "rev-parse", "HEAD").trim();
  const manager = createWorktreeManager(() => join(root, "worktrees"));
  const record = await manager.create(repository);

  assert.equal(record.baseCommit, base);
  assert.equal(record.state, "active");
  assert.match(record.branch, /^honeycomb\/edit-[0-9a-f]{8}$/);
  assert.ok(record.path.startsWith(join(root, "worktrees")));
  assert.equal(await manager.exists(record), true);
  assert.equal(await manager.exists({ ...record, path: repository }), false);
  assert.ok(await exists(record.path));
  assert.equal(git(repository, "rev-parse", record.branch).trim(), base);
  assert.equal(git(repository, "rev-parse", "--abbrev-ref", "HEAD").trim(), "main");

  await writeFile(join(record.path, "app.txt"), "hello again\n");
  await writeFile(join(record.path, "new.txt"), "created in the worktree\n");
  const diff = await manager.diff(record);
  assert.deepEqual(diff.files.map((file) => file.path).sort(), ["app.txt", "new.txt"]);

  const modified = diff.files.find((file) => file.path === "app.txt");
  assert.equal(modified.status, "modified");
  assert.match(modified.patch, /^-hello$/m);
  assert.match(modified.patch, /^\+hello again$/m);

  // New files are listed with their own patch so the whole result is reviewable.
  const added = diff.files.find((file) => file.path === "new.txt");
  assert.equal(added.status, "added");
  assert.match(added.patch, /^\+created in the worktree$/m);

  // The original checkout and its commit stay untouched.
  assert.equal(await readFile(join(repository, "app.txt"), "utf8"), "hello\n");
  assert.equal(await exists(join(repository, "new.txt")), false);
  assert.equal(git(repository, "status", "--porcelain"), "");
});

test("discarding removes only the worktree and branch Honeycomb created", async (t) => {
  const { root, repository } = await repositoryWithCommit(t);
  git(repository, "branch", "keep-me");
  const manager = createWorktreeManager(() => join(root, "worktrees"));
  const first = await manager.create(repository);
  const second = await manager.create(repository);
  await writeFile(join(first.path, "app.txt"), "changed in the worktree\n");

  assert.equal(await manager.discard(first.id), true);
  assert.equal(await exists(first.path), false);
  assert.equal(git(repository, "branch", "--list", first.branch), "");
  assert.match(git(repository, "branch", "--list", "keep-me"), /keep-me/);
  assert.match(git(repository, "branch", "--list", second.branch), new RegExp(second.branch));

  // Another worktree, the project branch and its files are left alone.
  assert.ok(await exists(second.path));
  assert.equal(await readFile(join(repository, "app.txt"), "utf8"), "hello\n");
  assert.equal(git(repository, "status", "--porcelain"), "");
  assert.equal(manager.find(first.id).state, "discarded");
});

test("cleanup refuses a worktree Honeycomb did not create", async (t) => {
  const { root, repository } = await repositoryWithCommit(t);
  const manager = createWorktreeManager(() => join(root, "worktrees"));
  manager.restore([{
    id: "worktree-foreign",
    branch: "main",
    path: repository,
    repository,
    baseCommit: git(repository, "rev-parse", "HEAD").trim(),
    createdAt: new Date().toISOString(),
    state: "active",
  }]);

  await assert.rejects(manager.discard("worktree-foreign"), /only removes worktrees it created/);
  await assert.rejects(manager.discard("worktree-missing"), /no longer recorded/);
  assert.equal(await readFile(join(repository, "app.txt"), "utf8"), "hello\n");
});

test("keeping a worktree records it for later review", async (t) => {
  const { root, repository } = await repositoryWithCommit(t);
  const manager = createWorktreeManager(() => join(root, "worktrees"));
  const record = await manager.create(repository);

  assert.equal(manager.keep(record.id), true);
  assert.equal(manager.find(record.id).state, "kept");
  assert.ok(await exists(record.path));
  assert.equal(manager.records().length, 1);
});

test("a project without Git is reported before a worktree is created", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "honeycomb-worktree-nogit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = createWorktreeManager(() => join(root, "worktrees"));

  await assert.rejects(manager.create(root), /not a Git repository/);
  assert.deepEqual(manager.records(), []);
});

test("edit requests require Code mode and an editing connector", async () => {
  const service = createRunService(() => {});
  const project = { name: "Project", path: process.cwd() };

  assert.throws(
    () => service.start(undefined, { providerId: "claude", prompt: "Fix it", edit: true, mode: "chat" }),
    /Switch to Code/,
  );
  assert.throws(
    () => service.start(project, { providerId: "opencode", prompt: "Fix it", edit: true }),
    /Choose Codex or Claude Code/,
  );
  const id = service.start(project, { providerId: "codex", prompt: "Fix it", edit: true });
  assert.equal(service.conversation(id)[0].edit, true);
  await service.shutdown();
});

test("a follow-up edit continues in the chat's existing worktree", async (t) => {
  const { root, repository } = await repositoryWithCommit(t);
  const manager = createWorktreeManager(() => join(root, "worktrees"));
  const record = await manager.create(repository);
  const project = { name: "Example", path: repository };
  const review = {
    id: "review-chat",
    providerId: "claude",
    providerName: "Claude Code",
    folder: project,
    mode: "code",
    edit: true,
    worktree: { id: record.id, branch: record.branch, path: record.path, baseCommit: record.baseCommit, state: "active" },
    prompt: "Review the failing test",
    startedAt: "2026-01-01T12:00:00.000Z",
    status: "completed",
    revision: 1,
    usage: {},
    events: [{ type: "message", text: "The bug is in app.txt.", runId: "review-chat", sequence: 1, at: "2026-01-01T12:00:00.000Z" }],
  };
  const service = createRunService(() => {}, () => ({}), manager);
  service.restore([review]);

  const id = service.start(project, {
    providerId: "claude", conversationId: review.id, prompt: "Go ahead and fix that", edit: true,
  });
  const followUp = service.history().find((run) => run.id === id);
  assert.equal(followUp.edit, true);
  assert.equal(followUp.worktree.id, record.id);
  assert.equal(followUp.worktree.path, record.path);
  assert.equal(followUp.worktree.baseCommit, record.baseCommit);
  await service.shutdown();
});
