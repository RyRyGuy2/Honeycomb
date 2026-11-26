import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRunService } from "../dist/service/runs.js";
import { createWorktreeManager } from "../dist/service/worktree.js";
import { FREEBUFF_EXPORT_PATTERN, readFreebuffTranscript, readSavedFreebuffExchange, readSavedFreebuffExchanges } from "../dist/service/freebuff.js";
import { supportsWorktreeEditing } from "../dist/shared/editing.js";

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

test("a restored Freebuff handoff reviews commits and new files without staging them", async (t) => {
  const { root, repository } = await repositoryWithCommit(t);
  const directory = () => join(root, "worktrees");
  const manager = createWorktreeManager(directory);
  const record = await manager.create(repository, repository);
  await writeFile(join(record.path, "app.txt"), "committed edit\n");
  git(record.path, "commit", "-qam", "Freebuff edit");
  await writeFile(join(record.path, "new.txt"), "untracked edit\n");
  const restored = createWorktreeManager(directory);
  restored.restore(JSON.parse(JSON.stringify(manager.records())));
  const handoff = restored.find(record.id);
  assert.equal(handoff.freebuffProject, repository);
  assert.equal(await restored.exists(handoff), true);
  const { files } = await restored.diff(handoff);
  assert.match(files.find((file) => file.path === "app.txt").patch, /\+committed edit/);
  assert.match(files.find((file) => file.path === "new.txt").patch, /\+untracked edit/);
  assert.equal(git(record.path, "status", "--porcelain").trim(), "?? new.txt");
  assert.equal(await readFile(join(repository, "app.txt"), "utf8"), "hello\n");
  await assert.rejects(readFreebuffTranscript(record.path), /\/export freebuff-result\.md/);
  await writeFile(join(record.path, "freebuff-result.md"), "# Earlier\n" + "x".repeat(25_000) + "\nFinal reply");
  const transcript = await readFreebuffTranscript(record.path);
  assert.match(transcript, /^\[Earlier transcript omitted\]\n/);
  assert.match(transcript, /Final reply$/);
  await writeFile(join(record.path, "freebuff-result-1795574400000.md"), "Latest reply");
  assert.equal(await readFreebuffTranscript(record.path), "Latest reply");
  const codeOnly = await restored.diff(handoff, (path, status) => status !== "added" || !FREEBUFF_EXPORT_PATTERN.test(path));
  assert.deepEqual(codeOnly.files.map((file) => file.path).sort(), ["app.txt", "new.txt"]);
  git(repository, "worktree", "remove", "--force", record.path);
  await mkdir(record.path);
  assert.equal(await restored.exists(handoff), false, "an empty leftover folder cannot be reopened as a Git worktree");
  await writeFile(join(record.path, "keep.txt"), "preserved");
  await assert.rejects(restored.discard(record.id), /contains files/);
  assert.equal(await readFile(join(record.path, "keep.txt"), "utf8"), "preserved");
  await rm(join(record.path, "keep.txt"));
  assert.equal(await restored.discard(record.id), true);
  assert.equal(await exists(record.path), false);
});

test("Freebuff chat reads each completed public reply paired with its own prompt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "honeycomb-freebuff-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktree = join(root, "repo-abc123");
  const config = join(root, "freebuff-config");
  const complete = (content) => ({ variant: "ai", isComplete: true, content });
  async function save(project, id, messages, mtime) {
    const directory = join(config, "projects", project, "chats", id);
    await mkdir(directory, { recursive: true });
    const file = join(directory, "chat-messages.json");
    await writeFile(file, JSON.stringify(messages));
    await utimes(file, mtime, mtime);
    return file;
  }
  await save("repo-abc123", "2026-11-25T16-05-26.184Z", [complete("Older chat")], 10);
  await save("another-project", "2026-11-25T16-05-28.184Z", [complete("Other worktree")], 30);
  const latest = await save("repo-abc123", "2026-11-25T16-05-29.184Z", [
    { variant: "user", content: "Earlier question" },
    complete("Earlier response"),
    { variant: "user", content: "Original question" },
    complete("Intermediate note"),
    { variant: "ai", isComplete: true, blocks: [
      { type: "text", textType: "reasoning", content: "Internal reasoning" },
      { type: "tool", output: "Tool logs" },
      { type: "text", textType: "text", content: "Final response" },
    ] },
    { variant: "user", content: "Newer question" },
    { variant: "ai", isComplete: false, content: "Still streaming" },
  ], 20);
  await mkdir(join(config, "projects", "repo-abc123", "chats", "2026-11-25T16-05-32.184Z"));
  assert.deepEqual(await readSavedFreebuffExchanges(worktree, config), [
    { prompt: "Earlier question", reply: "Earlier response" },
    { prompt: "Original question", reply: "Final response" },
  ]);
  assert.deepEqual(await readSavedFreebuffExchange(worktree, config), { prompt: "Original question", reply: "Final response" });
  assert.equal(await readSavedFreebuffExchange(join(root, "unknown"), config), undefined);
  await writeFile(latest, "[broken");
  assert.equal(await readSavedFreebuffExchange(worktree, config), undefined);
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

test("edit requests require Code mode and a supported connector", async () => {
  const service = createRunService(() => {});
  const project = { name: "Project", path: process.cwd() };

  assert.throws(
    () => service.start(undefined, { providerId: "claude", prompt: "Fix it", edit: true, mode: "chat" }),
    /Switch to Code/,
  );
  assert.throws(
    () => service.start(project, { providerId: "unknown", prompt: "Fix it", edit: true }),
    /Choose an available Code connector/,
  );
  for (const providerId of ["antigravity", "github-copilot"]) {
    assert.throws(() => service.start(project, { providerId, prompt: "Fix it", edit: true }), /to edit in a Git worktree/);
  }
  for (const providerId of ["codex", "opencode", "claude"]) {
    assert.equal(supportsWorktreeEditing(providerId), true);
  }
  const id = service.start(project, { providerId: "opencode", prompt: "Fix it", edit: true });
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
