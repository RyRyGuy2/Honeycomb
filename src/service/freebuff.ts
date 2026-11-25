import { spawn } from "node:child_process";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join, relative } from "node:path";
import type { FreebuffExchange } from "../shared/contracts.js";
import { asRecord } from "../shared/records.js";
import { isInside } from "./worktree.js";

export const FREEBUFF_EXPORT_PATTERN = /^freebuff-result(?:-\d{13})?\.md$/;
const FREEBUFF_CHAT_FILE_LIMIT = 16 * 1024 * 1024;
const FREEBUFF_REPLY_LIMIT = 12_000;
const FREEBUFF_PROMPT_LIMIT = 4_000;

export async function readSavedFreebuffExchange(
  worktreePath: string,
  configDir = process.env.FREEBUFF_CONFIG_DIR || join(homedir(), ".config", "manicode"),
): Promise<FreebuffExchange | undefined> {
  if (!isAbsolute(configDir)) return;
  try {
    // Freebuff stores chat history under the basename of the project folder.
    const config = await realpath(configDir);
    const expected = join(config, "projects", basename(worktreePath), "chats");
    const chats = await realpath(expected);
    if (relative(expected, chats)) return;
    let latest: { path: string; modified: number } | undefined;
    for (const entry of await readdir(chats, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}T[\d.-]+Z$/.test(entry.name)) continue;
      const path = join(chats, entry.name, "chat-messages.json");
      const info = await lstat(path).catch(() => undefined);
      if (info?.isFile() && info.size && (!latest || info.mtimeMs > latest.modified)) {
        latest = { path, modified: info.mtimeMs };
      }
    }
    if (!latest) return;
    const path = await realpath(latest.path);
    if (!isInside(chats, path)) return;
    const file = await open(path, "r");
    try {
      const { size } = await file.stat();
      if (size > FREEBUFF_CHAT_FILE_LIMIT) return;
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await file.read(buffer);
      const messages: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      if (!Array.isArray(messages)) return;
      for (let index = messages.length - 1; index >= 0; index--) {
        const message = asRecord(messages[index]);
        if (message?.variant !== "ai" || message.isComplete !== true) continue;
        const text = Array.isArray(message.blocks) && message.blocks.length
          ? message.blocks.map(asRecord).filter((block) =>
              block?.type === "text" && block.textType !== "reasoning" && block.status !== "running" &&
              typeof block.content === "string",
            ).map((block) => block?.content).join("\n\n")
          : typeof message.content === "string" ? message.content : "";
        const reply = historyExcerpt(text, FREEBUFF_REPLY_LIMIT);
        if (!reply) continue;
        for (let previous = index - 1; previous >= 0; previous--) {
          const user = asRecord(messages[previous]);
          if (user?.variant === "user") {
            const prompt = typeof user.content === "string" ? historyExcerpt(user.content, FREEBUFF_PROMPT_LIMIT) : "";
            return { prompt: prompt || undefined, reply };
          }
        }
        return { reply };
      }
    } finally {
      await file.close();
    }
  } catch {
    // History can be missing, mid-write, or in a format from another CLI version.
  }
}

function historyExcerpt(text: string, limit: number) {
  const clean = text.replaceAll("\0", "").trim();
  const marker = "\n[Earlier text omitted]\n";
  return clean.length <= limit ? clean : clean.slice(0, 32) + marker + clean.slice(-(limit - 32 - marker.length));
}

export async function findFreebuffTranscript(worktreePath: string) {
  const root = await realpath(worktreePath);
  const entries = (await readdir(root, { withFileTypes: true })).filter((entry) =>
    entry.isFile() && FREEBUFF_EXPORT_PATTERN.test(entry.name));
  entries.sort((a, b) => b.name.length - a.name.length || b.name.localeCompare(a.name));
  for (const entry of entries) {
    const path = await realpath(join(root, entry.name)).catch(() => undefined);
    if (path && isInside(root, path) && (await stat(path).catch(() => undefined))?.size) return path;
  }
}

export async function readFreebuffTranscript(worktreePath: string) {
  const path = await findFreebuffTranscript(worktreePath);
  if (!path) throw new Error("Run /export freebuff-result.md in this Freebuff worktree first, or use Copy export command.");
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const buffer = Buffer.alloc(Math.min(size, 24_000));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, size - buffer.length);
    const transcript = buffer.subarray(0, bytesRead).toString("utf8").replace(/^\uFFFD/, "").replaceAll("\0", "").trim();
    if (!transcript) throw new Error("The Freebuff export is empty.");
    return size > buffer.length ? "[Earlier transcript omitted]\n" + transcript : transcript;
  } finally {
    await file.close();
  }
}

export async function findFreebuffTerminal() {
  if (process.platform !== "win32") throw new Error("Freebuff handoff currently requires Windows Terminal.");
  const directories = (process.env.PATH ?? "").split(delimiter)
    .map((path) => path.trim().replace(/^"(.*)"$/, "$1")).filter(isAbsolute);
  async function find(parts: string[], allowAlias = false) {
    for (const directory of directories) {
      const file = join(directory, ...parts);
      const info = await (allowAlias ? lstat(file) : stat(file)).catch(() => undefined);
      if (info?.isFile() || (allowAlias && info?.isSymbolicLink())) return file;
    }
  }
  // Windows exposes wt.exe as an execution alias. Node cannot stat its target.
  const terminal = await find(["wt.exe"], true);
  if (!terminal) throw new Error("Install Windows Terminal and enable its wt.exe execution alias.");
  const native = await find(["freebuff.exe"]);
  if (native) return { terminal, command: [native] };
  const [node, entry] = await Promise.all([find(["node.exe"]), find(["node_modules", "freebuff", "index.js"])]);
  if (!node || !entry) throw new Error("Install Freebuff with npm install -g freebuff, then restart Honeycomb.");
  return { terminal, command: [node, entry] };
}

export async function openFreebuffTerminal(target: Awaited<ReturnType<typeof findFreebuffTerminal>>, path: string, resume = false) {
  const args = ["-w", "new", "new-tab", "-d", path, ...target.command, ...(resume ? ["--continue"] : [])];
  if (args.some((arg) => /[;\r\n]/.test(arg))) throw new Error("Open Freebuff manually in this worktree. Windows Terminal cannot safely use its path.");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(target.terminal, args, { cwd: path, stdio: "ignore", windowsHide: false, shell: false });
    let startup: ReturnType<typeof setTimeout> | undefined;
    child.once("spawn", () => {
      // Windows Terminal can hand off to another process or stay open for the session.
      startup = setTimeout(() => {
        child.unref();
        resolve();
      }, 750);
    });
    child.once("error", (error) => {
      clearTimeout(startup);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(startup);
      if (code === 0) resolve();
      else reject(new Error("Windows Terminal could not open Freebuff."));
    });
  });
}
