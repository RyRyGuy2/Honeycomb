import { asRecord } from "../shared/records.js";
import type { ProviderAdapter } from "./types.js";

export function parseCodexModel(value: unknown): string {
  if (typeof value !== "string") throw new Error("Choose a Codex model from the list.");
  const model = value.trim();
  if (model && !/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(model)) {
    throw new Error("Choose a valid Codex model from the list.");
  }
  return model;
}

export const codex: ProviderAdapter = {
  id: "codex",
  name: "Codex",
  npmLaunchers: [["@openai", "codex", "bin", "codex.js"]],
  override: "HONEYCOMB_CODEX_PATH",
  authEnvironment: ["CODEX_HOME", "CODEX_API_KEY", "OPENAI_API_KEY"],
  parseVersion(output) {
    return output.match(/codex-cli (\d+\.\d+\.\d+[^\s]*)/)?.[1];
  },
  command(prompt, model) {
    return {
      args: [
        "--ask-for-approval", "never",
        "--config", 'web_search="disabled"',
        "exec", "--json", "--color", "never", "--sandbox", "read-only",
        ...(model ? ["--model", model] : []),
        "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "-",
      ],
      input: prompt,
    };
  },
  decode(event) {
    const item = asRecord(event.item);

    if (event.type === "turn.completed") {
      const usage = asRecord(event.usage);
      return {
        completed: true,
        event: {
          type: "usage",
          inputTokens: usage?.input_tokens,
          outputTokens: usage?.output_tokens,
          cachedTokens: usage?.cached_input_tokens,
        },
      };
    }
    if (event.type === "turn.failed") {
      const message = asRecord(event.error)?.message;
      return { failed: (typeof message === "string" && message) || "Codex reported a failed turn." };
    }
    if (event.type === "error" && typeof event.message === "string") {
      return { diagnostic: event.message };
    }

    if (event.type === "item.started" && item?.type === "command_execution") {
      const command = typeof item.command === "string" ? `\n${item.command.slice(0, 500)}` : "";
      return { event: { type: "tool_call", text: `Codex started a command.${command}` } };
    }
    if (event.type !== "item.completed") return;

    if (item?.type === "agent_message") {
      return { event: { type: "message", text: item.text } };
    }
    if (item?.type === "command_execution") {
      const text = item.status === "failed"
        ? "Codex command failed."
        : "Codex command finished.";
      return { event: { type: "tool_result", text } };
    }
  },
};
