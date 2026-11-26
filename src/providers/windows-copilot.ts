import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ChatMessage } from "./http-chat.js";
import type { StreamEvent } from "./stream.js";
import type { Connector, Run } from "../shared/contracts.js";

export const COPILOT_ID = "windows-copilot";
export const COPILOT_NAME = "Microsoft Copilot for Windows";
const HELPER = fileURLToPath(new URL("./windows-copilot.exe", import.meta.url));
const APP_ID = /^(?:Microsoft\.Copilot_8wekyb3d8bbwe|Microsoft\.MicrosoftOfficeHub_8wekyb3d8bbwe)![\w.]+$/i;

function nativeApp() {
  const roots = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA];
  for (const root of roots) {
    if (!root) continue;
    const file = join(root, "Microsoft", "Copilot", "Application", "copilotapp.exe");
    if (existsSync(file)) return file;
  }
}

async function registeredApp(signal: AbortSignal) {
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    const { stdout } = await promisify(execFile)(powershell, [
      "-NoProfile", "-NonInteractive", "-Command", "Get-StartApps | Where-Object { $_.Name -in 'Copilot','Microsoft Copilot','Microsoft 365 Copilot' } | Select-Object -ExpandProperty AppID",
    ], { windowsHide: true, timeout: 7500, signal });
    const ids = stdout.split(/\r?\n/).map((line) => line.trim()).filter((id) => APP_ID.test(id));
    return ids.find((id) => id.startsWith("Microsoft.Copilot_")) ?? ids[0];
  } catch {
    return undefined;
  }
}

export function createWindowsCopilot(copy: (text: string) => void) {
  let handoff: { run: Run; prompt: string; resolve: (text: string) => void } | undefined;

  async function open(signal: AbortSignal) {
    const native = nativeApp();
    const appId = native ? undefined : await registeredApp(signal);
    if (!native && !appId) throw new Error("Install or open the Microsoft Copilot app on Windows, then refresh Connectors.");
    signal.throwIfAborted();
    const explorer = join(process.env.SystemRoot ?? "C:\\Windows", "explorer.exe");
    const child = spawn(native ?? explorer, native ? [] : [`shell:AppsFolder\\${appId}`], { stdio: "ignore", detached: true });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () => reject(new Error("Windows could not open the Microsoft Copilot app.")));
    });
    child.unref();
  }

  function runHelper(file: string, prompt: string, thread: string | undefined, signal: AbortSignal, onSubmitted: (thread: string) => void) {
    return new Promise<string | undefined>((resolve, reject) => {
      const helper = spawn(HELPER, [file], { windowsHide: true, signal, stdio: ["pipe", "pipe", "ignore"] });
      let buffer = "";
      let reply: string | undefined;
      let failure: Error | undefined;
      helper.on("error", reject);
      helper.stdin.on("error", () => {});
      helper.stdout.setEncoding("utf8");
      helper.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 2_000_000) { helper.kill(); return; }
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const [type, value] = line.trimEnd().split("\t", 2);
          if (type === "SUBMITTED") onSubmitted(value ?? "");
          if (type === "THREAD" && value) onSubmitted(value);
          if (type === "REPLY" && value) reply = Buffer.from(value, "base64").toString("utf8");
          if (type === "WRONG_THREAD") failure = new Error("Open this conversation in the Copilot app before sending a follow-up.");
        }
      });
      helper.on("close", () => failure ? reject(failure) : resolve(reply));
      helper.stdin.end(`${thread ?? ""}\n${Buffer.from(prompt, "utf8").toString("base64")}\n`);
    });
  }

  return {
    async inspect(signal: AbortSignal): Promise<Connector> {
      const native = process.platform === "win32" && Boolean(nativeApp());
      const installed = native || (process.platform === "win32" && Boolean(await registeredApp(signal)));
      return {
        id: COPILOT_ID, name: COPILOT_NAME, chatOnly: true, status: installed ? "detected" : "missing",
        detail: installed ? "Opens the signed-in Windows app to send and read replies. If desktop controls are unavailable, paste the reply into Honeycomb."
          : process.platform === "win32" ? "Install the Microsoft Copilot app from Microsoft Store." : "Available on Windows.",
      };
    },
    async stream(run: Run, messages: ChatMessage[], signal: AbortSignal, receive: (event: StreamEvent) => void, update: () => void) {
      const prompt = run.prompt;
      const fallbackPrompt = !run.copilotThread && messages.length > 1
        ? `Continue this conversation using the prior messages as context.\n\n${JSON.stringify(messages.slice(0, -1))}\n\nLatest message:\n${prompt}`
        : prompt;
      const file = nativeApp();
      let submitted = false;
      let reply: string | undefined;
      if (file && existsSync(HELPER)) {
        const helperSignal = AbortSignal.any([signal, AbortSignal.timeout(265_000)]);
        try {
          reply = await runHelper(file, run.copilotThread ? prompt : fallbackPrompt, run.copilotThread, helperSignal, (thread) => {
            submitted = true;
            if (thread) run.copilotThread = thread;
          });
        } catch (error) {
          if (!helperSignal.aborted || signal.aborted) throw error;
        }
      }
      signal.throwIfAborted();
      if (!reply?.trim()) {
        if (!submitted) {
          await open(signal);
          signal.throwIfAborted();
          copy(fallbackPrompt);
        }
        reply = await new Promise<string>((resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          handoff = { run, prompt: fallbackPrompt, resolve: (text) => {
            signal.removeEventListener("abort", abort);
            resolve(text);
          } };
          run.copilotHandoff = submitted ? "reply" : "prompt";
          update();
        }).finally(() => {
          handoff = undefined;
          delete run.copilotHandoff;
        });
      }
      receive({ type: "message", id: "windows-copilot", text: reply });
    },
    copyDraft(id: unknown) {
      if (!handoff || handoff.run.id !== id || handoff.run.copilotHandoff !== "prompt") {
        throw new Error("This Copilot draft is no longer available.");
      }
      copy(handoff.prompt);
    },
    reply(id: unknown, text: unknown) {
      if (!handoff || handoff.run.id !== id) throw new Error("This Copilot response is no longer pending.");
      if (typeof text !== "string" || !text.trim() || text.length > 1_000_000 || text.includes("\0")) {
        throw new Error("Paste the reply from Microsoft Copilot.");
      }
      handoff.resolve(text.trim());
    },
  };
}
