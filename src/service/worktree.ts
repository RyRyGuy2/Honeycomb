import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { providerEnvironment } from "../providers/index.js";
import { WORKTREE_BRANCH_PREFIX } from "../shared/editing.js";
import type { DiffFile, DiffStatus, RunDiff, RunWorktree, WorktreeRecord } from "../shared/contracts.js";
import { runProcess } from "./process.js";

const GIT_TIMEOUT_MS = 30_000;
const GIT_OUTPUT_LIMIT = 512 * 1024;
const MAX_FILE_PATCH = 60_000;
const MAX_DIFF_PATCH = 200_000;
const WORKTREE_STATES = ["active", "kept", "discarded"] as const;

interface GitResult {
  code: number | null;
  output: string;
  stderr: string;
  error?: string;
}

export interface RepositoryState {
  root: string;
  baseCommit: string;
}

export interface WorktreeManager {
  records(): WorktreeRecord[];
  find(id: string): WorktreeRecord | undefined;
  restore(saved: readonly WorktreeRecord[]): void;
  inspect(repository: string): Promise<RepositoryState>;
  create(repository: string): Promise<WorktreeRecord>;
  exists(worktree: RunWorktree): Promise<boolean>;
  diff(worktree: RunWorktree): Promise<RunDiff>;
  keep(id: string): boolean;
  discard(id: string): Promise<boolean>;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return { ...providerEnvironment(), GIT_TERMINAL_PROMPT: "0" };
}

async function git(cwd: string, args: readonly string[], outputLimit = 64 * 1024): Promise<GitResult> {
  const result = await runProcess({
    file: "git",
    args: ["-c", "core.quotepath=false", ...args],
    cwd,
    env: gitEnvironment(),
    timeoutMs: GIT_TIMEOUT_MS,
    outputLimit,
  });
  if (result.error) throw new Error("Git could not start. Install Git and make it available on PATH.");
  if (result.stopped === "timeout") throw new Error("Git did not finish in time.");
  return result;
}

function detail(result: GitResult) {
  return result.stderr.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim().split("\n").filter(Boolean).slice(-3).join(" ").slice(0, 500);
}

function gitFailure(prefix: string, result: GitResult) {
  const message = detail(result);
  return new Error(message ? `${prefix} ${message}` : prefix);
}

async function pathExists(path: string) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function normalizePath(path: string) {
  return process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
}

/** True when `child` is the `parent` directory or sits below it. */
export function isInside(parent: string, child: string) {
  const base = normalizePath(parent);
  const target = normalizePath(child);
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
}

function diffStatus(code: string): DiffStatus {
  if (code.includes("R")) return "renamed";
  if (code.includes("D")) return "deleted";
  if (code.includes("A") || code.includes("?")) return "added";
  return "modified";
}

export function createWorktreeManager(directory: () => string, onChanged: () => void = () => {}): WorktreeManager {
  const list: WorktreeRecord[] = [];

  function find(id: string) {
    return list.find((record) => record.id === id);
  }

  async function exists(worktree: RunWorktree) {
    const record = find(worktree.id);
    if (!record || record.state === "discarded" || normalizePath(record.path) !== normalizePath(worktree.path)) return false;
    try {
      const [root, path] = await Promise.all([realpath(directory()), realpath(record.path)]);
      return normalizePath(root) !== normalizePath(path) && isInside(root, path) && await pathExists(path);
    } catch {
      return false;
    }
  }

  async function inspect(repository: string): Promise<RepositoryState> {
    if (!(await pathExists(repository))) {
      throw new Error("This project folder is no longer available. Choose the project again.");
    }
    const inside = await git(repository, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.code !== 0 || inside.output.trim() !== "true") {
      throw new Error("This project is not a Git repository. Honeycomb needs Git to create an editing worktree.");
    }
    const top = await git(repository, ["rev-parse", "--show-toplevel"]);
    const root = top.code === 0 ? top.output.trim() : "";
    if (!root) throw gitFailure("Honeycomb could not read the Git repository.", top);
    const head = await git(root, ["rev-parse", "HEAD"]);
    if (head.code !== 0) {
      throw new Error("This Git repository has no commits yet. Commit the project before requesting an edit.");
    }
    return { root, baseCommit: head.output.trim() };
  }

  return {
    records() {
      return list.map((record) => ({ ...record }));
    },
    find,
    restore(saved) {
      list.length = 0;
      for (const record of saved) {
        if (!record || typeof record !== "object") continue;
        if (typeof record.id !== "string" || typeof record.branch !== "string" || typeof record.path !== "string" ||
            typeof record.repository !== "string" || typeof record.baseCommit !== "string" ||
            typeof record.createdAt !== "string" || !WORKTREE_STATES.includes(record.state)) {
          continue;
        }
        list.push({ ...record });
      }
    },
    inspect,
    async create(repository) {
      const { root, baseCommit } = await inspect(repository);
      const id = randomUUID();
      const short = id.slice(0, 8);
      const branch = WORKTREE_BRANCH_PREFIX + short;
      const name = basename(root).replace(/[^a-z0-9._-]+/gi, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 40) || "project";
      const path = join(directory(), `${name}-${short}`);
      await mkdir(directory(), { recursive: true });
      const added = await git(root, ["worktree", "add", "--quiet", "-b", branch, path, baseCommit], GIT_OUTPUT_LIMIT);
      if (added.code !== 0) throw gitFailure("Honeycomb could not create the editing worktree.", added);
      const record: WorktreeRecord = {
        id: `worktree-${id}`,
        branch,
        path,
        repository: root,
        baseCommit,
        createdAt: new Date().toISOString(),
        state: "active",
      };
      list.push(record);
      onChanged();
      return { ...record };
    },
    exists,
    async diff(worktree) {
      if (!(await pathExists(worktree.path))) {
        throw new Error("The worktree for this chat is no longer available.");
      }
      const baseCommit = find(worktree.id)?.baseCommit ?? worktree.baseCommit;
      // Intent-to-add records new files in the diff without staging their contents.
      const marked = await git(worktree.path, ["add", "-A", "-N"]);
      if (marked.code !== 0) throw gitFailure("Honeycomb could not inspect the worktree changes.", marked);
      const status = await git(worktree.path, ["status", "--porcelain=v1", "-z", "-uall"], GIT_OUTPUT_LIMIT);
      if (status.code !== 0) throw gitFailure("Honeycomb could not list the worktree changes.", status);

      const tokens = status.output.split("\0");
      const files: DiffFile[] = [];
      let remaining = MAX_DIFF_PATCH;
      let truncated = false;
      for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (!token || token.length < 4) continue;
        const code = token.slice(0, 2);
        const path = token.slice(3);
        if (!path) continue;
        // With -z a rename reports the new path first and the original path in the next token.
        if (code.includes("R") || code.includes("C")) index++;

        const patchResult = await git(worktree.path,
          ["diff", "--no-ext-diff", "--no-color", "--unified=3", baseCommit, "--", path], GIT_OUTPUT_LIMIT);
        const patch = patchResult.code === 0 ? patchResult.output : "";
        const allowed = Math.min(MAX_FILE_PATCH, Math.max(0, remaining));
        const fileTruncated = patch.length > allowed;
        files.push({
          path,
          status: diffStatus(code),
          patch: patch.slice(0, allowed),
          ...(fileTruncated ? { truncated: true } : {}),
        });
        remaining -= Math.min(patch.length, allowed);
        if (remaining <= 0) truncated = true;
      }
      return { baseCommit, files, ...(truncated ? { truncated: true } : {}) };
    },
    keep(id) {
      const record = find(id);
      if (!record) throw new Error("This worktree is no longer recorded.");
      if (record.state !== "active") return true;
      record.state = "kept";
      onChanged();
      return true;
    },
    async discard(id) {
      const record = find(id);
      if (!record) throw new Error("This worktree is no longer recorded.");
      if (record.state === "discarded") return true;
      // Cleanup only ever touches the directory and branch Honeycomb created.
      if (!isInside(directory(), record.path)) throw new Error("Honeycomb only removes worktrees it created.");
      if (!record.branch.startsWith(WORKTREE_BRANCH_PREFIX)) throw new Error("Honeycomb only removes branches it created.");

      if (!(await pathExists(record.repository))) {
        await rm(record.path, { recursive: true, force: true });
      } else {
        if (await pathExists(record.path)) {
          const removed = await git(record.repository, ["worktree", "remove", "--force", record.path], GIT_OUTPUT_LIMIT);
          if (removed.code !== 0) throw gitFailure("Honeycomb could not remove the worktree.", removed);
        }
        const deleted = await git(record.repository, ["branch", "-D", record.branch], GIT_OUTPUT_LIMIT);
        if (deleted.code !== 0 && !/not found/i.test(deleted.stderr)) {
          throw gitFailure("Honeycomb could not delete the editing branch.", deleted);
        }
        await git(record.repository, ["worktree", "prune"]);
      }
      record.state = "discarded";
      onChanged();
      return true;
    },
  };
}
