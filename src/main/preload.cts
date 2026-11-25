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
  getState: () => invoke("state"),
  inspectProviders: () => invoke("inspect-providers"),
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
  onRunChanged(callback) {
    const listener = (_event: IpcRendererEvent, run: Run) => callback(run);
    ipcRenderer.on("honeycomb:run-changed", listener);
    return () => ipcRenderer.removeListener("honeycomb:run-changed", listener);
  },
};

contextBridge.exposeInMainWorld("honeycomb", api);
