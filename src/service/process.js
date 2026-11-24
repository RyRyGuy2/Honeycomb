import { spawn } from "node:child_process";
import { join } from "node:path";

const WINDOWS = process.platform === "win32";
const MAX_DIAGNOSTIC_LENGTH = 2_000;
const MAX_EVENT_LENGTH = 512_000;

export function readJsonLines(onEvent) {
  let line = "";
  let skipping = false;

  function readLine() {
    const candidate = line.trim();
    line = "";
    if (skipping || !candidate.startsWith("{")) return;

    let event;
    try {
      event = JSON.parse(candidate);
    } catch {
      return;
    }
    onEvent(event);
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

function terminateTree(child) {
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
  file, args, cwd, env, input = "", timeoutMs, signal, stdout,
}) {
  if (signal?.aborted) return Promise.resolve({ stopped: "cancelled" });

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
    let stopped;
    let error;

    function stop(reason) {
      if (stopped) return;
      stopped = reason;
      terminateTree(child);
    }

    const cancel = () => stop("cancelled");
    const deadline = setTimeout(() => stop("timeout"), timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });

    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      if (stdout) stdout.write(chunk);
      else output = (output + chunk).slice(-MAX_DIAGNOSTIC_LENGTH);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-MAX_DIAGNOSTIC_LENGTH);
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
