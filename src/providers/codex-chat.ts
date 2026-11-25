import type { ModelCatalog } from "../shared/contracts.js";
import { asRecord } from "../shared/records.js";
import type { StreamEvent } from "./stream.js";

const BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-5-mini";
const KEY_REQUIRED = "Set OPENAI_API_KEY to use Codex in Chat mode.";

export function codexChatEfforts(model: string) {
  const id = model || DEFAULT_MODEL;
  // The model listing does not include reasoning capabilities.
  if (/^gpt-5-(mini|nano)(-\d{4}-\d{2}-\d{2})?$/.test(id) || /^gpt-6\.[\w.-]+-(sol|astra)(-\d{4}-\d{2}-\d{2})?$/.test(id)) {
    return ["low", "medium", "high"];
  }
  return [];
}

export function chatApiKey(env = process.env) {
  return env.OPENAI_API_KEY?.trim() || env.CODEX_API_KEY?.trim();
}

async function apiError(response: Response) {
  const body = asRecord(await response.json().catch(() => undefined));
  const message = asRecord(body?.error)?.message;
  return new Error(typeof message === "string" ? message : "OpenAI returned HTTP " + response.status + ".");
}

export async function listCodexChatModels(signal: AbortSignal): Promise<ModelCatalog> {
  const key = chatApiKey();
  if (!key) return { models: [], selected: "", localError: KEY_REQUIRED };
  try {
    const response = await fetch(BASE_URL + "/models", {
      headers: { authorization: "Bearer " + key }, redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) throw new Error("OpenAI couldn't load the model list.");
    const list = asRecord(await response.json())?.data;
    const models = Array.isArray(list) ? list.flatMap((entry) => {
      const id = asRecord(entry)?.id;
      if (typeof id !== "string" || !/^(gpt-(4|5|6)|o[134])/.test(id)
        || /audio|realtime|search|transcri|tts|image|moderation|embed/.test(id)) return [];
      return [{ id, name: id, available: true, online: true, efforts: codexChatEfforts(id) }];
    }).sort((a, b) => b.id.localeCompare(a.id)) : [];
    return { models, selected: "", defaultEfforts: codexChatEfforts("") };
  } catch {
    return { models: [], selected: "", localError: "The OpenAI model list is unavailable. Check your API key and connection." };
  }
}

export async function streamCodexChat(
  key: string | undefined, prompt: string, model: string | undefined, signal: AbortSignal,
  publish: (event: StreamEvent) => void, effort?: string, request = fetch,
) {
  if (!key) throw new Error(KEY_REQUIRED);
  if (effort && !codexChatEfforts(model ?? "").includes(effort)) throw new Error("This model does not support that thinking level in Chat.");
  const response = await request(BASE_URL + "/responses", {
    method: "POST",
    headers: { authorization: "Bearer " + key, "content-type": "application/json" },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL, input: prompt, tools: [], tool_choice: "none", store: false, stream: true,
      ...(effort ? { reasoning: { effort } } : {}),
    }),
    redirect: "error", signal,
  });
  if (!response.ok) throw await apiError(response);
  if (!response.body) throw new Error("OpenAI did not return a response stream.");

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let completed = false;
  function consume(line: string) {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    const event = asRecord(JSON.parse(data));
    const result = asRecord(event?.response);
    if (event?.type === "response.output_text.delta" || event?.type === "response.refusal.delta") {
      if (typeof event.delta === "string") publish({ type: "delta", id: String(event.item_id), text: event.delta });
    } else if (event?.type === "response.completed" || event?.type === "response.incomplete") {
      completed = true;
      const usage = asRecord(result?.usage);
      if (usage) publish({
        type: "usage", inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
        cachedTokens: asRecord(usage.input_tokens_details)?.cached_tokens,
      });
    } else if (event?.type === "error" || event?.type === "response.failed") {
      const message = event.message ?? asRecord(result?.error)?.message;
      throw new Error(typeof message === "string" ? message : "OpenAI could not complete the response.");
    }
  }
  try {
    while (!completed) {
      const { value, done } = await reader.read();
      if (done) {
        consume(buffer);
        break;
      }
      const lines = (buffer + value).split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) consume(line);
    }
    if (!completed) throw new Error("OpenAI disconnected before the response finished.");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
