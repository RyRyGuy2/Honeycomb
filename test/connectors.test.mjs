import assert from "node:assert/strict";
import { test } from "node:test";
import { configuredConnectors } from "../dist/shared/connectors.js";

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
