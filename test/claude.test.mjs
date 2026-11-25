import assert from "node:assert/strict";
import { test } from "node:test";
import { claude, claudeModelCatalog, parseClaudeModel } from "../dist/providers/claude.js";

const decodeAll = (lines) => lines.map((line) => claude.decode(line)).filter(Boolean);

test("Claude Code runs headless with read-only tools and without project settings or MCP servers", () => {
  const { args, input, env } = claude.command("Review the fixture");
  assert.equal(input, "Review the fixture");
  assert.deepEqual(args.slice(0, 4), ["-p", "--output-format", "stream-json", "--verbose"]);
  assert.equal(args[args.indexOf("--setting-sources") + 1], "user");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  assert.ok(!args.includes("--model"));

  const allowed = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--disallowedTools"));
  assert.deepEqual(allowed, ["Read", "Grep", "Glob", "LS"]);
  const denied = args.slice(args.indexOf("--disallowedTools") + 1, args.indexOf("--append-system-prompt"));
  for (const tool of ["Bash", "Edit", "MultiEdit", "Write", "NotebookEdit", "WebFetch", "Task", "Read(**/.env)"]) {
    assert.ok(denied.includes(tool), `${tool} is denied`);
  }
  assert.equal(env.DISABLE_AUTOUPDATER, "1");
  assert.deepEqual(claude.requiredHelpFlags, ["--setting-sources", "--strict-mcp-config", "--disallowedTools"]);
});

test("the selected Claude model is passed through and aliases are offered", () => {
  const { args } = claude.command("hello", parseClaudeModel(" sonnet "));
  assert.deepEqual(args.slice(-2), ["--model", "sonnet"]);
  assert.equal(parseClaudeModel(""), "");
  assert.equal(parseClaudeModel("claude-sonnet-4-5[1m]"), "claude-sonnet-4-5[1m]");
  assert.throws(() => parseClaudeModel("--model"), /valid Claude model/);
  assert.throws(() => parseClaudeModel("opus; rm"), /valid Claude model/);
  assert.deepEqual(claudeModelCatalog("opus").models.map(({ id }) => id), ["sonnet", "opus", "haiku"]);
  assert.equal(claudeModelCatalog("opus").selected, "opus");
});

test("Claude Code version output is recognized", () => {
  assert.equal(claude.parseVersion("1.0.108 (Claude Code)\n"), "1.0.108");
  assert.equal(claude.parseVersion("2.1.3 (Claude Code)"), "2.1.3");
  assert.equal(claude.parseVersion("v22.19.0"), undefined);
});

test("a successful stream yields messages, tool activity and the final usage once", () => {
  const updates = decodeAll([
    { type: "system", subtype: "init", model: "claude-sonnet", tools: ["Read", "Grep"] },
    { type: "assistant", message: { model: "claude-sonnet", content: [
      { type: "text", text: "Looking at the layout." },
      { type: "tool_use", id: "t1", name: "Glob", input: { pattern: "**/*" } },
    ], usage: { input_tokens: 9, output_tokens: 9 } } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a.ts" }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", is_error: true, content: "denied" }] } },
    { type: "assistant", message: { model: "claude-sonnet", content: [{ type: "text", text: "The entry point is a.ts." }] } },
    { type: "result", subtype: "success", is_error: false, result: "The entry point is a.ts.", total_cost_usd: 0.0123,
      usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 40 } },
  ]);
  const events = updates.flatMap((update) => [...(update.event ? [update.event] : []), ...(update.events ?? [])]);
  assert.deepEqual(events.map((event) => event.type), ["message", "tool_call", "tool_result", "message", "usage"]);
  assert.equal(events[1].text, "Claude Code used Glob.");
  assert.deepEqual(events.at(-1), { type: "usage", inputTokens: 115, outputTokens: 40, cachedTokens: 100, costUsd: 0.0123 });
  assert.equal(updates.at(-1).completed, true);
  assert.equal(updates.some((update) => update.failed), false);
});

test("a revoked sign-in reported as an error result fails with sign-in guidance", () => {
  // Captured from Claude Code 1.0.108 with a revoked OAuth token: the result says success but is_error is true.
  const api = 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked."}} · Please run /login';
  const updates = decodeAll([
    { type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: api }] } },
    { type: "result", subtype: "success", is_error: true, result: api, total_cost_usd: 0,
      usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } },
  ]);
  assert.equal(updates.length, 1);
  assert.match(updates[0].failed, /isn't signed in.*\/login/);
  assert.notEqual(updates[0].completed, true);
});

test("limit and rate errors have clear messages", () => {
  assert.match(claude.decode({ type: "result", subtype: "error_max_turns", is_error: true }).failed, /turn limit/);
  assert.match(claude.decode({ type: "result", subtype: "success", is_error: true, result: "API Error: 529 overloaded_error" }).failed, /rate limited or overloaded/);
  assert.match(claude.diagnoseStderr("Invalid API key · Please run /login"), /signed in/);
  // Wording from Claude Code 2.1.332 with a revoked sign-in.
  assert.match(claude.decode({ type: "result", subtype: "success", is_error: true,
    result: "Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator." }).failed, /isn't signed in/);
});
