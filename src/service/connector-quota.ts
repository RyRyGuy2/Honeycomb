import { codex } from "../providers/codex.js";
import { checkProvider, providerEnvironment } from "../providers/index.js";
import type { ConnectorQuota, QuotaWindow } from "../shared/contracts.js";
import { asRecord } from "../shared/records.js";
import { runJsonRpc } from "./json-rpc.js";

const MAX_AGE = 5 * 60_000;

function percentLeft(used: unknown): number | undefined {
  return typeof used === "number" && Number.isFinite(used) && used >= 0 ? Math.max(0, 100 - used) : undefined;
}

export function codexQuotaWindows(value: unknown): QuotaWindow[] {
  const response = asRecord(value);
  const buckets = asRecord(response?.rateLimitsByLimitId);
  const fallback = asRecord(response?.rateLimits);
  const entries = buckets && Object.keys(buckets).length ? Object.entries(buckets) : [["codex", fallback]] as const;
  return entries.flatMap(([id, raw]) => {
    const bucket = asRecord(raw);
    return ["primary", "secondary"].flatMap((name) => {
      const meter = asRecord(bucket?.[name]);
      const remaining = percentLeft(meter?.usedPercent);
      if (remaining === undefined) return [];
      const duration = meter?.windowDurationMins;
      const durationMinutes = typeof duration === "number" && duration > 0 ? duration : undefined;
      const resets = meter?.resetsAt;
      return [{
        id: `${id}:${name}`,
        label: typeof bucket?.limitName === "string" ? bucket.limitName : id === "codex" ? "Codex" : id,
        remaining, unit: "percent" as const, durationMinutes,
        resetsAt: typeof resets === "number" && resets > 0 ? resets * 1000 : undefined,
      }];
    });
  });
}

export function openCodeGoQuotaWindows(value: unknown): QuotaWindow[] {
  const usage = asRecord(asRecord(value)?.usage);
  return ["rolling", "weekly", "monthly"].flatMap((key) => {
    const meter = asRecord(usage?.[key]);
    const remaining = meter?.status === "rate-limited" ? 0 : percentLeft(meter?.percent);
    if (remaining === undefined) return [];
    const reset = typeof meter?.resetsAt === "string" ? Date.parse(meter.resetsAt) : NaN;
    return [{
      id: `opencode-go:${key}`, label: "OpenCode Go · shared", remaining, unit: "percent" as const,
      durationMinutes: key === "rolling" ? 300 : key === "weekly" ? 10_080 : undefined,
      resetsAt: Number.isFinite(reset) ? reset : undefined,
    }];
  });
}

async function readCodex(signal: AbortSignal) {
  const { executable } = await checkProvider(codex, signal);
  if (!executable) return [];
  let limits: QuotaWindow[] | undefined;
  await runJsonRpc({
    file: executable.file, args: [...executable.args, "app-server"], cwd: undefined,
    env: providerEnvironment(codex), timeoutMs: 12_000, signal,
  }, { onNotification() {} }, async (rpc) => {
    await rpc.request("initialize", { clientInfo: { name: "honeycomb", version: "0.1.0" } });
    rpc.notify("initialized");
    limits = codexQuotaWindows(await rpc.request("account/rateLimits/read", {}));
  });
  signal.throwIfAborted();
  if (!limits) throw new Error("Codex returned no quota response.");
  return limits;
}

async function readOpenCodeGo(signal: AbortSignal) {
  const key = process.env.OPENCODE_GO_API_KEY?.trim() || process.env.OPENCODE_API_KEY?.trim();
  if (!key) return [];
  const response = await fetch("https://opencode.ai/inference/go/v1/usage", {
    headers: { Authorization: `Bearer ${key}` },
    redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (response.status === 401 || response.status === 403) return [];
  if (!response.ok) throw new Error("OpenCode Go quota is temporarily unavailable.");
  return openCodeGoQuotaWindows(await response.json());
}

export function createConnectorQuotas(signal: AbortSignal) {
  const cache = new Map<ConnectorQuota["connector"], ConnectorQuota>();
  const jobs = new Map<ConnectorQuota["connector"], Promise<ConnectorQuota>>();
  const lastAttempt = new Map<ConnectorQuota["connector"], number>();

  function get(connector: ConnectorQuota["connector"], force = false): Promise<ConnectorQuota> {
    const previous = cache.get(connector);
    const now = Date.now();
    const live = jobs.get(connector);
    if (live) return live;
    if (!force && previous?.status !== "available" && previous && now - (lastAttempt.get(connector) ?? 0) < 30_000) {
      return Promise.resolve(previous);
    }
    if (!force && previous?.checkedAt !== undefined && now - previous.checkedAt < MAX_AGE &&
        !previous.windows.some((window) => window.resetsAt !== undefined && window.resetsAt <= now)) {
      return Promise.resolve(previous);
    }
    const read = connector === "codex" ? readCodex : connector === "opencode" ? readOpenCodeGo : undefined;
    if (!read) return Promise.resolve({ connector, status: "unavailable", windows: [] });
    lastAttempt.set(connector, now);
    const job = read(signal).then((windows): ConnectorQuota => ({
      connector, status: windows.length ? "available" : "unavailable", windows, checkedAt: Date.now(),
    })).catch((): ConnectorQuota => previous?.windows.length
      ? { ...previous, status: "stale" }
      : { connector, status: "unavailable", windows: [] })
      .then((quota) => { cache.set(connector, quota); return quota; })
      .finally(() => jobs.delete(connector));
    jobs.set(connector, job);
    return job;
  }
  return { get };
}

export function remainingPercent(quota: ConnectorQuota | undefined, model: string, now = Date.now()) {
  if (quota?.status !== "available") return;
  if (quota.connector === "opencode" && !model.startsWith("opencode-go/")) return;
  const applicable = quota.windows.filter((window) => window.unit === "percent" &&
    (!window.models || window.models.includes(model)) &&
    (quota.connector !== "codex" || window.id.startsWith("codex:") || Boolean(window.models)) &&
    (window.resetsAt === undefined || window.resetsAt > now));
  if (applicable.length) return Math.min(...applicable.map((window) => window.remaining));
}
