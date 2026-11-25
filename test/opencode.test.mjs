import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { test } from "node:test";
import { installOpenCodeRelease, managedOpenCodePath, openCodeRelease } from "../dist/providers/opencode-install.js";
import { mergeOpenCodeModels } from "../dist/providers/opencode-models.js";
import { OPENCODE_EDIT_AGENT, opencode, parseOpenCodeModel } from "../dist/providers/opencode.js";

test("OpenCode downloads use a pinned compatible platform asset", () => {
  assert.match(openCodeRelease("win32", "x64").url, /v1\.19\.6\/opencode-windows-x64-baseline\.zip$/);
  assert.match(openCodeRelease("win32", "arm64").url, /windows-arm64\.zip$/);
  assert.equal(openCodeRelease("darwin", "arm64").executable, "opencode");
  assert.equal(openCodeRelease("win32", "ia32"), undefined);
});

test("an installer verifies the archive and preserves the previous executable on a bad download", async (t) => {
  const root = await mkdtemp(tmpdir() + "/honeycomb-install-test-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = Buffer.from("UEsDBBQAAAAAAAqHeF1rgcvlEgAAABIAAAAMAAAAb3BlbmNvZGUuZXhlZXhlY3V0YWJsZSBmaXh0dXJlUEsBAhQAFAAAAAAACod4XWuBy+USAAAAEgAAAAwAAAAAAAAAAAAAAIABAAAAAG9wZW5jb2RlLmV4ZVBLBQYAAAAAAQABADoAAAA8AAAAAAA=", "base64");
  const release = { ...openCodeRelease("win32", "x64"), sha256: createHash("sha256").update(archive).digest("hex") };
  const destination = managedOpenCodePath(root, release);
  let probes = 0;
  await installOpenCodeRelease(root, release, async (file, version) => {
    probes++;
    assert.equal(version, release.version);
    assert.equal(await readFile(file, "utf8"), "executable fixture");
  }, async (url) => {
    assert.equal(url, release.url);
    return new Response(archive);
  });
  await assert.rejects(
    installOpenCodeRelease(root, release, async () => { probes++; }, async () => new Response("different payload")),
    /checksum check/,
  );
  assert.equal(probes, 1);
  assert.equal(await readFile(destination, "utf8"), "executable fixture");
  assert.deepEqual(await readdir(dirname(destination)), ["opencode.exe"]);
});

test("model discovery deduplicates local and online entries and marks online-only models", () => {
  const local = "opencode/available\r\ncustom/local\r\ninfo: startup notice\ncustom/local\n";
  const catalog = { data: [
    { id: "available", name: "Available" },
    { id: "catalog-only", name: "Catalog model", type: "chat" },
    { id: "embedding", type: "embedding" },
    { id: "../invalid" },
  ] };
  assert.deepEqual(mergeOpenCodeModels(local, catalog), [
    { id: "custom/local", name: "custom/local", available: true, online: false },
    { id: "opencode/available", name: "Available", available: true, online: true },
    { id: "opencode/catalog-only", name: "Catalog model", available: false, online: true },
  ]);
  assert.equal(mergeOpenCodeModels(local, undefined).length, 2);
});

test("OpenCode 2.x is detected and invoked with its current CLI flags", () => {
  assert.equal(opencode.parseVersion("opencode v2.4.1"), "2.4.1");
  assert.equal(opencode.parseVersion("1.19.6"), "1.19.6");
  assert.equal(opencode.versionIssue("1.19.6"), undefined);
  assert.equal(opencode.versionIssue("2.4.1"), undefined);
  assert.match(opencode.versionIssue("1.13.0") ?? "", /1\.14 or newer/);

  const current = opencode.command("hello", "opencode/model", "2.4.1");
  assert.ok(!current.args.includes("--pure"));
  assert.deepEqual(current.args.slice(0, 3), ["run", "--format", "json"]);
  assert.deepEqual(current.args.slice(3, 6), ["--agent", "plan", "--print-logs"]);
  assert.deepEqual(current.args.slice(-3), ["error", "--model", "opencode/model"]);
  assert.equal(current.env.OPENCODE_CONFIG_CONTENT, undefined);

  const legacy = opencode.command("hello", undefined, "1.19.6");
  assert.ok(legacy.args.includes("--pure"));
  assert.equal(legacy.args[legacy.args.indexOf("--agent") + 1], "honeycomb-review");
  assert.equal(legacy.env.OPENCODE_CONFIG_CONTENT?.includes("honeycomb-review"), true);
});

test("OpenCode edit runs use a scoped worktree edit agent in both CLI generations", () => {
  const current = opencode.command("fix", undefined, "2.4.1", "edit");
  assert.equal(current.args[current.args.indexOf("--agent") + 1], OPENCODE_EDIT_AGENT);
  const modern = JSON.parse(current.env.OPENCODE_CONFIG_CONTENT);
  const agent = modern.agents[OPENCODE_EDIT_AGENT];
  assert.equal(agent.mode, "primary");
  assert.match(agent.system, /dedicated Git worktree/);
  assert.deepEqual(agent.permissions.find((rule) => rule.action === "edit"), { action: "edit", resource: "*", effect: "allow" });
  assert.deepEqual(agent.permissions.find((rule) => rule.action === "shell"), { action: "shell", resource: "*", effect: "allow" });
  assert.deepEqual(agent.permissions.find((rule) => rule.action === "external_directory"), { action: "external_directory", resource: "*", effect: "deny" });
  assert.equal(modern.policies.some((rule) => rule.action === "tool.use"), false);

  const legacy = opencode.command("fix", undefined, "1.19.6", "edit");
  assert.ok(legacy.args.includes("--pure"));
  assert.equal(legacy.args[legacy.args.indexOf("--agent") + 1], OPENCODE_EDIT_AGENT);
  const old = JSON.parse(legacy.env.OPENCODE_CONFIG_CONTENT);
  const oldAgent = old.agent[OPENCODE_EDIT_AGENT];
  assert.equal(oldAgent.permission.write, "allow");
  assert.equal(oldAgent.permission.edit, "allow");
  assert.equal(oldAgent.permission.bash, "allow");
  assert.equal(oldAgent.permission.external_directory, "deny");
  assert.equal(oldAgent.permission.read[".env*"], "deny");
  assert.equal(old.permission.bash, "allow");

  const review = opencode.command("review", undefined, "1.19.6");
  assert.equal(review.args[review.args.indexOf("--agent") + 1], "honeycomb-review");
  assert.equal(JSON.parse(review.env.OPENCODE_CONFIG_CONTENT).agent[OPENCODE_EDIT_AGENT], undefined);
});

test("the selected model is passed to OpenCode and 429s have an actionable message", () => {
  assert.deepEqual(opencode.command("hello", parseOpenCodeModel(" custom/local ")).args.slice(-2), ["--model", "custom/local"]);
  assert.throws(() => parseOpenCodeModel("--model broken"), /provider\/model/);
  assert.throws(() => parseOpenCodeModel("--broken/model"), /provider\/model/);
  assert.equal(opencode.command("hello").env.OPENCODE_DB, ":memory:");
  assert.match(opencode.decode({ type: "error", error: { data: { statusCode: 429 } } }).failed, /rate limited/);
  assert.match(opencode.diagnoseStderr('{"statusCode":429}'), /another configured model/);
});
