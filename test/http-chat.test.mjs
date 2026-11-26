import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listHttpChatModels, streamHttpChat } from "../dist/providers/http-chat.js";
import { createChatProfileStore } from "../dist/service/chat-profiles.js";
import { createRunService } from "../dist/service/runs.js";

const baseUrl = "http://localhost:1234/api/v1";

test("one OpenAI-compatible transport discovers models and streams text across chunk boundaries", async (t) => {
  const connection = { name: "Test server", model: "", apiKey: "test-token", baseUrl };
  t.mock.method(globalThis, "fetch", async (url, request) => {
    assert.equal(request.headers.get("Authorization"), "Bearer test-token");
    assert.equal(request.redirect, "error");
    if (url === `${baseUrl}/models`) return Response.json({ data: [{ id: "local/model" }, { id: "local/model" }] });
    assert.equal(url, `${baseUrl}/chat/completions`);
    assert.deepEqual(JSON.parse(request.body), {
      model: "local/model", stream: true, messages: [{ role: "user", content: "Hello" }],
    });
    const event = Buffer.from('data: {"choices":[{"delta":{"content":"Hi 🌻"}}]}\r\n\r\n');
    const body = new ReadableStream({
      start(stream) {
        stream.enqueue(event.subarray(0, event.indexOf(0xf0) + 1));
        stream.enqueue(event.subarray(event.indexOf(0xf0) + 1));
        stream.enqueue(Buffer.from('data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n'));
        stream.close();
      },
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  });
  const signal = AbortSignal.timeout(4000);
  const catalog = await listHttpChatModels(connection, signal);
  assert.equal(catalog.selected, "local/model");
  assert.equal(catalog.models.length, 1);
  const events = [];
  await streamHttpChat(connection, catalog.selected, [{ role: "user", content: "Hello" }], signal, (event) => events.push(event));
  assert.equal(events[0].text, "Hi 🌻");
  assert.equal(events[1].outputTokens, 2);
});

test("manual models survive a discovery failure and stream cancellation reaches the transport", async (t) => {
  const connection = { name: "Test server", model: "", manualModel: "manual", baseUrl };
  t.mock.method(globalThis, "fetch", async (url, { signal }) => {
    if (url.endsWith("/models")) return new Response(null, { status: 404 });
    const body = new ReadableStream({
      start(stream) {
        signal.addEventListener("abort", () => stream.error(signal.reason), { once: true });
        stream.enqueue(Buffer.from('data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n'));
      },
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  });
  const catalog = await listHttpChatModels(connection, AbortSignal.timeout(4000));
  assert.equal(catalog.selected, "manual");
  assert.match(catalog.localError, /discovery is unavailable/);
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(4000)]);
  await assert.rejects(streamHttpChat(connection, catalog.selected, [{ role: "user", content: "Hello" }], signal, () => controller.abort()),
    { name: "AbortError" });
});

test("profiles persist model choices and protect saved keys when the endpoint changes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "honeycomb-chat-profiles-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = () => join(directory, "chat-profiles.json");
  const secrets = { encrypt: (key) => Buffer.from(key).toString("base64"), decrypt: (key) => Buffer.from(key, "base64").toString() };
  const store = createChatProfileStore(filename, secrets);
  const settings = { preset: "freellmapi", name: "Router", baseUrl: "http://localhost:3001/v1/", manualModel: "", apiKey: "fixture-key" };
  const profile = await store.save(settings);
  assert.equal(profile.baseUrl, "http://localhost:3001/v1");
  assert.equal(profile.hasApiKey, true);
  assert.equal(profile.encryptedKey, undefined);
  await store.setModel(profile.id, "chosen/model");
  assert.doesNotMatch(await readFile(filename(), "utf8"), /fixture-key/);
  const restored = createChatProfileStore(filename, secrets);
  await restored.load();
  assert.equal(restored.connection(profile.id).apiKey, "fixture-key");
  assert.equal(restored.find(profile.id).model, "chosen/model");
  await assert.rejects(restored.save({ ...settings, id: profile.id, baseUrl: "https://example.com/v1", apiKey: undefined }), /API key/);
  await restored.remove(profile.id);
  assert.equal(restored.list().length, 0);
});

test("direct connectors only run in Chat and send completed follow-ups as role messages", async () => {
  const requests = [];
  let completion;
  const service = createRunService((run) => {
    if (run.status === "completed") completion?.();
  }, undefined, undefined, (id) => id === "chat:fixture" ? {
    id, name: "Fixture",
    async stream(_run, messages, _signal, receive) {
      requests.push(messages);
      receive({ type: "delta", id: "reply", text: "Earlier answer" });
    },
  } : undefined);
  const request = { providerId: "chat:fixture", prompt: "Earlier question" };
  assert.throws(() => service.start({ name: "Project", path: process.cwd() }, request), /Choose an available Code connector/);
  const first = new Promise((resolve) => { completion = resolve; });
  const id = service.start(undefined, { ...request, mode: "chat" });
  await first;
  const second = new Promise((resolve) => { completion = resolve; });
  service.start(undefined, { ...request, mode: "chat", conversationId: id, prompt: "Follow-up" });
  await second;
  assert.deepEqual(requests[1], [
    { role: "user", content: "Earlier question" },
    { role: "assistant", content: "Earlier answer" },
    { role: "user", content: "Follow-up" },
  ]);
});
