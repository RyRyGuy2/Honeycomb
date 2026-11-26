import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WorkflowRun } from "../shared/contracts.js";

function isSavedRun(value: unknown): value is WorkflowRun {
  if (!value || typeof value !== "object") return false;
  const run = value as Partial<WorkflowRun>;
  return typeof run.id === "string" && typeof run.workflowId === "string" && typeof run.status === "string" &&
    Array.isArray(run.steps) && Boolean(run.definition) && Boolean(run.folder) && typeof run.startedAt === "string";
}

/** Workflow run records live in userData so the project never gains run history. */
export function createWorkflowRunStore(filename: () => string) {
  let pending = Promise.resolve(true);
  return {
    async load(): Promise<WorkflowRun[]> {
      try {
        const saved = JSON.parse(await readFile(filename(), "utf8"));
        if (saved?.version === 1 && Array.isArray(saved.runs)) return saved.runs.filter(isSavedRun);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("Could not read workflow history", error);
      }
      return [];
    },
    save(runs: readonly WorkflowRun[]) {
      const data = JSON.stringify({ version: 1, runs });
      const path = filename();
      pending = pending.then(async () => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(`${path}.tmp`, data, { mode: 0o600 });
        await rename(`${path}.tmp`, path);
        return true;
      }).catch((error) => {
        console.error("Could not save workflow history", error);
        return false;
      });
      return pending;
    },
    flush: () => pending,
  };
}
