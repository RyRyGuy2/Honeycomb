import assert from "node:assert/strict";
import { test } from "node:test";
import { createRunService } from "../dist/service/runs.js";

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
