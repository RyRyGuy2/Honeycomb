import type {
  Connector, ConnectorStatus, HoneycombApi, ModelCatalog, ModelSelection, ProjectFolder, ProviderId, Run, RunEvent, RunStatus, RunUsage, WorkspaceMode,
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

const api = window.honeycomb;
const markdown = window.markdownit({ html: false });
markdown.disable("image");
const viewButtons = document.querySelectorAll<HTMLButtonElement>("[data-view]");
const connectorButtons = document.querySelectorAll<HTMLButtonElement>("[data-connector]");
const promptField = get("prompt", HTMLTextAreaElement);
const providerField = get("provider", HTMLSelectElement);
const chatModelField = get("chat-model", HTMLSelectElement);
const thinkingField = get("thinking-level", HTMLSelectElement);
const connectorModelField = get("connector-model", HTMLSelectElement);
const runButton = get("run-task", HTMLButtonElement);
const chatStatus = get("chat-status");
const modeButtons = document.querySelectorAll<HTMLButtonElement>("[data-mode]");

const statusLabels = {
  running: "Running",
  stopping: "Stopping",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
} satisfies Record<RunStatus, string>;
const connectorLabels = {
  detected: "Detected",
  missing: "Not installed",
  unavailable: "Unavailable",
  checking: "Checking",
} satisfies Record<ConnectorStatus, string>;
const connectorDescriptions = {
  codex: "Uses the Codex CLI’s read-only sandbox.",
  opencode: "Uses OpenCode’s agent permissions to read and search the project.",
} satisfies Record<ProviderId, string>;
const usageLabels = [
  ["inputTokens", "Input tokens"],
  ["outputTokens", "Output tokens"],
  ["cachedTokens", "Cached input"],
  ["costUsd", "Reported cost"],
] as const satisfies ReadonlyArray<readonly [keyof RunUsage, string]>;
const number = new Intl.NumberFormat();
const usd = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", maximumFractionDigits: 4,
});

let folder: ProjectFolder | undefined;
let mode: WorkspaceMode = "code";
let switchingMode = false;
let codexChatModel = "";
const drafts = { code: "", chat: "" };
const lastRunByMode: Partial<Record<WorkspaceMode, string | undefined>> = {};
let projects: ProjectFolder[] = [];
const expandedProjects = new Set<string>();
let selectedRunId: string | undefined;
let selectedConnectorId: ProviderId = "codex";
let catalogOpen = false;
const modelCatalogs: Partial<Record<ProviderId, ModelCatalog>> = {};
const modelRequests: Partial<Record<ProviderId, Promise<void>>> = {};
const effortChoices = new Map<string, string[]>();
const effortRequests = new Set<string>();
const selectedEfforts = new Map<string, string>();
let pendingModel: ModelSelection | undefined;
let connectorBusy = false;
let choosing = false;
let checking = false;
let starting = false;
let actionError = "";
let lastThreadId: string | undefined;
let connectors: Connector[] = [
  { id: "codex", name: "Codex", status: "checking" },
  { id: "opencode", name: "OpenCode", status: "checking" },
];
const runs = new Map<string, Run>();
const openToolGroups = new Set<string>();

function get(id: string): HTMLElement;
function get<T extends HTMLElement>(id: string, elementType: new () => T): T;
function get(id: string, elementType: new () => HTMLElement = HTMLElement): HTMLElement {
  const node = document.getElementById(id);
  if (!(node instanceof elementType)) throw new Error(`Missing or unexpected element: ${id}`);
  return node;
}

function element<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showView(name: string) {
  for (const button of viewButtons) {
    const view = button.dataset.view;
    if (!view) continue;
    const selected = view === name;
    get(view).hidden = !selected;
    get(`${view}-sidebar`).hidden = !selected;
    if (selected) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  if (name === "connectors" && !catalogOpen && !modelCatalogs[selectedConnectorId]) {
    void refreshModels(selectedConnectorId);
  }
  if (name === "chats") renderComposerProvider();
}

function history() {
  return [...runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function remember(run: Run) {
  if ((runs.get(run.id)?.revision ?? -1) >= run.revision) return;
  runs.set(run.id, run);
}

function activeRun() {
  return [...runs.values()].find((run) => run.status === "running" || run.status === "stopping");
}

function projectRuns(path = folder?.path) {
  return path ? history().filter((run) => run.folder?.path === path) : [];
}

function generalChats() {
  return history().filter((run) => run.mode === "chat");
}

function statusDot(status: ConnectorStatus | RunStatus) {
  const dot = element("span", "status-dot");
  dot.setAttribute("aria-hidden", "true");
  dot.dataset.status = status;
  return dot;
}

function showError(error: unknown) {
  const message = error instanceof Error ? error.message : "Honeycomb could not complete the action.";
  actionError = message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
  renderControls();
}

function renderControls() {
  const active = activeRun();
  const busy = Boolean(active) || starting || switchingMode;
  const stop = get("stop-run", HTMLButtonElement);
  const providerId = chatProviderId();
  const provider = connectors.find((connector) => connector.id === providerId);
  const saving = pendingModel?.providerId === providerId;
  const modelPending = Boolean(modelRequests[providerId]) || saving;
  get("choose-folder", HTMLButtonElement).disabled = choosing || busy;
  get("new-task", HTMLButtonElement).disabled = choosing || busy;
  for (const button of modeButtons) button.disabled = choosing || busy;
  stop.hidden = !active;
  stop.disabled = active?.status === "stopping";
  stop.textContent = stop.disabled ? "Stopping…" : "Stop run";
  runButton.disabled = (mode === "code" && !folder) || busy || choosing || modelPending ||
    !promptField.value.trim() || provider?.status !== "detected";
  chatStatus.dataset.error = String(Boolean(actionError));

  let message = actionError;
  if (!message && mode === "code" && !folder) message = "Choose a project folder to run a task.";
  if (!message && active) message = `${active.providerName} is ${statusLabels[active.status].toLowerCase()}.`;
  if (!message && provider?.status === "checking") message = `Checking for ${provider.name}…`;
  if (!message && provider?.status !== "detected") message = `${provider?.name ?? "The connector"} is unavailable. See Connectors for details.`;
  if (!message && modelPending) message = saving ? `Saving ${provider?.name} model…` : `Loading ${provider?.name} models…`;
  if (chatStatus.textContent !== message) chatStatus.textContent = message;
}

function chatProviderId(): ProviderId {
  return providerField.value === "opencode" ? "opencode" : "codex";
}

function renderComposerProvider() {
  const providerId = chatProviderId();
  if (!get("chats").hidden && !modelCatalogs[providerId] &&
      connectors.some((connector) => connector.id === providerId && connector.status === "detected")) {
    void refreshModels(providerId);
  }
  renderModelPicker(chatModelField, providerId);
  renderThinking(providerId);
  renderControls();
}

async function openProject(project: ProjectFolder, runId?: string) {
  if (mode !== "code" || choosing || starting || switchingMode) return;
  choosing = true;
  actionError = "";
  renderControls();
  try {
    folder = await api.selectProject(project.path);
    selectedRunId = runId ?? projectRuns()[0]?.id;
  } catch (error) {
    showError(error);
  } finally {
    choosing = false;
    renderChats();
  }
}

function historyButton(run: Run, select: () => void) {
  const button = element("button", "history-item");
  button.type = "button";
  button.title = run.prompt;
  if (run.id === selectedRunId) button.setAttribute("aria-current", "true");
  button.append(
    element("span", "history-name", run.prompt.replace(/\s+/g, " ")),
    element("span", "history-meta", `${run.providerName} · ${statusLabels[run.status]}`),
  );
  button.addEventListener("click", select);
  return button;
}

function renderSidebar() {
  const list = get("run-list");
  if (mode === "chat") {
    const chats = generalChats();
    list.replaceChildren(...(chats.length ? chats.map((run) => historyButton(run, () => selectRun(run.id)))
      : [element("p", "", "No chats yet.")]));
    return;
  }
  const groups = projects.map((project) => {
    const group = element("section", "project-group");
    const title = element("button", "folder-picker");
    title.type = "button";
    title.title = project.path;
    title.append(element("span", "folder-icon"), element("span", "history-name", project.name));
    if (project.path === folder?.path) title.setAttribute("aria-current", "true");
    title.addEventListener("click", () => void openProject(project));
    const chats = projectRuns(project.path);
    const expanded = expandedProjects.has(project.path);
    const chatList = element("div", "project-chats");
    for (const run of expanded ? chats : chats.slice(0, 3)) {
      chatList.append(historyButton(run, () => void openProject(project, run.id)));
    }
    if (chats.length > 3) {
      const toggle = element("button", "history-item history-more", expanded ? "Show less" : "...");
      toggle.type = "button";
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.setAttribute("aria-label", expanded ? `Show fewer chats in ${project.name}` : `Show more chats in ${project.name}`);
      toggle.addEventListener("click", () => {
        if (expanded) expandedProjects.delete(project.path);
        else expandedProjects.add(project.path);
        renderSidebar();
      });
      chatList.append(toggle);
    }
    group.append(title, chatList);
    return group;
  });
  list.replaceChildren(...(groups.length ? groups : [element("p", "", "No saved projects yet.")]));
}

function feedEntry(author: string, text: string, className = "") {
  const card = element("article", `feed-entry ${className}`);
  card.append(element("h2", "", author), element("p", "", text));
  return card;
}

function agentReply(author: string, text: string) {
  const article = element("article", "agent-reply");
  const body = element("div", "markdown");
  body.innerHTML = markdown.render(text);
  article.append(element("h2", "visually-hidden", author), body);
  return article;
}

function toolActivity(events: RunEvent[], key: string) {
  const details = element("details", "tool-activity");
  const summary = element("summary", "", "Tool activity");
  summary.append(element("span", "tool-count", `${events.length} ${events.length === 1 ? "update" : "updates"}`));
  const list = element("ol");
  for (const event of events) {
    if (event.type === "tool_call" || event.type === "tool_result") list.append(element("li", "", event.text));
  }
  details.open = openToolGroups.has(key);
  details.addEventListener("toggle", () => {
    if (!details.isConnected) return;
    if (details.open) openToolGroups.add(key);
    else openToolGroups.delete(key);
  });
  details.append(summary, list);
  return details;
}

get("feed").addEventListener("click", (event) => {
  const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
  if (!link) return;
  event.preventDefault();
  if (/^https?:$/.test(link.protocol)) void api.openReplyLink(link.href).catch(showError);
});

function renderThread(run: Run | undefined) {
  const thread = get("thread");
  const feed = get("feed");
  const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 55;
  get("welcome").hidden = Boolean(run);
  feed.hidden = !run;

  if (!run) {
    lastThreadId = undefined;
    feed.replaceChildren();
    return;
  }

  const entries = [feedEntry("You", run.prompt, "user")];
  let tools: RunEvent[] = [];
  function flushTools() {
    const first = tools[0];
    if (!first) return;
    entries.push(toolActivity(tools, `${first.runId}:${first.sequence}`));
    tools = [];
  }
  for (const event of run.events) {
    if (event.type === "usage") continue;
    if (event.type === "tool_call" || event.type === "tool_result") {
      tools.push(event);
      continue;
    }
    flushTools();
    if (event.type === "message") {
      entries.push(agentReply(run.providerName, event.text));
    } else {
      entries.push(element("p", `feed-line ${event.type}`, event.text));
    }
  }
  flushTools();
  feed.replaceChildren(...entries);
  if (atBottom || run.id !== lastThreadId) thread.scrollTop = thread.scrollHeight;
  lastThreadId = run.id;
}

function facts(items: ReadonlyArray<readonly [label: string, value: string]>) {
  const list = element("dl", "run-facts");
  for (const [label, value] of items) {
    const row = element("div");
    row.append(element("dt", "", label), element("dd", "", value));
    list.append(row);
  }
  return list;
}

function renderDetails(run: Run | undefined) {
  const panel = get("run-details");
  if (!run) {
    panel.replaceChildren(element("p", "empty-details", "Run status and reported usage appear here."));
    return;
  }

  const heading = element("div", "detail-top");
  const state = element("span", "run-state");
  state.append(statusDot(run.status), statusLabels[run.status]);
  heading.append(element("h3", "", run.providerName), state);

  const usage = element("section", "run-usage");
  usage.append(element("h3", "", "Usage"));
  const totals: Array<[string, string]> = [];
  for (const [key, label] of usageLabels) {
    const value = run.usage[key];
    if (value !== undefined) totals.push([label, (key === "costUsd" ? usd : number).format(value)]);
  }
  const active = run.status === "running" || run.status === "stopping";
  const emptyUsage = active ? "Waiting for usage data." : "The provider reported no usage.";
  usage.append(totals.length ? facts(totals) : element("p", "empty-details", emptyUsage));

  panel.replaceChildren(
    heading,
    ...(run.folder ? [facts([["Project", run.folder.name], ["Workflow", "Solo"]])] : []),
    usage,
  );
}

function renderChats() {
  const run = selectedRunId ? runs.get(selectedRunId) : undefined;
  const title = get("chat-title");
  title.textContent = run?.prompt.replace(/\s+/g, " ") ?? (mode === "chat" ? "New chat" : "New task");
  title.title = run ? title.textContent : "";
  renderSidebar();
  renderThread(run);
  renderDetails(run);
  renderControls();
}

function selectRun(id: string | undefined) {
  selectedRunId = id;
  renderChats();
}

function renderWorkspaceMode() {
  const chat = mode === "chat";
  for (const button of modeButtons) button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
  for (const button of viewButtons) {
    if (button.dataset.view === "workflows") button.hidden = chat;
  }
  get("chats").classList.toggle("chat-only", chat);
  get("choose-folder").hidden = chat;
  get("history-title").textContent = chat ? "Recent chats" : "Projects";
  get("welcome-title").textContent = chat ? "Ask a question" : "Start a review run";
  get("welcome-description").textContent = chat ? "Choose a model and start a conversation." : "Choose a project and ask Codex or OpenCode to investigate.";
  get("prompt-ideas").hidden = chat;
  get("send-label").textContent = chat ? "Send" : "Run task";
  promptField.placeholder = chat ? "Ask a question…" : "Ask about your project…";
  renderComposerProvider();
  renderChats();
}

async function switchMode(next: WorkspaceMode) {
  if (mode === next || switchingMode || choosing || starting || activeRun()) return;
  switchingMode = true;
  renderControls();
  try {
    await api.setMode(next);
    drafts[mode] = promptField.value;
    lastRunByMode[mode] = selectedRunId;
    mode = next;
    promptField.value = drafts[mode];
    selectedRunId = Object.hasOwn(lastRunByMode, mode) ? lastRunByMode[mode]
      : (mode === "chat" ? generalChats() : projectRuns())[0]?.id;
    actionError = "";
    renderWorkspaceMode();
  } catch (error) {
    showError(error);
  } finally {
    switchingMode = false;
    renderControls();
  }
}

function renderConnectors() {
  const refresh = get("refresh-connectors", HTMLButtonElement);
  refresh.disabled = checking;
  refresh.textContent = checking ? "Checking…" : "Refresh";

  for (const button of connectorButtons) {
    const connector = connectors.find((entry) => entry.id === button.dataset.connector);
    const state = button.querySelector(".connector-row-status");
    if (!connector || !state) continue;
    state.replaceChildren(statusDot(connector.status), connectorLabels[connector.status]);
    if (!catalogOpen && connector.id === selectedConnectorId) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  }

  const connector = connectors.find((entry) => entry.id === selectedConnectorId);
  if (!connector) return;
  const mark = get("connector-mark");
  mark.textContent = connector.name.charAt(0);
  mark.classList.toggle("opencode", connector.id === "opencode");
  get("connector-title").textContent = connector.name;
  get("connector-description").textContent = connectorDescriptions[connector.id];
  get("connector-status").replaceChildren(statusDot(connector.status), connectorLabels[connector.status]);
  get("connector-version").textContent = connector.version ?? "";
  get("connector-version-row").hidden = !connector.version;

  const note = get("connector-detail-note");
  const installHint = connector.status === "missing" ? "Install the CLI and make it available on PATH." : "";
  note.textContent = connector.detail || installHint;
  note.hidden = !note.textContent;

  const use = get("use-connector", HTMLButtonElement);
  use.textContent = `Use ${connector.name}`;
  use.disabled = connector.status !== "detected";
  const openCode = connector.id === "opencode";
  get("opencode-actions").hidden = !openCode;
  const status = get("connector-action-status");
  status.hidden = status.dataset.provider !== connector.id;
  const download = get("download-opencode", HTMLButtonElement);
  download.hidden = !connector.downloadAvailable || (connector.managed === true && connector.status === "detected");
  download.disabled = connectorBusy;
  get("test-opencode", HTMLButtonElement).disabled = connector.status !== "detected" || connectorBusy || Boolean(modelRequests.opencode);
  renderModels();
  if (catalogOpen) renderCatalog();
}

function renderCatalog() {
  const query = get("connector-search", HTMLInputElement).value.trim().toLowerCase();
  const results = connectors.filter(({ name, id }) =>
    `${name} ${connectorDescriptions[id]}`.toLowerCase().includes(query));
  const cards = results.map((connector) => {
    const card = element("article", "connector-result");
    const text = element("div");
    text.append(
      element("h2", "", connector.name),
      element("p", "connector-note", connectorDescriptions[connector.id]),
      element("p", "connector-note", connectorLabels[connector.status]),
    );
    const actions = element("div", "connector-actions");
    const details = element("button", "button button-small", `View ${connector.name}`);
    details.type = "button";
    details.addEventListener("click", () => {
      selectConnector(connector.id);
      get("connector-title").focus();
    });
    actions.append(details);
    if (connector.downloadAvailable && !(connector.managed && connector.status === "detected")) {
      const download = element("button", "button button-small button-primary", "Download OpenCode");
      download.type = "button";
      download.disabled = connectorBusy;
      download.addEventListener("click", () => {
        selectConnector("opencode");
        void downloadOpenCode();
      });
      actions.append(download);
    }
    card.append(text, actions);
    return card;
  });
  get("connector-results").replaceChildren(...(cards.length ? cards : [element("p", "connector-note", "No connectors match your search.")]));
}

function selectConnector(id: ProviderId) {
  if (id !== selectedConnectorId) get("connector-action-status").textContent = "";
  selectedConnectorId = id;
  catalogOpen = false;
  get("connector-catalog").hidden = true;
  get("connector-settings").hidden = false;
  get("add-connector").removeAttribute("aria-current");
  renderConnectors();
  if (!modelCatalogs[id] && !connectorBusy) void refreshModels(id);
}

function shortModelName(model: ModelCatalog["models"][number]) {
  return (model.name === model.id ? model.id.split("/").pop() ?? model.id : model.name).replace(/\s+\([^)]*\)$/, "");
}

function renderModelPicker(select: HTMLSelectElement, providerId: ProviderId) {
  const codexChat = select === chatModelField && mode === "chat" && providerId === "codex";
  const catalog = modelCatalogs[providerId];
  const loading = Boolean(modelRequests[providerId]);
  const providerName = providerId === "codex" ? "Codex" : "OpenCode";
  const fallback = element("option", "", loading && !catalog ? "Loading models…" : `${providerName} default`);
  fallback.value = "";
  const local = element("optgroup");
  local.label = `Listed by ${providerName}`;
  const online = element("optgroup");
  online.label = "Online catalog · may require setup";
  for (const model of catalog?.models ?? []) {
    const option = element("option", "", select === chatModelField ? shortModelName(model)
      : model.name === model.id ? model.id : `${model.name} (${model.id})`);
    option.value = model.id;
    option.disabled = !model.available;
    (model.available ? local : online).append(option);
  }
  const selected = (codexChat ? codexChatModel : pendingModel?.providerId === providerId ? pendingModel.model : catalog?.selected) ?? "";
  if (selected && !catalog?.models.some((model) => model.id === selected && model.available)) {
    const saved = element("option", "", select === chatModelField ? selected.split("/").pop() : `${selected} (saved selection)`);
    saved.value = selected;
    local.append(saved);
  }
  local.hidden = !local.childElementCount;
  online.hidden = !online.childElementCount;
  select.replaceChildren(fallback, local, online);
  select.value = selected;
  select.disabled = loading || connectorBusy || !catalog;
}

function effortLabel(value: string) {
  if (value === "xhigh") return "Extra high";
  if (!value) return "Default";
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/[_-]/g, " ");
}

function renderThinking(providerId: ProviderId) {
  const modelId = chatModelField.value;
  const codexChat = mode === "chat" && providerId === "codex";
  const key = (codexChat ? "chat-codex" : providerId) + ":" + modelId;
  const catalog = modelCatalogs[providerId];
  const model = catalog?.models.find((entry) => entry.id === modelId);
  if (providerId === "opencode" && catalog && !effortChoices.has(key) && !effortRequests.has(key)) {
    effortRequests.add(key);
    void api.listOpenCodeEfforts(modelId).then(
      (choices) => effortChoices.set(key, choices),
      () => effortChoices.set(key, []),
    ).finally(() => {
      effortRequests.delete(key);
      if (chatProviderId() === providerId && chatModelField.value === modelId) {
        renderModelPicker(chatModelField, providerId);
        renderThinking(providerId);
      }
    });
  }
  const choices = providerId === "codex" ? model?.efforts ?? [] : effortChoices.get(key) ?? [];
  const saved = selectedEfforts.get(key) ?? "";
  const selected = choices.includes(saved) ? saved : "";
  const current = selected || model?.defaultEffort || "";
  const defaultOption = element("option", "", "Thinking: default");
  defaultOption.value = "";
  const options = choices.map((value) => {
    const option = element("option", "", effortLabel(value));
    option.value = value;
    return option;
  });
  thinkingField.replaceChildren(defaultOption, ...options);
  thinkingField.value = selected;
  thinkingField.disabled = !choices.length || chatModelField.disabled;
  thinkingField.title = effortRequests.has(key) ? "Looking for thinking levels…"
    : choices.length ? "Thinking level" : "This model uses its default thinking level";
  const active = chatModelField.selectedOptions[0];
  if (active && !chatModelField.disabled) {
    const label = active.textContent ?? "";
    const suffix = " · " + effortLabel(current);
    active.textContent = (label.length > 22 ? label.slice(0, 21) + "…" : label) + suffix;
  }
}

function renderModels() {
  renderModelPicker(chatModelField, chatProviderId());
  renderThinking(chatProviderId());
  renderModelPicker(connectorModelField, selectedConnectorId);
  const catalog = modelCatalogs[selectedConnectorId];
  const loading = Boolean(modelRequests[selectedConnectorId]);
  get("refresh-models", HTMLButtonElement).disabled = loading || connectorBusy;
  get("model-status").textContent = loading ? "Looking for models…" : [
    catalog?.localError,
    catalog?.onlineError,
    catalog?.models.some((model) => !model.available) ? "Online-only models must be available in your OpenCode setup before selection." : "",
  ].filter(Boolean).join(" ");
}

function refreshModels(providerId: ProviderId) {
  const current = modelRequests[providerId];
  if (current) return current;
  const request = api.listModels(providerId).then((catalog) => {
    modelCatalogs[providerId] = catalog;
  }).catch(() => {
    modelCatalogs[providerId] ??= { models: [], selected: "", localError: "Could not load models. Try refreshing." };
  }).finally(() => {
    delete modelRequests[providerId];
    renderConnectors();
    renderControls();
  });
  modelRequests[providerId] = request;
  renderConnectors();
  renderControls();
  return request;
}

async function connectorAction(providerId: ProviderId, action: () => Promise<void>, pending: string, success: string, onError?: (error: unknown) => void) {
  if (connectorBusy) return;
  connectorBusy = true;
  const status = get("connector-action-status");
  status.dataset.provider = providerId;
  status.textContent = pending;
  renderConnectors();
  try {
    await action();
    status.textContent = success;
  } catch (error) {
    status.textContent = error instanceof Error
      ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")
      : "Honeycomb could not complete this action.";
    onError?.(error);
  } finally {
    connectorBusy = false;
    renderConnectors();
  }
}

async function saveModel(picker: HTMLSelectElement) {
  const fromChat = picker === chatModelField;
  const providerId = fromChat ? chatProviderId() : selectedConnectorId;
  if (fromChat && mode === "chat" && providerId === "codex") {
    codexChatModel = picker.value;
    actionError = "";
    renderControls();
    return;
  }
  const catalog = modelCatalogs[providerId];
  if (!catalog || connectorBusy || modelRequests[providerId]) return;
  const model = picker.value;
  if (fromChat) actionError = "";
  pendingModel = { providerId, model };
  renderControls();
  try {
    await connectorAction(providerId, async () => {
      await api.setModel({ providerId, model });
      catalog.selected = model;
    }, "Saving model selection…", "Model selection saved.", fromChat ? showError : undefined);
  } finally {
    pendingModel = undefined;
    renderModels();
    renderControls();
  }
}

async function downloadOpenCode() {
  await connectorAction("opencode", async () => {
    await api.installOpenCode();
    await refreshConnectors();
    await modelRequests.opencode;
    await refreshModels("opencode");
  }, "Downloading and checking OpenCode…", "OpenCode downloaded. You can now test a model.");
}

async function refreshConnectors() {
  if (checking) return;
  checking = true;
  renderConnectors();
  try {
    connectors = await api.inspectProviders();
  } catch {
    connectors = connectors.map((connector) => ({
      ...connector, status: "unavailable", detail: "The installation check could not run.",
    }));
  } finally {
    checking = false;
    renderConnectors();
    renderComposerProvider();
  }
}

for (const button of viewButtons) {
  button.addEventListener("click", () => {
    if (button.dataset.view) showView(button.dataset.view);
  });
}
for (const button of modeButtons) {
  button.addEventListener("click", () => {
    const next = button.dataset.mode;
    if (next === "code" || next === "chat") void switchMode(next);
  });
}
for (const button of connectorButtons) {
  button.addEventListener("click", () => {
    const connector = connectors.find((entry) => entry.id === button.dataset.connector);
    if (!connector) return;
    selectConnector(connector.id);
  });
}
get("add-connector").addEventListener("click", () => {
  catalogOpen = true;
  get("connector-catalog").hidden = false;
  get("connector-settings").hidden = true;
  get("add-connector").setAttribute("aria-current", "true");
  renderConnectors();
  get("connector-search").focus();
});
get("connector-search").addEventListener("input", renderCatalog);
get("download-opencode").addEventListener("click", downloadOpenCode);
get("refresh-models").addEventListener("click", () => { void refreshModels(selectedConnectorId); });
get("test-opencode").addEventListener("click", () => {
  void connectorAction("opencode", () => api.testOpenCode(), "Testing the selected model…", "OpenCode returned a model response.");
});
for (const picker of [connectorModelField, chatModelField]) {
  picker.addEventListener("change", () => { void saveModel(picker); });
}
get("select-solo").addEventListener("click", () => get("solo-title").focus());
get("use-solo").addEventListener("click", () => {
  showView("chats");
  promptField.focus();
});
get("refresh-connectors").addEventListener("click", refreshConnectors);
get("use-connector").addEventListener("click", () => {
  providerField.value = selectedConnectorId;
  actionError = "";
  showView("chats");
  promptField.focus();
});
get("stop-run").addEventListener("click", async () => {
  const run = activeRun();
  if (!run) return;
  try {
    await api.stopRun(run.id);
  } catch (error) {
    showError(error);
  }
});
get("new-task").addEventListener("click", () => {
  actionError = "";
  selectRun(undefined);
  promptField.focus();
});

get("choose-folder").addEventListener("click", async () => {
  if (mode !== "code") return;
  choosing = true;
  actionError = "";
  renderControls();
  try {
    const selection = await api.chooseFolder();
    if (selection && selection.path !== folder?.path) {
      if (!projects.some((project) => project.path === selection.path)) projects.push(selection);
      folder = selection;
      selectedRunId = projectRuns()[0]?.id;
    }
  } catch (error) {
    showError(error);
  } finally {
    choosing = false;
    renderChats();
  }
});

for (const example of document.querySelectorAll<HTMLButtonElement>("[data-prompt]")) {
  example.addEventListener("click", () => {
    promptField.value = example.dataset.prompt ?? "";
    actionError = "";
    renderControls();
    promptField.focus();
  });
}
promptField.addEventListener("input", () => {
  actionError = "";
  renderControls();
});
providerField.addEventListener("change", () => {
  actionError = "";
  renderComposerProvider();
});
thinkingField.addEventListener("change", () => {
  const provider = chatProviderId();
  const space = mode === "chat" && provider === "codex" ? "chat-codex" : provider;
  selectedEfforts.set(space + ":" + chatModelField.value, thinkingField.value);
  renderComposerProvider();
});

get("composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  const connector = connectors.find((entry) => entry.id === providerField.value);
  if (!connector || runButton.disabled) return;
  const draft = promptField.value;
  starting = true;
  actionError = "";
  renderControls();
  try {
    selectedRunId = await api.startRun({
      providerId: connector.id, prompt: draft, effort: thinkingField.value, model: chatModelField.value,
    });
    if (promptField.value === draft) promptField.value = "";
  } catch (error) {
    showError(error);
  } finally {
    starting = false;
    renderChats();
  }
});

api.onRunChanged((run) => {
  const previous = runs.get(run.id);
  remember(run);
  if (previous?.status === run.status) {
    if (selectedRunId === run.id && previous.revision < run.revision) {
      renderThread(run);
      renderDetails(run);
    }
    return;
  }
  const inMode = run.mode === "chat" ? mode === "chat" : mode === "code" && run.folder?.path === folder?.path;
  if (run.revision === 1 && inMode) selectedRunId = run.id;
  renderChats();
});

renderChats();
void refreshConnectors();
api.getState().then((state) => {
  folder = state.folder;
  projects = state.projects;
  mode = state.mode === "chat" ? "chat" : "code";
  for (const run of state.runs) remember(run);
  selectedRunId ??= (mode === "chat" ? generalChats() : projectRuns())[0]?.id;
  renderWorkspaceMode();
}).catch(showError);
