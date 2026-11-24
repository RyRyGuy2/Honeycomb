const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("honeycomb", {
  getState: () => ipcRenderer.invoke("honeycomb:state"),
  inspectProviders: () => ipcRenderer.invoke("honeycomb:inspect-providers"),
  chooseFolder: () => ipcRenderer.invoke("honeycomb:choose-folder"),
  startRun: (request) => ipcRenderer.invoke("honeycomb:start-run", request),
  stopRun: (runId) => ipcRenderer.invoke("honeycomb:stop-run", runId),
  onRunChanged(callback) {
    const listener = (_event, run) => callback(run);
    ipcRenderer.on("honeycomb:run-changed", listener);
    return () => ipcRenderer.removeListener("honeycomb:run-changed", listener);
  },
});
