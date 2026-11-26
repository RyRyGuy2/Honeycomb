import electron = require("electron");
import type { IpcRendererEvent } from "electron";
import type { HoneycombApi, IpcCalls, Run } from "../shared/contracts.js" with { "resolution-mode": "import" };

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
  onRunChanged(callback) {
    const listener = (_event: IpcRendererEvent, run: Run) => callback(run);
    ipcRenderer.on("honeycomb:run-changed", listener);
    return () => ipcRenderer.removeListener("honeycomb:run-changed", listener);
  },
};

contextBridge.exposeInMainWorld("honeycomb", api);
