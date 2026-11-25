import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claude, claudeArgs, claudeModelCatalog, parseClaudeModel, streamClaude } from "../dist/providers/claude.js";
import { parseEffort } from "../dist/providers/stream.js";

const valueOf = (args, flag) => args[args.indexOf(flag) + 1];
const listAfter = (args, flag) => {
  const start = args.indexOf(flag) + 1;
  const end = args.findIndex((arg, index) => index >= start && arg.startsWith("--"));
  return args.slice(start, end === -1 ? undefined : end);
};

test("Code runs are headless, read-only and ignore project settings, MCP servers and slash commands", () => {
  const args = claudeArgs({});
  assert.deepEqual(args.slice(0, 5), ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
  assert.equal(valueOf(args, "--setting-sources"), "user");
  for (const flag of ["--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]) assert.ok(args.includes(flag), flag);
  assert.equal(valueOf(args, "--permission-mode"), "default");
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  assert.equal(valueOf(args, "--tools"), "Read,Grep,Glob");
  assert.deepEqual(listAfter(args, "--allowedTools"), ["Read", "Grep", "Glob"]);
  const denied = listAfter(args, "--disallowedTools");
  for (const tool of ["Bash", "Edit", "Write", "WebFetch", "Task", "Read(**/.env)"]) assert.ok(denied.includes(tool), tool);
  assert.ok(!args.includes("--model") && !args.includes("--effort"));
  assert.ok(claude.requiredHelpFlags.includes("--setting-sources"));
  assert.ok(claude.requiredHelpFlags.includes("--tools"));
});

test("Chat runs turn every tool off and pass the model and thinking level", () => {
  const args = claudeArgs({ chat: true, model: parseClaudeModel(" opus "), effort: parseEffort("xhigh", "claude") });
  assert.equal(valueOf(args, "--tools"), "");
  assert.ok(!args.includes("--allowedTools"));
  assert.equal(valueOf(args, "--model"), "opus");
  assert.equal(valueOf(args, "--effort"), "xhigh");
  assert.throws(() => parseEffort("ultra", "claude"), /thinking level/);
});

test("models, versions and model IDs are recognized", () => {
  const catalog = claudeModelCatalog("opus");
  assert.deepEqual(catalog.models.map(({ id }) => id), ["sonnet", "opus", "haiku"]);
  assert.equal(catalog.selected, "opus");
  assert.deepEqual(catalog.models.find(({ id }) => id === "opus").efforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(parseClaudeModel("claude-sonnet-4-5[1m]"), "claude-sonnet-4-5[1m]");
  assert.throws(() => parseClaudeModel("--model"), /valid Claude model/);
  assert.throws(() => parseClaudeModel("opus; rm"), /valid Claude model/);
  assert.equal(claude.parseVersion("1.0.108 (Claude Code)\n"), "1.0.108");
  assert.equal(claude.parseVersion("2.1.332 (Claude Code)"), "2.1.332");
  assert.equal(claude.parseVersion("v22.19.0"), undefined);
});

test("result lines report usage, and error results fail with actionable messages", () => {
  const done = claude.decode({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.0123,
    usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 40 } });
  assert.equal(done.completed, true);
  assert.deepEqual(done.event, { type: "usage", inputTokens: 115, outputTokens: 40, cachedTokens: 100, costUsd: 0.0123 });

  // Captured from Claude Code 1.0.108 and 2.1.332 with a revoked sign-in.
  for (const result of [
    'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked."}} · Please run /login',
    "Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.",
  ]) {
    const update = claude.decode({ type: "result", subtype: "success", is_error: true, result });
    assert.match(update.failed, /isn't signed in.*\/login/);
    assert.notEqual(update.completed, true);
  }
  assert.match(claude.decode({ type: "result", subtype: "error_max_turns", is_error: true }).failed, /turn limit/);
  assert.match(claude.decode({ type: "result", subtype: "success", is_error: true, result: "API Error: 529 overloaded_error" }).failed, /rate limited or overloaded/);
  assert.match(claude.diagnoseStderr("Invalid API key · Please run /login"), /signed in/);
});

// A stand-in for the CLI: it checks its flags and prompt, then replays a stream-json transcript.
const fixture = String.raw`
  const args = process.argv.slice(1);
  const flag = (name) => args[args.indexOf(name) + 1];
  if (flag("--setting-sources") !== "user" || !args.includes("--include-partial-messages")) process.exit(3);
  let prompt = "";
  process.stdin.on("data", (chunk) => { prompt += chunk; });
  process.stdin.on("end", () => {
    if (prompt !== "Map the repo") process.exit(4);
    const write = (value) => console.log(JSON.stringify(value));
    const stream = (event) => write({ type: "stream_event", event });
    if (flag("--model") === "broken") {
      write({ type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: "API Error: 401" }] } });
      write({ type: "result", subtype: "success", is_error: true, result: "Failed to authenticate: OAuth token revoked. Please log in again." });
      return;
    }
    write({ type: "system", subtype: "init", tools: ["Read", "Grep", "Glob"] });
    stream({ type: "message_start", message: { id: "msg1" } });
    stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Looking " } });
    stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "around." } });
    write({ type: "assistant", message: { id: "msg1", model: "claude", content: [{ type: "text", text: "Looking around." }] } });
    write({ type: "assistant", message: { id: "msg1", model: "claude", content: [
      { type: "tool_use", id: "t1", name: "Glob", input: { pattern: "**/*.ts" } },
    ] } });
    write({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a.ts" }] } });
    write({ type: "assistant", message: { id: "msg2", model: "claude", content: [{ type: "text", text: "The entry point is a.ts." }] } });
    write({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01,
      usage: { input_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 7, output_tokens: 20 } });
  });
`;

async function runFixture(t, options) {
  const cwd = await mkdtemp(join(tmpdir(), "honeycomb-claude-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const events = [];
  const run = streamClaude(
    { file: process.execPath, args: ["-e", fixture, "--"], cwd, env: { PATH: process.env.PATH ?? "" }, timeoutMs: 20_000 },
    "Map the repo", options, (event) => events.push(event),
  );
  return { run, events };
}

test("a streamed run yields live text, tool activity and the final usage", async (t) => {
  const { run, events } = await runFixture(t, { model: "sonnet" });
  await run;
  assert.deepEqual(events.map((event) => event.type), ["delta", "delta", "tool_call", "tool_result", "message", "usage"]);
  assert.deepEqual(events.slice(0, 2).map(({ id, text }) => [id, text]), [["msg1:0", "Looking "], ["msg1:0", "around."]]);
  assert.equal(events[2].text, "Claude Code Glob\n**/*.ts");
  assert.equal(events[3].text, "Claude Code Glob finished.");
  assert.equal(events[4].text, "The entry point is a.ts.");
  assert.deepEqual(events[5], { type: "usage", inputTokens: 10, outputTokens: 20, cachedTokens: 7, costUsd: 0.01 });
});

test("a streamed sign-in failure rejects with sign-in guidance and shows no error text as a reply", async (t) => {
  const { run, events } = await runFixture(t, { model: "broken" });
  await assert.rejects(run, /isn't signed in/);
  assert.equal(events.some((event) => event.type === "message" || event.type === "delta"), false);
});
