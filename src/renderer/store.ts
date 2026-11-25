import type {
  Connector, ConnectorStatus, HoneycombApi, ModelCatalog, ModelSelection, ProjectFolder, ProviderId, Run, RunStatus, RunUsage, WorkspaceMode,
} from "../shared/contracts.js";

declare global {
  interface Window {
    honeycomb: HoneycombApi;
    markdownit(options: { html: boolean }): {
      disable(rule: string): void;
      render(text: string): string;
    };
  }
}

export type View = "chats" | "workflows" | "connectors";

export const api = window.honeycomb;
export const markdown = window.markdownit({ html: false });
markdown.disable("image");

export const statusLabels = {
  running: "Running",
  stopping: "Stopping",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
} satisfies Record<RunStatus, string>;
export const connectorLabels = {
  detected: "Detected",
  missing: "Not installed",
  unavailable: "Unavailable",
  checking: "Checking",
} satisfies Record<ConnectorStatus, string>;
export const connectorDescriptions = {
  codex: "Uses the Codex CLI’s read-only sandbox.",
  opencode: "Uses OpenCode’s agent permissions to read and search the project.",
  claude: "Uses Claude Code with read and search tools only, no MCP servers, and no project settings.",
} satisfies Record<ProviderId, string>;
export const providerNames = {
  codex: "Codex",
  opencode: "OpenCode",
  claude: "Claude Code",
} satisfies Record<ProviderId, string>;
export const usageLabels = [
  ["inputTokens", "Input tokens"],
  ["outputTokens", "Output tokens"],
  ["cachedTokens", "Cached input"],
  ["costUsd", "Reported cost"],
] as const satisfies ReadonlyArray<readonly [keyof RunUsage, string]>;
export const number = new Intl.NumberFormat();
export const usd = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", maximumFractionDigits: 4,
});

// One mutable store, read by the React tree through useSyncExternalStore. Actions change it and call emit().
export const state = {
  view: "chats" as View,
  folder: undefined as ProjectFolder | undefined,
  mode: "code" as WorkspaceMode,
  switchingMode: false,
  codexChatModel: "",
  drafts: { code: "", chat: "" },
  lastRunByMode: {} as Partial<Record<WorkspaceMode, string | undefined>>,
  projects: [] as ProjectFolder[],
  expandedProjects: new Set<string>(),
  selectedRunId: undefined as string | undefined,
  selectedConnectorId: "codex" as ProviderId,
  catalogOpen: false,
  catalogQuery: "",
  modelCatalogs: {} as Partial<Record<ProviderId, ModelCatalog>>,
  modelRequests: {} as Partial<Record<ProviderId, Promise<void>>>,
  effortChoices: new Map<string, string[]>(),
  effortRequests: new Set<string>(),
  selectedEfforts: new Map<string, string>(),
  pendingModel: undefined as ModelSelection | undefined,
  connectorBusy: false,
  connectorAction: { provider: undefined as ProviderId | undefined, text: "" },
  choosing: false,
  checking: false,
  starting: false,
  actionError: "",
  prompt: "",
  provider: "codex" as ProviderId,
  connectors: [
    { id: "codex", name: "Codex", status: "checking" },
    { id: "opencode", name: "OpenCode", status: "checking" },
    { id: "claude", name: "Claude Code", status: "checking" },
  ] as Connector[],
  runs: new Map<string, Run>(),
  openToolGroups: new Set<string>(),
};

let version = 0;
const listeners = new Set<() => void>();
export const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const getVersion = () => version;
export function emit() {
  version++;
  for (const listener of listeners) listener();
}

export function focusLater(id: string) {
  requestAnimationFrame(() => document.getElementById(id)?.focus());
}

// Derived state

export function history() {
  return [...state.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function activeRun() {
  return [...state.runs.values()].find((run) => run.status === "running" || run.status === "stopping");
}

export function projectRuns(path = state.folder?.path) {
  return path ? history().filter((run) => run.folder?.path === path) : [];
}

export function generalChats() {
  return history().filter((run) => run.mode === "chat");
}

export function selectedRun() {
  return state.selectedRunId ? state.runs.get(state.selectedRunId) : undefined;
}

export function connectorFor(id: ProviderId) {
  return state.connectors.find((connector) => connector.id === id);
}

export function isCodexChat(providerId = state.provider) {
  return state.mode === "chat" && providerId === "codex";
}

/** The model the composer's picker shows for a provider. */
export function chatModelValue(providerId = state.provider) {
  const catalog = state.modelCatalogs[providerId];
  if (isCodexChat(providerId)) return state.codexChatModel;
  if (state.pendingModel?.providerId === providerId) return state.pendingModel.model;
  return catalog?.selected ?? "";
}

export function chatModelDisabled(providerId = state.provider) {
  return Boolean(state.modelRequests[providerId]) || state.connectorBusy || !state.modelCatalogs[providerId];
}

export function effortLabel(value: string) {
  if (value === "xhigh") return "Extra high";
  if (!value) return "Default";
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/[_-]/g, " ");
}

export function thinking(providerId = state.provider) {
  const modelId = chatModelValue(providerId);
  const key = (isCodexChat(providerId) ? "chat-codex" : providerId) + ":" + modelId;
  const catalog = state.modelCatalogs[providerId];
  const model = catalog?.models.find((entry) => entry.id === modelId);
  const choices = providerId !== "opencode" ? model?.efforts ?? [] : state.effortChoices.get(key) ?? [];
  const saved = state.selectedEfforts.get(key) ?? "";
  const selected = choices.includes(saved) ? saved : "";
  return { key, modelId, catalog, choices, selected, current: selected || model?.defaultEffort || "" };
}

export function controls() {
  const active = activeRun();
  const busy = Boolean(active) || state.starting || state.switchingMode;
  const providerId = state.provider;
  const provider = connectorFor(providerId);
  const saving = state.pendingModel?.providerId === providerId;
  const modelPending = Boolean(state.modelRequests[providerId]) || saving;
  const runDisabled = (state.mode === "code" && !state.folder) || busy || state.choosing || modelPending ||
    !state.prompt.trim() || provider?.status !== "detected";

  let message = state.actionError;
  if (!message && state.mode === "code" && !state.folder) message = "Choose a project folder to run a task.";
  if (!message && active) message = `${active.providerName} is ${statusLabels[active.status].toLowerCase()}.`;
  if (!message && provider?.status === "checking") message = `Checking for ${provider.name}…`;
  if (!message && provider?.status !== "detected") message = `${provider?.name ?? "The connector"} is unavailable. See Connectors for details.`;
  if (!message && modelPending) message = saving ? `Saving ${provider?.name} model…` : `Loading ${provider?.name} models…`;
  return { active, busy, runDisabled, message };
}

// Actions

function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : fallback;
}

export function showError(error: unknown) {
  state.actionError = errorText(error, "Honeycomb could not complete the action.");
  emit();
}

function remember(run: Run) {
  if ((state.runs.get(run.id)?.revision ?? -1) >= run.revision) return;
  state.runs.set(run.id, run);
}

export function showView(view: View) {
  state.view = view;
  emit();
  if (view === "connectors" && !state.catalogOpen && !state.modelCatalogs[state.selectedConnectorId]) {
    void refreshModels(state.selectedConnectorId);
  }
}

export function selectRun(id: string | undefined) {
  state.selectedRunId = id;
  emit();
}

export function refreshModels(providerId: ProviderId) {
  const current = state.modelRequests[providerId];
  if (current) return current;
  const request = api.listModels(providerId).then((catalog) => {
    state.modelCatalogs[providerId] = catalog;
  }).catch(() => {
    state.modelCatalogs[providerId] ??= { models: [], selected: "", localError: "Could not load models. Try refreshing." };
  }).finally(() => {
    delete state.modelRequests[providerId];
    emit();
  });
  state.modelRequests[providerId] = request;
  emit();
  return request;
}

/** Loads what the composer needs. Runs after every render, so each check guards against repeat requests. */
export function loadForView() {
  const providerId = state.provider;
  if (state.view === "chats" && !state.modelCatalogs[providerId] && !state.modelRequests[providerId] &&
      connectorFor(providerId)?.status === "detected") {
    void refreshModels(providerId);
  }
  const { key, modelId, catalog } = thinking(providerId);
  if (providerId === "opencode" && catalog && !state.effortChoices.has(key) && !state.effortRequests.has(key)) {
    state.effortRequests.add(key);
    void api.listOpenCodeEfforts(modelId).then(
      (choices) => state.effortChoices.set(key, choices),
      () => state.effortChoices.set(key, []),
    ).finally(() => {
      state.effortRequests.delete(key);
      emit();
    });
  }
}

export async function openProject(project: ProjectFolder, runId?: string) {
  if (state.mode !== "code" || state.choosing || state.starting || state.switchingMode) return;
  state.choosing = true;
  state.actionError = "";
  emit();
  try {
    state.folder = await api.selectProject(project.path);
    state.selectedRunId = runId ?? projectRuns()[0]?.id;
  } catch (error) {
    showError(error);
  } finally {
    state.choosing = false;
    emit();
  }
}

export function toggleProject(path: string) {
  if (state.expandedProjects.has(path)) state.expandedProjects.delete(path);
  else state.expandedProjects.add(path);
  emit();
}

export function toggleToolGroup(key: string, open: boolean) {
  if (open) state.openToolGroups.add(key);
  else state.openToolGroups.delete(key);
}

export async function switchMode(next: WorkspaceMode) {
  if (state.mode === next || state.switchingMode || state.choosing || state.starting || activeRun()) return;
  state.switchingMode = true;
  emit();
  try {
    await api.setMode(next);
    state.drafts[state.mode] = state.prompt;
    state.lastRunByMode[state.mode] = state.selectedRunId;
    state.mode = next;
    state.prompt = state.drafts[next];
    state.selectedRunId = Object.hasOwn(state.lastRunByMode, next) ? state.lastRunByMode[next]
      : (next === "chat" ? generalChats() : projectRuns())[0]?.id;
    state.actionError = "";
  } catch (error) {
    showError(error);
  } finally {
    state.switchingMode = false;
    emit();
  }
}

export function openCatalog() {
  state.catalogOpen = true;
  emit();
  focusLater("connector-search");
}

export function setCatalogQuery(query: string) {
  state.catalogQuery = query;
  emit();
}

export function selectConnector(id: ProviderId) {
  if (id !== state.selectedConnectorId) state.connectorAction.text = "";
  state.selectedConnectorId = id;
  state.catalogOpen = false;
  emit();
  if (!state.modelCatalogs[id] && !state.connectorBusy) void refreshModels(id);
}

async function connectorAction(
  providerId: ProviderId, action: () => Promise<void>, pending: string, success: string, onError?: (error: unknown) => void,
) {
  if (state.connectorBusy) return;
  state.connectorBusy = true;
  state.connectorAction = { provider: providerId, text: pending };
  emit();
  try {
    await action();
    state.connectorAction.text = success;
  } catch (error) {
    state.connectorAction.text = errorText(error, "Honeycomb could not complete this action.");
    onError?.(error);
  } finally {
    state.connectorBusy = false;
    emit();
  }
}

export async function saveModel(fromChat: boolean, model: string) {
  const providerId = fromChat ? state.provider : state.selectedConnectorId;
  if (fromChat && isCodexChat(providerId)) {
    state.codexChatModel = model;
    state.actionError = "";
    emit();
    return;
  }
  const catalog = state.modelCatalogs[providerId];
  if (!catalog || state.connectorBusy || state.modelRequests[providerId]) return;
  if (fromChat) state.actionError = "";
  state.pendingModel = { providerId, model };
  emit();
  try {
    await connectorAction(providerId, async () => {
      await api.setModel({ providerId, model });
      catalog.selected = model;
    }, "Saving model selection…", "Model selection saved.", fromChat ? showError : undefined);
  } finally {
    state.pendingModel = undefined;
    emit();
  }
}

export function setThinking(value: string) {
  state.selectedEfforts.set(thinking().key, value);
  emit();
}

export async function refreshConnectors() {
  if (state.checking) return;
  state.checking = true;
  emit();
  try {
    state.connectors = await api.inspectProviders();
  } catch {
    state.connectors = state.connectors.map((connector) => ({
      ...connector, status: "unavailable", detail: "The installation check could not run.",
    }));
  } finally {
    state.checking = false;
    emit();
  }
}

export async function downloadOpenCode() {
  await connectorAction("opencode", async () => {
    await api.installOpenCode();
    await refreshConnectors();
    await state.modelRequests.opencode;
    await refreshModels("opencode");
  }, "Downloading and checking OpenCode…", "OpenCode downloaded. You can now test a model.");
}

export function testOpenCode() {
  void connectorAction("opencode", () => api.testOpenCode(), "Testing the selected model…", "OpenCode returned a model response.");
}

export function useConnector() {
  state.provider = state.selectedConnectorId;
  state.actionError = "";
  state.view = "chats";
  emit();
  focusLater("prompt");
}

export function setProvider(providerId: ProviderId) {
  state.provider = providerId;
  state.actionError = "";
  emit();
}

export function setPrompt(text: string, focus = false) {
  state.prompt = text;
  state.actionError = "";
  emit();
  if (focus) focusLater("prompt");
}

export async function stopRun() {
  const run = activeRun();
  if (!run) return;
  try {
    await api.stopRun(run.id);
  } catch (error) {
    showError(error);
  }
}

export function newTask() {
  state.actionError = "";
  state.selectedRunId = undefined;
  emit();
  focusLater("prompt");
}

export async function chooseFolder() {
  if (state.mode !== "code") return;
  state.choosing = true;
  state.actionError = "";
  emit();
  try {
    const selection = await api.chooseFolder();
    if (selection && selection.path !== state.folder?.path) {
      if (!state.projects.some((project) => project.path === selection.path)) state.projects.push(selection);
      state.folder = selection;
      state.selectedRunId = projectRuns()[0]?.id;
    }
  } catch (error) {
    showError(error);
  } finally {
    state.choosing = false;
    emit();
  }
}

export async function submitTask() {
  const connector = connectorFor(state.provider);
  if (!connector || controls().runDisabled) return;
  const draft = state.prompt;
  state.starting = true;
  state.actionError = "";
  emit();
  try {
    state.selectedRunId = await api.startRun({
      providerId: connector.id, prompt: draft, effort: thinking().selected, model: chatModelValue(),
    });
    if (state.prompt === draft) state.prompt = "";
  } catch (error) {
    showError(error);
  } finally {
    state.starting = false;
    emit();
  }
}

export function openReplyLink(href: string) {
  void api.openReplyLink(href).catch(showError);
}

export function start() {
  api.onRunChanged((run) => {
    const previous = state.runs.get(run.id);
    remember(run);
    if (previous?.status !== run.status) {
      const inMode = run.mode === "chat" ? state.mode === "chat" : state.mode === "code" && run.folder?.path === state.folder?.path;
      if (run.revision === 1 && inMode) state.selectedRunId = run.id;
    }
    emit();
  });
  void refreshConnectors();
  api.getState().then((saved) => {
    state.folder = saved.folder;
    state.projects = saved.projects;
    state.mode = saved.mode === "chat" ? "chat" : "code";
    for (const run of saved.runs) remember(run);
    state.selectedRunId ??= (state.mode === "chat" ? generalChats() : projectRuns())[0]?.id;
    emit();
  }).catch(showError);
}
