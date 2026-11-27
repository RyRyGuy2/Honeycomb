import type {
  Connector, ConnectorQuota, FreebuffTerminalEvent, HoneycombApi, Run, RunUsage, SmartConnector, SmartSettings,
  SmartBilling, SmartStrength, WorkflowRun,
} from "../shared/contracts.js";
import { addRunUsage } from "../shared/workflows.js";

interface TerminalInstance {
  open(container: HTMLElement): void;
  focus(): void;
  dispose(): void;
  write(data: string): void;
  onData(callback: (data: string) => void): void;
  onKey(callback: (event: { key: string; domEvent: KeyboardEvent }) => void): void;
}

const connectorNames: Record<SmartConnector, string> = {
  opencode: "OpenCode", codex: "Codex", claude: "Claude Code", antigravity: "Google Antigravity CLI",
  "github-copilot": "GitHub Copilot CLI", freebuff: "Freebuff",
};
const tagLabels: Record<SmartStrength, string> = { fast: "Fast lookup", coding: "Coding", deep: "Deep reasoning" };
const billingLabels: Record<SmartBilling, string> = { free: "Free or local", included: "Included quota", metered: "Metered" };
const formatNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });
const timeLabel = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const dayLabel = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function button(text: string, click: () => void) {
  const element = node("button", text, "button");
  element.type = "button";
  element.addEventListener("click", click);
  return element;
}

function field(text: string, child: HTMLElement) {
  const label = node("label", undefined, "model-field");
  label.append(node("span", text), child);
  return label;
}

function elem<T extends HTMLElement = HTMLElement>(id: string) {
  return document.getElementById(id) as T;
}

function errorText(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

function usageText(usage: RunUsage) {
  return [
    usage.inputTokens === undefined ? "" : `${formatNumber.format(usage.inputTokens)} input`,
    usage.outputTokens === undefined ? "" : `${formatNumber.format(usage.outputTokens)} output`,
    usage.cachedTokens === undefined ? "" : `${formatNumber.format(usage.cachedTokens)} cached`,
    usage.costUsd === undefined ? "" : `$${formatNumber.format(usage.costUsd)} reported cost`,
  ].filter(Boolean).join(" · ");
}

type Activity = { name: string; connector: string; model: string; at: number; usage: RunUsage };

function timeBucket(at: number, period: string) {
  const date = new Date(at);
  if (period === "hour") return new Date(Math.floor(at / 3_600_000) * 3_600_000);
  date.setHours(0, 0, 0, 0);
  if (period === "week") date.setDate(date.getDate() - (date.getDay() + 6) % 7);
  return date;
}

export function createSmartUi(api: HoneycombApi, sources: {
  connectors: () => readonly Connector[];
  runs: () => Iterable<Run>;
  workflows: () => Iterable<WorkflowRun>;
}) {
  let quotas: ConnectorQuota[] = [];
  let quotaBusy = false;
  let settings: SmartSettings | undefined;
  let settingsBusy = false;
  const drafts = new Map<string, { reply: string; model: string; error: string }>();
  const working = new Set<string>();
  const dialog = elem<HTMLDialogElement>("freebuff-terminal-dialog");
  const screen = elem("freebuff-terminal-screen");
  const terminalStatus = elem("freebuff-terminal-status");
  let terminal: { id: string; runId: string; view: TerminalInstance } | undefined;
  let openingTerminal = false;
  let earlyEvents: FreebuffTerminalEvent[] = [];

  function renderUsage() {
    const period = elem<HTMLSelectElement>("usage-period").value;
    const now = Date.now();
    const threshold = now - (period === "hour" ? 1 : period === "week" ? 56 : 7) * 86_400_000;
    const activity: Activity[] = [...sources.runs()].map((run) => ({
      name: run.providerName, connector: run.providerId, model: run.model ?? run.modelOverride ?? "CLI default",
      at: Date.parse(run.startedAt), usage: run.usage,
    }));
    for (const run of sources.workflows()) {
      for (const entry of run.steps) {
        const step = run.definition.steps.find((item) => item.id === entry.stepId);
        if (step?.kind !== "agent" || step.providerId !== "freebuff" || !entry.startedAt) continue;
        activity.push({ name: "Freebuff", connector: "freebuff", model: entry.detail?.startsWith("Model used: ")
          ? entry.detail.slice(12) : step.model || "Model unconfirmed", at: Date.parse(entry.startedAt), usage: {} });
      }
    }
    const providers = new Map(sources.connectors().filter(({ status }) => status === "detected").map(({ id, name }) => [id as string, name]));
    for (const quota of quotas) if (quota.windows.length && !providers.has(quota.connector)) providers.set(quota.connector, quota.connector);
    for (const row of activity) if (!providers.has(row.connector)) providers.set(row.connector, row.name);
    providers.set("freebuff", "Freebuff");
    const cards = [...providers].map(([id, name]) => {
      const card = node("article", undefined, "smart-usage-card");
      const quota = quotas.find((item) => item.connector === id);
      card.append(node("h3", name));
      if (quota?.windows.length) {
        const windows = node("ul", undefined, "quota-windows");
        for (const meter of quota.windows) {
          const minutes = meter.durationMinutes;
          const duration = meter.id.endsWith(":monthly") ? "Monthly" : minutes === 10_080 ? "Weekly"
            : minutes === 1_440 ? "Daily" : minutes && minutes % 60 === 0 ? `${minutes / 60}h` : minutes ? `${minutes} min` : "";
          const remaining = meter.unit === "percent" ? `${formatNumber.format(meter.remaining)}%` : `${formatNumber.format(meter.remaining)} ${meter.unit}`;
          const until = meter.resetsAt === undefined ? undefined : Math.ceil((meter.resetsAt - now) / 60_000);
          const countdown = until !== undefined && until > 0 && until < 1_440
            ? `in ${until >= 60 ? `${Math.floor(until / 60)}h ` : ""}${until % 60}m` : "";
          const reset = meter.resetsAt ? (until !== undefined && until <= 0 ? " · refresh for next reset"
            : ` · resets ${countdown || new Date(meter.resetsAt).toLocaleString()}`) : "";
          const label = node("li", `${[meter.label, duration].filter(Boolean).join(" · ")} · ${remaining} left${reset}`);
          if (meter.resetsAt) label.title = new Date(meter.resetsAt).toLocaleString();
          windows.append(label);
        }
        card.append(windows);
      } else {
        card.append(node("p", id === "freebuff" ? "Check current allowance in Freebuff with /model." : "Quota unavailable.", "connector-note"));
      }
      if (quota?.checkedAt) card.append(node("p", `${quota.status === "stale" ? "Stale · last checked" : "Last checked"} ${new Date(quota.checkedAt).toLocaleString()}`, "connector-note"));
      const selected = activity.filter((entry) => entry.connector === id && entry.at >= threshold);
      if (!selected.length) {
        card.append(node("p", "No Honeycomb activity in this period.", "connector-note"));
        return card;
      }
      const total = selected.reduce((usage, entry) => addRunUsage(usage, entry.usage), {} as RunUsage);
      const byBucket = new Map<number, Map<string, { count: number; usage: RunUsage }>>();
      for (const entry of selected) {
        const key = timeBucket(entry.at, period).getTime();
        const bucket = byBucket.get(key) ?? new Map();
        const data = bucket.get(entry.model);
        bucket.set(entry.model, { count: (data?.count ?? 0) + 1, usage: addRunUsage(data?.usage, entry.usage) });
        byBucket.set(key, bucket);
      }
      const details = node("details");
      if (elem("connector-usage").querySelector<HTMLDetailsElement>(`[data-usage-id="${CSS.escape(id)}"]`)?.open) details.open = true;
      details.dataset.usageId = id;
      details.append(node("summary", [`${selected.length} ${id === "freebuff" ? "handoffs" : "runs"}`, usageText(total)].filter(Boolean).join(" · ")));
      for (const [key, models] of [...byBucket].sort(([left], [right]) => right - left)) {
        const date = new Date(key);
        const list = node("ul", undefined, "quota-windows");
        for (const [model, data] of models) {
          list.append(node("li", [model, `${data.count} ${data.count === 1 ? "run" : "runs"}`, usageText(data.usage)].filter(Boolean).join(" · ")));
        }
        details.append(node("p", period === "hour" ? `${dayLabel.format(date)}, ${timeLabel.format(date)}` : dayLabel.format(date), "connector-note"), list);
      }
      card.append(details);
      return card;
    });
    elem("connector-usage").replaceChildren(...cards);
  }

  async function refreshQuota(force: boolean) {
    if (quotaBusy) return;
    quotaBusy = true;
    const control = elem<HTMLButtonElement>("refresh-quotas");
    const status = elem("quota-status");
    control.disabled = true;
    status.textContent = "Checking connector quota…";
    try {
      quotas = await api.connectorQuotas(force);
      status.textContent = "";
    } catch (error) {
      status.textContent = errorText(error);
    } finally {
      control.disabled = false;
      quotaBusy = false;
      renderUsage();
    }
  }

  function renderSettings() {
    const state = settings;
    if (!state) return;
    const fields = elem("smart-settings-fields");
    const ordering = node("ol", undefined, "smart-connector-order");
    for (const [index, id] of state.order.entries()) {
      const row = node("li");
      const enabled = node("input");
      enabled.type = "checkbox";
      enabled.checked = !state.disabled.includes(id);
      enabled.addEventListener("change", () => {
        state.disabled = enabled.checked ? state.disabled.filter((entry) => entry !== id) : [...state.disabled, id];
      });
      const label = node("label");
      label.append(enabled, document.createTextNode(` ${connectorNames[id]}`));
      const move = (destination: number) => {
        state.order.splice(index, 1);
        state.order.splice(destination, 0, id);
        renderSettings();
      };
      const up = button("↑", () => move(index - 1));
      up.setAttribute("aria-label", `Move ${connectorNames[id]} up`);
      up.disabled = index === 0;
      const down = button("↓", () => move(index + 1));
      down.setAttribute("aria-label", `Move ${connectorNames[id]} down`);
      down.disabled = index === state.order.length - 1;
      row.append(label, up, down);
      ordering.append(row);
    }
    const policy = node("select", undefined, "connector-input");
    for (const [id, label] of [["fallback", "Fallback"], ["prefer", "Prefer when suitable"], ["explicit", "Only when requested"], ["off", "Off"]] as const) {
      const option = node("option", label);
      option.value = id;
      policy.append(option);
    }
    policy.value = state.freebuff;
    policy.addEventListener("change", () => { state.freebuff = policy.value as SmartSettings["freebuff"]; });
    const overage = node("input");
    overage.type = "checkbox";
    overage.checked = state.allowOverage;
    overage.addEventListener("change", () => { state.allowOverage = overage.checked; });
    const overageLabel = node("label");
    overageLabel.append(overage, document.createTextNode(" Allow paid overage when included quota is exhausted"));
    const strengthList = node("div");
    for (const [index, entry] of state.strengths.entries()) {
      const row = node("div", undefined, "smart-strength-entry");
      const tags = [...entry.strengths.map((tag) => tagLabels[tag]), ...(entry.billing ? [billingLabels[entry.billing]] : [])];
      row.append(node("span", [connectorNames[entry.connector], entry.model, tags.join(", ")].filter(Boolean).join(" · ")),
        button("Remove", () => { state.strengths.splice(index, 1); renderSettings(); }));
      strengthList.append(row);
    }
    const connectors = node("select", undefined, "connector-input");
    for (const id of state.order) {
      const option = node("option", connectorNames[id]);
      option.value = id;
      connectors.append(option);
    }
    const model = node("input", undefined, "connector-input");
    const modelOptions = node("datalist");
    modelOptions.id = "smart-model-options";
    model.setAttribute("list", modelOptions.id);
    async function modelSuggestions() {
      const id = connectors.value;
      modelOptions.replaceChildren();
      if (id === "freebuff") return;
      const catalog = await api.listModels(id as Exclude<SmartConnector, "freebuff">).catch(() => undefined);
      if (id !== connectors.value || !catalog) return;
      modelOptions.replaceChildren(...catalog.models.filter((entry) => entry.available).map((entry) => {
        const suggestion = node("option");
        suggestion.value = entry.id;
        return suggestion;
      }));
    }
    connectors.addEventListener("change", () => void modelSuggestions());
    model.addEventListener("focus", () => void modelSuggestions(), { once: true });
    model.maxLength = 200;
    const billing = node("select", undefined, "connector-input");
    const automatic = node("option", "Automatic");
    automatic.value = "";
    billing.append(automatic);
    for (const [id, label] of Object.entries(billingLabels)) {
      const option = node("option", label);
      option.value = id;
      billing.append(option);
    }
    const checks = new Map<SmartStrength, HTMLInputElement>();
    const tags = node("div", undefined, "workflow-actions");
    for (const strength of Object.keys(tagLabels) as SmartStrength[]) {
      const input = node("input");
      input.type = "checkbox";
      const label = node("label");
      label.append(input, document.createTextNode(` ${tagLabels[strength]}`));
      tags.append(label);
      checks.set(strength, input);
    }
    fields.replaceChildren(
      node("h3", "Connector order"), ordering, field("Freebuff preference", policy), overageLabel,
      node("h3", "Model preferences"), strengthList,
      node("p", "Add a model ID from the connector’s catalog. For Freebuff, use the model name you see in /model.", "connector-note"),
      field("Connector", connectors), field("Model ID or Freebuff model name", model), modelOptions, tags,
      field("Billing", billing),
      button("Add model preference", () => {
        const id = connectors.value as SmartConnector;
        const key = model.value.trim();
        const strengths = [...checks].filter(([, input]) => input.checked).map(([tag]) => tag);
        const status = elem("smart-settings-status");
        if (!key || (!strengths.length && !billing.value)) {
          status.textContent = "Enter a model and choose a strength or billing preference.";
          return;
        }
        state.strengths = [...state.strengths.filter((entry) => entry.connector !== id || entry.model !== key),
          { connector: id, model: key, strengths, ...(billing.value && { billing: billing.value as SmartBilling }) }];
        status.textContent = "Model preferences updated. Save Smart settings to apply them.";
        renderSettings();
      }),
    );
  }

  function freebuffEvent(event: FreebuffTerminalEvent) {
    if (!terminal || terminal.id !== event.id) {
      if (openingTerminal && earlyEvents.length < 100) earlyEvents.push(event);
      return;
    }
    if (event.data) terminal.view.write(event.data);
    if (event.state === "copied") terminalStatus.textContent = "Task copied. Choose the model, then paste and send the task.";
    if (event.state === "clipboard-error") terminalStatus.textContent = "Could not copy automatically. Use Copy task.";
    if (event.state === "closed") terminalStatus.textContent = "Freebuff closed. Return to the handoff to submit the reply or reopen it.";
  }

  async function openTerminal(runId: string, model: string) {
    if (terminal || openingTerminal) throw new Error("Close the current Freebuff terminal before opening another.");
    const Terminal = (window as Window & { Terminal?: new (options: object) => TerminalInstance }).Terminal;
    if (!Terminal) throw new Error("The Freebuff terminal could not load. Use Copy /model and Copy task for a manual handoff.");
    const view = new Terminal({ cols: 90, rows: 24, cursorBlink: true, allowProposedApi: false });
    openingTerminal = true;
    try {
      const id = await api.openSmartFreebuff(runId);
      terminal = { id, runId, view };
      elem("freebuff-terminal-instructions").textContent =
        `Recommended model: ${model || "Freebuff default"}. Paste /model and press Enter, then select the model and paste the task.`;
      terminalStatus.textContent = "/model copied.";
      dialog.showModal();
      view.open(screen);
      let enter = false;
      view.onKey(({ domEvent, key }) => { enter = domEvent.key === "Enter" && key === "\r"; });
      view.onData((data) => {
        const submitted = enter && data === "\r";
        enter = false;
        void api.freebuffTerminalInput({ id, data, enter: submitted }).catch((error) => { terminalStatus.textContent = errorText(error); });
      });
      for (const event of earlyEvents) freebuffEvent(event);
      view.focus();
    } catch (error) {
      if (terminal) void api.closeFreebuffTerminal(terminal.id).catch(() => undefined);
      terminal = undefined;
      view.dispose();
      if (dialog.open) dialog.close();
      throw error;
    } finally {
      openingTerminal = false;
      earlyEvents = [];
    }
  }

  function controls(run: WorkflowRun, rerender: () => void, busy: boolean) {
    if (!run.smart || run.status !== "waiting") return;
    const pending = run.smart.pending;
    const draft = drafts.get(run.id) ?? { reply: "", model: "", error: "" };
    drafts.set(run.id, draft);
    const section = node("section", undefined, "gate-controls");
    const actions = node("div", undefined, "workflow-actions");
    const error = node("p", draft.error, "workflow-error");
    error.setAttribute("role", "status");
    const execute = (call: () => Promise<unknown>, clear?: boolean) => {
      if (working.has(run.id)) return;
      working.add(run.id);
      draft.error = "";
      rerender();
      void call().then(() => {
        if (clear) drafts.delete(run.id);
      }).catch((failure) => { draft.error = errorText(failure); })
        .finally(() => { working.delete(run.id); rerender(); });
    };
    if (!pending) {
      section.append(node("p", busy ? "Ready to resume when the active run finishes." : "Ready to resume.", "workflow-note"));
      const resume = button("Resume", () => execute(() => api.resumeSmart(run.id), true));
      resume.disabled = busy;
      actions.append(resume);
    } else {
      const reply = node("textarea", undefined, "workflow-input");
      reply.rows = 4;
      reply.value = draft.reply;
      if (pending.kind === "question") {
        section.append(node("p", pending.question, "workflow-note"), field("Your answer", reply));
        reply.maxLength = 2_000;
      } else {
        const model = run.smart.selection[pending.stepId]?.model ?? "";
        section.append(node("p", `Freebuff is ready when you are. Recommended model: ${model || "Freebuff default"}.`, "workflow-note"));
        const actual = node("input", undefined, "workflow-input");
        actual.value = draft.model;
        actual.maxLength = 200;
        actual.addEventListener("input", () => { draft.model = actual.value; });
        section.append(field("Model used (optional)", actual), field("Freebuff reply", reply));
        reply.maxLength = 16_000;
        actions.append(
          button("Open Freebuff", () => execute(() => openTerminal(run.id, model))),
          button("Copy /model", () => execute(() => api.copySmartFreebuff({ runId: run.id, item: "model" }))),
          button("Copy task", () => execute(() => api.copySmartFreebuff({ runId: run.id, item: "task" }))),
          button("Use another connector", () => execute(() => api.rerouteSmart(run.id), true)),
        );
      }
      const submit = button(pending.kind === "question" ? "Submit answer" : "Submit reply", () => execute(() => pending.kind === "question"
        ? api.answerSmart({ runId: run.id, answer: draft.reply })
        : api.replySmartFreebuff({ runId: run.id, reply: draft.reply, model: draft.model }), true));
      submit.classList.add("button-primary");
      submit.disabled = !draft.reply.trim();
      reply.addEventListener("input", () => { draft.reply = reply.value; submit.disabled = !reply.value.trim(); });
      actions.append(submit);
    }
    if (working.has(run.id)) for (const control of actions.querySelectorAll("button")) control.disabled = true;
    section.append(actions, error);
    return section;
  }

  api.onFreebuffTerminal(freebuffEvent);
  dialog.addEventListener("close", () => {
    if (!terminal) return;
    const { id, view } = terminal;
    terminal = undefined;
    view.dispose();
    screen.replaceChildren();
    void api.closeFreebuffTerminal(id).catch(() => undefined);
  });
  elem("terminal-close").addEventListener("click", () => dialog.close());
  for (const item of ["model", "task"] as const) {
    elem(`terminal-copy-${item}`).addEventListener("click", () => {
      if (!terminal) return;
      void api.copySmartFreebuff({ runId: terminal.runId, item }).then(() => {
        terminalStatus.textContent = item === "model" ? "/model copied." : "Task copied.";
        terminal?.view.focus();
      }).catch((error) => { terminalStatus.textContent = errorText(error); });
    });
  }
  elem("usage-period").addEventListener("change", renderUsage);
  elem("refresh-quotas").addEventListener("click", () => void refreshQuota(true));
  window.setInterval(() => {
    if (!elem("settings").hidden) renderUsage();
  }, 60_000);
  elem("smart-settings-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!settings || settingsBusy) return;
    settingsBusy = true;
    const status = elem("smart-settings-status");
    void api.saveSmartSettings(settings).then((saved) => {
      settings = saved;
      status.textContent = "Smart settings saved.";
      renderSettings();
    }).catch((error) => { status.textContent = errorText(error); })
      .finally(() => { settingsBusy = false; });
  });

  return {
    controls,
    renderUsage,
    openSettings() {
      renderUsage();
      void refreshQuota(false);
      if (settings || settingsBusy) return;
      settingsBusy = true;
      void api.smartSettings().then((saved) => { settings = saved; renderSettings(); })
        .catch((error) => { elem("smart-settings-status").textContent = errorText(error); })
        .finally(() => { settingsBusy = false; });
    },
  };
}
