import type { Writable } from "node:stream";
import { asRecord } from "../shared/records.js";
import { readJsonLines, runProcess } from "./process.js";

type Fields = Record<string, unknown>;

export interface JsonRpc {
  request(method: string, params: Fields): Promise<Fields>;
  notify(method: string, params?: Fields): void;
}

interface RpcOptions {
  jsonrpc?: boolean;
  onNotification(method: string, params: Fields): void;
  onRequest?(method: string): Fields | undefined;
}

export async function runJsonRpc(
  options: Parameters<typeof runProcess>[0],
  handlers: RpcOptions,
  interact: (rpc: JsonRpc) => Promise<void>,
) {
  let input: Writable | undefined;
  let sequence = 0;
  let session: Promise<void> | undefined;
  let sessionError: unknown;
  let disconnected = false;
  let disconnect: () => void = () => {};
  const closed = new Promise<void>((resolve) => { disconnect = resolve; });
  const waiting = new Map<number, { resolve: (value: Fields) => void; reject: (error: Error) => void }>();

  function send(message: Fields) {
    if (input && !input.destroyed && !input.writableEnded) {
      input.write(JSON.stringify({ ...(handlers.jsonrpc ? { jsonrpc: "2.0" } : {}), ...message }) + "\n");
    }
  }
  const rpc: JsonRpc = {
    request(method, params) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        send({ id, method, params });
      });
    },
    notify(method, params) {
      send({ method, params });
    },
  };
  const stdout = readJsonLines((message) => {
    const { id, method } = message;
    if (typeof method === "string") {
      if (id === undefined) {
        handlers.onNotification(method, asRecord(message.params) ?? {});
      } else {
        const result = handlers.onRequest?.(method);
        send(result ? { id, result } : { id, error: { code: -32601, message: "Unsupported by Honeycomb" } });
      }
      return;
    }
    if (typeof id !== "number") return;
    const request = waiting.get(id);
    waiting.delete(id);
    const error = asRecord(message.error);
    if (error) {
      const detail = asRecord(error.data);
      request?.reject(new Error([error.message, detail?.message].filter((value) => typeof value === "string").join(": ") || "Provider request failed."));
    } else {
      request?.resolve(asRecord(message.result) ?? {});
    }
  });

  const result = await runProcess({
    ...options, stdout,
    startInput(stream) {
      input = stream;
      session = Promise.race([interact(rpc), closed])
        .catch((error: unknown) => { sessionError = error; })
        .finally(() => { if (!disconnected) input?.end(); });
    },
  });
  disconnected = true;
  const endedInput = input?.writableEnded;
  for (const request of waiting.values()) request.reject(new Error(result.stderr || result.error || "The provider disconnected."));
  disconnect();
  if (result.stopped === "cancelled") return;
  if (result.stopped === "timeout") throw new Error("The run reached its five-minute limit.");
  await session;
  if (sessionError) throw sessionError;
  if (!endedInput) {
    throw new Error(result.error || result.stderr || "The provider disconnected before finishing.");
  }
}
