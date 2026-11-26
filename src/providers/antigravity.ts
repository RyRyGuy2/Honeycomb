import { homedir } from "node:os";
import { join } from "node:path";
import { asRecord } from "../shared/records.js";
import type { ProviderAdapter } from "./types.js";

export const antigravity: ProviderAdapter = {
  id: "antigravity",
  name: "Google Antigravity CLI",
  executableName: "agy",
  installDirectories: [process.platform === "win32"
    ? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "agy", "bin")
    : join(homedir(), ".local", "bin")],
  npmLaunchers: [],
  override: "HONEYCOMB_ANTIGRAVITY_PATH",
  authEnvironment: [],
  probeEnvironment: { AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
  requiredHelpFlags: ["--input-format", "--output-format", "--mode", "--sandbox"],
  parseVersion(output) {
    return output.match(/(?:^|\b)v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)(?=\s|$)/i)?.[1];
  },
  command(prompt, model, _version, mode, effort) {
    const content = mode === "chat"
      ? "Answer directly as a text conversation without calling tools.\n\n" + prompt
      : "Review the project using read-only tools and report your findings.\n\n" + prompt;
    return {
      args: ["--input-format", "stream-json", "--output-format", "stream-json", "--mode", "plan", "--sandbox",
        ...(model ? ["--model=" + model] : []), ...(effort ? ["--effort=" + effort] : [])],
      input: JSON.stringify({ event: "user", message: { content } }) + "\n",
    };
  },
  decode(line) {
    const step = asRecord(line.step_update);
    if (line.event === "step_update" && step?.step_type === "tool" && typeof step.tool_name === "string") {
      if (step.state === "ACTIVE") return { event: { type: "tool_call", text: step.tool_name } };
      if (step.state === "DONE") return { event: { type: "tool_result", text: step.tool_name + " finished." } };
    }
    if (line.event !== "result") return;
    const result = asRecord(line.result);
    if (result?.status !== "SUCCESS") {
      return { failed: typeof result?.error === "string" ? result.error : "Antigravity did not complete the turn." };
    }
    const usage = asRecord(result.usage);
    return {
      completed: true,
      events: [
        { type: "message", text: result.response },
        { type: "usage", inputTokens: usage?.input_tokens, outputTokens: usage?.output_tokens, cachedTokens: usage?.cache_read_tokens },
      ],
    };
  },
  diagnoseStderr(stderr) {
    if (/authentication required|not (?:logged|signed) in|failed to authenticate/i.test(stderr)) {
      return "Run agy in a terminal and sign in to Google Antigravity, then try again.";
    }
  },
};
