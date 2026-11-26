import { lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CLI_PROVIDER_IDS } from "../shared/contracts.js";

const RESET_MARKER = "factory-reset.pending";
const STATE_FILES = [
  "workspace.json", "workspace.json.tmp", "workflow-runs.json", "workflow-runs.json.tmp",
  "chat-connections.json", "chat-connections.json.tmp", ...CLI_PROVIDER_IDS.map((id) => id + "-model"),
];

export async function requestFactoryReset(userData: string) {
  await mkdir(userData, { recursive: true });
  await writeFile(join(userData, RESET_MARKER), "", { flag: "wx", mode: 0o600 });
}

/** Apply the reset before opening any saved state or starting a connector. */
export async function applyFactoryReset(userData: string, clearBrowserData: () => Promise<void>) {
  try {
    await lstat(join(userData, RESET_MARKER));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const root = await realpath(userData);

  await clearBrowserData();
  for (const name of STATE_FILES) await rm(join(root, name), { force: true });
  for (const name of ["connectors", "workflows"]) {
    const path = join(root, name);
    const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    // Node unlinks a symbolic link or junction without traversing its target.
    if (entry?.isDirectory()) await rm(path, { recursive: true });
    else if (entry) await rm(path);
  }
  await rm(join(root, RESET_MARKER));
}
