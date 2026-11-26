import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SavedWorkflow } from "../shared/contracts.js";
import { isWorkflowId, validateWorkflow } from "../shared/workflows.js";

/** Workflow definitions are project data. Honeycomb only ever reads and writes these files. */
const WORKFLOW_DIRECTORY = join(".honeycomb", "workflows");
const WORKFLOW_FILE = /^[a-z0-9][a-z0-9-]{0,63}\.json$/;

export function workflowDirectory(project: string) {
  return join(project, WORKFLOW_DIRECTORY);
}

export function createWorkflowStore(project: () => string | undefined) {
  function saveDirectory() {
    const path = project();
    if (!path) throw new Error("Choose a project folder first.");
    return workflowDirectory(path);
  }

  return {
    async list(): Promise<SavedWorkflow[]> {
      const path = project();
      if (!path) return [];
      const directory = workflowDirectory(path);
      let names: string[];
      try {
        names = await readdir(directory);
      } catch {
        return [];
      }
      const saved: SavedWorkflow[] = [];
      for (const name of names) {
        if (!WORKFLOW_FILE.test(name)) continue;
        try {
          const file = join(directory, name);
          const definition = validateWorkflow(JSON.parse(await readFile(file, "utf8")));
          const info = await stat(file);
          saved.push({ ...definition, updatedAt: info.mtime.toISOString() });
        } catch {
          // A hand-edited file that fails validation stays untouched and is ignored until it is fixed.
        }
      }
      return saved.sort((a, b) => a.name.localeCompare(b.name));
    },
    async save(value: unknown): Promise<SavedWorkflow> {
      const workflow = validateWorkflow(value);
      const directory = saveDirectory();
      await mkdir(directory, { recursive: true });
      const file = join(directory, `${workflow.id}.json`);
      await writeFile(`${file}.tmp`, `${JSON.stringify(workflow, null, 2)}\n`, "utf8");
      await rename(`${file}.tmp`, file);
      return { ...workflow, updatedAt: new Date().toISOString() };
    },
    async remove(id: unknown): Promise<boolean> {
      if (!isWorkflowId(id)) throw new Error("Invalid workflow.");
      try {
        await rm(join(saveDirectory(), `${id}.json`));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
  };
}
