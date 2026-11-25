import type { ModelCatalog } from "../shared/contracts.js";
import { asRecord } from "../shared/records.js";
import { readJsonLines, runProcess } from "../service/process.js";
import type { StreamEvent } from "./stream.js";
import type { ProviderAdapter } from "./types.js";

const SIGN_IN = "Claude Code isn't signed in. Run `claude` in a terminal and use /login, or set ANTHROPIC_API_KEY, then retry.";
const RATE_LIMIT = "Claude's model is rate limited or overloaded. Wait and retry, or select another model in Connectors.";
const REVIEW_PROMPT = "You are running a read-only review inside Honeycomb. Read and search the project, then answer in text. Leave the workspace unchanged.";
const CHAT_PROMPT = "You are answering a question inside Honeycomb's Chat mode. No tools are available. Answer the user's question directly in text.";

// Code runs may only read and search. `--tools` limits which tools exist; the deny rules also override
// any allow rule in the user's settings and keep secrets out of reads.
const REVIEW_TOOLS = ["Read", "Grep", "Glob"];
const DENIED_TOOLS = [
  "Bash", "Edit", "MultiEdit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Task", "Skill",
  "Read(./.env)", "Read(./.env.*)", "Read(**/.env)", "Read(**/.env.*)",
];
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// Model aliases always resolve to the latest model of that family in the installed CLI.
const MODELS: ModelCatalog["models"] = [
  { id: "sonnet", name: "Sonnet (latest)", available: true, online: false, efforts: CLAUDE_EFFORTS },
  { id: "opus", name: "Opus (latest)", available: true, online: false, efforts: CLAUDE_EFFORTS },
  { id: "haiku", name: "Haiku (latest)", available: true, online: false, efforts: [] },
];

export interface ClaudeRunOptions {
  model?: string;
  effort?: string;
  chat?: boolean;
}

interface ClaudeTransport {
  file: string;
  args: readonly string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  onStderr?: (tail: string) => void;
}

export function parseClaudeModel(value: unknown): string {
  if (typeof value !== "string") throw new Error("Choose a Claude model from the list.");
  const model = value.trim();
  if (model && !/^[a-z0-9][a-z0-9._:\[\]-]{0,127}$/i.test(model)) {
    throw new Error("Choose a valid Claude model from the list.");
  }
  return model;
}

export function claudeModelCatalog(selected: string): ModelCatalog {
  return { models: MODELS, selected, defaultEfforts: CLAUDE_EFFORTS };
}

function failureMessage(text: string) {
  if (/\b401\b|authentication_error|failed to authenticate|token (has been )?revoked|log ?in again|invalid api key|\/login|not logged in/i.test(text)) return SIGN_IN;
  if (/\b(429|529)\b|rate_limit_error|overloaded_error|rate limit/i.test(text)) return RATE_LIMIT;
  return text;
}

export function claudeArgs({ model, effort, chat = false }: ClaudeRunOptions = {}): string[] {
  return [
    "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    // Keep the folder's .claude settings and hooks, MCP servers, slash commands and saved sessions out of the run.
    "--setting-sources", "user",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--permission-mode", "default",
    ...(chat
      ? ["--tools", "", "--append-system-prompt", CHAT_PROMPT]
      : ["--tools", REVIEW_TOOLS.join(","), "--allowedTools", ...REVIEW_TOOLS, "--disallowedTools", ...DENIED_TOOLS,
        "--append-system-prompt", REVIEW_PROMPT]),
    ...(model ? ["--model", model] : []),
    ...(effort ? ["--effort", effort] : []),
  ];
}

const CLAUDE_ENV = { DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };

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
  requiredHelpFlags: [
    "--setting-sources", "--strict-mcp-config", "--tools", "--include-partial-messages",
    "--disable-slash-commands", "--no-session-persistence", "--effort",
  ],
  helpIssue: "This Claude Code CLI is too old for safe review runs. Run `claude update`, then refresh.",
  parseVersion(output) {
    return output.match(/(\d+\.\d+\.\d+[^\s]*)\s*\(Claude Code\)/i)?.[1];
  },
  command(prompt, model) {
    return { args: claudeArgs({ model }), input: prompt, env: CLAUDE_ENV };
  },
  diagnoseStderr(stderr) {
    if (/invalid api key|please run \/login|not logged in|failed to authenticate/i.test(stderr)) return SIGN_IN;
    if (/\b429\b|rate limit/i.test(stderr)) return RATE_LIMIT;
  },
  // Decodes the final result line. Streaming text and tool activity are handled by streamClaude.
  decode(event) {
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
    // A revoked sign-in arrives as subtype "success" with is_error set.
    if (event.is_error === true || event.subtype !== "success") {
      const detail = typeof event.result === "string" && event.result.trim()
        ? event.result
        : event.subtype === "error_max_turns" ? "Claude Code reached its turn limit." : "Claude Code reported a failed run.";
      return { failed: failureMessage(detail), event: usageEvent };
    }
    return { completed: true, event: usageEvent };
  },
};

function toolTarget(input: Record<string, unknown> | undefined) {
  const target = [input?.file_path, input?.path, input?.pattern]
    .find((value): value is string => typeof value === "string" && Boolean(value.trim()));
  return target ? "\n" + target.slice(0, 500) : "";
}

export async function streamClaude(
  transport: ClaudeTransport, prompt: string, options: ClaudeRunOptions, publish: (event: StreamEvent) => void,
) {
  const tools = new Map<string, string>();
  const streamed = new Set<string>();
  let current = "";
  let unnamed = 0;
  let failed: string | undefined;
  let completed = false;

  const stdout = readJsonLines((line) => {
    if (line.type === "stream_event") {
      const event = asRecord(line.event);
      if (event?.type === "message_start") {
        const id = asRecord(event.message)?.id;
        current = typeof id === "string" ? id : "message-" + ++unnamed;
      }
      const delta = asRecord(event?.delta);
      if (event?.type === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
        streamed.add(current);
        publish({ type: "delta", id: current + ":" + String(event.index ?? 0), text: delta.text });
      }
      return;
    }
    const message = asRecord(line.message);
    const content = Array.isArray(message?.content) ? message.content.map(asRecord) : [];
    if (line.type === "assistant") {
      // The CLI reports API errors as a synthetic message and repeats them in the result line.
      if (message?.model === "<synthetic>") return;
      const id = typeof message?.id === "string" ? message.id : "message-" + ++unnamed;
      content.forEach((block, index) => {
        if (block?.type === "text" && typeof block.text === "string" && !streamed.has(id)) {
          publish({ type: "message", id: id + ":text-" + index, text: block.text });
        }
        if (block?.type === "tool_use" && typeof block.name === "string") {
          if (typeof block.id === "string") tools.set(block.id, block.name);
          publish({ type: "tool_call", text: "Claude Code " + block.name + toolTarget(asRecord(block.input)) });
        }
      });
      return;
    }
    if (line.type === "user") {
      for (const block of content) {
        if (block?.type !== "tool_result") continue;
        const name = (typeof block.tool_use_id === "string" && tools.get(block.tool_use_id)) || "tool";
        publish({ type: "tool_result", text: "Claude Code " + name + (block.is_error === true ? " failed." : " finished.") });
      }
      return;
    }
    const update = claude.decode(line);
    if (!update) return;
    failed = update.failed ?? failed;
    completed ||= Boolean(update.completed);
    if (update.event?.type === "usage") publish(update.event);
  });

  const result = await runProcess({
    file: transport.file,
    args: [...transport.args, ...claudeArgs(options)],
    cwd: transport.cwd,
    env: { ...transport.env, ...CLAUDE_ENV },
    input: prompt,
    timeoutMs: transport.timeoutMs,
    signal: transport.signal,
    stdout,
    onStderr: transport.onStderr,
  });
  if (result.stopped === "cancelled") return;
  if (failed) throw new Error(failed);
  if (result.stopped === "timeout") throw new Error("The run reached its five-minute limit.");
  if (result.error) throw new Error(result.error);
  if (!completed) {
    throw new Error(claude.diagnoseStderr?.(result.stderr) || result.stderr.trim() || "Claude Code exited without completing the run.");
  }
}
