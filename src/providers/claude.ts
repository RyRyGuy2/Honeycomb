import type { ModelCatalog } from "../shared/contracts.js";
import { asRecord } from "../shared/records.js";
import type { ProviderAdapter, ProviderEvent } from "./types.js";

const SIGN_IN = "Claude Code isn't signed in. Run `claude` in a terminal and use /login, or set ANTHROPIC_API_KEY, then retry.";
const RATE_LIMIT = "Claude's model is rate limited or overloaded. Wait and retry, or select another model in Connectors.";
const REVIEW_PROMPT = "You are running a read-only review inside Honeycomb. Read and search the project, then answer in text. Leave the workspace unchanged.";

// Review runs may only read and search. Deny rules override any allow rule in the user's settings.
const ALLOWED_TOOLS = ["Read", "Grep", "Glob", "LS"];
const DENIED_TOOLS = [
  "Bash", "BashOutput", "KillBash", "KillShell", "Edit", "MultiEdit", "Write", "NotebookEdit",
  "WebFetch", "WebSearch", "Task", "SlashCommand", "Skill",
  "Read(./.env)", "Read(./.env.*)", "Read(**/.env)", "Read(**/.env.*)",
];

// Model aliases always resolve to the latest model of that family in the installed CLI.
const MODELS: ModelCatalog["models"] = [
  { id: "sonnet", name: "Sonnet (latest)", available: true, online: false },
  { id: "opus", name: "Opus (latest)", available: true, online: false },
  { id: "haiku", name: "Haiku (latest)", available: true, online: false },
];

export function parseClaudeModel(value: unknown): string {
  if (typeof value !== "string") throw new Error("Choose a Claude model from the list.");
  const model = value.trim();
  if (model && !/^[a-z0-9][a-z0-9._:\[\]-]{0,127}$/i.test(model)) {
    throw new Error("Choose a valid Claude model from the list.");
  }
  return model;
}

export function claudeModelCatalog(selected: string): ModelCatalog {
  return { models: MODELS, selected };
}

function failureMessage(text: string) {
  if (/\b401\b|authentication_error|failed to authenticate|token (has been )?revoked|log ?in again|invalid api key|\/login|not logged in/i.test(text)) return SIGN_IN;
  if (/\b(429|529)\b|rate_limit_error|overloaded_error|rate limit/i.test(text)) return RATE_LIMIT;
  return text;
}

export const claude: ProviderAdapter = {
  id: "claude",
  name: "Claude Code",
  // 2.x npm packages ship a native executable; 1.x shipped a JS entry point.
  npmLaunchers: [["@anthropic-ai", "claude-code", "bin", "claude.exe"], ["@anthropic-ai", "claude-code", "cli.js"]],
  override: "HONEYCOMB_CLAUDE_PATH",
  authEnvironment: [
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_GIT_BASH_PATH", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
    "AWS_REGION", "AWS_PROFILE", "ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION",
    "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
  ],
  secretEnvironment: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
  probeEnvironment: { DISABLE_AUTOUPDATER: "1" },
  // `--setting-sources user` keeps the reviewed project's .claude settings (and their hooks) out of the run.
  requiredHelpFlags: ["--setting-sources", "--strict-mcp-config", "--disallowedTools"],
  helpIssue: "This Claude Code CLI is too old for safe review runs. Run `claude update`, then refresh.",
  parseVersion(output) {
    return output.match(/(\d+\.\d+\.\d+[^\s]*)\s*\(Claude Code\)/i)?.[1];
  },
  command(prompt, model) {
    return {
      args: [
        "-p", "--output-format", "stream-json", "--verbose",
        "--setting-sources", "user",
        "--strict-mcp-config",
        "--permission-mode", "default",
        "--allowedTools", ...ALLOWED_TOOLS,
        "--disallowedTools", ...DENIED_TOOLS,
        "--append-system-prompt", REVIEW_PROMPT,
        ...(model ? ["--model", model] : []),
      ],
      input: prompt,
      env: {
        DISABLE_AUTOUPDATER: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
    };
  },
  diagnoseStderr(stderr) {
    if (/invalid api key|please run \/login|not logged in/i.test(stderr)) return SIGN_IN;
    if (/\b429\b|rate limit/i.test(stderr)) return RATE_LIMIT;
  },
  decode(event) {
    const message = asRecord(event.message);
    const content = Array.isArray(message?.content) ? message.content.map(asRecord) : [];

    if (event.type === "assistant") {
      // The CLI reports API errors as a synthetic message and repeats them in the result event.
      if (message?.model === "<synthetic>") return;
      const events: ProviderEvent[] = [];
      for (const block of content) {
        if (block?.type === "text") events.push({ type: "message", text: block.text });
        if (block?.type === "tool_use" && typeof block.name === "string") {
          events.push({ type: "tool_call", text: `Claude Code used ${block.name}.` });
        }
      }
      return events.length ? { events } : undefined;
    }
    if (event.type === "user") {
      const failed = content.filter((block) => block?.type === "tool_result" && block.is_error === true).length;
      if (failed) return { event: { type: "tool_result", text: failed === 1 ? "A Claude Code tool call was denied or failed." : `${failed} Claude Code tool calls were denied or failed.` } };
      return;
    }
    if (event.type !== "result") return;

    const usage = asRecord(event.usage);
    const count = (value: unknown) => (typeof value === "number" ? value : 0);
    const cached = usage?.cache_read_input_tokens;
    const usageEvent = {
      type: "usage" as const,
      inputTokens: usage ? count(usage.input_tokens) + count(usage.cache_creation_input_tokens) + count(cached) : undefined,
      outputTokens: usage?.output_tokens,
      cachedTokens: cached,
      costUsd: event.total_cost_usd,
    };
    if (event.is_error === true || event.subtype !== "success") {
      const detail = typeof event.result === "string" && event.result.trim()
        ? event.result
        : event.subtype === "error_max_turns" ? "Claude Code reached its turn limit." : "Claude Code reported a failed run.";
      return { failed: failureMessage(detail), event: usageEvent };
    }
    return { completed: true, event: usageEvent };
  },
};
