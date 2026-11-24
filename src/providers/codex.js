export const codex = {
  id: "codex",
  name: "Codex",
  npmLauncher: ["@openai", "codex", "bin", "codex.js"],
  override: "HONEYCOMB_CODEX_PATH",
  authEnvironment: ["CODEX_HOME", "CODEX_API_KEY", "OPENAI_API_KEY"],
  parseVersion(output) {
    return output.match(/codex-cli (\d+\.\d+\.\d+[^\s]*)/)?.[1];
  },
  command(prompt) {
    return {
      args: [
        "--ask-for-approval", "never",
        "--config", 'web_search="disabled"',
        "exec", "--json", "--color", "never", "--sandbox", "read-only",
        "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "-",
      ],
      input: prompt,
    };
  },
  decode(event) {
    const item = event.item;

    if (event.type === "turn.completed") {
      return {
        completed: true,
        event: {
          type: "usage",
          inputTokens: event.usage?.input_tokens,
          outputTokens: event.usage?.output_tokens,
          cachedTokens: event.usage?.cached_input_tokens,
        },
      };
    }
    if (event.type === "turn.failed") {
      return { failed: event.error?.message || "Codex reported a failed turn." };
    }
    if (event.type === "error") return { diagnostic: event.message };

    if (event.type === "item.started" && item?.type === "command_execution") {
      return { event: { type: "tool_call", text: "Codex started a command." } };
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
