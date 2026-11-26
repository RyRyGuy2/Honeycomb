import assert from "node:assert/strict";
import { test } from "node:test";
import { configuredConnectors } from "../dist/shared/connectors.js";
import { providers } from "../dist/providers/index.js";
import { streamHeadlessCli } from "../dist/providers/stream.js";

test("the connector sidebar only includes connected and configured connectors", () => {
  const connectors = [
    { id: "codex", name: "Codex", status: "detected" },
    { id: "opencode", name: "OpenCode", status: "missing" },
    { id: "claude", name: "Claude Code", status: "checking" },
    { id: "chat:local", name: "Local", status: "detected", chatOnly: true },
    { id: "windows-copilot", name: "Microsoft Copilot for Windows", status: "missing", chatOnly: true },
    { id: "copilot-web", name: "Copilot Web", status: "detected", chatOnly: true },
  ];

  assert.deepEqual(configuredConnectors(connectors).map((connector) => connector.id), [
    "codex", "chat:local", "copilot-web",
  ]);
});

test("Antigravity passes prompts through JSON stdin and reports its result and usage", async () => {
  const provider = providers.get("antigravity");
  const events = [];
  const script = `
    const assert = require("node:assert/strict");
    const args = process.argv.slice(1);
    assert.ok(args.includes("--sandbox") && args.includes("plan"));
    const { message } = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    assert.ok(message.content.endsWith("A multiline\\nprompt"));
    console.log(JSON.stringify({ event: "result", result: {
      status: "SUCCESS", response: "Antigravity reply", usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 4 },
    } }));
  `;
  await streamHeadlessCli(provider, {
    file: process.execPath, args: ["-e", script, "--"], env: process.env, timeoutMs: 5000,
  }, "A multiline\nprompt", undefined, "review", (event) => events.push(event));
  assert.deepEqual(events, [
    { type: "usage", inputTokens: 10, outputTokens: 2, cachedTokens: 4 },
    { type: "message", id: "antigravity", text: "Antigravity reply" },
  ]);
});

test("GitHub Copilot sends a review prompt over stdin with read tools and reports authentication failures", async () => {
  const provider = providers.get("github-copilot");
  const events = [];
  const transport = (script) => ({ file: process.execPath, args: ["-e", script, "--"], env: process.env, timeoutMs: 5000 });
  await streamHeadlessCli(provider, transport(`
    const assert = require("node:assert/strict");
    assert.ok(process.argv.includes("--available-tools=view,grep,glob"));
    assert.ok(process.argv.includes("--deny-tool=shell,write,url"));
    assert.ok(require("node:fs").readFileSync(0, "utf8").endsWith("Review this project"));
    process.stdout.write("Copilot reply");
  `), "Review this project", undefined, "review", (event) => events.push(event));
  assert.deepEqual(events, [{ type: "message", id: "github-copilot", text: "Copilot reply" }]);
  await assert.rejects(streamHeadlessCli(provider, transport(`
    console.error("No authentication information found");
    process.exitCode = 1;
  `), "Hello", undefined, "chat", () => assert.fail("No reply is expected")), /Run copilot login/);
});
