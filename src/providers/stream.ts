import { asRecord } from "../shared/records.js";
import type { ProviderId } from "../shared/contracts.js";
import { runJsonRpc } from "../service/json-rpc.js";
import { isOpenCodeV2, opencode } from "./opencode.js";
import type { ProviderUsageEvent } from "./types.js";

export type StreamEvent =
  | { type: "delta" | "message"; id: string; text: string }
  | { type: "tool_call" | "tool_result"; text: string }
  | ProviderUsageEvent;

type Transport = Parameters<typeof runJsonRpc>[0];
type Publish = (event: StreamEvent) => void;

function codexStream(transport: Transport, prompt: string, model: string | undefined, publish: Publish) {
  let notifyTurn: (error?: Error) => void = () => {};
  const turnDone = new Promise<Error | undefined>((resolve) => { notifyTurn = resolve; });
  return runJsonRpc({
    ...transport,
    args: [...transport.args, "app-server", "-c", 'web_search="disabled"', "-c", "mcp_servers={}",
      "--disable", "plugins", "--disable", "multi_agent"],
  }, {
    onRequest(method) {
      if (method.endsWith("/requestApproval")) return { decision: "decline" };
    },
    onNotification(method, params) {
      if (method === "item/agentMessage/delta" && typeof params.itemId === "string" && typeof params.delta === "string") {
        publish({ type: "delta", id: params.itemId, text: params.delta });
      }
      if (method === "item/started" || method === "item/completed") {
        const item = asRecord(params.item);
        const done = method === "item/completed";
        if (done && item?.type === "agentMessage" && typeof item.id === "string" && typeof item.text === "string") {
          publish({ type: "message", id: item.id, text: item.text });
        }
        const label = item?.type === "commandExecution" ? "command"
          : item?.type === "fileChange" ? "file change"
          : item?.type === "mcpToolCall" || item?.type === "dynamicToolCall" ? String(item.tool ?? "tool")
          : item?.type === "collabAgentToolCall" ? String(item.tool ?? "agent call") : "";
        if (label) {
          const detail = typeof item?.command === "string" ? "\n" + item.command.slice(0, 500) : "";
          const status = done ? item?.status === "failed" ? "failed" : "finished" : "started";
          publish({ type: done ? "tool_result" : "tool_call", text: "Codex " + label + " " + status + "." + (done ? "" : detail) });
        }
      }
      if (method === "thread/tokenUsage/updated") {
        const usage = asRecord(asRecord(params.tokenUsage)?.total);
        publish({ type: "usage", inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens, cachedTokens: usage?.cachedInputTokens });
      }
      if (method === "turn/completed") {
        const turn = asRecord(params.turn);
        const detail = asRecord(turn?.error)?.message;
        notifyTurn(turn?.status === "completed" ? undefined : new Error(
          typeof detail === "string" ? detail : "Codex did not complete the turn.",
        ));
      }
    },
  }, async (rpc) => {
    await rpc.request("initialize", { clientInfo: { name: "honeycomb", title: "Honeycomb", version: "0.1.0" } });
    rpc.notify("initialized");
    const response = await rpc.request("thread/start", {
      cwd: transport.cwd, model, ephemeral: true, approvalPolicy: "never", sandbox: "read-only",
    });
    const threadId = asRecord(response.thread)?.id;
    if (typeof threadId !== "string") throw new Error("Codex did not start a thread.");
    await rpc.request("turn/start", { threadId, input: [{ type: "text", text: prompt, text_elements: [] }] });
    const failure = await turnDone;
    if (failure) throw failure;
  });
}

function openCodeStream(
  transport: Transport, prompt: string, model: string | undefined, version: string | undefined, publish: Publish,
) {
  const modern = isOpenCodeV2(version);
  const settings = opencode.command(prompt, model, version);
  const toolNames = new Map<string, string>();
  let reply = 0;
  let activeSession: string | undefined;
  let writing = false;
  return runJsonRpc({
    ...transport,
    args: [...transport.args, "acp", ...(modern ? [] : ["--pure"]), "--log-level", modern ? "error" : "ERROR"],
    env: { ...transport.env, ...settings.env },
  }, {
    jsonrpc: true,
    onRequest(method) {
      if (method === "session/request_permission") return { outcome: { outcome: "cancelled" } };
    },
    onNotification(method, params) {
      if (method !== "session/update" || params.sessionId !== activeSession) return;
      const update = asRecord(params.update);
      const content = asRecord(update?.content);
      if (update?.sessionUpdate === "agent_message_chunk" && content?.type === "text" && typeof content.text === "string") {
        if (!writing) reply++;
        writing = true;
        publish({ type: "delta", id: String(reply), text: content.text });
      }
      if (update?.sessionUpdate === "tool_call" || update?.sessionUpdate === "tool_call_update") {
        writing = false;
        const id = update.toolCallId;
        if (typeof id !== "string") return;
        const title = typeof update.title === "string" ? update.title : toolNames.get(id) ?? (typeof update.kind === "string" ? update.kind : "tool");
        if (!toolNames.has(id)) {
          toolNames.set(id, title);
          const input = asRecord(update.rawInput);
          const target = [input?.command, input?.filePath, input?.path, input?.pattern]
            .find((value): value is string => typeof value === "string" && value.length > 0);
          publish({ type: "tool_call", text: "OpenCode " + title + (target ? "\n" + target.slice(0, 500) : "") });
        }
        if (update.status === "completed" || update.status === "failed") {
          publish({ type: "tool_result", text: "OpenCode " + title + (update.status === "completed" ? " finished." : " failed.") });
        }
      }
      if (update?.sessionUpdate === "usage_update") {
        publish({ type: "usage", costUsd: asRecord(update.cost)?.amount });
      }
    },
  }, async (rpc) => {
    await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const session = await rpc.request("session/new", { cwd: transport.cwd, mcpServers: [] });
    const sessionId = session.sessionId;
    if (typeof sessionId !== "string") throw new Error("OpenCode did not start a session.");
    activeSession = sessionId;
    await rpc.request("session/set_mode", { sessionId, modeId: modern ? "plan" : "honeycomb-review" });
    if (model) {
      if (modern) await rpc.request("session/set_config_option", { sessionId, configId: "model", value: model });
      else await rpc.request("session/set_model", { sessionId, modelId: model });
    }
    const result = await rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] });
    if (!["end_turn", "max_tokens"].includes(String(result.stopReason))) {
      throw new Error("OpenCode ended the response with status " + String(result.stopReason) + ".");
    }
    const usage = asRecord(result.usage);
    if (usage) publish({ type: "usage", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedTokens: usage.cachedReadTokens });
  });
}

export function streamProvider(
  provider: ProviderId, transport: Transport, prompt: string, model: string | undefined, version: string | undefined, publish: Publish,
) {
  return provider === "codex"
    ? codexStream(transport, prompt, model, publish)
    : openCodeStream(transport, prompt, model, version, publish);
}
