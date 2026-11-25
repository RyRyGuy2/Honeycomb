import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCodexCatalog } from "../dist/providers/codex-models.js";
import { codex, parseCodexModel } from "../dist/providers/codex.js";

test("the Codex picker uses visible model slugs from the CLI catalog", () => {
  const models = parseCodexCatalog(JSON.stringify({ models: [
    { slug: "codex-first", display_name: "First model", visibility: "list" },
    { slug: "codex-hidden", visibility: "hide" },
    { slug: "codex-first", display_name: "Duplicate" },
    { slug: "codex-second" },
    { slug: "--invalid", visibility: "list" },
  ] }));
  assert.deepEqual(models.map(({ id, name }) => [id, name]), [
    ["codex-first", "First model"], ["codex-second", "codex-second"],
  ]);
  assert.throws(() => parseCodexCatalog("{}"), /model catalog/);
});

test("the Codex adapter passes a selected model and preserves the CLI default", () => {
  const original = codex.command("Review the fixture");
  assert.equal(original.args.includes("--model"), false);
  const selected = codex.command("Review the fixture", parseCodexModel(" codex-first "));
  const index = selected.args.indexOf("--model");
  assert.equal(selected.args[index + 1], "codex-first");
  assert.equal(selected.args.at(-1), "-");
  assert.equal(selected.input, original.input);
  assert.equal(parseCodexModel("  "), "");
  assert.throws(() => parseCodexModel("--model"), /valid Codex model/);
});
