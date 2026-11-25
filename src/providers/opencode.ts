import { asRecord } from "../shared/records.js";
import type { ProviderAdapter } from "./types.js";

const AGENT = "honeycomb-review";
export const OPENCODE_EDIT_AGENT = "honeycomb-edit";
const EDIT_INSTRUCTIONS = "You are editing inside a dedicated Git worktree created by Honeycomb. The working directory is that worktree. Make the requested change there only, run focused tests when they help verify it, then summarize what changed. Do not modify any other checkout.";
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
const readPermissions = {
  "*": "allow",
  ".env*": "deny",
  "*/.env*": "deny",
  "*.env": "deny",
  "*.env.*": "deny",
};
const toolPermissions = {
  "*": "deny",
  read: readPermissions,
  glob: "allow",
  grep: "allow",
  external_directory: "deny",
};
// Edits are allowed only in the worktree Honeycomb uses as the run's cwd. Shell runs with the
// host user's authority, so every permission request is still denied by the ACP client.
const editToolPermissions = {
  ...toolPermissions,
  write: "allow",
  edit: "allow",
  patch: "allow",
  bash: "allow",
};
const editPolicies = (["skill", "mcp", "websearch", "plugin"] as const).map((action) => ({
  action: `${action}.use`, resource: "*", effect: "deny",
}));
const v2EditPermissions = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "deny" },
  { action: "read", resource: "*.env.*", effect: "deny" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "edit", resource: "*", effect: "allow" },
  { action: "shell", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "deny" },
];

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
  command(prompt, model, version, mode = "review") {
    const current = isOpenCodeV2(version);
    const edit = mode === "edit";
    const agent = edit ? OPENCODE_EDIT_AGENT : current ? "plan" : AGENT;
    const args = ["run", "--format", "json"];
    if (!current) args.push("--pure");
    args.push("--agent", agent, "--print-logs", "--log-level", current ? "error" : "ERROR");
    if (model) args.push("--model", model);
    const config = edit ? current ? {
      tools: { skill: false },
      agents: {
        title: { disabled: true },
        [OPENCODE_EDIT_AGENT]: {
          mode: "primary",
          system: EDIT_INSTRUCTIONS,
          permissions: v2EditPermissions,
        },
      },
      policies: editPolicies,
    } : {
      share: "disabled",
      agent: {
        title: { disable: true },
        [OPENCODE_EDIT_AGENT]: {
          mode: "primary",
          description: "Edit the selected project inside its worktree",
          prompt: EDIT_INSTRUCTIONS,
          permission: editToolPermissions,
        },
      },
      permission: editToolPermissions,
    } : current ? undefined : {
      share: "disabled",
      agent: {
        [AGENT]: {
          mode: "primary",
          description: "Read and explain the selected project",
          prompt: "Review the project and answer in text. Leave the workspace unchanged.",
          permission: toolPermissions,
        },
      },
    };
    return {
      args,
      input: prompt,
      env: {
        // Each Honeycomb run starts a new session with its own schema.
        OPENCODE_DB: ":memory:",
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_DISABLE_PROJECT_CONFIG: "true",
        OPENCODE_DISABLE_CLAUDE_CODE: "true",
        ...(config ? { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) } : {}),
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
      const state = asRecord(part.state);
      const status = state?.status === "error" ? "failed" : "finished";
      const input = asRecord(state?.input);
      const target = [input?.command, input?.filePath, input?.path, input?.pattern]
        .find((value): value is string => typeof value === "string" && Boolean(value.trim()));
      const detail = target ? `\n${target.slice(0, 500)}` : "";
      return { event: { type: "tool_result", text: `OpenCode ${part.tool} ${status}.${detail}` } };
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
