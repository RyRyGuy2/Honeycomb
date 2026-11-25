import assert from "node:assert/strict";
import { test } from "node:test";
import { streamOpenCodeChat, streamProvider } from "../dist/providers/stream.js";

const fixture = String.raw`
  const lines = require("node:readline").createInterface({ input: process.stdin });
  let codex;
  let chat = false;
  let pendingPrompt;
  const write = (value) => console.log(JSON.stringify(value));
  lines.on("line", (line) => {
    const { id, method, params } = JSON.parse(line);
    if (method === "session/cancel" && pendingPrompt) {
      write({ id: pendingPrompt, result: { stopReason: "cancelled" } });
      return;
    }
    if (id === undefined) return;
    const reply = (result = {}) => write({ id, result });
    const notify = (method, params) => write({ method, params });
    if (method === "initialize") {
      codex = Boolean(params.clientInfo);
      reply();
    } else if (method === "thread/start") {
      if (params.sandbox !== "read-only" || params.approvalPolicy !== "never") process.exit(2);
      reply({ thread: { id: "t1" } });
    } else if (method === "session/new") {
      reply({ sessionId: "s1" });
    } else if (method === "session/set_mode" || method === "session/set_config_option") {
      if (method === "session/set_mode" && params.modeId.startsWith("honeycomb-chat-")) {
        chat = true;
        const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
        if (!config.agents[params.modeId] || !config.policies.some((rule) =>
          rule.action === "tool.use" && rule.resource === "*" && rule.effect === "deny")) process.exit(2);
      }
      reply();
    } else if (method === "turn/start" || method === "session/prompt") {
      if (codex) {
        reply({ turn: { id: "turn-1" } });
        notify("item/agentMessage/delta", { itemId: "m1", delta: "**Live" });
        setTimeout(() => {
          notify("item/agentMessage/delta", { itemId: "m1", delta: " reply**" });
          notify("item/completed", { item: { type: "agentMessage", id: "m1", text: "**Live reply**" } });
          notify("turn/completed", { turn: { status: "completed" } });
        }, 20);
      } else {
        const update = (update) => notify("session/update", { sessionId: "s1", update });
        if (chat) {
          if (params.prompt[0].text !== "User question:\n/compact") process.exit(2);
          pendingPrompt = id;
          update({ sessionUpdate: "tool_call", toolCallId: "tool", title: "skill" });
          return;
        }
        update({ sessionUpdate: "tool_call", toolCallId: "tool", title: "glob", rawInput: { pattern: "src/*" } });
        update({ sessionUpdate: "tool_call_update", toolCallId: "tool", status: "completed" });
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "**Live" } });
        setTimeout(() => {
          update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: " reply**" } });
          reply({ stopReason: "end_turn" });
        }, 20);
      }
    }
  });
`;

for (const provider of ["codex", "opencode"]) {
  test(provider + " streams Markdown chunks in order before completing", async () => {
    const events = [];
    let finished = false;
    await streamProvider(provider, {
      file: process.execPath, args: ["-e", fixture, "--"], cwd: process.cwd(), env: process.env, timeoutMs: 5000,
    }, "Prompt", provider === "opencode" ? "provider/model" : undefined, "2.4.1", (event) => {
      assert.equal(finished, false);
      events.push(event);
    }).then(() => { finished = true; });
    const chunks = events.filter((event) => event.type === "delta");
    assert.equal(chunks.map((chunk) => chunk.text).join(""), "**Live reply**");
    assert.equal(new Set(chunks.map((chunk) => chunk.id)).size, 1);
    if (provider === "opencode") {
      assert.deepEqual(events.slice(0, 2).map((event) => event.type), ["tool_call", "tool_result"]);
      assert.match(events[0].text, /src\/\*/);
    }
  });
}

test("OpenCode Chat passes slash commands as text and stops an unexpected tool request", async () => {
  const events = [];
  await assert.rejects(streamOpenCodeChat({
    file: process.execPath, args: ["-e", fixture, "--"], cwd: process.cwd(), env: process.env, timeoutMs: 5000,
  }, "/compact", "provider/model", "2.4.1", (event) => events.push(event)), /tried to use a tool/);
  assert.deepEqual(events, []);
});
