import assert from "node:assert/strict";
import { test } from "node:test";
import { streamCodexChat, streamCodexEdit, streamOpenCodeChat, streamOpenCodeEdit, streamProvider } from "../dist/providers/stream.js";

const fixture = String.raw`
  const lines = require("node:readline").createInterface({ input: process.stdin });
  let codex;
  let experimentalApi;
  let chat = false;
  const edit = process.env.FIXTURE_EDIT === "1";
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
      experimentalApi = params.capabilities?.experimentalApi;
      reply();
    } else if (method === "account/read") {
      chat = true;
      reply({ account: process.env.FIXTURE_ACCOUNT ? { type: process.env.FIXTURE_ACCOUNT } : null });
    } else if (method === "thread/start") {
      if (params.sandbox !== (edit ? "workspace-write" : "read-only") || params.approvalPolicy !== "never") process.exit(2);
      if (edit && (params.cwd !== process.cwd() || !params.ephemeral)) process.exit(2);
      if (chat && (!experimentalApi || !params.ephemeral || params.environments?.length !== 0 ||
        params.model !== (process.env.FIXTURE_MODEL || undefined) ||
        !params.developerInstructions?.includes("Answer the user's question directly in text") ||
        !process.argv.includes("shell_tool"))) process.exit(2);
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
      if (method === "session/set_mode" && process.env.FIXTURE_EDIT === "1" && params.modeId === "honeycomb-edit") {
        const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
        if (!config.agents[params.modeId] || !config.agents[params.modeId].permissions.some((rule) =>
          rule.action === "edit" && rule.resource === "*" && rule.effect === "allow")) process.exit(2);
      }
      reply();
    } else if (method === "turn/start" || method === "session/prompt") {
      if (codex) {
        if (edit) {
          const policy = params.sandboxPolicy;
          if (params.cwd !== process.cwd() || params.approvalPolicy !== "never" || policy?.type !== "workspaceWrite" ||
            policy.writableRoots?.length !== 1 || policy.writableRoots[0] !== process.cwd() || policy.networkAccess !== false ||
            !policy.excludeTmpdirEnvVar || !policy.excludeSlashTmp) process.exit(2);
        } else if (params.sandboxPolicy) process.exit(2);
        reply({ turn: { id: "turn-1" } });
        if (chat) {
          if (params.effort !== "low" || params.input[0].type !== "text") process.exit(2);
          if (params.input[0].text === "Tool attempt") {
            notify("item/started", { item: { type: "commandExecution" } });
            return;
          }
          if (params.input[0].text !== "A question") process.exit(2);
        }
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

test("Codex Chat uses the CLI's ChatGPT login and streams text", async () => {
  const events = [];
  const transport = {
    file: process.execPath, args: ["-e", fixture, "--"], cwd: process.cwd(), timeoutMs: 5000,
    env: { ...process.env, FIXTURE_ACCOUNT: "chatgpt" },
  };
  await streamCodexChat(transport, "A question", undefined, (event) => events.push(event), "low");
  assert.equal(events.filter(({ type }) => type === "delta").map(({ text }) => text).join(""), "**Live reply**");
  const unexpected = [];
  await assert.rejects(streamCodexChat({ ...transport, env: { ...transport.env, FIXTURE_MODEL: "gpt-5.4" } },
    "Tool attempt", "gpt-5.4", (event) => unexpected.push(event), "low"), /tried to use a tool/);
  await assert.rejects(streamCodexChat({ ...transport, env: { ...process.env, FIXTURE_ACCOUNT: "apiKey" } },
    "A question", "gpt-5.4", (event) => unexpected.push(event), "low"), /codex login/);
  assert.deepEqual(unexpected, []);
});

test("Codex edit turns restrict the write sandbox to the worktree", async () => {
  const events = [];
  await streamCodexEdit({
    file: process.execPath, args: ["-e", fixture, "--"], cwd: process.cwd(),
    timeoutMs: 5000, env: { ...process.env, FIXTURE_EDIT: "1" },
  }, "Fix a test", undefined, (event) => events.push(event));
  assert.equal(events.find(({ type }) => type === "message")?.text, "**Live reply**");
});

test("OpenCode edit sessions use the scoped edit agent", async () => {
  const events = [];
  await streamOpenCodeEdit({
    file: process.execPath, args: ["-e", fixture, "--"], cwd: process.cwd(), timeoutMs: 5000,
    env: { ...process.env, FIXTURE_EDIT: "1" },
  }, "Fix it", "provider/model", "2.4.1", (event) => events.push(event));
  assert.deepEqual(events.slice(0, 2).map((event) => event.type), ["tool_call", "tool_result"]);
  assert.equal(events.filter(({ type }) => type === "delta").map(({ text }) => text).join(""), "**Live reply**");
});

test("OpenCode Chat passes slash commands as text and stops an unexpected tool request", async () => {
  const events = [];
  await assert.rejects(streamOpenCodeChat({
    file: process.execPath, args: ["-e", fixture, "--"], cwd: process.cwd(), env: process.env, timeoutMs: 5000,
  }, "/compact", "provider/model", "2.4.1", (event) => events.push(event)), /tried to use a tool/);
  assert.deepEqual(events, []);
});
