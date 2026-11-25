import assert from "node:assert/strict";
import { test } from "node:test";
import { promptWithHistory, replyText } from "../dist/service/runs.js";

const turn = (prompt, replies, status = "completed") => ({
  prompt, status, events: replies.map((text, index) => ({ type: "message", text, sequence: index + 1 })),
});

test("a follow-up carries the earlier turns, oldest first, before the new message", () => {
  const earlier = [turn("What is in src?", ["Three folders."]), turn("Which is biggest?", ["main", "by far."])];
  assert.equal(replyText(earlier[1]), "main\n\nby far.");
  const prompt = promptWithHistory(earlier, "Show me its entry point");
  assert.ok(prompt.indexOf("User: What is in src?") < prompt.indexOf("User: Which is biggest?"));
  assert.ok(prompt.includes("Assistant: main\n\nby far."));
  assert.ok(prompt.endsWith("Respond to the user's new message:\n\nShow me its entry point"));
});

test("the first message is sent as is, and long histories keep the newest turns", () => {
  assert.equal(promptWithHistory([], "Hello"), "Hello");
  const long = Array.from({ length: 40 }, (_, index) => turn(`question ${index}`, ["x".repeat(1_000)]));
  const prompt = promptWithHistory(long, "next");
  assert.ok(prompt.includes("question 39"));
  assert.ok(!prompt.includes("question 0\n"));
  assert.ok(prompt.length < 30_000);
});

test("turns without a reply say why", () => {
  assert.match(promptWithHistory([turn("Hi", [], "failed")], "again"), /\(no reply: the turn failed\)/);
});
