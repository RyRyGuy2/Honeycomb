import type {
  ChatPresetId, ChatProfile, CliProviderId, Connector, ConnectorStatus, ConversationContextSummary, DiffFile, HoneycombApi, ModelCatalog, ModelSelection, ProjectFolder, ProviderId, Run, RunStatus,
  RunUsage, RunWorktree, SavedWorkflow, SidebarMenuRequest, WorkflowAgentStep, WorkflowDefinition, WorkflowGateStep, WorkflowRun, WorkflowRunStatus,
  SmartOrchestrator, SmartRunRequest, WorkflowPlanReply, WorkflowPlanRequest, WorkflowProviderId, WorkflowStep, WorkflowStepStatus, WorkspaceMode,
} from "../shared/contracts.js";
import { configuredConnectors } from "../shared/connectors.js";
import { compareTurns, conversationContext, conversationId, runMode } from "../shared/conversations.js";
import { isCliProvider, supportsWorktreeEditing } from "../shared/editing.js";
import { chatPresets, isChatPreset } from "../shared/chat-presets.js";
import { copilotClipboardMarkdown, copilotCodeBlock } from "./copilot-clipboard.js";
import { createSmartUi } from "./smart.js";
import type { FreebuffAttachment, FreebuffContext, FreebuffReview, WorktreeRecord } from "../shared/contracts.js";
import {
  DEFAULT_GATE_REVISIONS, DEFAULT_STEP_TIMEOUT_MS, MAX_FREEBUFF_REPLY, MAX_GATE_FEEDBACK, MAX_GATE_REVISIONS,
  MAX_STEP_INPUTS, MAX_STEP_PROMPT, MAX_STEP_TIMEOUT_MS, MAX_WORKFLOW_STEPS, MIN_STEP_TIMEOUT_MS, cloneWorkflow, workflowRequiresProject,
} from "../shared/workflows.js";

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
const installCommands = {
  codex: "npm install -g @openai/codex",
  opencode: "npm install -g @opencode/cli",
  claude: "npm install -g @anthropic-ai/claude-code@latest",
  "github-copilot": "npm install -g @github/copilot",
  freebuff: "npm install -g freebuff",
} satisfies Record<Exclude<CliProviderId, "antigravity"> | "freebuff", string>;
let freebuffWorktrees: WorktreeRecord[] = [];
const freebuffReviews = new Map<string, FreebuffReview>();
const freebuffErrors = new Map<string, string>();
const freebuffNotices = new Map<string, string>();
const freebuffChecking = new Set<string>();
let olderFreebuffOpen = false;
let viewedFreebuffId: string | undefined;
const markdown = window.markdownit({ html: false });
markdown.disable("image");
const viewButtons = document.querySelectorAll<HTMLButtonElement>("[data-view]");
const cliConnectorList = get("cli-connector-list");
const chatConnectorList = get("chat-connector-list");
const connectorEmpty = get("connector-empty");
const promptField = get("prompt", HTMLTextAreaElement);
const providerField = get("provider", HTMLSelectElement);
const chatModelField = get("chat-model", HTMLSelectElement);
const thinkingField = get("thinking-level", HTMLSelectElement);
const connectorModelField = get("connector-model", HTMLSelectElement);
const chatConnectionModelField = get("chat-connection-model", HTMLSelectElement);
const connectionForm = get("chat-connection-form", HTMLFormElement);
const connectionName = get("chat-connection-name", HTMLInputElement);
const connectionUrl = get("chat-connection-url", HTMLInputElement);
const connectionKey = get("chat-connection-key", HTMLInputElement);
const connectionClear = get("chat-connection-clear", HTMLInputElement);
const connectionManual = get("chat-connection-manual", HTMLInputElement);
const runButton = get("run-task", HTMLButtonElement);
const accessPicker = get("project-access", HTMLSelectElement);
const editAccessOption = get("project-access-edit", HTMLOptionElement);
const chatStatus = get("chat-status");
const modeButtons = document.querySelectorAll<HTMLButtonElement>("[data-mode]");
const projectPicker = get("composer-project-picker", HTMLSelectElement);

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
  opencode: "Uses OpenCode’s scoped agent permissions to read, search and edit in a worktree.",
  claude: "Uses Claude Code with read and search tools only, no MCP servers, and no project settings.",
  antigravity: "Uses the agy CLI for Chat and project review in plan mode. Run agy in a terminal to sign in.",
  "github-copilot": "Uses the copilot CLI for Chat and read-only project review. Run copilot login in a terminal to sign in.",
} satisfies Record<CliProviderId, string>;
const providerNames = {
  codex: "Codex",
  opencode: "OpenCode",
  claude: "Claude Code",
  antigravity: "Google Antigravity CLI",
  "github-copilot": "GitHub Copilot CLI",
  freebuff: "Freebuff",
} satisfies Record<WorkflowProviderId, string>;
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
let newProjectPath: string | undefined;
let mode: WorkspaceMode = "code";
let switchingMode = false;
let codexChatModel = "";
const drafts = new Map<string, string>();
const freebuffAttachments = new Map<string, FreebuffAttachment>();
const editAccess = new Set<string>();
let draftKey: string | undefined;
const lastChatByMode: Partial<Record<WorkspaceMode, string | undefined>> = {};
let projects: ProjectFolder[] = [];
const expandedProjects = new Set<string>();
const collapsedProjects = new Set<string>();
let sidebarMenuOpen = false;
let selectedChatId: string | undefined;
let selectedConnectorId: ProviderId = "codex";
let profilePreset: ChatPresetId | undefined;
let profiles: ChatProfile[] = [];
let profileRevision = 0;
let profileMessage = "";
let copilotWebSignInPending = false;
let copilotWebSignInMessage = "";
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
let worktreeBusy = false;
let actionError = "";
let lastThreadId: string | undefined;
let connectors: Connector[] = [
  { id: "codex", name: "Codex", status: "checking" },
  { id: "opencode", name: "OpenCode", status: "checking" },
  { id: "claude", name: "Claude Code", status: "checking" },
  { id: "antigravity", name: providerNames.antigravity, status: "checking" },
  { id: "github-copilot", name: providerNames["github-copilot"], status: "checking" },
];
const runs = new Map<string, Run>();
const openActivity = new Set<string>();

type WorkflowView =
  | { kind: "solo" }
  | { kind: "plan" }
  | { kind: "detail"; id: string }
  | { kind: "edit"; draft: WorkflowDefinition; existing: boolean }
  | { kind: "run"; runId: string };

let workflows: SavedWorkflow[] = [];
const workflowRuns = new Map<string, WorkflowRun>();
const smartUi = createSmartUi(api, { connectors: () => connectors, runs: () => runs.values(), workflows: () => workflowRuns.values() });
let smartSelected = false;
let selectedChatWorkflowId: string | undefined;
let workflowView: WorkflowView = { kind: "solo" };
const plannerProvider = get("workflow-plan-provider", HTMLSelectElement);
const plannerModel = get("workflow-plan-model", HTMLSelectElement);
const plannerGoal = get("workflow-plan-goal", HTMLTextAreaElement);
const plannerTurns: Array<{ prompt: string; result?: WorkflowPlanReply; error?: string }> = [];
let plannerDraft: WorkflowDefinition | undefined;
let plannerBusy = false;
let workflowBusy = false;
let workflowError = "";
let workflowNote = "";
let workflowConfirmDelete = false;
let workflowRunRender: ReturnType<typeof setTimeout> | undefined;
const gateFeedback = new Map<string, string>();
const freebuffReplies = new Map<string, string>();

interface ChatSummary {
  id: string;
  first: Run;
  latest: Run;
  count: number;
}

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
  if (name === "connectors" && !catalogOpen && !profilePreset && isCliProvider(selectedConnectorId) && !modelCatalogs[selectedConnectorId]) {
    void refreshModels(selectedConnectorId);
  }
  if (name === "chats") {
    renderChatWorkflow();
    renderComposerProvider();
  }
  if (name === "workflows") renderWorkflows();
  if (name === "settings") smartUi.openSettings();
}

function chatHistory() {
  const chats = new Map<string, ChatSummary>();
  for (const run of runs.values()) {
    // Workflow steps keep their own timeline in Workflows instead of appearing as chats.
    if (run.workflowRunId || run.workflowPlanner) continue;
    const id = conversationId(run);
    const chat = chats.get(id);
    if (chat) {
      if (compareTurns(run, chat.first) < 0) chat.first = run;
      if (compareTurns(run, chat.latest) > 0) chat.latest = run;
      chat.count++;
    } else {
      chats.set(id, { id, first: run, latest: run, count: 1 });
    }
  }
  return [...chats.values()].sort((a, b) => b.latest.startedAt.localeCompare(a.latest.startedAt));
}

function chatTurns(id = selectedChatId) {
  if (!id) return [];
  return [...runs.values()].filter((run) => conversationId(run) === id).sort(compareTurns);
}

function remember(run: Run) {
  if ((runs.get(run.id)?.revision ?? -1) >= run.revision) return false;
  runs.set(run.id, run);
  return true;
}

function activeRun() {
  return [...runs.values()].find((run) => run.status === "running" || run.status === "stopping");
}

function projectChats(path = folder?.path, chats = chatHistory()) {
  return path ? chats.filter(({ first }) => runMode(first) === "code" && first.folder?.path === path) : [];
}

function generalChats(chats = chatHistory()) {
  return chats.filter(({ first }) => runMode(first) === "chat");
}

function recentChatId() {
  return (mode === "chat" ? generalChats() : projectChats())[0]?.id;
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
  const workflowActive = Boolean(active?.workflowRunId);
  const chatActive = workflowActive || active?.workflowPlanner ? undefined : active;
  const workflow = selectedChatWorkflow();
  const busy = Boolean(active) || workflowsBusy() || starting || switchingMode || worktreeBusy;
  const stop = get("stop-run", HTMLButtonElement);
  const providerId = chatProviderId();
  const provider = connectors.find((connector) => connector.id === providerId);
  const saving = pendingModel?.providerId === providerId;
  const modelPending = Boolean(modelRequests[providerId]) || saving;
  const needsProject = mode === "code" && (!folder || (!selectedChatId && newProjectPath !== folder.path));
  const freebuffOption = get("freebuff-provider", HTMLOptionElement);
  freebuffOption.hidden = smartSelected || mode !== "code";
  freebuffOption.disabled = smartSelected || mode !== "code";
  const freebuff = !smartSelected && providerField.value === "freebuff";
  const copilot = isCopilotProvider(providerId);
  const webSigningIn = providerId === "copilot-web" && copilotWebSignInPending;
  const modelRequired = providerId.startsWith("chat:");
  const workflowInvocation = workflowCommand(promptField.value) !== undefined;
  const resumeFreebuff = freebuff && Boolean(latestActiveFreebuff());
  const attachment = pendingFreebuff();
  const contextStatus = get("composer-freebuff-status");
  const removeAttachment = get("remove-freebuff-context", HTMLButtonElement);
  contextStatus.hidden = smartSelected || freebuff || (!attachment && !chatTurns().some((turn) => turn.freebuffContext));
  contextStatus.textContent = attachment
    ? attachment.source === "export" ? "Freebuff transcript attached" : "Freebuff exchange attached"
    : "Freebuff context included";
  removeAttachment.hidden = smartSelected || freebuff || !attachment;
  removeAttachment.disabled = busy;
  get("chat-model-control").hidden = freebuff || copilot;
  thinkingField.hidden = freebuff || copilot || modelRequired;
  providerField.setAttribute("aria-label", smartSelected ? "Orchestrator connector" : "Connector");
  chatModelField.setAttribute("aria-label", smartSelected ? "Orchestrator model" : "Model");
  const smartMode = get("smart-mode", HTMLButtonElement);
  smartMode.setAttribute("aria-pressed", String(smartSelected));
  smartMode.disabled = busy;
  providerField.disabled = (!smartSelected && Boolean(selectedChatId)) || busy;
  projectPicker.disabled = choosing || busy;
  for (const button of document.querySelectorAll<HTMLButtonElement>(".project-new-chat")) {
    button.disabled = choosing || busy;
  }
  get("choose-folder", HTMLButtonElement).disabled = choosing || busy;
  get("new-task", HTMLButtonElement).disabled = choosing || busy;
  for (const button of modeButtons) button.disabled = choosing || busy;
  stop.hidden = workflow ? !isWorkflowInProgress(workflow) : !chatActive;
  stop.disabled = workflow ? workflowBusy || workflow.status === "stopping" : chatActive?.status === "stopping";
  stop.textContent = (workflow ?? chatActive)?.status === "stopping" ? "Stopping…" : workflow ? "Stop workflow" : "Stop run";
  runButton.disabled = workflowInvocation ? busy || workflowBusy || choosing : needsProject || busy || choosing || !promptField.value.trim() ||
    (smartSelected ? !isCliProvider(providerField.value) || modelPending || provider?.status !== "detected"
      : webSigningIn || (!freebuff && (modelPending || provider?.status !== "detected" || (modelRequired && !chatModelField.value))));
  const preview = get("smart-preview", HTMLButtonElement);
  preview.hidden = !smartSelected || workflowInvocation;
  preview.disabled = runButton.disabled;
  const freshFreebuff = document.querySelector<HTMLButtonElement>("[data-freebuff-fresh]");
  if (freshFreebuff) freshFreebuff.disabled = !freebuff || runButton.disabled;
  const canEdit = mode === "code" && (smartSelected || supportsWorktreeEditing(providerId));
  const editing = canEdit && draftKey !== undefined && editAccess.has(draftKey);
  get("composer-access").hidden = mode !== "code" || freebuff;
  accessPicker.disabled = busy || choosing;
  accessPicker.title = canEdit ? "Choose whether to review or edit in a separate Git worktree." : "This connector supports read-only review in Honeycomb.";
  editAccessOption.disabled = !canEdit;
  accessPicker.value = editing ? "edit" : "review";
  get("send-label").textContent = workflowInvocation ? "Run workflow" : smartSelected ? "Run Smart" : freebuff ? (resumeFreebuff ? "Continue in Freebuff" : "Open in Freebuff")
    : editing ? "Send edit" : selectedChatId || mode === "chat" ? "Send" : "Run task";
  chatStatus.dataset.error = String(Boolean(actionError));

  let message = actionError;
  if (!message && workflowInvocation) message = "Run a saved workflow with /workflow <name> <prompt>.";
  if (!message && needsProject) message = "Choose a project above to start a Code chat.";
  if (!message && active) {
    message = workflowActive ? "A workflow step is running. Choose its run in the sidebar to follow it."
      : `${active.providerName} is ${statusLabels[active.status].toLowerCase()}.`;
  }
  if (!message && smartSelected && workflowsBusy()) message = "A workflow is running.";
  if (!message && freebuff) message = worktreeBusy ? "Working on the Freebuff handoff…" : "Paste and send the copied prompt in Freebuff.";
  if (!message && provider?.status === "checking") message = `Checking for ${provider.name}…`;
  if (!message && provider?.status !== "detected") message = `${provider?.name ?? "The connector"} is unavailable. See Connectors for details.`;
  if (!message && modelPending) message = saving ? `Saving ${provider?.name} model…` : `Loading ${provider?.name} models…`;
  if (!message && webSigningIn) message = "Finish signing in in the Copilot window.";
  if (!message && modelRequired && !chatModelField.value) message = "Choose a model or enter a model ID in Connectors.";
  if (!message && smartSelected) message = "This model orchestrates the workflow and chooses which agents to launch.";
  if (chatStatus.textContent !== message) chatStatus.textContent = message;
}

function chatProviderId(): ProviderId {
  const value = providerField.value;
  return isCopilotProvider(value) || value.startsWith("chat:") || isCliProvider(value) ? value as ProviderId : "codex";
}

function isCopilotProvider(value: string): value is "windows-copilot" | "copilot-web" {
  return value === "windows-copilot" || value === "copilot-web";
}

function renderChatProviders(first = chatTurns()[0]) {
  const previous = (smartSelected ? undefined : first?.providerId) ?? providerField.value;
  providerField.querySelectorAll("[data-chat-connector]").forEach((option) => option.remove());
  if (mode === "chat" && !smartSelected) {
    const available = connectors.filter((connector) => connector.chatOnly);
    if (first && !isCliProvider(first.providerId) && !available.some((connector) => connector.id === first.providerId)) {
      available.push({ id: first.providerId, name: first.providerName, status: "missing" });
    }
    for (const connector of available) {
      if (connector.status !== "detected" && connector.id !== first?.providerId) continue;
      const option = element("option", "", connector.name);
      option.value = connector.id;
      option.dataset.chatConnector = "";
      providerField.append(option);
    }
  }
  providerField.value = smartSelected && !isCliProvider(previous)
    ? connectors.find(({ id, status }) => isCliProvider(id) && status === "detected")?.id ?? "codex"
    : mode === "chat" && previous === "freebuff" ? "codex" : previous;
  if (!providerField.value) providerField.value = "codex";
}

function renderComposerProvider() {
  if (mode === "code" && providerField.value === "freebuff") {
    renderControls();
    return;
  }
  const providerId = chatProviderId();
  if (!isCopilotProvider(providerId) && !get("chats").hidden && !modelCatalogs[providerId] &&
      connectors.some((connector) => connector.id === providerId && connector.status === "detected")) {
    void refreshModels(providerId);
  }
  renderModelPicker(chatModelField, providerId);
  renderThinking(providerId);
  renderControls();
}

async function selectWorkspaceProject(
  select: () => Promise<ProjectFolder | undefined>,
  { register = false, startNew = false, chatId }: { register?: boolean; startNew?: boolean; chatId?: string } = {},
) {
  if (mode !== "code" || choosing || starting || switchingMode || worktreeBusy) return false;
  choosing = true;
  actionError = "";
  renderControls();
  try {
    const selection = await select();
    if (!selection) return false;
    if (!projects.some((entry) => entry.path === selection.path)) {
      if (!register) return false;
      projects.push(selection);
    }
    const keepChat = register && !startNew && folder?.path === selection.path;
    if (folder?.path !== selection.path || (startNew && selectedChatId)) editAccess.delete("new:code");
    if (folder?.path !== selection.path || startNew) freebuffAttachments.delete("new:code");
    if (!keepChat) viewedFreebuffId = undefined;
    folder = selection;
    if (!keepChat || startNew) selectedChatWorkflowId = undefined;
    if (!keepChat) selectedChatId = startNew ? undefined : chatId && chatTurns(chatId).length ? chatId : projectChats()[0]?.id;
    newProjectPath = selectedChatId ? undefined : selection.path;
    return true;
  } catch (error) {
    showError(error);
    return false;
  } finally {
    choosing = false;
    renderChats();
    refreshLatestFreebuff();
  }
}

async function showSidebarMenu(request: SidebarMenuRequest, button: HTMLButtonElement) {
  if (sidebarMenuOpen) return;
  sidebarMenuOpen = true;
  button.focus({ preventScroll: true });
  try {
    if (!await api.showSidebarMenu(request)) return;
    const { target, id } = request;
    if (target === "project") {
      projects = projects.filter((project) => project.path !== id);
      expandedProjects.delete(id);
      collapsedProjects.delete(id);
      const lastCodeChat = lastChatByMode.code;
      if (lastCodeChat && chatTurns(lastCodeChat)[0]?.folder?.path === id) delete lastChatByMode.code;
      if (folder?.path === id) {
        folder = undefined;
        newProjectPath = undefined;
        if (mode === "code") selectedChatId = undefined;
      }
    } else {
      for (const turn of chatTurns(id)) {
        runs.delete(turn.id);
        openActivity.delete(turn.id);
      }
      if (lastChatByMode.chat === id) delete lastChatByMode.chat;
      if (lastChatByMode.code === id) delete lastChatByMode.code;
      if (selectedChatId === id) {
        selectedChatId = recentChatId();
        draftKey = undefined;
      }
      drafts.delete(`chat:${id}`);
      editAccess.delete(`chat:${id}`);
    }
    actionError = "";
    const restoreFocus = button === document.activeElement || document.activeElement === document.body;
    renderChats();
    if (restoreFocus) {
      const next = get("run-list").querySelector<HTMLButtonElement>('.history-item[aria-current="true"]:not([hidden] *)');
      (next ?? get("new-task")).focus();
    }
  } catch (error) {
    showError(error);
  } finally {
    sidebarMenuOpen = false;
  }
}

function bindSidebarMenu(button: HTMLButtonElement, target: SidebarMenuRequest["target"], id: string) {
  button.setAttribute("aria-haspopup", "menu");
  button.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    void showSidebarMenu({ target, id, x: Math.round(event.clientX), y: Math.round(event.clientY) }, button);
  });
  button.addEventListener("keydown", (event) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    const { left, bottom } = button.getBoundingClientRect();
    void showSidebarMenu({ target, id, x: Math.round(left), y: Math.round(bottom) }, button);
  });
}

function historyButton({ id, first, latest, count }: ChatSummary, select: () => void) {
  const button = element("button", "history-item");
  const name = first.prompt.replace(/\s+/g, " ");
  button.type = "button";
  button.title = first.prompt;
  if (id === selectedChatId && !selectedChatWorkflowId) button.setAttribute("aria-current", "true");
  button.append(
    element("span", "history-name", name),
    element("span", "history-meta", `${first.providerName} · ${count} ${count === 1 ? "turn" : "turns"} · ${statusLabels[latest.status]}`),
  );
  button.addEventListener("click", select);
  bindSidebarMenu(button, "chat", id);
  return button;
}

function renderSidebar() {
  const list = get("run-list");
  const allChats = chatHistory();
  if (mode === "chat") {
    const chats = generalChats(allChats);
    list.replaceChildren(...(chats.length ? chats.map((chat) => historyButton(chat, () => selectChat(chat.id)))
      : [element("p", "", "No chats yet.")]));
    return;
  }
  const groups = projects.map((project, index) => {
    const group = element("section", "project-group");
    const header = element("div", "project-heading");
    const title = element("button", "folder-picker");
    title.type = "button";
    title.title = project.path;
    title.append(element("span", "folder-icon"), element("span", "history-name", project.name));
    if (project.path === folder?.path) title.setAttribute("aria-current", "true");
    title.addEventListener("click", () => void selectWorkspaceProject(() => api.selectProject(project.path)));
    bindSidebarMenu(title, "project", project.path);
    const chats = projectChats(project.path, allChats);
    const expanded = expandedProjects.has(project.path);
    const chatList = element("div", "project-chats");
    chatList.id = `project-chats-${index}`;
    for (const chat of expanded ? chats : chats.slice(0, 3)) {
      chatList.append(historyButton(chat, () => void selectWorkspaceProject(() => api.selectProject(project.path), { chatId: chat.id })));
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
    header.append(title);
    const newChat = element("button", "sidebar-action-button project-new-chat", "+");
    newChat.type = "button";
    newChat.title = `New chat in ${project.name}`;
    newChat.setAttribute("aria-label", newChat.title);
    newChat.addEventListener("click", async () => {
      if (await selectWorkspaceProject(() => api.selectProject(project.path), { startNew: true })) promptField.focus();
    });
    header.append(newChat);
    if (chats.length) {
      const disclosure = element("button", "sidebar-action-button project-disclosure");
      disclosure.type = "button";
      disclosure.setAttribute("aria-controls", chatList.id);
      function updateDisclosure() {
        const collapsed = collapsedProjects.has(project.path);
        const label = `${collapsed ? "Show" : "Hide"} chats in ${project.name}`;
        chatList.hidden = collapsed;
        disclosure.setAttribute("aria-expanded", String(!collapsed));
        disclosure.setAttribute("aria-label", label);
        disclosure.title = label;
      }
      disclosure.addEventListener("click", () => {
        if (!collapsedProjects.delete(project.path)) collapsedProjects.add(project.path);
        updateDisclosure();
      });
      updateDisclosure();
      header.append(disclosure);
    }
    group.append(header, chatList);
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

function countLabel(count: number, label: string) {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

function contextLabel(summary: ConversationContextSummary) {
  const included = `${countLabel(summary.includedTurns, "earlier turn")} included`;
  const limits = [];
  if (summary.shortenedTurns) limits.push(`${summary.shortenedTurns} shortened`);
  if (summary.omittedTurns) limits.push(`${summary.omittedTurns} omitted`);
  return limits.length ? `${included} (${limits.join(", ")})` : included;
}

function runActivity(run: Run) {
  const details = element("details", "tool-activity");
  const summary = element("summary", "", "Activity");
  const toolCalls = run.events.filter((event) => event.type === "tool_call").length;
  const tests = run.events.filter((event) => event.type === "test_result").length;
  const errors = run.events.filter((event) => event.type === "error").length;
  const highlights = [statusLabels[run.status]];
  if (toolCalls) highlights.push(countLabel(toolCalls, "tool call"));
  if (tests) highlights.push(countLabel(tests, "test result"));
  if (errors) highlights.push(countLabel(errors, "error"));
  summary.append(element("span", "tool-count", highlights.join(" · ")));
  const list = element("ol");
  if (run.context) list.append(element("li", "", `Conversation context · ${contextLabel(run.context)}`));
  for (const event of run.events) {
    if (event.type === "message" || event.type === "usage") continue;
    const time = element("time", "activity-time", new Date(event.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }));
    time.dateTime = event.at;
    const entry = element("li", event.type === "error" ? "activity-error" : "");
    entry.append(time, document.createTextNode(event.text));
    list.append(entry);
  }
  details.open = openActivity.has(run.id);
  details.addEventListener("toggle", () => {
    if (!details.isConnected) return;
    if (details.open) openActivity.add(run.id);
    else openActivity.delete(run.id);
  });
  details.append(summary, list);
  return details;
}

get("thread").addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const link = target?.closest<HTMLAnchorElement>("a[href]");
  if (link) {
    event.preventDefault();
    if (/^https?:$/.test(link.protocol)) void api.openReplyLink(link.href).catch(showError);
    return;
  }
  const action = target?.closest<HTMLButtonElement>("button[data-worktree]");
  const id = action?.dataset.worktreeId;
  const kind = action?.dataset.worktree;
  if (!action || !id || (kind !== "keep" && kind !== "discard")) return;
  void worktreeAction(kind, id);
});

async function worktreeAction(action: "keep" | "discard", id: string) {
  if (worktreeBusy) return;
  worktreeBusy = true;
  actionError = "";
  renderChats();
  try {
    if (action === "keep") await api.keepWorktree(id);
    else await api.discardWorktree(id);
  } catch (error) {
    showError(error);
  } finally {
    worktreeBusy = false;
    renderChats();
    if (workflowView.kind === "run") renderWorkflowPanel();
  }
}

function commitLabel(commit: string) {
  return commit.slice(0, 10);
}

const diffLabels = {
  added: "Added", modified: "Modified", deleted: "Deleted", renamed: "Renamed",
} satisfies Record<DiffFile["status"], string>;
const worktreeLabels = {
  active: "In worktree", kept: "Kept for later", discarded: "Discarded",
} satisfies Record<RunWorktree["state"], string>;

function diffPatch(patch: string) {
  const pre = element("pre", "diff-patch");
  if (!patch.trim()) {
    pre.append(element("span", "diff-meta", "No recorded lines for this file."));
    return pre;
  }
  for (const line of patch.split("\n")) {
    const className = /^(diff --git|index |--- |\+\+\+ |@@|new file|deleted file|similarity |rename )/.test(line) ? "diff-meta"
      : line.startsWith("+") ? "diff-add"
      : line.startsWith("-") ? "diff-remove" : "";
    const row = element("span", className);
    row.textContent = line + "\n";
    pre.append(row);
  }
  return pre;
}

function runChanges(run: Pick<Run, "worktree" | "diff">, latest: boolean, external = false) {
  const worktree = run.worktree;
  if (!worktree) return undefined;
  const section = element("section", "diff-review");
  const header = element("div", "diff-head");
  header.append(element("h3", "", "Changes in worktree"));
  const state = element("span", "diff-state", worktreeLabels[worktree.state]);
  state.dataset.state = worktree.state;
  header.append(state);
  const meta = element("p", "diff-meta", `${worktree.branch} · from ${commitLabel(worktree.baseCommit)}`);
  const location = element("p", "diff-path", worktree.path);
  location.title = worktree.path;
  section.append(header, meta, location);

  const diff = run.diff;
  if (!diff) {
    section.append(element("p", "diff-empty", external ? "Waiting for the first worktree check." : "Changed files appear here when the run finishes."));
  } else if (!diff.files.length) {
    section.append(element("p", "diff-empty", external ? "No code changes yet." : "No file changes were recorded in the worktree."));
  } else {
    const files = element("div", "diff-files");
    for (const file of diff.files) {
      const item = element("details", "diff-file");
      item.open = !external;
      const summary = element("summary", "");
      summary.append(element("span", "diff-status", diffLabels[file.status]), element("span", "diff-name", file.path));
      item.append(summary, diffPatch(file.patch));
      if (file.truncated) item.append(element("p", "diff-note", "This diff was shortened."));
      files.append(item);
    }
    section.append(files);
    if (diff.truncated) section.append(element("p", "diff-note", "Some diffs were shortened. Open the worktree for the full change."));
  }

  if (latest && worktree.state !== "discarded") {
    const actions = element("div", "diff-actions");
    if (worktree.state === "active") {
      const keep = element("button", "button button-small", "Keep worktree");
      keep.type = "button";
      keep.dataset.worktree = "keep";
      keep.dataset.worktreeId = worktree.id;
      keep.disabled = worktreeBusy;
      actions.append(keep);
    }
    const discard = element("button", "button button-small", "Discard worktree");
    discard.type = "button";
    discard.dataset.worktree = "discard";
    discard.dataset.worktreeId = worktree.id;
    discard.disabled = worktreeBusy;
    actions.append(discard);
    section.append(actions,
      element("p", "diff-note", "Your checkout is unchanged. Discard removes only this worktree and branch after confirmation."));
  }
  return section;
}

async function reviewFreebuffWorktree(id: string) {
  if (freebuffChecking.has(id)) return;
  freebuffChecking.add(id);
  try {
    freebuffReviews.set(id, await api.reviewFreebuff(id));
    freebuffErrors.delete(id);
  } catch (error) {
    freebuffErrors.set(id, error instanceof Error
      ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")
      : "Honeycomb could not read the worktree.");
  } finally {
    freebuffChecking.delete(id);
  }
}

type FreebuffAction = "send" | "fresh" | "open" | "replace" | "view" | "review" | "export" | "import" | "use-reply" | "keep" | "discard";

async function freebuffAction(action: FreebuffAction, id?: string) {
  if (worktreeBusy) return;
  worktreeBusy = true;
  actionError = "";
  const targetDraft = draftKey;
  const targetProject = folder?.path;
  renderChats();
  try {
    if (action === "open" || action === "replace" || action === "send" || action === "fresh") {
      const prompt = action === "open" || (action === "replace" && providerField.value !== "freebuff") ? "" : promptField.value;
      const record = await api.openFreebuff({ prompt, id, replace: action === "replace" });
      freebuffNotices.set(record.id, prompt.trim() ? "Prompt copied. Paste it into Freebuff and press Enter." : "Freebuff opened in Windows Terminal.");
      if (targetDraft && targetDraft === draftKey && targetProject === folder?.path && mode === "code") {
        freebuffAttachments.set(targetDraft, { worktreeId: record.id, source: "saved" });
        if (!selectedChatId) viewedFreebuffId = record.id;
      }
    } else if (id && action === "view") {
      selectedChatId = undefined;
      newProjectPath = folder?.path;
      viewedFreebuffId = id;
    } else if (id && action === "review") await reviewFreebuffWorktree(id);
    else if (id && action === "export") {
      await api.copyFreebuffExport();
      freebuffNotices.set(id, "Export command copied. Paste and run it in Freebuff, then return here.");
    }
    else if (id && (action === "import" || action === "use-reply")) {
      const review = freebuffReviews.get(id);
      if (!review?.available || !(action === "import" ? review.transcriptReady : review.savedExchanges.length)) {
        throw new Error("Refresh the worktree after Freebuff finishes.");
      }
      if (!targetDraft || targetDraft !== draftKey || targetProject !== folder?.path || mode !== "code") {
        throw new Error("Return to the original draft to attach the Freebuff exchange.");
      }
      freebuffAttachments.set(targetDraft, { worktreeId: id, source: action === "import" ? "export" : "saved" });
      if (!promptField.value.trim()) {
        promptField.value = "Review the Freebuff results and tell me what to do next.";
        promptField.select();
      }
      if (providerField.value === "freebuff") {
        providerField.value = "codex";
        renderComposerProvider();
      }
      promptField.focus();
    }
    else if (id && action === "keep") await api.keepWorktree(id);
    else if (id && await api.discardWorktree(id)) {
      if (viewedFreebuffId === id) viewedFreebuffId = undefined;
      freebuffReviews.delete(id);
      freebuffErrors.delete(id);
      freebuffNotices.delete(id);
      for (const [key, attachment] of freebuffAttachments) {
        if (attachment.worktreeId === id) freebuffAttachments.delete(key);
      }
    }
  } catch (error) {
    showError(error);
  } finally {
    try {
      freebuffWorktrees = (await api.getState()).worktrees ?? [];
    } catch (error) {
      showError(error);
    }
    worktreeBusy = false;
    renderChats();
    if (action === "open" || action === "replace" || action === "send" || action === "fresh") refreshLatestFreebuff();
  }
}

function projectFreebuffWorktrees() {
  return mode === "code" && folder
    ? freebuffWorktrees.filter((record) => record.freebuffProject === folder?.path && record.state !== "discarded").reverse()
    : [];
}

function pendingFreebuff() {
  const attachment = draftKey && freebuffAttachments.get(draftKey);
  if (mode !== "code" || !folder || !attachment) return;
  if (freebuffWorktrees.some((record) =>
    record.id === attachment.worktreeId && record.freebuffProject === folder?.path && record.state !== "discarded")) {
    return attachment;
  }
}

function latestActiveFreebuff() {
  const records = projectFreebuffWorktrees();
  const latest = records.find((record) => record.id === viewedFreebuffId) ?? records[0];
  return latest?.state === "active" && freebuffReviews.get(latest.id)?.available !== false ? latest : undefined;
}

function freebuffChatWorktree() {
  if (selectedChatId) return;
  const records = projectFreebuffWorktrees();
  const id = viewedFreebuffId ?? pendingFreebuff()?.worktreeId;
  return records.find((record) => record.id === id) ?? (providerField.value === "freebuff" ? records[0] : undefined);
}

function freebuffCard(record: WorktreeRecord, latest: boolean) {
  const review = freebuffReviews.get(record.id);
  const diff = review?.available ? review.diff : undefined;
  const card = runChanges({ worktree: record, diff }, false, true)!;
  const count = diff?.files.length ?? 0;
  card.querySelector("h3")!.textContent = count ? `Freebuff · ${countLabel(count, "changed file")}` : "Freebuff worktree";
  const actions = element("div", "diff-actions");
  const error = freebuffErrors.get(record.id);
  const unavailable = review?.available === false;
  if (error || unavailable) {
    card.querySelector(".diff-empty")?.remove();
    const status = element("p", "diff-note", unavailable ? "This folder is no longer registered as a Git worktree." : error);
    status.setAttribute("role", "status");
    card.append(status);
  }
  const notice = freebuffNotices.get(record.id);
  if (notice && !unavailable) {
    const status = element("p", "diff-note", notice);
    status.setAttribute("role", "status");
    card.append(status);
  }
  const hasReply = review?.available && review.savedExchanges.length > 0;
  const options = element("details", "freebuff-options");
  options.append(element("summary", "", "Worktree options"));
  for (const meta of card.querySelectorAll(".diff-meta, .diff-path")) options.append(meta);
  const extras = element("div", "diff-actions");
  const addAction = (parent: HTMLElement, action: FreebuffAction, label: string) => {
    const button = element("button", "button button-small", label);
    button.type = "button";
    button.disabled = worktreeBusy;
    button.addEventListener("click", () => void freebuffAction(action, action === "fresh" ? undefined : record.id));
    parent.append(button);
    return button;
  };
  if (unavailable) {
    addAction(actions, "replace", "Create replacement");
  } else {
    addAction(actions, "review", "Refresh changes");
    if (hasReply) {
      if (freebuffChatWorktree()?.id !== record.id) addAction(actions, "view", "View chat");
      addAction(actions, "use-reply", "Use reply");
      if (review?.available && review.transcriptReady) addAction(extras, "import", "Use exported transcript");
      addAction(extras, "export", "Copy export command");
    } else if (review?.available && review.transcriptReady) {
      addAction(actions, "import", "Use transcript");
      addAction(extras, "export", "Copy new export command");
    } else {
      addAction(actions, "export", "Copy export command");
    }
    addAction(extras, "open", "Resume in Freebuff");
    if (record.state === "active") addAction(extras, "keep", "Keep worktree");
  }
  if (latest && providerField.value === "freebuff") {
    const fresh = addAction(extras, "fresh", "Start new worktree");
    fresh.dataset.freebuffFresh = "";
    fresh.disabled = runButton.disabled;
    fresh.title = "Use the current draft to start a separate Freebuff worktree.";
  }
  addAction(extras, "discard", "Discard worktree");
  options.append(extras);
  card.append(actions, options);
  return card;
}

function renderFreebuff() {
  const panel = get("freebuff-handoffs");
  const [latest, ...older] = projectFreebuffWorktrees();
  panel.hidden = !latest;
  get("welcome").hidden = Boolean(latest || selectedChatId);
  if (!latest) {
    panel.replaceChildren();
    return;
  }
  panel.replaceChildren(freebuffCard(latest, true));
  if (!older.length) return;
  const archive = element("details", "freebuff-archive");
  archive.open = olderFreebuffOpen;
  archive.append(element("summary", "", countLabel(older.length, "earlier Freebuff worktree")),
    ...older.map((record) => freebuffCard(record, false)));
  archive.addEventListener("toggle", () => { if (archive.isConnected) olderFreebuffOpen = archive.open; });
  panel.append(archive);
}

function runTests(run: Run) {
  const results = run.events.filter(
    (event): event is Extract<Run["events"][number], { type: "test_result" }> => event.type === "test_result",
  );
  if (!results.length) return undefined;
  const section = element("section", "test-results");
  section.append(element("h3", "", "Test results"));
  const list = element("ul");
  for (const result of results) {
    const item = element("li", result.passed ? "test-pass" : "test-fail", result.text);
    item.dataset.passed = String(result.passed);
    list.append(item);
  }
  section.append(list);
  return section;
}

function renderThread(turns: readonly Run[]) {
  const thread = get("thread");
  const feed = get("feed");
  const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 55;
  const freebuff = freebuffChatWorktree();
  const review = freebuff && freebuffReviews.get(freebuff.id);
  const exchanges = review?.available ? review.savedExchanges : [];
  const threadId = freebuff ? `freebuff:${freebuff.id}` : selectedChatId;
  const switched = lastThreadId !== threadId;
  lastThreadId = threadId;
  get("welcome").hidden = Boolean(turns.length || exchanges.length);
  feed.hidden = !turns.length && !exchanges.length;
  if (exchanges.length) {
    feed.replaceChildren(...exchanges.map((exchange, index) => {
      const turn = element("section", "conversation-turn");
      turn.setAttribute("aria-label", `Freebuff turn ${index + 1}`);
      turn.append(...freebuffMessages(exchange));
      return turn;
    }));
    if (atBottom || switched) thread.scrollTop = thread.scrollHeight;
    return;
  }
  if (switched || !turns.length) feed.replaceChildren();

  for (const [index, run] of turns.entries()) {
    const existing = feed.children[index];
    if (existing instanceof HTMLElement && existing.dataset.runId === run.id && existing.dataset.revision === String(run.revision)) continue;
    const turn = element("section", "conversation-turn");
    turn.setAttribute("aria-label", `Turn ${index + 1}`);
    turn.dataset.runId = run.id;
    turn.dataset.revision = String(run.revision);
    if (run.freebuffContext) turn.append(...freebuffMessages(run.freebuffContext));
    turn.append(feedEntry("You", run.prompt, "user"));
    for (const event of run.events) {
      if (event.type === "message") turn.append(agentReply(run.providerName, event.text));
    }
    if (run.status === "running" && run.copilotHandoff) turn.append(copilotReplyForm(run));
    const tests = runTests(run);
    if (tests) turn.append(tests);
    const changes = runChanges(run, index === turns.length - 1);
    if (changes) turn.append(changes);
    turn.append(runActivity(run));
    if (existing) {
      const restoreFocus = existing.contains(document.activeElement);
      existing.replaceWith(turn);
      if (restoreFocus) turn.querySelector("summary")?.focus({ preventScroll: true });
    } else {
      feed.append(turn);
    }
  }
  if (atBottom || switched) thread.scrollTop = thread.scrollHeight;
}

function freebuffMessages(context: FreebuffContext) {
  const transcript = "transcript" in context;
  const reply = agentReply(transcript ? "Freebuff transcript" : "Freebuff", transcript ? context.transcript : context.reply);
  reply.classList.add("freebuff-message");
  reply.querySelector("h2")!.classList.remove("visually-hidden");
  return !transcript && context.prompt ? [feedEntry("You · Freebuff", context.prompt, "user"), reply] : [reply];
}

function copilotReplyForm(run: Run) {
  const form = element("form", "copilot-reply model-field");
  const label = element("label", "", "Paste the reply from Microsoft Copilot");
  const field = element("textarea", "connector-input");
  field.id = `copilot-reply-${run.id}`;
  field.required = true;
  field.maxLength = 1_000_000;
  field.addEventListener("paste", (event) => {
    const markdown = copilotClipboardMarkdown(event.clipboardData?.getData("text/html") ?? "");
    if (!markdown) return;
    const available = field.maxLength - field.value.length + (field.selectionEnd - field.selectionStart);
    if (markdown.length > available) return;
    event.preventDefault();
    field.setRangeText(markdown, field.selectionStart, field.selectionEnd, "end");
  });
  label.htmlFor = field.id;
  const status = element("p", "connector-note", run.copilotHandoff === "prompt"
    ? run.copilotThread ? "Paste the copied prompt into the original Copilot conversation and send it."
      : "Start a new chat in Copilot, then paste and send the copied prompt."
    : "Copy the completed reply from the Copilot app.");
  status.setAttribute("role", "status");
  const buttons = element("div", "connector-actions");
  const submit = element("button", "button button-primary", "Save reply");
  const saveCode = element("button", "button", "Save as code");
  if (run.copilotHandoff === "prompt") {
    const copy = element("button", "button", "Copy prompt");
    copy.type = "button";
    copy.addEventListener("click", async () => {
      try {
        await api.copilotHandoff(run.id);
        status.textContent = "Prompt copied.";
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : "Could not copy the prompt.";
      }
    });
    buttons.append(copy);
  }
  buttons.append(submit, saveCode);
  form.append(status, label, field, buttons);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    saveCode.disabled = true;
    try {
      const text = event.submitter === saveCode && field.value.trim() ? copilotCodeBlock(field.value) : field.value;
      await api.copilotReply({ runId: run.id, text });
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Could not save the reply.";
      submit.disabled = false;
      saveCode.disabled = false;
    }
  });
  return form;
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
  const totals = usageRows(run.usage);
  const active = run.status === "running" || run.status === "stopping";
  const emptyUsage = active ? "Waiting for usage data." : "The provider reported no usage.";
  usage.append(totals.length ? facts(totals) : element("p", "empty-details", emptyUsage));

  const details: Array<[string, string]> = run.folder ? [["Project", run.folder.name], ["Workflow", "Solo"]] : [];
  if (run.worktree) {
    details.push(
      ["Branch", run.worktree.branch],
      ["Base commit", commitLabel(run.worktree.baseCommit)],
      ["Worktree", run.worktree.path],
    );
  }
  panel.replaceChildren(heading, ...(details.length ? [facts(details)] : []), usage);
}

function usageRows(usage?: RunUsage): Array<[string, string]> {
  return usageLabels.flatMap(([key, label]) => {
    const value = usage?.[key];
    return typeof value === "number" && Number.isFinite(value) ? [[label, (key === "costUsd" ? usd : number).format(value)]] : [];
  });
}

function renderComposerProject(first: Run | undefined) {
  get("composer-project-bar").hidden = mode !== "code";
  if (mode !== "code") return;
  const project = first?.folder;
  const projectLabel = get("composer-project");
  projectLabel.hidden = !project;
  projectLabel.textContent = project?.name ?? "";
  projectLabel.title = project?.path ?? "";
  projectPicker.hidden = Boolean(project);
  if (project) return;

  const placeholder = element("option", "", "Choose a project");
  placeholder.value = "";
  placeholder.disabled = true;
  const saved = projects.map((entry) => {
    const duplicateName = projects.some((other) => other !== entry && other.name === entry.name);
    const option = element("option", "", duplicateName ? entry.path : entry.name);
    option.value = entry.path;
    return option;
  });
  const browse = element("option", "", "Browse for a folder…");
  browse.dataset.browse = "true";
  projectPicker.replaceChildren(placeholder, ...saved, browse);
  projectPicker.value = newProjectPath ?? "";
  projectPicker.title = newProjectPath ?? "";
}

function renderChats() {
  const turns = chatTurns();
  const first = turns[0];
  const workflow = selectedChatWorkflow();
  const contextTurns = turns.filter((turn) => turn.status !== "running" && turn.status !== "stopping");
  renderComposerProject(first);
  get("composer-context-status").textContent = contextTurns.length
    ? contextLabel(conversationContext(contextTurns).summary)
    : "New conversation";
  const key = selectedChatId ? `chat:${selectedChatId}` : `new:${mode}`;
  if (key !== draftKey) {
    if (draftKey) drafts.set(draftKey, promptField.value);
    promptField.value = drafts.get(key) ?? "";
    draftKey = key;
  }
  const previousProvider = providerField.value;
  renderChatProviders(first);
  const providerChanged = providerField.value !== previousProvider;
  const continueChat = Boolean(first);
  promptField.placeholder = continueChat ? "Ask a follow-up…" : mode === "chat" ? "Ask a question…" : "Ask about your project…";
  const title = get("chat-title");
  title.textContent = workflow?.workflowName ?? first?.prompt.replace(/\s+/g, " ") ??
    (freebuffChatWorktree() ? "Freebuff chat" : mode === "chat" ? "New chat" : "New task");
  title.title = first || workflow ? title.textContent : "";
  renderSidebar();
  renderThread(turns);
  renderFreebuff();
  renderChatWorkflow();
  renderDetails(turns.at(-1));
  if (providerChanged) renderComposerProvider();
  else renderControls();
}

function selectChat(id: string | undefined) {
  if (starting) return;
  selectedChatWorkflowId = undefined;
  viewedFreebuffId = undefined;
  selectedChatId = id;
  renderChats();
}

function renderWorkspaceMode() {
  const chat = mode === "chat";
  for (const button of modeButtons) button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
  get("chats").classList.toggle("chat-only", chat);
  get("choose-folder").hidden = chat;
  get("history-title").textContent = chat ? "Recent chats" : "Projects";
  get("welcome-title").textContent = chat ? "Ask a question" : "Start a review run";
  get("welcome-description").textContent = chat ? "Choose a model and start a conversation." : "Choose a project and a connector to investigate.";
  get("prompt-ideas").hidden = chat;
  renderChats();
  renderComposerProvider();
}

async function switchMode(next: WorkspaceMode) {
  if (mode === next || switchingMode || choosing || starting || activeRun()) return;
  switchingMode = true;
  renderControls();
  try {
    await api.setMode(next);
    lastChatByMode[mode] = selectedChatId;
    selectedChatWorkflowId = undefined;
    viewedFreebuffId = undefined;
    mode = next;
    selectedChatId = Object.hasOwn(lastChatByMode, mode) ? lastChatByMode[mode] : recentChatId();
    actionError = "";
    renderWorkspaceMode();
  } catch (error) {
    showError(error);
  } finally {
    switchingMode = false;
    renderControls();
    refreshLatestFreebuff();
  }
}

function connectorSidebarRow(connector: Connector, label: string) {
  const button = element("button", "sidebar-item");
  button.type = "button";
  button.dataset.connector = connector.id;
  button.setAttribute("aria-controls", connector.chatOnly ? "chat-connector-settings" : "connector-detail");
  if (!catalogOpen && connector.id === selectedConnectorId) button.setAttribute("aria-current", "true");
  const mark = element("span", "connector-monogram", connector.name.charAt(0));
  mark.setAttribute("aria-hidden", "true");
  mark.classList.toggle("opencode", connector.id === "opencode");
  mark.classList.toggle("claude", connector.id === "claude");
  const row = element("span", "connector-row");
  const status = element("span", "connector-row-status");
  status.replaceChildren(statusDot(connector.status), label);
  row.append(element("span", "", connector.name), status);
  button.append(mark, row);
  button.addEventListener("click", () => selectConnector(connector.id));
  return button;
}

function renderConnectors() {
  const refresh = get("refresh-connectors", HTMLButtonElement);
  refresh.disabled = checking;
  refresh.textContent = checking ? "Checking…" : "Refresh";

  const available = configuredConnectors(connectors);
  cliConnectorList.replaceChildren(...available.filter((connector) => !connector.chatOnly)
    .map((connector) => connectorSidebarRow(connector, connectorLabels[connector.status])));
  chatConnectorList.replaceChildren(...available.filter((connector) => connector.chatOnly)
    .map((connector) => connectorSidebarRow(connector, "Configured")));
  connectorEmpty.hidden = catalogOpen || available.length > 0;

  const chatSettings = Boolean(profilePreset) || isCopilotProvider(selectedConnectorId);
  get("connector-settings").hidden = catalogOpen || chatSettings;
  get("chat-connector-settings").hidden = catalogOpen || !chatSettings;
  if (catalogOpen) return renderCatalog();
  if (chatSettings) return renderChatConnection();

  const connector = connectors.find((entry) => entry.id === selectedConnectorId);
  if (!connector || !isCliProvider(connector.id)) return;
  const mark = get("connector-mark");
  mark.textContent = connector.name.charAt(0);
  mark.classList.toggle("opencode", connector.id === "opencode");
  mark.classList.toggle("claude", connector.id === "claude");
  get("connector-title").textContent = connector.name;
  get("connector-description").textContent = connectorDescriptions[connector.id];
  get("connector-install").replaceChildren(installCommand(connector.id, connector.name));
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
}

function installCommand(id: CliProviderId | "freebuff", name: string) {
  const row = element("div", "connector-install-command");
  if (id === "antigravity") {
    const guide = element("button", "button button-small", "Open installation guide");
    guide.type = "button";
    guide.addEventListener("click", () => {
      void api.openReplyLink("https://antigravity.google/docs/cli/getting-started/").catch(showError);
    });
    row.append(guide);
    return row;
  }
  const command = installCommands[id];
  const copy = element("button", "button button-small", "Copy");
  copy.type = "button";
  copy.setAttribute("aria-label", `Copy ${name} install command`);
  const status = element("span", "visually-hidden");
  status.setAttribute("role", "status");
  copy.addEventListener("click", async () => {
    try {
      await api.copyInstallCommand(command);
      copy.textContent = "Copied";
      status.textContent = "Install command copied.";
    } catch {
      copy.textContent = "Copy failed";
      status.textContent = "Select the command text to copy it manually.";
    }
  });
  row.append(element("code", "", command), copy, status);
  return row;
}

function renderCatalog() {
  const query = get("connector-search", HTMLInputElement).value.trim().toLowerCase();
  const results = connectors.flatMap((connector) => {
    const { id, name } = connector;
    return isCliProvider(id) && `${name} ${connectorDescriptions[id]}`.toLowerCase().includes(query)
      ? [{ ...connector, id }] : [];
  });
  const cards = results.map((connector) => {
    const card = element("article", "connector-result");
    const text = element("div");
    text.append(
      element("h2", "", connector.name),
      element("p", "connector-note", connectorDescriptions[connector.id]),
      element("p", "connector-note", connectorLabels[connector.status]),
      installCommand(connector.id, connector.name),
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
  const freebuffDescription = "Opens the official CLI in a separate Git worktree on Windows.";
  if (`Freebuff ${freebuffDescription}`.toLowerCase().includes(query)) {
    const card = element("article", "connector-result");
    const info = element("div");
    info.append(element("h2", "", "Freebuff"), element("p", "connector-note", freebuffDescription), installCommand("freebuff", "Freebuff"));
    const use = element("button", "button button-small", "Use Freebuff");
    use.type = "button";
    use.addEventListener("click", async () => {
      if (mode !== "code") await switchMode("code");
      if (mode !== "code" || starting || activeRun()) return;
      selectChat(undefined);
      providerField.value = "freebuff";
      showView("chats");
      (newProjectPath ? promptField : projectPicker).focus();
    });
    card.append(info, use);
    cards.push(card);
  }
  function addChatCard(name: string, description: string, label: string, choose: () => void) {
    if (!`${name} ${description}`.toLowerCase().includes(query)) return;
    const card = element("article", "connector-result");
    const info = element("div");
    info.append(element("h2", "", name), element("p", "connector-note", description));
    const button = element("button", "button button-small", label);
    button.type = "button";
    button.addEventListener("click", choose);
    card.append(info, button);
    cards.push(card);
  }
  for (const [id, preset] of Object.entries(chatPresets)) {
    if (!isChatPreset(id)) continue;
    addChatCard(preset.name, preset.description, "Configure", () => {
      openChatConnection(id);
      get("chat-connector-title").focus();
    });
  }
  addChatCard("Microsoft Copilot for Windows", "Chat through the signed-in Copilot desktop app.", "View Copilot", () => selectConnector("windows-copilot"));
  addChatCard("Copilot Web", "Sign in to Microsoft Copilot and chat in a hidden browser.", "View Copilot Web", () => selectConnector("copilot-web"));
  get("connector-results").replaceChildren(...(cards.length ? cards : [element("p", "connector-note", "No connectors match your search.")]));
}

function selectConnector(id: ProviderId) {
  if (id !== selectedConnectorId) get("connector-action-status").textContent = "";
  const profile = profiles.find((entry) => entry.id === id);
  if (profile) {
    openChatConnection(profile.preset, profile);
    get("chat-connector-title").focus();
    return;
  }
  profilePreset = undefined;
  profileMessage = "";
  selectedConnectorId = id;
  catalogOpen = false;
  get("connector-catalog").hidden = true;
  get("connector-settings").hidden = false;
  get("add-connector").removeAttribute("aria-current");
  renderConnectors();
  if (isCopilotProvider(id)) get("chat-connector-title").focus();
  else if (!modelCatalogs[id] && !connectorBusy) void refreshModels(id);
}

function openChatConnection(preset: ChatPresetId, profile?: ChatProfile) {
  const defaults = chatPresets[preset];
  profilePreset = preset;
  profileMessage = "";
  selectedConnectorId = profile?.id ?? "codex";
  catalogOpen = false;
  get("connector-catalog").hidden = true;
  get("add-connector").removeAttribute("aria-current");
  connectionForm.reset();
  connectionName.value = profile?.name ?? defaults.name;
  connectionUrl.value = profile?.baseUrl ?? defaults.baseUrl;
  connectionManual.value = profile?.manualModel ?? "";
  connectionKey.required = defaults.requiresKey && !profile?.hasApiKey;
  connectionKey.placeholder = profile?.hasApiKey ? "Saved key" : defaults.requiresKey ? "Required" : "Optional";
  get("chat-connection-clear-label").hidden = defaults.requiresKey || !profile?.hasApiKey;
  renderConnectors();
  if (profile && !modelCatalogs[profile.id]) void refreshModels(profile.id);
}

function renderChatConnection() {
  const profile = profiles.find((entry) => entry.id === selectedConnectorId);
  const copilot = !profilePreset && isCopilotProvider(selectedConnectorId);
  const web = copilot && selectedConnectorId === "copilot-web";
  const connector = connectors.find((entry) => entry.id === selectedConnectorId);
  get("chat-connector-title").textContent = web ? "Copilot Web" : copilot ? "Microsoft Copilot for Windows"
    : profile?.name ?? (profilePreset ? chatPresets[profilePreset].name : "");
  get("chat-connector-description").textContent = web ? "Chats run in a hidden browser using your Microsoft sign-in."
    : copilot ? "Connects to the signed-in Copilot desktop app."
    : profilePreset ? chatPresets[profilePreset].description : "";
  connectionForm.hidden = copilot;
  get("chat-connection-controls").hidden = !profile;
  get("copilot-connection-controls").hidden = !copilot;
  get("use-copilot", HTMLButtonElement).disabled = connector?.status !== "detected" || (web && copilotWebSignInPending);
  const signIn = get("sign-in-copilot-web", HTMLButtonElement);
  signIn.hidden = !web;
  signIn.disabled = copilotWebSignInPending;
  get("save-chat-connection", HTMLButtonElement).disabled = connectorBusy;
  get("remove-chat-connection").hidden = !profile;
  get("remove-chat-connection", HTMLButtonElement).disabled = connectorBusy;
  const loading = Boolean(profile && modelRequests[profile.id]);
  get("refresh-chat-connection-models", HTMLButtonElement).disabled = connectorBusy || loading;
  get("use-chat-connection", HTMLButtonElement).disabled = connectorBusy;
  if (profile) {
    renderModelPicker(chatConnectionModelField, profile.id);
    get("test-chat-connection", HTMLButtonElement).disabled = connectorBusy || loading || !chatConnectionModelField.value;
  }
  get("chat-connection-status").textContent = web ? copilotWebSignInMessage
    : copilot ? connector?.detail ?? "Checking for the Windows app…"
    : profileMessage || (loading ? "Looking for models…" : (profile && modelCatalogs[profile.id]?.localError) || "");
}

function shortModelName(model: ModelCatalog["models"][number]) {
  return (model.name === model.id ? model.id.split("/").pop() ?? model.id : model.name).replace(/\s+\([^)]*\)$/, "");
}

function renderModelPicker(select: HTMLSelectElement, providerId: ProviderId) {
  const codexChat = select === chatModelField && mode === "chat" && providerId === "codex";
  const catalog = modelCatalogs[providerId];
  const loading = Boolean(modelRequests[providerId]);
  const providerName = isCliProvider(providerId) ? providerNames[providerId]
    : connectors.find((connector) => connector.id === providerId)?.name ?? "Connector";
  const direct = providerId.startsWith("chat:");
  const fallback = element("option", "", loading && !catalog ? "Loading models…" : direct ? "Choose a model" : `${providerName} default`);
  fallback.value = "";
  fallback.disabled = direct;
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
  const choices = providerId !== "opencode" ? model?.efforts ?? catalog?.defaultEfforts ?? [] : effortChoices.get(key) ?? [];
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
  if (active && !chatModelField.disabled && supportsWorktreeEditing(providerId)) {
    const label = active.textContent ?? "";
    const suffix = " · " + effortLabel(current);
    active.textContent = (label.length > 22 ? label.slice(0, 21) + "…" : label) + suffix;
  }
}

function renderModels() {
  renderModelPicker(chatModelField, chatProviderId());
  renderThinking(chatProviderId());
  if (!isCliProvider(selectedConnectorId) || profilePreset) return;
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
  }).catch((error) => {
    modelCatalogs[providerId] = { models: [], selected: "", localError: actionMessage(error, "Could not load models. Try refreshing.") };
  }).finally(() => {
    delete modelRequests[providerId];
    renderConnectors();
    renderModels();
    renderControls();
    if (workflowView.kind === "plan") renderPlannerModels();
    if (workflowView.kind === "edit") renderSubagentModels();
  });
  modelRequests[providerId] = request;
  renderConnectors();
  renderControls();
  if (workflowView.kind === "plan") renderPlannerControls();
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
  if (fromChat) get("smart-preview-result").hidden = true;
  if (fromChat && mode === "chat" && providerId === "codex") {
    codexChatModel = picker.value;
    actionError = "";
    renderComposerProvider();
    return;
  }
  const catalog = modelCatalogs[providerId];
  if (!catalog || connectorBusy || modelRequests[providerId]) return;
  const model = picker.value;
  if (fromChat) actionError = "";
  pendingModel = { providerId, model };
  renderControls();
  try {
    if (providerId.startsWith("chat:")) {
      await profileAction(async () => {
        await api.setModel({ providerId, model });
        catalog.selected = model;
        const profile = profiles.find((entry) => entry.id === providerId);
        if (profile) profile.model = model;
      }, "Saving model selection…", "Model selection saved.", fromChat);
      return;
    }
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

function actionMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : fallback;
}

async function profileAction(action: () => Promise<void>, pending: string, success: string, fromChat = false) {
  if (connectorBusy) return;
  connectorBusy = true;
  profileMessage = pending;
  renderConnectors();
  try {
    await action();
    profileMessage = success;
  } catch (error) {
    profileMessage = actionMessage(error, "Honeycomb could not complete this action.");
    if (fromChat) showError(error);
  } finally {
    connectorBusy = false;
    renderConnectors();
    renderComposerProvider();
  }
}

function saveChatConnection(event: SubmitEvent) {
  event.preventDefault();
  const preset = profilePreset;
  if (!preset || connectorBusy) return;
  const previous = profiles.find((entry) => entry.id === selectedConnectorId);
  const key = connectionClear.checked ? "" : connectionKey.value.trim() || undefined;
  void profileAction(async () => {
    const profile = await api.saveChatProfile({
      id: previous?.id, preset, name: connectionName.value, baseUrl: connectionUrl.value,
      manualModel: connectionManual.value, apiKey: key,
    });
    profileRevision++;
    profiles = [...profiles.filter((entry) => entry.id !== profile.id), profile];
    connectors = [...connectors.filter((entry) => entry.id !== profile.id),
      { id: profile.id, name: profile.name, status: "detected", chatOnly: true }];
    await modelRequests[profile.id];
    delete modelCatalogs[profile.id];
    if (!catalogOpen && profilePreset === preset && selectedConnectorId === (previous?.id ?? "codex")) {
      openChatConnection(preset, profile);
    }
    renderChatProviders();
  }, "Saving connection…", "");
}

async function useInChat(id: ProviderId) {
  if (mode !== "chat") await switchMode("chat");
  if (mode !== "chat" || activeRun() || starting) return;
  selectChat(undefined);
  providerField.value = id;
  actionError = "";
  showView("chats");
  promptField.focus();
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
  const revision = profileRevision;
  renderConnectors();
  try {
    const [inspected, saved] = await Promise.all([api.inspectProviders(), api.chatProfiles()]);
    if (revision === profileRevision) profiles = saved;
    connectors = [...inspected.filter((entry) => !entry.id.startsWith("chat:")),
      ...profiles.map(({ id, name }): Connector => ({ id, name, status: "detected", chatOnly: true }))];
  } catch {
    connectors = connectors.map((connector) => connector.id.startsWith("chat:") ? connector : ({
      ...connector, status: "unavailable", detail: "The installation check could not run.",
    }));
  } finally {
    checking = false;
    renderConnectors();
    renderChatProviders();
    renderComposerProvider();
    if (workflowView.kind === "plan") renderPlannerModels();
    if (workflowView.kind === "edit") renderSubagentModels();
  }
}

const workflowProviderOptions: ReadonlyArray<readonly [WorkflowProviderId, string]> = [
  ["codex", "Codex"], ["opencode", "OpenCode"], ["claude", "Claude Code"],
  ["antigravity", providerNames.antigravity], ["github-copilot", providerNames["github-copilot"]], ["freebuff", "Freebuff"],
];

function workflowAgentLabel(step: WorkflowAgentStep) {
  return step.providerId === "freebuff" ? `Freebuff · ${step.model || "manual handoff"}`
    : `${providerNames[step.providerId]} · ${step.model || "Connector default"}`;
}

function orchestratorLabel(route: SmartOrchestrator) {
  return `${providerNames[route.connector]} · ${route.model || "CLI default"}`;
}

function orchestratorNotices(record: WorkflowRun) {
  return (record.smart?.orchestratorSwitches ?? []).map(({ from, to }) =>
    element("p", "workflow-note", `${orchestratorLabel(from)} reached its usage limit. Continuing with ${orchestratorLabel(to)}.`));
}

function workflowAgentAccess(step: WorkflowAgentStep) {
  if (step.providerId === "freebuff") return step.edit ? "Manual · edit in worktree" : "Manual";
  if (step.edit) return "Code · edit in worktree";
  return step.mode === "code" ? "Code · read-only" : "Chat · no project access";
}

function workflowCommand(value: string) {
  const command = /^\/workflow(?:\s+([\s\S]*))?$/i.exec(value.trim());
  return command ? (command[1] ?? "").trim() : undefined;
}

function isPlannerProvider(value: string): value is WorkflowPlanRequest["providerId"] {
  return isCliProvider(value) || value.startsWith("chat:");
}

function renderPlannerModels() {
  const selectedProvider = plannerProvider.value;
  const selectedModel = plannerModel.value;
  const available = connectors.filter((connector) => connector.status === "detected" && isPlannerProvider(connector.id));
  plannerProvider.replaceChildren(...available.map((connector) => {
    const option = element("option", "", connector.name);
    option.value = connector.id;
    return option;
  }));
  if (available.some((connector) => connector.id === selectedProvider)) plannerProvider.value = selectedProvider;
  const provider = plannerProvider.value;
  plannerModel.replaceChildren(element("option", "", "Connector default"));
  plannerModel.options[0]!.value = "";
  if (isPlannerProvider(provider)) {
    if (!modelCatalogs[provider]) void refreshModels(provider);
    for (const model of modelCatalogs[provider]?.models.filter((entry) => entry.available) ?? []) {
      const option = element("option", "", model.name === model.id ? model.id : `${model.name} (${model.id})`);
      option.value = model.id;
      plannerModel.append(option);
    }
    if ([...plannerModel.options].some((option) => option.value === selectedModel)) plannerModel.value = selectedModel;
  }
  renderPlannerControls();
}

function renderPlannerControls() {
  const active = activeRun();
  const provider = plannerProvider.value;
  const loading = isPlannerProvider(provider) && Boolean(modelRequests[provider]);
  const stop = get("workflow-plan-stop", HTMLButtonElement);
  const status = get("workflow-plan-status");
  get("workflow-plan-loading").hidden = !loading;
  plannerProvider.disabled = plannerBusy || !plannerProvider.options.length;
  plannerModel.disabled = plannerBusy || loading || !provider;
  get("workflow-plan-send", HTMLButtonElement).disabled = plannerBusy || Boolean(active) ||
    loading || !provider || !plannerGoal.value.trim();
  stop.hidden = !active?.workflowPlanner || Boolean(active.workflowRunId);
  stop.disabled = active?.status === "stopping";
  const edit = get("workflow-plan-edit", HTMLButtonElement);
  edit.hidden = !plannerDraft;
  edit.disabled = plannerBusy;
  const fresh = get("workflow-plan-new", HTMLButtonElement);
  fresh.hidden = !plannerTurns.length;
  fresh.disabled = plannerBusy;
  status.textContent = plannerBusy ? "Planning your workflow…"
    : active ? "Finish or stop the current run before planning."
    : !provider ? "Set up a connector to plan a workflow."
    : loading ? `Loading ${plannerProvider.selectedOptions[0]?.textContent ?? "connector"} models…`
    : isPlannerProvider(provider) ? modelCatalogs[provider]?.localError ?? "" : "";
}

function renderPlannerMessages() {
  const feed = get("workflow-plan-messages");
  feed.replaceChildren(...plannerTurns.map((turn) => {
    const section = element("section", "conversation-turn");
    section.append(feedEntry("You", turn.prompt, "user"));
    if (turn.result) {
      section.append(turn.result.failed ? element("p", "workflow-error", turn.result.reply)
        : agentReply("Workflow planner", turn.result.reply));
      const totals = usageRows(turn.result.usage);
      section.append(totals.length ? facts(totals) : element("p", "connector-note", "The provider reported no usage."));
      if (turn.result.workflow) {
        const steps = element("ol", "workflow-plan-steps");
        for (const step of turn.result.workflow.steps) {
          const description = step.kind === "agent"
            ? `${workflowAgentLabel(step)}${step.effort ? ` · ${effortLabel(step.effort)}` : ""} · ${workflowAgentAccess(step)}`
            : `${step.judgeStepId ? "Automatic review" : "Human review"} · up to ${step.maxRevisions} ${step.maxRevisions === 1 ? "revision" : "revisions"}`;
          steps.append(element("li", "", `${step.title} · ${description}`));
        }
        section.append(steps);
      }
    }
    if (turn.error) section.append(element("p", "workflow-error", turn.error));
    return section;
  }));
}

function openWorkflowPlanner() {
  workflowView = { kind: "plan" };
  showView("workflows");
  plannerGoal.focus();
}

async function submitWorkflowPlan() {
  const providerId = plannerProvider.value;
  const prompt = plannerGoal.value.trim();
  if (plannerBusy || activeRun() || !isPlannerProvider(providerId) || modelRequests[providerId] || !prompt) return;
  if (prompt.length > plannerGoal.maxLength) {
    get("workflow-plan-status").textContent = `Keep the goal to ${plannerGoal.maxLength.toLocaleString()} characters.`;
    return;
  }
  const turn: typeof plannerTurns[number] = { prompt };
  const history = plannerTurns.flatMap((earlier) => earlier.result && !earlier.result.failed
    ? [{ prompt: earlier.prompt, reply: earlier.result.reply }] : []).slice(-2);
  plannerTurns.push(turn);
  plannerGoal.value = "";
  plannerBusy = true;
  renderPlannerControls();
  renderPlannerMessages();
  renderControls();
  try {
    turn.result = await api.planWorkflow({ providerId, model: plannerModel.value, prompt, previous: plannerDraft, history });
    plannerDraft = turn.result.workflow ?? plannerDraft;
  } catch (error) {
    turn.error = actionMessage(error, "Could not generate a workflow.");
  } finally {
    plannerBusy = false;
    renderPlannerMessages();
    renderPlannerControls();
    renderControls();
    if (workflowView.kind === "plan" && !get("workflows").hidden) plannerGoal.focus();
  }
}

function renderSubagentModels() {
  for (const list of document.querySelectorAll<HTMLDataListElement>("[data-subagent-models]")) {
    const provider = list.dataset.subagentModels;
    if (!isCliProvider(provider)) continue;
    if (!modelCatalogs[provider] && connectors.some((entry) => entry.id === provider && entry.status === "detected")) {
      void refreshModels(provider);
    }
    list.replaceChildren(...(modelCatalogs[provider]?.models ?? []).filter((entry) => entry.available).map((entry) => {
      const option = element("option", "", entry.name);
      option.value = entry.id;
      return option;
    }));
  }
}
const workflowStatusLabels = {
  running: "Running",
  waiting: "Waiting for review",
  stopping: "Stopping",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Interrupted",
} satisfies Record<WorkflowRunStatus, string>;
const workflowStepLabels = {
  pending: "Pending",
  running: "Running",
  waiting: "Waiting for review",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
  skipped: "Skipped",
} satisfies Record<WorkflowStepStatus, string>;

let stepCounter = 0;

function workflowErrorText(error: unknown) {
  const message = error instanceof Error ? error.message : "Honeycomb could not complete the action.";
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

function newStepId() {
  stepCounter++;
  return `step-${crypto.randomUUID().slice(0, 8)}-${stepCounter}`;
}

function newAgentStep(providerId: CliProviderId = "codex", index = 1): WorkflowAgentStep {
  return {
    id: newStepId(), kind: "agent", title: `Step ${index}`, providerId, model: "", effort: "", mode: "code",
    edit: false, prompt: "", inputs: [], output: "", timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  };
}

function newGateStep(steps: readonly WorkflowStep[]): WorkflowGateStep {
  const target = [...steps].reverse().find((step) => step.kind === "agent");
  return {
    id: newStepId(), kind: "gate", title: "Review gate", feedbackStepId: target?.id ?? "",
    maxRevisions: DEFAULT_GATE_REVISIONS,
  };
}

function blankWorkflow(): WorkflowDefinition {
  return {
    id: `workflow-${crypto.randomUUID().slice(0, 8)}`, name: "New workflow", description: "",
    steps: [newAgentStep("codex", 1)],
  };
}

function workflowBadge(status: string, label: string) {
  const badge = element("span", "workflow-status");
  badge.dataset.status = status;
  const dot = element("span", "status-dot");
  dot.dataset.status = status;
  badge.append(dot, document.createTextNode(label));
  return badge;
}

function selectedWorkflowId() {
  if (workflowView.kind === "detail") return workflowView.id;
  if (workflowView.kind === "edit") return workflowView.draft.id;
  return undefined;
}

function workflowById(id: string | undefined) {
  return id ? workflows.find((entry) => entry.id === id) : undefined;
}

function currentWorkflow() {
  return workflowById(selectedWorkflowId());
}

function workflowDraft() {
  return workflowView.kind === "edit" ? workflowView.draft : undefined;
}

function currentWorkflowRun() {
  return workflowView.kind === "run" ? workflowRuns.get(workflowView.runId) : undefined;
}

function selectedChatWorkflow() {
  return selectedChatWorkflowId ? workflowRuns.get(selectedChatWorkflowId) : undefined;
}

function isWorkflowInProgress(run: WorkflowRun) {
  return run.status === "running" || run.status === "waiting" || run.status === "stopping";
}

function workflowsBusy() {
  return [...workflowRuns.values()].some((run) => isWorkflowInProgress(run) && (run.status !== "waiting" || !run.smart));
}

function workflowStatusIcon(status: WorkflowRunStatus | WorkflowStepStatus) {
  const glyph = {
    pending: "○", running: "", waiting: "◷", stopping: "", completed: "✓",
    failed: "!", cancelled: "×", interrupted: "×", skipped: "–",
  }[status];
  const icon = element("span", glyph ? "workflow-status-icon" : "workflow-status-icon loading-icon", glyph);
  icon.dataset.status = status;
  icon.setAttribute("aria-hidden", "true");
  return icon;
}

function renderChatWorkflow() {
  const record = selectedChatWorkflow();
  const outline = get("chat-workflow-outline");
  const history = get("chat-workflow-history");
  const feed = get("chat-workflow-feed");
  const entries = [...workflowRuns.values()].filter((run) => run.goal)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  history.hidden = !entries.length;
  get("chat-workflow-list").replaceChildren(...entries.map((entry) => {
    const button = element("button", "history-item workflow-chat-history-item");
    button.type = "button";
    button.title = entry.goal ?? entry.workflowName;
    if (entry.id === record?.id) button.setAttribute("aria-current", "true");
    const text = element("span", "workflow-chat-history-text");
    text.append(
      element("span", "history-name", entry.goal?.replace(/\s+/g, " ") ?? entry.workflowName),
      element("span", "history-meta", workflowStatusLabels[entry.status]),
    );
    button.append(workflowStatusIcon(entry.status), text);
    button.addEventListener("click", () => openChatWorkflow(entry.id));
    return button;
  }));

  outline.hidden = !record;
  feed.hidden = !record;
  get("composer-area").hidden = Boolean(record);
  get("chats").classList.toggle("workflow-chat", Boolean(record));
  if (!record) {
    outline.replaceChildren();
    feed.replaceChildren();
    return;
  }
  for (const id of ["welcome", "feed", "freebuff-handoffs"]) get(id).hidden = true;

  const steps = element("ol", "chat-workflow-steps");
  for (const [index, step] of record.definition.steps.entries()) {
    const state = record.steps[index]?.status ?? "pending";
    const item = element("li");
    if (isWorkflowInProgress(record) && index === record.currentIndex) item.setAttribute("aria-current", "step");
    const text = element("div");
    const access = step.kind === "agent" ? workflowAgentAccess(step) : step.judgeStepId ? "Automatic review" : "Human review";
    const route = record.smart && step.kind === "agent" ? ` · ${workflowAgentLabel(step)}${step.effort ? ` · ${effortLabel(step.effort)}` : ""}` : "";
    const status = state === "waiting" && isWaitingForFreebuff(record) ? "Waiting for Freebuff" : workflowStepLabels[state];
    text.append(element("span", "workflow-step-title", step.title),
      element("span", "workflow-step-meta", `${status} · ${access}${route}`));
    const reason = record.smart?.selection[step.id]?.reason;
    if (reason) text.append(element("span", "workflow-step-meta", reason));
    item.append(workflowStatusIcon(state), text);
    steps.append(item);
  }
  const orchestrator = record.smart?.orchestrator;
  outline.replaceChildren(element("h3", "", "Workflow outline"),
    element("p", "history-meta", record.folder?.name ?? "Chat-only · no project access"),
    ...(orchestrator ? [element("p", "history-meta", `Orchestrator: ${orchestratorLabel(orchestrator)}`)] : []), steps);

  const content = element("section", "conversation-turn");
  if (record.goal) content.append(feedEntry("You", record.goal, "user"));
  content.append(...orchestratorNotices(record));
  if (isWorkflowInProgress(record)) content.append(...workflowMessages());
  const current = record.definition.steps[record.currentIndex];
  if (record.smart?.reply && record.status === "completed") {
    content.append(agentReply(record.smart.replyFrom ? providerNames[record.smart.replyFrom] : "Smart", record.smart.reply));
  } else if (record.smart && record.status === "waiting") {
    const controls = smartUi.controls(record, renderWorkflowActions, Boolean(activeRun()) || workflowsBusy());
    if (controls) content.append(controls);
  } else if (record.status === "completed") {
    const judges = new Set(record.definition.steps.flatMap((step) => step.kind === "gate" && step.judgeStepId ? [step.judgeStepId] : []));
    const lastAgent = [...record.definition.steps].reverse().find((step) => step.kind === "agent" && !judges.has(step.id));
    const lastStep = record.steps.find((step) => step.stepId === lastAgent?.id);
    const run = lastStep?.runId ? runs.get(lastStep.runId) : undefined;
    const reply = lastStep?.freebuffReply || run?.events.flatMap((event) => event.type === "message" && event.text.trim() ? [event.text] : []).at(-1);
    if (reply) content.append(agentReply(run?.providerName ?? "Freebuff", reply));
    else content.append(element("p", "workflow-note", "The workflow finished without a final reply."));
  } else if (record.status === "waiting" && current?.kind === "gate") {
    content.append(gateControls(record, current));
  } else if (current && isWaitingForFreebuff(record)) {
    content.append(freebuffHandoffControls(record, current.id));
  } else {
    const status = element("p", record.error ? "workflow-error" : "workflow-note",
      record.error ?? (record.smart && record.status === "running" && !current ? "Selecting the next step…" : workflowStatusLabels[record.status]));
    status.setAttribute("role", "status");
    content.append(status);
  }
  if (record.worktree && !isWorkflowInProgress(record)) {
    const run = workflowWorktreeRun(record);
    const changes = run && runChanges(run, true);
    const details = element("details", "tool-activity");
    details.append(element("summary", "", "Review worktree changes"), changes ?? worktreeFallback(record.worktree));
    content.append(details);
  }
  feed.replaceChildren(content);
}

function openChatWorkflow(runId: string) {
  selectedChatWorkflowId = runId;
  workflowError = "";
  workflowNote = "";
  renderChats();
  if (!get("chats").hidden) get("chat-title").focus();
}

function rememberWorkflowRun(run: WorkflowRun) {
  if ((workflowRuns.get(run.id)?.revision ?? -1) >= run.revision) return false;
  workflowRuns.set(run.id, run);
  return true;
}

async function loadWorkflowRuns() {
  try {
    for (const record of await api.listWorkflowRuns()) rememberWorkflowRun(record);
  } catch {
    // Workflow run history is optional; the timeline simply starts empty.
  }
  renderChatWorkflow();
  renderControls();
}

async function loadWorkflows() {
  try {
    workflows = await api.listWorkflows();
  } catch (error) {
    workflowError = workflowErrorText(error);
    workflows = [];
  }
  renderWorkflowSidebar();
}

async function refreshWorkflows() {
  if (workflowBusy) return;
  workflowBusy = true;
  workflowError = "";
  renderWorkflowSidebar();
  try {
    workflows = await api.listWorkflows();
    await loadWorkflowRuns();
    workflowNote = "Saved workflows reloaded.";
  } catch (error) {
    workflowError = workflowErrorText(error);
  } finally {
    workflowBusy = false;
    renderWorkflows();
  }
}

function renderWorkflowSidebar() {
  const list = get("workflow-list");
  const selected = selectedWorkflowId();
  const items = workflows.map((workflow) => {
    const button = element("button", "sidebar-item workflow-workflow");
    button.type = "button";
    button.title = workflow.description || workflow.name;
    if (workflow.id === selected) button.setAttribute("aria-current", "true");
    const text = element("span", "connector-row");
    text.append(
      element("span", "workflow-item-name", workflow.name),
      element("span", "connector-row-status", `${workflow.steps.length} ${workflow.steps.length === 1 ? "step" : "steps"}`),
    );
    button.append(element("span", "workflow-marker"), text);
    button.addEventListener("click", () => openWorkflow(workflow.id));
    return button;
  });
  list.replaceChildren(...(items.length ? items : [element("p", "workflow-empty", "No saved workflows yet.")]));
  for (const handoff of [...workflowRuns.values()].filter((run) => isWaitingForFreebuff(run) || run.smart && isWorkflowInProgress(run))) {
    const label = isWaitingForFreebuff(handoff) ? "Freebuff reply needed" : `Smart · ${workflowStatusLabels[handoff.status]}`;
    const button = element("button", "button sidebar-action", label);
    button.type = "button";
    button.title = handoff.goal ?? handoff.workflowName;
    button.addEventListener("click", () => {
      workflowView = { kind: "run", runId: handoff.id };
      workflowError = "";
      workflowNote = "";
      renderWorkflows();
    });
    list.prepend(button);
  }
  const solo = get("select-solo");
  if (workflowView.kind === "solo") solo.setAttribute("aria-current", "true");
  else solo.removeAttribute("aria-current");
  const planner = get("plan-workflow");
  if (workflowView.kind === "plan") planner.setAttribute("aria-current", "true");
  else planner.removeAttribute("aria-current");
  get("refresh-workflows", HTMLButtonElement).disabled = workflowBusy;
}

function renderWorkflows() {
  get("workflow-solo").hidden = workflowView.kind !== "solo";
  get("workflow-panel").hidden = workflowView.kind === "solo" || workflowView.kind === "plan";
  get("workflow-planner").hidden = workflowView.kind !== "plan";
  renderWorkflowSidebar();
  renderWorkflowPanel();
}

function renderWorkflowPanel() {
  const panel = get("workflow-panel");
  if (workflowView.kind === "solo") {
    panel.replaceChildren();
    return;
  }
  if (workflowView.kind === "plan") {
    panel.replaceChildren();
    renderPlannerModels();
    renderPlannerMessages();
    return;
  }
  if (workflowView.kind === "edit") {
    panel.replaceChildren(...workflowEditor(workflowView.draft, workflowView.existing));
    renderSubagentModels();
    return;
  }
  if (workflowView.kind === "run") {
    const record = workflowRuns.get(workflowView.runId);
    if (!record) {
      panel.replaceChildren(element("p", "workflow-empty", "Loading this workflow run…"));
      return;
    }
    panel.replaceChildren(...workflowRunView(record));
    return;
  }
  const workflow = workflowById(workflowView.id);
  if (!workflow) {
    panel.replaceChildren(element("p", "workflow-empty", "This workflow is no longer saved."));
    return;
  }
  panel.replaceChildren(...workflowDetail(workflow));
}

function openWorkflow(id: string) {
  workflowView = { kind: "detail", id };
  workflowError = "";
  workflowNote = "";
  workflowConfirmDelete = false;
  renderWorkflows();
}

function workflowMessages() {
  const nodes: HTMLElement[] = [];
  if (workflowError) nodes.push(element("p", "workflow-error", workflowError));
  if (workflowNote) nodes.push(element("p", "workflow-note", workflowNote));
  return nodes;
}

function workflowDetail(workflow: SavedWorkflow) {
  const header = element("div", "library-header");
  const title = element("h1", "", workflow.name);
  title.tabIndex = -1;
  header.append(title, element("p", "", workflow.description || "A linear workflow of agent steps and review gates."));

  const flow = element("ol", "workflow-steps");
  for (const step of workflow.steps) {
    const item = element("li", "workflow-step-row");
    const meta = step.kind === "agent"
      ? `${workflowAgentLabel(step)}${step.edit ? " · edits in worktree" : ""}`
      : `${step.judgeStepId ? "Automatic review" : "Human review"} · feedback to ${workflow.steps.find((entry) => entry.id === step.feedbackStepId)?.title ?? "an earlier step"}`;
    item.append(
      element("span", "workflow-marker"),
      element("span", "workflow-step-title", step.title),
      element("span", "workflow-step-meta", meta),
    );
    flow.append(item);
  }

  const actions = element("div", "workflow-actions");
  const run = element("button", "button button-primary", "Run workflow");
  run.type = "button";
  run.dataset.action = "run-workflow";
  const needsProject = workflowRequiresProject(workflow);
  const project = mode === "code" ? folder : undefined;
  run.disabled = workflowBusy || (needsProject && !project);
  const edit = element("button", "button", "Edit");
  edit.type = "button";
  edit.dataset.action = "edit-workflow";
  edit.disabled = workflowBusy;
  const remove = element("button", "button", workflowConfirmDelete ? "Confirm delete" : "Delete");
  remove.type = "button";
  remove.dataset.action = "delete-workflow";
  remove.disabled = workflowBusy;
  actions.append(run, edit, remove);

  const hint = element("p", "workflow-note", needsProject
    ? project ? `Code steps run in ${project.name}.` : "Choose a project in Code to run this workflow’s Code steps."
    : "This workflow runs in Chat without a project.");
  const command = element("p", "workflow-note");
  const copyCommand = element("button", "workflow-command-copy");
  copyCommand.type = "button";
  copyCommand.setAttribute("aria-label", "Copy workflow command");
  const copyStatus = element("span", "visually-hidden");
  copyStatus.setAttribute("role", "status");
  copyCommand.addEventListener("click", async () => {
    try {
      await api.copyWorkflowCommand(workflow.id);
      copyCommand.dataset.copied = "true";
      copyStatus.textContent = "Workflow command copied.";
    } catch {
      copyCommand.dataset.copied = "false";
      copyStatus.textContent = "Could not copy the workflow command.";
    }
  });
  command.append("Run from Chats with ", element("code", "", `/workflow ${workflow.id} <prompt>`), copyCommand, copyStatus);
  const history = workflowRunHistory(workflow.id);
  return [header, flow, ...workflowMessages(), actions, hint, command, ...(history ? [history] : [])];
}

function workflowRunHistory(workflowId: string) {
  const records = [...workflowRuns.values()]
    .filter((run) => run.workflowId === workflowId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (!records.length) return undefined;
  const section = element("section", "workflow-history");
  section.append(element("h2", "", "Runs"));
  const list = element("div", "workflow-history-list");
  for (const record of records.slice(0, 10)) {
    const button = element("button", "sidebar-item workflow-history-run");
    button.type = "button";
    button.append(
      workflowBadge(record.status, isWaitingForFreebuff(record) ? "Waiting for Freebuff" : workflowStatusLabels[record.status]),
      element("span", "workflow-step-meta",
        `${new Date(record.startedAt).toLocaleString()} · step ${Math.min(record.currentIndex + 1, record.steps.length)} of ${record.steps.length}`),
    );
    button.addEventListener("click", () => {
      workflowView = { kind: "run", runId: record.id };
      workflowError = "";
      workflowNote = "";
      renderWorkflows();
    });
    list.append(button);
  }
  section.append(list);
  return section;
}

function workflowField(labelText: string, control: HTMLElement, hint?: string) {
  const field = element("label", "workflow-field");
  field.append(element("span", "workflow-field-label", labelText), control);
  if (hint) field.append(element("span", "workflow-field-hint", hint));
  return field;
}

function workflowTextInput(value: string, options: { field: string; step?: string; max?: number; placeholder?: string }) {
  const input = element("input", "workflow-input");
  input.type = "text";
  input.value = value;
  input.autocomplete = "off";
  input.dataset.field = options.field;
  if (options.step) input.dataset.step = options.step;
  if (options.max) input.maxLength = options.max;
  if (options.placeholder) input.placeholder = options.placeholder;
  return input;
}

function workflowNumberInput(value: number, field: string, step: string, min: number, max: number) {
  const input = element("input", "workflow-input workflow-number");
  input.type = "number";
  input.min = String(min);
  input.max = String(max);
  input.step = "1";
  input.value = String(Math.round(value));
  input.dataset.field = field;
  input.dataset.step = step;
  return input;
}

function workflowSelect<T extends string>(
  options: ReadonlyArray<readonly [T, string]>, value: T, field: string, step: string,
) {
  const select = element("select", "workflow-input");
  select.dataset.field = field;
  select.dataset.step = step;
  for (const [optionValue, label] of options) {
    const option = element("option", "", label);
    option.value = optionValue;
    select.append(option);
  }
  select.value = value;
  return select;
}

function workflowTextArea(value: string, field: string, step: string, placeholder: string) {
  const area = element("textarea", "workflow-input");
  area.rows = 4;
  area.maxLength = MAX_STEP_PROMPT;
  area.placeholder = placeholder;
  area.value = value;
  area.dataset.field = field;
  area.dataset.step = step;
  return area;
}

function editorStepCard(step: WorkflowStep, index: number, steps: readonly WorkflowStep[]) {
  const card = element("section", "workflow-step-editor");
  card.dataset.stepId = step.id;
  const head = element("div", "workflow-step-head");
  head.append(element("span", "workflow-step-index", `${index + 1}`));
  head.append(workflowTextInput(step.title, { field: "title", step: step.id, max: 80 }));
  head.append(element("span", "workflow-step-kind", step.kind === "agent" ? "Subagent" : "Review gate"));
  const controls = element("div", "workflow-step-controls");
  for (const [action, label, disabled] of [
    ["step-up", "Move up", index === 0],
    ["step-down", "Move down", index === steps.length - 1],
    ["step-remove", "Remove", false],
  ] as const) {
    const button = element("button", "button button-small", label);
    button.type = "button";
    button.dataset.action = action;
    button.dataset.step = step.id;
    button.disabled = disabled;
    button.setAttribute("aria-label", `${label} ${step.title}`);
    controls.append(button);
  }
  head.append(controls);
  card.append(head);

  if (step.kind === "agent") {
    const connector = workflowField("Connector", workflowSelect(workflowProviderOptions, step.providerId, "providerId", step.id));
    if (step.providerId === "freebuff") {
      card.append(connector, element("p", "workflow-note", "Honeycomb copies the prompt when this step starts. Send it in Freebuff, then paste the reply into the workflow."));
    } else {
      const row = element("div", "workflow-field-row");
      const model = workflowTextInput(step.model, { field: "model", step: step.id, max: 200, placeholder: "Connector default" });
      const suggestions = element("datalist");
      suggestions.id = `workflow-models-${step.id}`;
      suggestions.dataset.subagentModels = step.providerId;
      model.setAttribute("list", suggestions.id);
      row.append(
        connector,
        workflowField("Model", model),
        workflowField("Thinking effort", workflowTextInput(step.effort, {
          field: "effort", step: step.id, max: 40, placeholder: "Connector default",
        })),
      );
      const row2 = element("div", "workflow-field-row");
      row2.append(
        workflowField("Mode", workflowSelect([["code", "Code"], ["chat", "Chat"]] as const, step.mode, "mode", step.id),
          "Code uses the selected project. Chat has no project access."),
        workflowField("Time limit (seconds)",
          workflowNumberInput(step.timeoutMs / 1000, "timeoutSeconds", step.id, MIN_STEP_TIMEOUT_MS / 1000, MAX_STEP_TIMEOUT_MS / 1000)),
      );
      card.append(row, row2, suggestions);

      const edit = element("label", "workflow-check");
      const box = element("input");
      box.type = "checkbox";
      box.checked = step.edit;
      box.dataset.field = "edit";
      box.dataset.step = step.id;
      box.disabled = step.mode !== "code" || !supportsWorktreeEditing(step.providerId);
      edit.append(box, element("span", "", "Edit in the workflow worktree"));
      card.append(edit);
    }

    const inputs = element("div", "workflow-inputs");
    inputs.append(element("span", "workflow-field-label", "Inputs"));
    const earlier = steps.slice(0, index).filter((entry) => entry.kind === "agent");
    if (!earlier.length) inputs.append(element("span", "workflow-field-hint", "No earlier step results to use."));
    for (const candidate of earlier) {
      const label = element("label", "workflow-check");
      const check = element("input");
      check.type = "checkbox";
      check.checked = step.inputs.includes(candidate.id);
      check.disabled = !check.checked && step.inputs.length >= MAX_STEP_INPUTS;
      check.dataset.field = "input";
      check.dataset.step = step.id;
      check.dataset.input = candidate.id;
      label.append(check, element("span", "", candidate.title));
      inputs.append(label);
    }
    card.append(inputs);

    card.append(workflowField("Prompt", workflowTextArea(step.prompt, "prompt", step.id, "What should this step do?"),
      `Up to ${MAX_STEP_PROMPT.toLocaleString("en-US")} characters. Earlier results and gate feedback are added automatically.`));
    card.append(workflowField("Output name", workflowTextInput(step.output, {
      field: "output", step: step.id, max: 60, placeholder: "Optional, for example plan",
    })));
  } else {
    const row = element("div", "workflow-field-row");
    const earlier = steps.slice(0, index).filter((entry) => entry.kind === "agent");
    const preceding = steps[index - 1];
    const reviewers: Array<[string, string]> = [["", "Human review"]];
    if (preceding?.kind === "agent" && preceding.providerId !== "freebuff" && !preceding.edit) {
      reviewers.push([preceding.id, preceding.title]);
    }
    if (step.judgeStepId && !reviewers.some(([id]) => id === step.judgeStepId)) {
      reviewers.push([step.judgeStepId, "Reviewer unavailable"]);
    }
    row.append(
      workflowField("Feedback goes to", workflowSelect(
        earlier.map((entry) => [entry.id, entry.title] as const), step.feedbackStepId, "feedbackStepId", step.id)),
      workflowField("Allowed revisions", workflowNumberInput(step.maxRevisions, "maxRevisions", step.id, 0, MAX_GATE_REVISIONS)),
    );
    card.append(row, workflowField("Reviewer", workflowSelect(reviewers, step.judgeStepId ?? "", "judgeStepId", step.id),
      "An automatic reviewer runs immediately before the gate and takes the worker’s result as input."));
  }
  return card;
}

function workflowEditor(draft: WorkflowDefinition, existing: boolean) {
  const header = element("div", "library-header");
  const title = element("h1", "", existing ? "Edit workflow" : "New workflow");
  title.tabIndex = -1;
  header.append(title, element("p", "", "Steps run in order. Human review gates pause the run for your decision."));

  const steps = draft.steps.map((step, index) => editorStepCard(step, index, draft.steps));
  const actions = element("div", "workflow-actions");
  const addAgent = element("button", "button", "Add subagent");
  addAgent.type = "button";
  addAgent.dataset.action = "add-agent";
  addAgent.disabled = draft.steps.length >= MAX_WORKFLOW_STEPS;
  const addGate = element("button", "button", "Add review gate");
  addGate.type = "button";
  addGate.dataset.action = "add-gate";
  addGate.disabled = draft.steps.length >= MAX_WORKFLOW_STEPS || !draft.steps.some((step) => step.kind === "agent");
  const save = element("button", "button button-primary", workflowBusy ? "Saving…" : "Save workflow");
  save.type = "button";
  save.dataset.action = "save-workflow";
  save.disabled = workflowBusy;
  const cancel = element("button", "button", "Cancel");
  cancel.type = "button";
  cancel.dataset.action = "cancel-edit";
  cancel.disabled = workflowBusy;
  actions.append(addAgent, addGate, save, cancel);

  return [
    header,
    ...workflowMessages(),
    workflowField("Name", workflowTextInput(draft.name, { field: "workflow-name", max: 80 })),
    workflowField("Description", workflowTextInput(draft.description, { field: "workflow-description", max: 400 })),
    ...steps,
    actions,
    element("p", "workflow-note", "Workflow files are data: no shell commands, environment variables, paths or secrets."),
  ];
}

function sanitizeDraft(draft: WorkflowDefinition) {
  const earlier = new Set<string>();
  for (const [index, step] of draft.steps.entries()) {
    if (step.kind === "agent") {
      step.inputs = step.inputs.filter((id) => earlier.has(id));
    } else if (!earlier.has(step.feedbackStepId)) {
      const agents = draft.steps.slice(0, index).filter((entry) => entry.kind === "agent");
      step.feedbackStepId = agents.at(-1)?.id ?? "";
    }
    earlier.add(step.id);
  }
}

function onWorkflowInput(event: Event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) return;
  const field = target.dataset.field;
  if (!field) return;
  if (field === "gate-feedback") {
    const record = currentWorkflowRun();
    if (record) gateFeedback.set(`${record.id}:${target.dataset.gateStep ?? ""}`, target.value);
    return;
  }
  const draft = workflowDraft();
  if (!draft) return;
  if (field === "workflow-name") {
    draft.name = target.value;
    return;
  }
  if (field === "workflow-description") {
    draft.description = target.value;
    return;
  }
  const stepId = target.dataset.step;
  if (!stepId) return;
  const step = draft.steps.find((entry) => entry.id === stepId);
  if (!step) return;
  const value = target.value;
  switch (field) {
    case "title":
      step.title = value;
      return;
    case "model":
      if (step.kind === "agent") step.model = value;
      return;
    case "effort":
      if (step.kind === "agent") step.effort = value;
      return;
    case "output":
      if (step.kind === "agent") step.output = value;
      return;
    case "prompt":
      if (step.kind === "agent") step.prompt = value;
      return;
    case "providerId": {
      if (step.kind !== "agent") return;
      const provider = workflowProviderOptions.find(([id]) => id === value)?.[0];
      if (!provider || provider === step.providerId) return;
      step.providerId = provider;
      step.model = "";
      step.effort = "";
      if (provider === "freebuff") {
        step.mode = "chat";
        step.edit = false;
      }
      renderWorkflowPanel();
      return;
    }
    case "mode": {
      if (step.kind !== "agent") return;
      step.mode = value === "chat" ? "chat" : "code";
      if (step.mode === "chat") step.edit = false;
      renderWorkflowPanel();
      return;
    }
    case "edit":
      if (step.kind === "agent" && target instanceof HTMLInputElement) {
        step.edit = target.checked;
        if (step.edit) step.mode = "code";
      }
      return;
    case "input": {
      if (step.kind !== "agent" || !(target instanceof HTMLInputElement)) return;
      const inputId = target.dataset.input ?? "";
      if (target.checked) {
        if (!step.inputs.includes(inputId)) step.inputs.push(inputId);
      } else {
        step.inputs = step.inputs.filter((id) => id !== inputId);
      }
      return;
    }
    case "timeoutSeconds": {
      if (step.kind !== "agent") return;
      const seconds = Number.parseInt(value, 10);
      if (!Number.isFinite(seconds)) return;
      step.timeoutMs = Math.min(MAX_STEP_TIMEOUT_MS, Math.max(MIN_STEP_TIMEOUT_MS, seconds * 1000));
      return;
    }
    case "feedbackStepId":
      if (step.kind === "gate") step.feedbackStepId = value;
      return;
    case "judgeStepId":
      if (step.kind === "gate") step.judgeStepId = value || undefined;
      return;
    case "maxRevisions": {
      if (step.kind !== "gate") return;
      const revisions = Number.parseInt(value, 10);
      if (Number.isFinite(revisions)) step.maxRevisions = Math.min(MAX_GATE_REVISIONS, Math.max(0, revisions));
      return;
    }
  }
}

async function onWorkflowClick(event: MouseEvent) {
  const target = event.target instanceof Element ? event.target : null;
  const button = target?.closest<HTMLButtonElement>("button[data-action]");
  const action = button?.dataset.action;
  if (!action) return;
  const stepId = button.dataset.step;
  const draft = workflowDraft();
  const run = event.currentTarget === get("chat-workflow-feed") ? selectedChatWorkflow() : currentWorkflowRun();

  switch (action) {
    case "add-agent": {
      if (!draft) return;
      draft.steps.push(newAgentStep("codex", draft.steps.length + 1));
      renderWorkflowPanel();
      return;
    }
    case "add-gate": {
      if (!draft) return;
      const gate = newGateStep(draft.steps);
      if (!gate.feedbackStepId) return;
      draft.steps.push(gate);
      renderWorkflowPanel();
      return;
    }
    case "step-up":
    case "step-down": {
      if (!draft || !stepId) return;
      const index = draft.steps.findIndex((step) => step.id === stepId);
      const next = action === "step-up" ? index - 1 : index + 1;
      if (index < 0 || next < 0 || next >= draft.steps.length) return;
      const [moved] = draft.steps.splice(index, 1);
      if (moved) draft.steps.splice(next, 0, moved);
      sanitizeDraft(draft);
      renderWorkflowPanel();
      return;
    }
    case "step-remove": {
      if (!draft || !stepId) return;
      draft.steps = draft.steps.filter((step) => step.id !== stepId);
      sanitizeDraft(draft);
      renderWorkflowPanel();
      return;
    }
    case "save-workflow":
      void saveWorkflow();
      return;
    case "cancel-edit": {
      const id = workflowDraft()?.id;
      workflowConfirmDelete = false;
      workflowError = "";
      const saved = workflowById(id);
      workflowView = saved ? { kind: "detail", id: saved.id } : { kind: "solo" };
      renderWorkflows();
      return;
    }
    case "edit-workflow": {
      const workflow = currentWorkflow();
      if (!workflow) return;
      workflowView = { kind: "edit", draft: cloneWorkflow(workflow), existing: true };
      workflowError = "";
      workflowNote = "";
      workflowConfirmDelete = false;
      renderWorkflows();
      return;
    }
    case "delete-workflow":
      void removeWorkflow();
      return;
    case "run-workflow":
      void startWorkflowRun();
      return;
    case "show-definition": {
      const record = currentWorkflowRun();
      if (!record) return;
      openWorkflow(record.workflowId);
      return;
    }
    case "stop-workflow":
      void stopWorkflowRun(run);
      return;
    case "approve-gate":
    case "reject-gate":
      void decideGate(action === "approve-gate" ? "approved" : "rejected", run);
      return;
    case "copy-freebuff-prompt":
    case "submit-freebuff-reply":
      if (stepId) void handleWorkflowFreebuff(stepId, action === "submit-freebuff-reply", run);
      return;
  }
}

async function saveWorkflow() {
  const draft = workflowDraft();
  if (!draft || workflowBusy) return;
  workflowBusy = true;
  workflowError = "";
  workflowNote = "";
  renderWorkflowPanel();
  try {
    const saved = await api.saveWorkflow(JSON.parse(JSON.stringify(draft)) as WorkflowDefinition);
    workflows = [...workflows.filter((entry) => entry.id !== saved.id), saved]
      .sort((a, b) => a.name.localeCompare(b.name));
    workflowView = { kind: "detail", id: saved.id };
    workflowNote = "Workflow saved in Honeycomb.";
  } catch (error) {
    workflowError = workflowErrorText(error);
  } finally {
    workflowBusy = false;
    renderWorkflows();
  }
}

async function removeWorkflow() {
  const workflow = currentWorkflow();
  if (!workflow || workflowBusy) return;
  if (!workflowConfirmDelete) {
    workflowConfirmDelete = true;
    workflowError = "";
    renderWorkflowPanel();
    return;
  }
  workflowBusy = true;
  renderWorkflowPanel();
  try {
    await api.deleteWorkflow(workflow.id);
    workflows = workflows.filter((entry) => entry.id !== workflow.id);
    workflowView = { kind: "solo" };
    workflowNote = `Deleted ${workflow.name}.`;
  } catch (error) {
    workflowError = workflowErrorText(error);
  } finally {
    workflowBusy = false;
    workflowConfirmDelete = false;
    renderWorkflows();
  }
}

async function startWorkflowRun() {
  const workflow = currentWorkflow();
  if (!workflow || workflowBusy) return;
  workflowBusy = true;
  workflowError = "";
  workflowNote = "";
  renderWorkflowPanel();
  try {
    const runId = await api.startWorkflow(workflow.id);
    await loadWorkflowRuns();
    workflowView = { kind: "run", runId };
  } catch (error) {
    workflowError = workflowErrorText(error);
  } finally {
    workflowBusy = false;
    renderWorkflows();
  }
}

function renderWorkflowActions() {
  renderWorkflows();
  renderChatWorkflow();
  renderControls();
}

async function stopWorkflowRun(record: WorkflowRun | undefined) {
  if (!record || workflowBusy) return;
  workflowBusy = true;
  workflowError = "";
  renderWorkflowActions();
  try {
    await api.stopWorkflow(record.id);
  } catch (error) {
    workflowError = workflowErrorText(error);
  } finally {
    workflowBusy = false;
    renderWorkflowActions();
  }
}

async function decideGate(decision: "approved" | "rejected", record: WorkflowRun | undefined) {
  if (!record || workflowBusy) return;
  const step = record.definition.steps[record.currentIndex];
  const key = step ? `${record.id}:${step.id}` : "";
  const feedbackValue = key ? gateFeedback.get(key)?.trim() ?? "" : "";
  if (decision === "rejected" && !feedbackValue) {
    workflowError = "Describe what should change before rejecting.";
    renderWorkflowActions();
    return;
  }
  workflowBusy = true;
  workflowError = "";
  renderWorkflowActions();
  try {
    await api.decideWorkflow({ runId: record.id, decision, ...(feedbackValue ? { feedback: feedbackValue } : {}) });
    if (key) gateFeedback.delete(key);
  } catch (error) {
    workflowError = workflowErrorText(error);
  } finally {
    workflowBusy = false;
    renderWorkflowActions();
  }
}

async function handleWorkflowFreebuff(stepId: string, submit: boolean, record: WorkflowRun | undefined) {
  if (!record || workflowBusy) return;
  const request = { runId: record.id, stepId };
  const key = `${record.id}:${stepId}`;
  workflowBusy = true;
  workflowError = "";
  workflowNote = "";
  renderWorkflowActions();
  try {
    if (submit) {
      await api.submitWorkflowFreebuff({ ...request, reply: freebuffReplies.get(key) ?? "" });
      freebuffReplies.delete(key);
    } else {
      await api.copyWorkflowFreebuff(request);
      workflowNote = "Prompt copied. Paste it into Freebuff and send it.";
    }
  } catch (error) {
    workflowError = workflowErrorText(error);
  } finally {
    workflowBusy = false;
    renderWorkflowActions();
  }
}

function scheduleWorkflowRunRender(run: Run) {
  if (!run.workflowRunId || workflowView.kind !== "run" || workflowRunRender) return;
  const record = currentWorkflowRun();
  if (!record || record.id !== run.workflowRunId) return;
  workflowRunRender = setTimeout(() => {
    workflowRunRender = undefined;
    if (workflowView.kind === "run") renderWorkflowPanel();
  }, 150);
}

function workflowWorktreeRun(record: WorkflowRun): Pick<Run, "worktree" | "diff"> | undefined {
  if (record.smart && record.worktree) return record;
  for (let index = record.steps.length - 1; index >= 0; index--) {
    const id = record.steps[index]?.runId;
    const run = id ? runs.get(id) : undefined;
    if (run?.worktree) return run;
  }
  return undefined;
}

function worktreeFallback(worktree: RunWorktree) {
  const section = element("section", "diff-review");
  const head = element("div", "diff-head");
  head.append(element("h3", "", "Changes in worktree"), element("span", "diff-state", worktreeLabels[worktree.state]));
  section.append(
    head,
    element("p", "diff-meta", `${worktree.branch} · from ${commitLabel(worktree.baseCommit)}`),
    element("p", "diff-path", worktree.path),
    element("p", "diff-empty", "The diff appears after the next editing step finishes."),
  );
  return section;
}

function gateControls(record: WorkflowRun, gate: WorkflowGateStep) {
  const key = `${record.id}:${gate.id}`;
  const section = element("div", "gate-controls");
  section.append(element("h3", "", "Review decision"));
  const target = record.definition.steps.find((entry) => entry.id === gate.feedbackStepId);
  if (target) {
    section.append(element("p", "workflow-field-hint", `Rejecting sends your feedback to “${target.title}” and re-runs it.`));
  }
  const area = element("textarea", "workflow-input");
  area.rows = 3;
  area.maxLength = MAX_GATE_FEEDBACK;
  area.placeholder = "What should change before this gate passes?";
  area.value = gateFeedback.get(key) ?? "";
  area.dataset.field = "gate-feedback";
  area.dataset.gateStep = gate.id;
  const actions = element("div", "workflow-actions");
  const approve = element("button", "button button-primary", "Approve and continue");
  approve.type = "button";
  approve.dataset.action = "approve-gate";
  approve.disabled = workflowBusy;
  const reject = element("button", "button", "Send feedback back");
  reject.type = "button";
  reject.dataset.action = "reject-gate";
  reject.disabled = workflowBusy || !area.value.trim();
  area.addEventListener("input", () => {
    gateFeedback.set(key, area.value);
    reject.disabled = workflowBusy || !area.value.trim();
  });
  actions.append(approve, reject);
  section.append(area, actions);
  return section;
}

function isWaitingForFreebuff(record: WorkflowRun) {
  if (record.smart) return record.status === "waiting" && record.smart.pending?.kind === "freebuff";
  const step = record.definition.steps[record.currentIndex];
  return record.status === "waiting" && step?.kind === "agent" && step.providerId === "freebuff";
}

function freebuffHandoffControls(record: WorkflowRun, stepId: string) {
  const key = `${record.id}:${stepId}`;
  const section = element("div", "gate-controls");
  const notice = element("p", "workflow-note", "Paste and send the copied prompt in Freebuff. Paste its completed reply here to continue.");
  notice.setAttribute("role", "status");
  const area = element("textarea", "workflow-input");
  area.rows = 4;
  area.maxLength = MAX_FREEBUFF_REPLY;
  area.value = freebuffReplies.get(key) ?? "";
  const actions = element("div", "workflow-actions");
  const copy = element("button", "button", "Copy Freebuff prompt");
  copy.type = "button";
  copy.dataset.action = "copy-freebuff-prompt";
  copy.dataset.step = stepId;
  copy.disabled = workflowBusy;
  const submit = element("button", "button button-primary", "Submit reply and continue");
  submit.type = "button";
  submit.dataset.action = "submit-freebuff-reply";
  submit.dataset.step = stepId;
  submit.disabled = workflowBusy || !area.value.trim();
  area.addEventListener("input", () => {
    freebuffReplies.set(key, area.value);
    submit.disabled = workflowBusy || !area.value.trim();
  });
  actions.append(copy, submit);
  section.append(notice, workflowField("Freebuff reply", area), actions);
  return section;
}

function workflowRunView(record: WorkflowRun) {
  const header = element("div", "library-header");
  const title = element("h1", "", record.workflowName);
  title.tabIndex = -1;
  const status = element("p", "workflow-run-status");
  status.append(
    workflowBadge(record.status, isWaitingForFreebuff(record) ? "Waiting for Freebuff" : workflowStatusLabels[record.status]),
    element("span", "workflow-step-meta", `${record.folder?.name ?? "Chat"} · started ${new Date(record.startedAt).toLocaleTimeString()}`),
  );
  header.append(title, status);
  if (record.smart?.orchestrator) {
    header.append(element("p", "workflow-step-meta", `Orchestrator: ${orchestratorLabel(record.smart.orchestrator)}`));
  }
  const totalUsage = usageRows(record.usage);
  if (totalUsage.length) header.append(facts(totalUsage));

  const actions = element("div", "workflow-actions");
  const back = element("button", "button", "Workflow");
  back.type = "button";
  back.dataset.action = "show-definition";
  if (!record.smart) actions.append(back);
  const inProgress = record.status === "running" || record.status === "waiting" || record.status === "stopping";
  if (inProgress) {
    const stop = element("button", "button", record.status === "stopping" ? "Stopping…" : "Stop workflow");
    stop.type = "button";
    stop.dataset.action = "stop-workflow";
    stop.disabled = workflowBusy || record.status === "stopping";
    actions.append(stop);
  }

  const timeline = element("ol", "workflow-timeline");
  for (const [index, step] of record.definition.steps.entries()) {
    const stepRun = record.steps.find((entry) => entry.stepId === step.id);
    const item = element("li", "workflow-timeline-step");
    if (record.status !== "completed" && index === record.currentIndex) item.dataset.current = "true";
    const head = element("div", "workflow-timeline-head");
    head.append(
      workflowBadge(stepRun?.status ?? "pending", stepRun?.status === "waiting" && isWaitingForFreebuff(record)
        ? "Waiting for Freebuff" : workflowStepLabels[stepRun?.status ?? "pending"]),
      element("h2", "", step.title),
      element("span", "workflow-step-index", `${index + 1}`),
    );
    item.append(head);

    const meta = step.kind === "agent"
      ? `${workflowAgentLabel(step)}${step.effort ? ` · ${effortLabel(step.effort)}` : ""} · ${step.edit ? "Edit in worktree" : step.mode === "chat" ? "Chat" : "Read-only"}`
      : `${step.judgeStepId ? "Automatic review" : "Human review"} · up to ${step.maxRevisions} ${step.maxRevisions === 1 ? "revision" : "revisions"}`;
    item.append(element("p", "workflow-step-meta", meta));
    const reason = record.smart?.selection[step.id]?.reason;
    if (reason) item.append(element("p", "workflow-note", reason));
    const stepUsage = usageRows(stepRun?.usage);
    if (stepUsage.length) item.append(facts(stepUsage));
    if (stepRun?.detail) item.append(element("p", "workflow-note", stepRun.detail));
    if (stepRun?.freebuffReply) item.append(agentReply("Freebuff", stepRun.freebuffReply));

    const run = stepRun?.runId ? runs.get(stepRun.runId) : undefined;
    if (run) {
      const last = run.events.map((event) => (event.type === "message" ? event.text : "")).filter(Boolean).at(-1);
      if (last) item.append(agentReply(run.providerName, last));
      item.append(runActivity(run));
    }
    if (record.status === "waiting" && stepRun?.status === "waiting" && step.kind === "gate") {
      item.append(gateControls(record, step));
    }
    if (!record.smart && isWaitingForFreebuff(record) && stepRun?.status === "waiting") {
      item.append(freebuffHandoffControls(record, step.id));
    }
    timeline.append(item);
  }

  const diffRun = workflowWorktreeRun(record);
  const changes = diffRun ? runChanges(diffRun, true) : undefined;
  const worktree = changes ?? (record.worktree ? worktreeFallback(record.worktree) : undefined);
  const smartControls = smartUi.controls(record, renderWorkflowActions, Boolean(activeRun()) || workflowsBusy());

  return [
    header,
    ...(record.goal ? [feedEntry("Workflow prompt", record.goal, "user")] : []),
    ...orchestratorNotices(record),
    ...workflowMessages(),
    ...(record.error && !workflowError ? [element("p", "workflow-note", record.error)] : []),
    actions,
    timeline,
    ...(smartControls ? [smartControls] : []),
    ...(record.smart?.reply ? [agentReply(record.smart.replyFrom ? providerNames[record.smart.replyFrom] : "Smart", record.smart.reply)] : []),
    ...(worktree ? [worktree] : []),
  ];
}

for (const button of viewButtons) {
  button.addEventListener("click", () => {
    if (button.dataset.view) showView(button.dataset.view);
  });
}
get("factory-reset", HTMLButtonElement).addEventListener("click", async (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  const status = get("factory-reset-status");
  button.disabled = true;
  status.textContent = "";
  status.dataset.error = "false";
  try {
    if (await api.factoryReset()) {
      status.textContent = "Restarting Honeycomb…";
      return;
    }
  } catch (error) {
    status.textContent = actionMessage(error, "Could not reset Honeycomb.");
    status.dataset.error = "true";
  }
  button.disabled = false;
});
for (const button of modeButtons) {
  button.addEventListener("click", () => {
    const next = button.dataset.mode;
    if (next === "code" || next === "chat") void switchMode(next);
  });
}
get("add-connector").addEventListener("click", () => {
  catalogOpen = true;
  get("connector-catalog").hidden = false;
  get("connector-settings").hidden = true;
  get("chat-connector-settings").hidden = true;
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
for (const picker of [connectorModelField, chatModelField, chatConnectionModelField]) {
  picker.addEventListener("change", () => { void saveModel(picker); });
}
connectionForm.addEventListener("submit", saveChatConnection);
get("refresh-chat-connection-models").addEventListener("click", () => {
  profileMessage = "";
  void refreshModels(selectedConnectorId);
});
get("test-chat-connection").addEventListener("click", () => {
  const profile = profiles.find((entry) => entry.id === selectedConnectorId);
  const model = chatConnectionModelField.value;
  if (profile && model) void profileAction(() => api.testChatProfile({ id: profile.id, model }), "Testing the selected model…", "The model returned a reply.");
});
get("use-chat-connection").addEventListener("click", () => { void useInChat(selectedConnectorId); });
get("use-copilot").addEventListener("click", () => { void useInChat(selectedConnectorId); });
get("sign-in-copilot-web").addEventListener("click", async () => {
  if (copilotWebSignInPending) return;
  copilotWebSignInPending = true;
  copilotWebSignInMessage = "Finish signing in in the Copilot window.";
  renderConnectors();
  renderControls();
  try {
    await api.signInCopilotWeb();
    copilotWebSignInMessage = "Copilot Web is signed in.";
  } catch (error) {
    copilotWebSignInMessage = actionMessage(error, "Could not sign in to Copilot Web.");
  } finally {
    copilotWebSignInPending = false;
    renderConnectors();
    renderControls();
  }
});
get("remove-chat-connection").addEventListener("click", () => {
  const profile = profiles.find((entry) => entry.id === selectedConnectorId);
  if (!profile || !window.confirm(`Remove ${profile.name}? Chat history will still be available.`)) return;
  void profileAction(async () => {
    await api.removeChatProfile(profile.id);
    profileRevision++;
    profiles = profiles.filter((entry) => entry.id !== profile.id);
    connectors = connectors.filter((entry) => entry.id !== profile.id);
    await modelRequests[profile.id];
    delete modelCatalogs[profile.id];
    selectConnector("codex");
    renderChatProviders();
  }, "Removing connection…", "");
});
get("new-workflow").addEventListener("click", () => {
  workflowView = { kind: "edit", draft: blankWorkflow(), existing: false };
  workflowError = "";
  workflowNote = "";
  workflowConfirmDelete = false;
  renderWorkflows();
  get("workflow-panel").querySelector<HTMLInputElement>('input[data-field="workflow-name"]')?.focus();
});
get("plan-workflow").addEventListener("click", () => openWorkflowPlanner());
plannerProvider.addEventListener("change", () => {
  plannerModel.value = "";
  renderPlannerModels();
});
plannerGoal.addEventListener("input", renderPlannerControls);
get("workflow-plan-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void submitWorkflowPlan();
});
get("workflow-plan-edit").addEventListener("click", () => {
  if (!plannerDraft || plannerBusy) return;
  workflowView = { kind: "edit", draft: cloneWorkflow(plannerDraft), existing: Boolean(workflowById(plannerDraft.id)) };
  workflowError = "";
  workflowNote = "";
  workflowConfirmDelete = false;
  renderWorkflows();
  document.querySelector<HTMLInputElement>('#workflow-panel [data-field="workflow-name"]')?.focus();
});
get("workflow-plan-new").addEventListener("click", () => {
  if (plannerBusy) return;
  plannerDraft = undefined;
  plannerTurns.length = 0;
  plannerGoal.value = "";
  renderPlannerMessages();
  renderPlannerControls();
  plannerGoal.focus();
});
get("workflow-plan-stop").addEventListener("click", () => {
  const run = activeRun();
  if (run?.workflowPlanner && !run.workflowRunId) void api.stopRun(run.id).catch((error) => {
    get("workflow-plan-status").textContent = actionMessage(error, "Could not stop the planner.");
  });
});
get("refresh-workflows").addEventListener("click", () => void refreshWorkflows());
function handleWorkflowPanelClick(event: MouseEvent) {
  const target = event.target instanceof Element ? event.target : null;
  const worktreeButton = target?.closest<HTMLButtonElement>("button[data-worktree]");
  if (worktreeButton) {
    const id = worktreeButton.dataset.worktreeId;
    const kind = worktreeButton.dataset.worktree;
    if (id && (kind === "keep" || kind === "discard")) void worktreeAction(kind, id);
    return;
  }
  void onWorkflowClick(event);
}
get("workflow-panel").addEventListener("click", handleWorkflowPanelClick);
get("chat-workflow-feed").addEventListener("click", handleWorkflowPanelClick);
get("workflow-panel").addEventListener("input", onWorkflowInput);
get("workflow-panel").addEventListener("change", onWorkflowInput);
api.onWorkflowChanged((change) => {
  if (change.type === "open") {
    void loadWorkflowRuns().then(() => {
      showView("chats");
      openChatWorkflow(change.runId);
    });
    return;
  }
  if (change.type === "definitions") {
    void loadWorkflows().then(() => {
      if (workflowView.kind === "edit") renderWorkflowSidebar();
      else renderWorkflows();
    });
    return;
  }
  if (!rememberWorkflowRun(change.run)) return;
  if (!get("settings").hidden) smartUi.renderUsage();
  if (workflowView.kind === "run" && workflowView.runId === change.run.id) renderWorkflowPanel();
  if (change.run.goal) {
    renderChatWorkflow();
    renderControls();
  }
  renderWorkflowSidebar();
});
get("select-solo").addEventListener("click", () => {
  workflowView = { kind: "solo" };
  renderWorkflows();
  get("solo-title").focus();
});
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
  const workflow = selectedChatWorkflow();
  if (workflow) {
    await stopWorkflowRun(workflow);
    return;
  }
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
  if (mode === "code") {
    newProjectPath = undefined;
    editAccess.delete("new:code");
    freebuffAttachments.delete("new:code");
  }
  selectChat(undefined);
  (mode === "code" ? projectPicker : promptField).focus();
});

get("choose-folder").addEventListener("click", () => void selectWorkspaceProject(() => api.chooseFolder(), { register: true }));

projectPicker.addEventListener("change", async () => {
  if (projectPicker.selectedOptions[0]?.dataset.browse) {
    if (await selectWorkspaceProject(() => api.chooseFolder(), { register: true, startNew: true })) promptField.focus();
    else projectPicker.focus();
    return;
  }
  const path = projectPicker.value;
  if (path && await selectWorkspaceProject(() => api.selectProject(path), { startNew: true })) promptField.focus();
});

for (const example of document.querySelectorAll<HTMLButtonElement>("[data-prompt]")) {
  example.addEventListener("click", () => {
    promptField.value = example.dataset.prompt ?? "";
    actionError = "";
    renderControls();
    promptField.focus();
  });
}
promptField.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing || event.altKey || event.metaKey) return;

  if (event.ctrlKey) {
    event.preventDefault();
    const { selectionStart, selectionEnd, value, maxLength } = promptField;
    if (maxLength >= 0 && value.length - (selectionEnd - selectionStart) >= maxLength) return;
    promptField.setRangeText("\n", selectionStart, selectionEnd, "end");
    promptField.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  if (event.shiftKey) return;

  event.preventDefault();
  if (!event.repeat && !runButton.disabled) promptField.form?.requestSubmit(runButton);
});

promptField.addEventListener("input", () => {
  actionError = "";
  get("smart-preview-result").hidden = true;
  renderControls();
});

get("smart-mode").addEventListener("click", () => {
  smartSelected = !smartSelected;
  actionError = "";
  get("smart-preview-result").hidden = true;
  renderChatProviders();
  renderComposerProvider();
  promptField.focus();
});
get("smart-preview").addEventListener("click", () => void runSmartFromChat(true));
providerField.addEventListener("change", () => {
  actionError = "";
  get("smart-preview-result").hidden = true;
  if (providerField.value === "freebuff" && draftKey && !pendingFreebuff()) {
    const worktree = latestActiveFreebuff();
    if (worktree) freebuffAttachments.set(draftKey, { worktreeId: worktree.id, source: "saved" });
  }
  if (!smartSelected && draftKey && !supportsWorktreeEditing(chatProviderId())) editAccess.delete(draftKey);
  renderChats();
  renderComposerProvider();
});
get("remove-freebuff-context").addEventListener("click", () => {
  if (draftKey) freebuffAttachments.delete(draftKey);
  actionError = "";
  renderControls();
  promptField.focus();
});
accessPicker.addEventListener("change", () => {
  if (!draftKey) return;
  if (accessPicker.value === "edit" && !editAccessOption.disabled) editAccess.add(draftKey);
  else editAccess.delete(draftKey);
  actionError = "";
  renderControls();
});
thinkingField.addEventListener("change", () => {
  get("smart-preview-result").hidden = true;
  const provider = chatProviderId();
  const space = mode === "chat" && provider === "codex" ? "chat-codex" : provider;
  selectedEfforts.set(space + ":" + chatModelField.value, thinkingField.value);
  renderComposerProvider();
});

async function startTask() {
  const connector = connectors.find((entry) => entry.id === providerField.value);
  if (!connector || starting || runButton.disabled) return;
  const edit = mode === "code" && supportsWorktreeEditing(connector.id) && accessPicker.value === "edit";
  const draft = promptField.value;
  const key = draftKey;
  const freebuff = pendingFreebuff();
  const chatId = selectedChatId;
  starting = true;
  actionError = "";
  renderControls();
  try {
    const runId = await api.startRun({
      providerId: connector.id, conversationId: chatId, prompt: draft, effort: thinkingField.value, model: chatModelField.value,
      ...(edit ? { edit: true } : {}),
      ...(freebuff ? { freebuff } : {}),
    });
    if (freebuff && key) freebuffAttachments.delete(key);
    if (promptField.value === draft) promptField.value = "";
    if (!chatId && edit) {
      editAccess.delete("new:code");
      editAccess.add(`chat:${runId}`);
    }
    selectedChatId = chatId ?? runId;
    if (mode === "code") newProjectPath = undefined;
  } catch (error) {
    showError(error);
  } finally {
    starting = false;
    renderChats();
  }
}

get("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  if (runButton.disabled) return;
  const invocation = workflowCommand(promptField.value);
  if (invocation !== undefined) {
    void runWorkflowFromChat(invocation);
    return;
  }
  if (smartSelected) {
    void runSmartFromChat(false);
    return;
  }
  if (providerField.value === "freebuff") {
    const existing = latestActiveFreebuff();
    void freebuffAction("send", existing?.id);
  }
  else void startTask();
});

async function runSmartFromChat(preview: boolean) {
  if (starting || runButton.disabled) return;
  const connector = providerField.value;
  if (!isCliProvider(connector)) return;
  const draft = promptField.value;
  const request: SmartRunRequest = {
    goal: draft,
    projectPath: mode === "code" ? (chatTurns()[0]?.folder?.path ?? newProjectPath) : undefined,
    conversationId: selectedChatId,
    access: mode === "chat" ? "chat" : accessPicker.value === "edit" ? "edit" : "review",
    orchestrator: { connector, model: chatModelField.value, effort: thinkingField.value },
  };
  starting = true;
  actionError = "";
  const result = get("smart-preview-result");
  result.hidden = true;
  renderControls();
  try {
    if (preview) {
      const plan = await api.previewSmart(request);
      if (promptField.value !== draft) return;
      const choice = plan.choice;
      const worker = choice
        ? `${providerNames[choice.connector]} · ${choice.model || "CLI default"}${choice.effort ? ` · ${effortLabel(choice.effort)}` : ""}. ${choice.reason}`
        : plan.reply ?? "Smart did not select a first step.";
      result.textContent = plan.orchestrator
        ? `Orchestrator: ${orchestratorLabel(plan.orchestrator)}${plan.orchestrator.connector !== request.orchestrator.connector
          ? " (quota fallback)" : ""}. ${worker}` : worker;
      result.hidden = false;
    } else {
      const id = await api.startSmart(request);
      if (promptField.value === draft) promptField.value = "";
      if (!workflowRuns.has(id)) await loadWorkflowRuns();
      openChatWorkflow(id);
    }
  } catch (error) {
    showError(error);
  } finally {
    starting = false;
    renderControls();
  }
}

async function runWorkflowFromChat(invocation: string) {
  if (starting || workflowBusy) return;
  const draft = promptField.value;
  starting = true;
  actionError = "";
  renderControls();
  try {
    const projectPath = mode === "code" ? (selectedChatId ? chatTurns()[0]?.folder?.path : newProjectPath) : undefined;
    const runId = await api.runWorkflowCommand({ argument: invocation, projectPath });
    if (promptField.value === draft) promptField.value = "";
    if (!workflowRuns.has(runId)) await loadWorkflowRuns();
    openChatWorkflow(runId);
  } catch (error) {
    showError(error);
  } finally {
    starting = false;
    renderControls();
  }
}

function refreshLatestFreebuff() {
  if (worktreeBusy || mode !== "code" || !folder) return;
  const latest = freebuffChatWorktree() ?? projectFreebuffWorktrees()[0];
  if (!latest) return;
  void reviewFreebuffWorktree(latest.id).then(() => {
    renderChats();
  });
}
window.addEventListener("focus", refreshLatestFreebuff);

api.onRunChanged((run) => {
  const previous = runs.get(run.id);
  if (!remember(run)) return;
  const inspected = currentWorkflowRun();
  if (previous?.status !== run.status && inspected?.status === "waiting" && inspected.smart && !inspected.smart.pending) renderWorkflowPanel();
  if (!get("settings").hidden && (!previous || previous.status !== run.status || run.events.at(-1)?.type === "usage")) smartUi.renderUsage();
  if (workflowView.kind === "plan") renderPlannerControls();
  scheduleWorkflowRunRender(run);
  if (run.workflowRunId) {
    const workflow = selectedChatWorkflow();
    if (workflow?.id === run.workflowRunId && workflow.status === "completed") renderChatWorkflow();
    if (previous?.status !== run.status) {
      renderControls();
      if (workflow?.smart && workflow.status === "waiting" && !workflow.smart.pending) renderChatWorkflow();
    }
    return;
  }
  if (previous?.status === run.status) {
    if (!selectedChatWorkflowId && selectedChatId === conversationId(run)) {
      renderThread(chatTurns());
      renderDetails(run);
    }
    return;
  }
  renderChats();
});

renderChats();
void refreshConnectors();
api.getState().then((state) => {
  freebuffWorktrees = state.worktrees ?? [];
  folder = state.folder;
  projects = state.projects;
  mode = state.mode === "chat" ? "chat" : "code";
  refreshLatestFreebuff();
  for (const run of state.runs) remember(run);
  if (!get("settings").hidden) smartUi.renderUsage();
  selectedChatId ??= recentChatId();
  renderWorkspaceMode();
  void loadWorkflows();
  void loadWorkflowRuns();
}).catch(showError);
