import type { ModelCatalog } from "../shared/contracts.js";
import { asRecord } from "../shared/records.js";
import type { StreamEvent } from "./stream.js";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface Connection {
  name: string;
  baseUrl: string;
  apiKey?: string;
}

const MAX_FRAME = 1_048_576;

async function request(connection: Connection, path: string, signal: AbortSignal, body?: object) {
  const headers = new Headers();
  if (connection.apiKey) headers.set("Authorization", `Bearer ${connection.apiKey}`);
  if (body) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(`${connection.baseUrl}/${path}`, {
      signal, headers, redirect: "error", method: body ? "POST" : "GET", body: body && JSON.stringify(body),
    });
  } catch {
    if (signal.aborted) throw new Error("The request was stopped or timed out.");
    throw new Error(`Could not reach ${connection.name}. Check the base URL and that the server is running.`);
  }
  if (response.ok) return response;
  void response.body?.cancel().catch(() => {});
  if (response.status === 401 || response.status === 403) throw new Error("Access denied. Check your API key and its permissions.");
  if (response.status === 429) throw new Error("The provider rate limit or quota was reached. Try again later.");
  if (response.status === 402) throw new Error("The provider requires more credits for this request.");
  if (response.status === 404) {
    throw new Error(body ? "The endpoint or model was not found. Check the base URL and model ID."
      : "Model discovery is unavailable. Check the base URL or enter a model ID manually.");
  }
  throw new Error(`${connection.name} returned HTTP ${response.status}. Check the provider and the selected model.`);
}

export async function listHttpChatModels(connection: Connection & { model: string; manualModel?: string }, signal: AbortSignal): Promise<ModelCatalog> {
  const ids = new Set<string>();
  let localError: string | undefined;
  try {
    const response = await request(connection, "models", signal);
    const models = asRecord(await response.json())?.data;
    if (!Array.isArray(models)) throw new Error("The endpoint did not return a model list. Enter a model ID manually.");
    for (const model of models) {
      const id = asRecord(model)?.id;
      if (typeof id === "string" && id.trim() === id && id && id.length <= 512 && !/[\x00-\x1f\x7f]/.test(id)) ids.add(id);
    }
    if (!ids.size) localError = "The server returned no models. Load a model on the server or enter a model ID manually.";
  } catch (error) {
    localError = error instanceof SyntaxError ? "The endpoint did not return JSON model data. Check the API base URL."
      : error instanceof Error ? error.message : "Could not discover models.";
    if (connection.model) ids.add(connection.model);
  }
  if (connection.manualModel) ids.add(connection.manualModel);
  return {
    models: [...ids].map((id) => ({ id, name: id, available: true, online: false })),
    selected: ids.has(connection.model) ? connection.model : connection.manualModel ?? ids.values().next().value ?? "",
    localError,
  };
}

export async function streamHttpChat(
  connection: Connection, model: string, messages: ChatMessage[], signal: AbortSignal,
  publish: (event: StreamEvent) => void,
) {
  if (!model) throw new Error("Choose a model before sending.");
  const response = await request(connection, "chat/completions", signal, { model, messages, stream: true });
  let hasText = false;
  let finished = false;

  function accept(value: unknown, streaming: boolean) {
    const chunk = asRecord(value);
    if (!chunk || chunk.error) throw new Error(`${connection.name} could not generate a reply. Check the model and provider status.`);
    const choice = Array.isArray(chunk.choices) ? asRecord(chunk.choices[0]) : undefined;
    if (choice?.finish_reason === "error") throw new Error(`${connection.name} stopped with a generation error.`);
    if (choice?.finish_reason) finished = true;
    const text = asRecord(streaming ? choice?.delta : choice?.message)?.content;
    if (typeof text === "string" && text) {
      hasText ||= Boolean(text.trim());
      publish({ type: "delta", id: "http-chat", text });
    }
    const usage = asRecord(chunk.usage);
    if (usage) {
      publish({
        type: "usage", inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens,
        cachedTokens: asRecord(usage.prompt_tokens_details)?.cached_tokens,
      });
    }
  }

  function parse(data: string, streaming: boolean) {
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      throw new Error("The endpoint returned an invalid chat response. Check the API base URL.");
    }
    accept(value, streaming);
  }

  const mime = response.headers.get("content-type")?.toLowerCase();
  if (mime?.includes("text/html")) {
    void response.body?.cancel().catch(() => {});
    throw new Error("The endpoint returned a web page. Enter the OpenAI-compatible API base URL.");
  }
  if (mime?.includes("application/json")) {
    parse(await response.text(), false);
  } else {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("The provider returned an empty response.");
    const decoder = new TextDecoder();
    let buffer = "";
    let doneMarker = false;
    function readFrame(frame: string) {
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, "")).join("\n").trim();
      if (data === "[DONE]") doneMarker = true;
      else if (data) parse(data, true);
    }
    try {
      while (!doneMarker) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let boundary: RegExpExecArray | null;
        while (!doneMarker && (boundary = /\r?\n\r?\n/.exec(buffer))) {
          if (boundary.index > MAX_FRAME) throw new Error("The provider sent an oversized chat event.");
          readFrame(buffer.slice(0, boundary.index));
          buffer = buffer.slice(boundary.index + boundary[0].length);
        }
        if (buffer.length > MAX_FRAME) throw new Error("The provider sent an oversized chat event.");
        if (done) {
          if (buffer.trim()) readFrame(buffer);
          break;
        }
      }
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (hasText && !finished && !doneMarker) throw new Error("The response stream ended before the provider finished.");
  }
  if (!hasText) throw new Error("The model returned no text. Try a different chat model.");
}
