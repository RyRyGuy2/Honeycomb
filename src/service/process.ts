import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { asRecord } from "../shared/records.js";

const WINDOWS = process.platform === "win32";
const MAX_DIAGNOSTIC_LENGTH = 2_000;
const MAX_EVENT_LENGTH = 512_000;

interface StdoutReader {
  write(chunk: string): void;
  end(): void;
}

interface ProcessOptions {
  file: string;
  args: readonly string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  stdout?: StdoutReader;
  onStderr?: (tail: string) => void;
  outputLimit?: number;
}

type StopReason = "cancelled" | "timeout";

interface ProcessResult {
  code: number | null;
  output: string;
  stderr: string;
  stopped?: StopReason;
  error?: string;
}

export function readJsonLines(onEvent: (event: Record<string, unknown>) => void): StdoutReader {
  let line = "";
  let skipping = false;

  function readLine() {
    const candidate = line.trim();
    line = "";
    if (skipping || !candidate.startsWith("{")) return;

    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      return;
    }
    const event = asRecord(value);
    if (event) onEvent(event);
  }

  return {
    write(chunk) {
      const fragments = chunk.split("\n");
      for (const [index, fragment] of fragments.entries()) {
        if (index > 0) {
          readLine();
          skipping = false;
        }
        if (skipping) continue;

        if (line.length + fragment.length > MAX_EVENT_LENGTH) {
          line = "";
          skipping = true;
        } else {
          line += fragment;
        }
      }
    },
    end: readLine,
  };
}

function terminateTree(child: ChildProcess) {
  if (!child.pid) return;

  if (WINDOWS) {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const taskkill = spawn(join(systemRoot, "System32", "taskkill.exe"), [
      "/PID", String(child.pid), "/T", "/F",
    ], { stdio: "ignore", windowsHide: true });
    taskkill.once("error", () => child.kill());
    taskkill.once("exit", (code) => {
      if (code !== 0) child.kill();
    });
    return;
  }

  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

export function runProcess({
  file, args, cwd, env, input = "", timeoutMs, signal, stdout, onStderr, outputLimit = MAX_DIAGNOSTIC_LENGTH,
}: ProcessOptions): Promise<ProcessResult> {
  if (signal?.aborted) {
    return Promise.resolve({ code: null, output: "", stderr: "", stopped: "cancelled" });
  }

  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd,
      env,
      shell: false,
      detached: !WINDOWS,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let stderr = "";
    let stopped: StopReason | undefined;
    let error: string | undefined;

    function stop(reason: StopReason) {
      if (stopped) return;
      stopped = reason;
      terminateTree(child);
    }

    const cancel = () => stop("cancelled");
    const deadline = setTimeout(() => stop("timeout"), timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout) stdout.write(chunk);
      else output = (output + chunk).slice(-outputLimit);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_DIAGNOSTIC_LENGTH);
      onStderr?.(stderr);
    });
    child.stdin.on("error", () => {
      // The CLI can exit before consuming the prompt. Its exit and stderr report the failure.
    });
    child.once("error", (failure) => { error = failure.message; });
    child.once("close", (code) => {
      clearTimeout(deadline);
      signal?.removeEventListener("abort", cancel);
      stdout?.end();
      resolve({ code, output, stderr, stopped, error });
    });
    child.stdin.end(input);
  });
}
