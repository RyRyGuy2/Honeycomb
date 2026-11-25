import { asRecord } from "../shared/records.js";
import { randomUUID } from "node:crypto";
import type { ProviderId } from "../shared/contracts.js";
import { runJsonRpc } from "../service/json-rpc.js";
import type { JsonRpc } from "../service/json-rpc.js";
import { isOpenCodeV2, OPENCODE_EDIT_AGENT, opencode } from "./opencode.js";
import type { ProviderUsageEvent } from "./types.js";

export type StreamEvent =
  | { type: "delta" | "message"; id: string; text: string }
  | { type: "tool_call" | "tool_result"; text: string }
  | { type: "test_result"; text: string; passed: boolean }
  | ProviderUsageEvent;

type Transport = Parameters<typeof runJsonRpc>[0];
type Publish = (event: StreamEvent) => void;

function codexStream(transport: Transport, prompt: string, model: string | undefined, publish: Publish, effort?: string,
  mode: "review" | "chat" | "edit" = "review") {
  const chat = mode === "chat";
  const cwd = transport.cwd;
  if (mode === "edit" && !cwd) throw new Error("Codex editing requires a Git worktree.");
  const sandboxPolicy = mode === "edit" && cwd ? {
    type: "workspaceWrite", writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true,
  } : undefined;
  let notifyTurn: (error?: Error) => void = () => {};
  const turnDone = new Promise<Error | undefined>((resolve) => { notifyTurn = resolve; });
  const chatFlags = chat ? [
    "--disable", "shell_tool", "--disable", "unified_exec", "--disable", "apps", "--disable", "memories",
    "--disable", "browser_use", "--disable", "computer_use", "--disable", "image_generation",
    "-c", "tools.view_image=false",
  ] : [];
  return runJsonRpc({
    ...transport,
    args: [...transport.args, "app-server", "-c", 'web_search="disabled"', "-c", "mcp_servers={}",
      "--disable", "plugins", "--disable", "hooks", "--disable", "multi_agent", "--disable", "multi_agent_v2", ...chatFlags],
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
        if (chat && item && !["userMessage", "agentMessage", "reasoning", "plan", "contextCompaction"].includes(String(item.type))) {
          notifyTurn(new Error("Codex tried to use a tool in Chat mode. Try asking for a text response."));
          return;
        }
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
    await rpc.request("initialize", {
      clientInfo: { name: "honeycomb", title: "Honeycomb", version: "0.1.0" },
      ...(chat ? { capabilities: { experimentalApi: true, requestAttestation: false } } : {}),
    });
    rpc.notify("initialized");
    if (chat) {
      const { account } = await rpc.request("account/read", {});
      if (asRecord(account)?.type !== "chatgpt") {
        throw new Error("Run codex login in a terminal and sign in with ChatGPT to use Codex in Chat mode.");
      }
    }
    const response = await rpc.request("thread/start", {
      cwd, model, ephemeral: true, approvalPolicy: "never", sandbox: sandboxPolicy ? "workspace-write" : "read-only",
      ...(chat ? {
        environments: [],
        developerInstructions: "Answer the user's question directly in text. Do not use tools, run commands, or access files.",
      } : {}),
      ...(sandboxPolicy ? { developerInstructions: "Make the requested changes in the current Git worktree. Leave the original checkout and other branches unchanged. Summarize changes and test results." } : {}),
    });
    const threadId = asRecord(response.thread)?.id;
    if (typeof threadId !== "string") throw new Error("Codex did not start a thread.");
    await rpc.request("turn/start", {
      threadId, effort, input: [{ type: "text", text: prompt, text_elements: [] }],
      ...(sandboxPolicy ? { cwd, approvalPolicy: "never", sandboxPolicy } : {}),
    });
    const failure = await turnDone;
    if (failure) throw failure;
  });
}

function openCodeTransport(transport: Transport, version: string | undefined, mode: "review" | "edit" = "review"): Transport {
  const modern = isOpenCodeV2(version);
  return {
    ...transport,
    args: [...transport.args, "acp", ...(modern ? [] : ["--pure"]), "--log-level", modern ? "error" : "ERROR"],
    env: { ...transport.env, ...opencode.command("", undefined, version, mode).env },
  };
}

async function newOpenCodeSession(rpc: JsonRpc, cwd: string | undefined) {
  await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  const session = await rpc.request("session/new", { cwd, mcpServers: [] });
  const sessionId = session.sessionId;
  if (typeof sessionId !== "string") throw new Error("OpenCode did not start a session.");
  return { sessionId, configOptions: session.configOptions };
}

export function parseEffort(value: unknown, provider: ProviderId): string | undefined {
  if (value === undefined || value === "") return;
  const valid = provider === "codex" ? /^(none|minimal|low|medium|high|xhigh|max|ultra)$/
    : provider === "claude" ? /^(low|medium|high|xhigh|max)$/
    : /^[a-z\d][a-z\d_-]{0,31}$/i;
  if (typeof value !== "string" || !valid.test(value)) throw new Error("Choose a valid thinking level.");
  return value;
}

export async function openCodeEfforts(transport: Transport, model: string, version?: string) {
  let efforts: string[] = [];
  await runJsonRpc(openCodeTransport(transport, version), { jsonrpc: true, onNotification() {} }, async (rpc) => {
    const session = await newOpenCodeSession(rpc, transport.cwd);
    if (!Array.isArray(session.configOptions) && !isOpenCodeV2(version)) return;
    const { configOptions } = model
      ? await rpc.request("session/set_config_option", { sessionId: session.sessionId, configId: "model", value: model })
      : session;
    const option = Array.isArray(configOptions) && configOptions.map(asRecord).find((item) => item?.id === "effort");
    const choices = option && option.options;
    if (!Array.isArray(choices)) return;
    efforts = choices.flatMap((choice) => {
      const value = asRecord(choice)?.value;
      return typeof value === "string" && value !== "default" && /^[a-z\d][a-z\d_-]{0,31}$/i.test(value) ? [value] : [];
    });
  });
  return efforts;
}

function openCodeStream(
  transport: Transport, prompt: string, model: string | undefined, version: string | undefined, publish: Publish, effort?: string,
  chat = false, edit = false,
) {
  const modern = isOpenCodeV2(version);
  const runner = openCodeTransport(transport, version, edit ? "edit" : "review");
  const agent = chat ? "honeycomb-chat-" + randomUUID()
    : edit ? OPENCODE_EDIT_AGENT
      : modern ? "plan" : "honeycomb-review";
  if (chat) {
    const instructions = "Answer the user's question directly in text.";
    const isolated = modern ? {
      tools: { skill: false },
      agents: {
        title: { disabled: true },
        [agent]: {
          mode: "primary", steps: 1, system: instructions,
          permissions: ["*", "skill"].map((action) => ({ action, resource: "*", effect: "deny" })),
        },
      },
      policies: ["tool.use", "mcp.use", "skill.use", "websearch.use", "plugin.use"].map(
        (action) => ({ action, resource: "*", effect: "deny" }),
      ),
    } : {
      share: "disabled",
      agent: {
        title: { disable: true },
        [agent]: { mode: "primary", steps: 1, prompt: instructions, permission: { "*": "deny" } },
      },
      permission: { "*": "deny" },
    };
    runner.env = {
      ...runner.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(isolated),
      ...(modern ? {} : { OPENCODE_PERMISSION: '{"*":"deny"}' }),
    };
  }
  const toolNames = new Map<string, string>();
  let reply = 0;
  let activeSession: string | undefined;
  let cancelUnexpectedTool: (() => void) | undefined;
  let toolRequested = false;
  let hasReplyText = false;
  let writing = false;
  return runJsonRpc(runner, {
    jsonrpc: true,
    onRequest(method) {
      if (method === "session/request_permission") return { outcome: { outcome: "cancelled" } };
    },
    onNotification(method, params) {
      if (method !== "session/update" || params.sessionId !== activeSession) return;
      const update = asRecord(params.update);
      const content = asRecord(update?.content);
      if (update?.sessionUpdate === "agent_message_chunk" && content?.type === "text" && typeof content.text === "string") {
        hasReplyText ||= Boolean(content.text.trim());
        if (!writing) reply++;
        writing = true;
        publish({ type: "delta", id: String(reply), text: content.text });
      }
      if (update?.sessionUpdate === "tool_call" || update?.sessionUpdate === "tool_call_update") {
        if (chat) {
          if (!toolRequested) cancelUnexpectedTool?.();
          toolRequested = true;
          return;
        }
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
    const { sessionId, configOptions } = await newOpenCodeSession(rpc, transport.cwd);
    activeSession = sessionId;
    cancelUnexpectedTool = () => rpc.notify("session/cancel", { sessionId });
    // Fail before sending the prompt if the CLI didn't load the tool-free agent.
    await rpc.request("session/set_mode", { sessionId, modeId: agent });
    if (model) {
      if (modern || Array.isArray(configOptions)) await rpc.request("session/set_config_option", { sessionId, configId: "model", value: model });
      else await rpc.request("session/set_model", { sessionId, modelId: model });
    }
    if (effort) {
      await rpc.request("session/set_config_option", { sessionId, configId: "effort", value: effort });
    }
    // OpenCode interprets a leading slash as a command. The Chat prompt is always literal text.
    const text = chat ? "User question:\n" + prompt : prompt;
    const result = await rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
    if (toolRequested) throw new Error("The model tried to use a tool in Chat mode. Try asking for a text response.");
    if (!["end_turn", "max_tokens"].includes(String(result.stopReason))) {
      throw new Error("OpenCode ended the response with status " + String(result.stopReason) + ".");
    }
    if (!hasReplyText) throw new Error("OpenCode returned no reply. Check the selected model and its credentials.");
    const usage = asRecord(result.usage);
    if (usage) publish({ type: "usage", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedTokens: usage.cachedReadTokens });
  });
}

export function streamProvider(
  provider: ProviderId, transport: Transport, prompt: string, model: string | undefined, version: string | undefined, publish: Publish,
  effort?: string,
) {
  return provider === "codex"
    ? codexStream(transport, prompt, model, publish, effort)
    : openCodeStream(transport, prompt, model, version, publish, effort);
}

export function streamOpenCodeChat(
  transport: Transport, prompt: string, model: string | undefined, version: string | undefined, publish: Publish, effort?: string,
) {
  return openCodeStream(transport, prompt, model, version, publish, effort, true);
}

export function streamOpenCodeEdit(
  transport: Transport & { cwd: string }, prompt: string, model: string | undefined, version: string | undefined, publish: Publish, effort?: string,
) {
  if (!transport.cwd) throw new Error("OpenCode editing requires a Git worktree.");
  return openCodeStream(transport, prompt, model, version, publish, effort, false, true);
}

export function streamCodexChat(transport: Transport, prompt: string, model: string | undefined, publish: Publish, effort?: string) {
  return codexStream(transport, prompt, model, publish, effort, "chat");
}

export function streamCodexEdit(transport: Transport & { cwd: string }, prompt: string, model: string | undefined, publish: Publish, effort?: string) {
  return codexStream(transport, prompt, model, publish, effort, "edit");
}
