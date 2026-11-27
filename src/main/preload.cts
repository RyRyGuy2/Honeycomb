import electron = require("electron");
import type { IpcRendererEvent } from "electron";
import type { FreebuffTerminalEvent, HoneycombApi, IpcCalls, Run, WorkflowChange } from "../shared/contracts.js" with { "resolution-mode": "import" };

const { contextBridge, ipcRenderer } = electron;

function invoke<Channel extends keyof IpcCalls>(
  channel: Channel,
  ...args: Parameters<IpcCalls[Channel]>
): Promise<ReturnType<IpcCalls[Channel]>> {
  return ipcRenderer.invoke(`honeycomb:${channel}`, ...args);
}

const api: HoneycombApi = {
  copyInstallCommand: (command) => invoke("copy-install-command", command),
  getState: () => invoke("state"),
  factoryReset: () => invoke("factory-reset"),
  inspectProviders: () => invoke("inspect-providers"),
  chatProfiles: () => invoke("chat-profiles"),
  saveChatProfile: (profile) => invoke("save-chat-profile", profile),
  removeChatProfile: (id) => invoke("remove-chat-profile", id),
  testChatProfile: (selection) => invoke("test-chat-profile", selection),
  copilotHandoff: (runId) => invoke("copilot-handoff", runId),
  copilotReply: (request) => invoke("copilot-reply", request),
  signInCopilotWeb: () => invoke("sign-in-copilot-web"),
  installOpenCode: () => invoke("install-opencode"),
  listModels: (providerId) => invoke("list-models", providerId),
  listOpenCodeEfforts: (model) => invoke("list-opencode-efforts", model),
  setModel: (selection) => invoke("set-model", selection),
  listOpenCodeModels: () => invoke("list-models", "opencode"),
  setOpenCodeModel: (model) => invoke("set-model", { providerId: "opencode", model }),
  testOpenCode: () => invoke("test-opencode"),
  chooseFolder: () => invoke("choose-folder"),
  setMode: (mode) => invoke("set-mode", mode),
  selectProject: (path) => invoke("select-project", path),
  startRun: (request) => invoke("start-run", request),
  openReplyLink: (url) => invoke("open-reply-link", url),
  stopRun: (runId) => invoke("stop-run", runId),
  keepWorktree: (worktreeId) => invoke("keep-worktree", worktreeId),
  openFreebuff: (request) => invoke("open-freebuff", request),
  reviewFreebuff: (id) => invoke("review-freebuff", id),
  copyFreebuffExport: () => invoke("copy-freebuff-export"),
  discardWorktree: (worktreeId) => invoke("discard-worktree", worktreeId),
  showSidebarMenu: (request) => invoke("sidebar-menu", request),
  listWorkflows: () => invoke("list-workflows"),
  planWorkflow: (request) => invoke("plan-workflow", request),
  saveWorkflow: (workflow) => invoke("save-workflow", workflow),
  deleteWorkflow: (id) => invoke("delete-workflow", id),
  listWorkflowRuns: () => invoke("list-workflow-runs"),
  startWorkflow: (id) => invoke("start-workflow", id),
  runWorkflowCommand: (request) => invoke("run-workflow-command", request),
  stopWorkflow: (runId) => invoke("stop-workflow", runId),
  decideWorkflow: (request) => invoke("workflow-decision", request),
  copyWorkflowFreebuff: (request) => invoke("copy-workflow-freebuff", request),
  submitWorkflowFreebuff: (request) => invoke("submit-workflow-freebuff", request),
  smartSettings: () => invoke("smart-settings"),
  saveSmartSettings: (request) => invoke("save-smart-settings", request),
  connectorQuotas: (refresh) => invoke("connector-quotas", refresh),
  previewSmart: (request) => invoke("preview-smart", request),
  startSmart: (request) => invoke("start-smart", request),
  answerSmart: (request) => invoke("answer-smart", request),
  resumeSmart: (id) => invoke("resume-smart", id),
  rerouteSmart: (id) => invoke("reroute-smart", id),
  openSmartFreebuff: (id) => invoke("open-smart-freebuff", id),
  copySmartFreebuff: (request) => invoke("copy-smart-freebuff", request),
  replySmartFreebuff: (request) => invoke("reply-smart-freebuff", request),
  freebuffTerminalInput: (request) => invoke("freebuff-terminal-input", request),
  closeFreebuffTerminal: (id) => invoke("close-freebuff-terminal", id),
  onFreebuffTerminal(callback) {
    const listener = (_event: IpcRendererEvent, event: FreebuffTerminalEvent) => callback(event);
    ipcRenderer.on("honeycomb:freebuff-terminal", listener);
    return () => ipcRenderer.removeListener("honeycomb:freebuff-terminal", listener);
  },
  onRunChanged(callback) {
    const listener = (_event: IpcRendererEvent, run: Run) => callback(run);
    ipcRenderer.on("honeycomb:run-changed", listener);
    return () => ipcRenderer.removeListener("honeycomb:run-changed", listener);
  },
  onWorkflowChanged(callback) {
    const listener = (_event: IpcRendererEvent, change: WorkflowChange) => callback(change);
    ipcRenderer.on("honeycomb:workflow-changed", listener);
    return () => ipcRenderer.removeListener("honeycomb:workflow-changed", listener);
  },
};

contextBridge.exposeInMainWorld("honeycomb", api);
