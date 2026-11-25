import assert from "node:assert/strict";
import { test } from "node:test";
import { streamCodexChat } from "../dist/providers/codex-chat.js";
import { createRunService } from "../dist/service/runs.js";

test("Codex Chat sends a text-only request and streams the reply", async () => {
  const chunks = [
    'data: {"type":"response.output_text.delta","item_id":"a","delta":"**One"}\n\n',
    'data: {"type":"response.output_text.delta","item_id":"a","delta":" answer**"}\n\n',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":3}}}\n\n',
  ];
  const events = [];
  await streamCodexChat("test-key", "A question", "gpt-5-mini", new AbortController().signal, (event) => {
    events.push(event);
  }, "low", async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.deepEqual(JSON.parse(init.body), {
      model: "gpt-5-mini", input: "A question", tools: [], tool_choice: "none", store: false, stream: true, reasoning: { effort: "low" },
    });
    return new Response(new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk.slice(0, 14)));
          controller.enqueue(encoder.encode(chunk.slice(14)));
        }
        controller.close();
      },
    }));
  });
  assert.equal(events.filter(({ type }) => type === "delta").map(({ text }) => text).join(""), "**One answer**");
  assert.equal(events.find(({ type }) => type === "usage").outputTokens, 3);
});

test("Chat does not attach the selected project to a run", async () => {
  const service = createRunService(() => {});
  assert.throws(() => service.start(undefined, { providerId: "opencode", prompt: "Example", mode: "code" }), /project folder/);
  service.start({ name: "Existing project", path: process.cwd() }, { providerId: "opencode", prompt: "Example", mode: "chat" });
  const [run] = service.history();
  assert.equal(run.mode, "chat");
  assert.equal(run.folder, undefined);
  await service.shutdown();
  assert.equal(run.status, "cancelled");
});
