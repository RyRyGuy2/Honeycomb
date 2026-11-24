const AGENT = "honeycomb-review";
const toolPermissions = {
  "*": "deny",
  read: {
    "*": "allow",
    ".env*": "deny",
    "*/.env*": "deny",
    "*.env": "deny",
    "*.env.*": "deny",
  },
  glob: "allow",
  grep: "allow",
  external_directory: "deny",
};

export const opencode = {
  id: "opencode",
  name: "OpenCode",
  npmLauncher: ["opencode-ai", "bin", "opencode"],
  override: "HONEYCOMB_OPENCODE_PATH",
  authEnvironment: [],
  probeEnvironment: { OPENCODE_DISABLE_AUTOUPDATE: "true" },
  parseVersion(output) {
    return output.match(/^\s*(\d+\.\d+\.\d+[^\s]*)\s*$/m)?.[1];
  },
  versionIssue(version) {
    const [major, minor] = version.split(".").map(Number);
    if (major !== 1 || minor < 14) return "This adapter uses OpenCode 1.14 or a later 1.x release.";
  },
  command(prompt) {
    return {
      args: ["run", "--format", "json", "--pure", "--agent", AGENT],
      input: prompt,
      env: {
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_DISABLE_PROJECT_CONFIG: "true",
        OPENCODE_DISABLE_CLAUDE_CODE: "true",
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          share: "disabled",
          agent: {
            [AGENT]: {
              mode: "primary",
              description: "Read and explain the selected project",
              prompt: "Review the project and answer in text. Leave the workspace unchanged.",
              permission: toolPermissions,
            },
          },
        }),
      },
    };
  },
  decode(event) {
    const part = event.part;
    if (event.type === "error") {
      return { failed: event.error?.data?.message || event.error?.name || "OpenCode reported a failed run." };
    }
    if (event.type === "text") {
      return { event: { type: "message", text: part?.text } };
    }
    if (event.type === "tool_use" && part?.tool) {
      const status = part.state?.status === "error" ? "failed" : "finished";
      return { event: { type: "tool_result", text: `OpenCode ${part.tool} ${status}.` } };
    }
    if (event.type === "step_finish") {
      return {
        completed: part?.reason === "stop" || part?.reason === "length",
        event: {
          type: "usage",
          inputTokens: part?.tokens?.input,
          outputTokens: part?.tokens?.output,
          cachedTokens: part?.tokens?.cache?.read,
          costUsd: part?.cost,
        },
      };
    }
  },
};
