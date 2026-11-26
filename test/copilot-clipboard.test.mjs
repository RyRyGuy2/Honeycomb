import assert from "node:assert/strict";
import { test } from "node:test";
import { copilotCodeBlock } from "../dist/renderer/copilot-clipboard.js";

test("Copilot code previews preserve indentation and code containing backtick fences", () => {
  const source = "function example() {\r\n  return '```';\r\n}\r\n";
  assert.equal(copilotCodeBlock(source, "javascript"), "````javascript\nfunction example() {\n  return '```';\n}\n````");
});
