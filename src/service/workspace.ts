import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppState } from "../shared/contracts.js";

export function createWorkspaceStore(filename: () => string) {
  let pending = Promise.resolve();
  return {
    async load(): Promise<AppState | undefined> {
      try {
        const saved = JSON.parse(await readFile(filename(), "utf8"));
        if (saved?.version === 1 && Array.isArray(saved.projects) && Array.isArray(saved.runs)) {
          return saved;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("Could not read Honeycomb history", error);
      }
    },
    save(state: AppState) {
      const data = JSON.stringify({ ...state, version: 1 });
      const path = filename();
      pending = pending.then(async () => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(`${path}.tmp`, data, { mode: 0o600 });
        await rename(`${path}.tmp`, path);
      }).catch((error) => console.error("Could not save Honeycomb history", error));
      return pending;
    },
    flush: () => pending,
  };
}
