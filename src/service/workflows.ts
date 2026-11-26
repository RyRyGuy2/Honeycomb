import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SavedWorkflow } from "../shared/contracts.js";
import { isWorkflowId, validateWorkflow } from "../shared/workflows.js";

const WORKFLOW_FILE = /^[a-z0-9][a-z0-9-]{0,63}\.json$/;

export function workflowDirectory(userData: string) {
  return join(userData, "workflows");
}

async function readDirectory(directory: string): Promise<SavedWorkflow[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const saved: SavedWorkflow[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !WORKFLOW_FILE.test(entry.name)) continue;
    try {
      const file = join(directory, entry.name);
      const info = await stat(file);
      if (info.size > 1_000_000) continue;
      const definition = validateWorkflow(JSON.parse(await readFile(file, "utf8")));
      if (entry.name !== `${definition.id}.json`) continue;
      saved.push({ ...definition, updatedAt: info.mtime.toISOString() });
    } catch {
      // Invalid or partially written workflow files are ignored.
    }
  }
  return saved.sort((a, b) => a.name.localeCompare(b.name));
}

export function createWorkflowStore(userData: () => string) {
  const directory = () => workflowDirectory(userData());
  let pending = Promise.resolve();
  function mutate<T>(action: () => Promise<T>) {
    const result = pending.then(action);
    pending = result.then(() => {}, () => {});
    return result;
  }

  async function save(value: unknown): Promise<SavedWorkflow> {
    const workflow = validateWorkflow(value);
    const root = directory();
    await mkdir(root, { recursive: true });
    const file = join(root, `${workflow.id}.json`);
    await writeFile(`${file}.tmp`, `${JSON.stringify(workflow, null, 2)}\n`, { mode: 0o600 });
    await rename(`${file}.tmp`, file);
    return { ...workflow, updatedAt: new Date().toISOString() };
  }

  return {
    list: () => readDirectory(directory()),
    save: (value: unknown) => mutate(() => save(value)),
    async importLegacy(projects: readonly string[]) {
      const marker = join(directory(), ".project-workflows-imported");
      try {
        await access(marker);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const ids = new Set((await readDirectory(directory())).map((workflow) => workflow.id));
      for (const project of projects) {
        for (const { updatedAt: _updatedAt, ...workflow } of await readDirectory(join(project, ".honeycomb", "workflows"))) {
          if (ids.has(workflow.id)) continue;
          await save(workflow);
          ids.add(workflow.id);
        }
      }
      await mkdir(directory(), { recursive: true });
      await writeFile(marker, "", { mode: 0o600 });
    },
    remove: (id: unknown) => mutate(async () => {
      if (!isWorkflowId(id)) throw new Error("Invalid workflow.");
      try {
        await rm(join(directory(), `${id}.json`));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    }),
  };
}
