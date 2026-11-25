import { asRecord } from "../shared/records.js";
import type { ProviderAdapter } from "./types.js";

const AGENT = "honeycomb-review";
const RATE_LIMIT = "OpenCode's model is rate limited. Wait and retry, or select another configured model in Connectors.";

// OpenCode 2.x is a different CLI generation: `--pure` is gone, log levels are
// lowercase, and its built-in read-only `plan` agent replaces our custom one.
export function isOpenCodeV2(version: string | undefined) {
  return Number(version?.split(".")[0]) >= 2;
}

export function parseOpenCodeModel(value: unknown): string {
  if (typeof value !== "string") throw new Error("Enter a model ID in provider/model format.");
  const model = value.trim();
  if (model && (model.length > 256 || !/^[\w][\w.-]*\/[\w.:+@-]+(?:\/[\w.:+@-]+)*$/.test(model))) {
    throw new Error("Enter a model ID in provider/model format, or leave it blank to use the default.");
  }
  return model;
}
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

export const opencode: ProviderAdapter = {
  id: "opencode",
  name: "OpenCode",
  npmLaunchers: [
    ["@opencode", "cli", "bin", "opencode.exe"],
    ["opencode-ai", "bin", "opencode"],
  ],
  override: "HONEYCOMB_OPENCODE_PATH",
  authEnvironment: [],
  probeEnvironment: { OPENCODE_DISABLE_AUTOUPDATE: "true" },
  parseVersion(output) {
    return output.match(/^\s*(?:opencode\s+)?v?(\d+\.\d+\.\d+[^\s]*)\s*$/im)?.[1];
  },
  versionIssue(version) {
    const [major = 0, minor = 0] = version.split(".").map(Number);
    if (major < 1 || (major === 1 && minor < 14)) return "This adapter uses OpenCode 1.14 or newer.";
  },
  command(prompt, model, version) {
    const current = isOpenCodeV2(version);
    const args = ["run", "--format", "json"];
    if (!current) args.push("--pure");
    args.push("--agent", current ? "plan" : AGENT, "--print-logs", "--log-level", current ? "error" : "ERROR");
    if (model) args.push("--model", model);
    return {
      args,
      input: prompt,
      env: {
        // Each Honeycomb review starts a new session with its own schema.
        OPENCODE_DB: ":memory:",
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_DISABLE_PROJECT_CONFIG: "true",
        OPENCODE_DISABLE_CLAUDE_CODE: "true",
        ...(current ? {} : {
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
        }),
      },
    };
  },
  diagnoseStderr(stderr) {
    if (/rate limit exceeded|"statusCode"\s*:\s*429/i.test(stderr)) return RATE_LIMIT;
  },
  decode(event) {
    const part = asRecord(event.part);
    if (event.type === "error") {
      const error = asRecord(event.error);
      const data = asRecord(error?.data);
      const message = data?.message;
      if (data?.statusCode === 429 || (typeof message === "string" && /rate limit exceeded/i.test(message))) {
        return { failed: RATE_LIMIT };
      }
      const name = typeof error?.name === "string" ? error.name : "";
      return { failed: (typeof message === "string" && message) || name || "OpenCode reported a failed run." };
    }
    if (event.type === "text") {
      return { event: { type: "message", text: part?.text } };
    }
    if (event.type === "tool_use" && typeof part?.tool === "string" && part.tool) {
      const status = asRecord(part.state)?.status === "error" ? "failed" : "finished";
      return { event: { type: "tool_result", text: `OpenCode ${part.tool} ${status}.` } };
    }
    if (event.type === "step_finish") {
      const tokens = asRecord(part?.tokens);
      return {
        completed: part?.reason === "stop" || part?.reason === "length",
        event: {
          type: "usage",
          inputTokens: tokens?.input,
          outputTokens: tokens?.output,
          cachedTokens: asRecord(tokens?.cache)?.read,
          costUsd: part?.cost,
        },
      };
    }
  },
};
