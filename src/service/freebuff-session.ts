import type { IPty } from "node-pty";
import type { FreebuffTerminalEvent } from "../shared/contracts.js";
import { randomUUID } from "node:crypto";

export function createModelSubmissionDetector() {
  let line = "";
  let valid = true;
  let submitted = false;
  return (value: string, enter: boolean) => {
    if (submitted) return false;
    const input = value.replaceAll("\x1b[200~", "").replaceAll("\x1b[201~", "");
    if (enter && input === "\r" && valid && line.trim() === "/model") {
      submitted = true;
      return true;
    }
    for (const char of input) {
      if (char === "\r" || char === "\n" || char === "\u0003" || char === "\u0015") {
        valid = true;
        line = "";
      } else if (char === "\x7f" || char === "\b") {
        line = line.slice(0, -1);
      } else if (char < " " || line.length >= 32) {
        valid = false;
      } else if (valid) {
        line += char;
      }
    }
    return false;
  };
}

export function createFreebuffSessions(options: {
  copy: (text: string) => void;
  send: (event: FreebuffTerminalEvent) => void;
}) {
  const terminals = new Map<string, { runId: string; pty: IPty; input: (text: string, enter: boolean) => void }>();
  const opening = new Set<string>();

  function close(id: unknown) {
    if (typeof id !== "string") return;
    const session = terminals.get(id);
    if (!session) return;
    terminals.delete(id);
    try { session.pty.kill(); } catch { /* The CLI can exit while the panel closes. */ }
    options.send({ id, state: "closed" });
  }

  return {
    async open(runId: string, target: [string, ...string[]], cwd: string, prompt: string, isPending: () => boolean, onExit: () => void) {
      if (opening.has(runId) || [...terminals.values()].some((session) => session.runId === runId)) {
        throw new Error("This Freebuff handoff already has an open terminal.");
      }
      opening.add(runId);
      try {
        const { spawn } = await import("node-pty");
        if (!isPending()) throw new Error("This Freebuff handoff is no longer pending.");
        const id = randomUUID();
        const [file, ...args] = target;
        options.copy("/model");
        const pty = spawn(file, args, { name: "xterm-256color", cwd, cols: 90, rows: 24, useConptyDll: true });
        const submitted = createModelSubmissionDetector();
        const input = (data: string, enter: boolean) => {
          pty.write(data);
          if (!submitted(data, enter)) return;
          try {
            options.copy(prompt);
            options.send({ id, state: "copied" });
          } catch {
            options.send({ id, state: "clipboard-error" });
          }
        };
        terminals.set(id, { runId, pty, input });
        pty.onData((data) => { if (terminals.has(id)) options.send({ id, data }); });
        pty.onExit(() => {
          onExit();
          if (terminals.delete(id)) options.send({ id, state: "closed" });
        });
        return id;
      } finally {
        opening.delete(runId);
      }
    },
    input(id: unknown, data: unknown, enter: unknown) {
      const session = typeof id === "string" ? terminals.get(id) : undefined;
      if (!session) return;
      if (typeof data !== "string" || data.length > 32_000) throw new Error("Freebuff terminal input is too large.");
      session.input(data, enter === true);
    },
    close,
    closeRun(runId: unknown) {
      for (const [id, session] of terminals) if (session.runId === runId) close(id);
    },
    closeAll() {
      for (const id of terminals.keys()) close(id);
    },
  };
}
