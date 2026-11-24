import { app, BrowserWindow, dialog, ipcMain, protocol, session } from "electron";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectProviders } from "../providers/index.js";
import { createRunService } from "../service/runs.js";

const APP_URL = "honeycomb://app/";
const RENDERER_ASSETS = new Map([
  ["/", ["index.html", "text/html"]],
  ["/styles.css", ["styles.css", "text/css"]],
  ["/app.js", ["app.js", "text/javascript"]],
]);
const CONTENT_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

let window;
let folder;
let quitting = false;
const runs = createRunService((run) => {
  if (window && !window.isDestroyed()) window.webContents.send("honeycomb:run-changed", run);
});

protocol.registerSchemesAsPrivileged([
  { scheme: "honeycomb", privileges: { standard: true, secure: true } },
]);

function serveRenderer() {
  protocol.handle("honeycomb", async (request) => {
    const url = new URL(request.url);
    const asset = RENDERER_ASSETS.get(url.pathname);
    if (url.host !== "app" || request.method !== "GET" || !asset) {
      return new Response(null, { status: 404 });
    }

    const [filename, contentType] = asset;
    const body = await readFile(new URL(`../renderer/${filename}`, import.meta.url));
    return new Response(body, {
      headers: {
        "Content-Type": `${contentType}; charset=utf-8`,
        "Content-Security-Policy": CONTENT_POLICY,
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}

function handle(channel, callback) {
  ipcMain.handle(`honeycomb:${channel}`, (event, request) => {
    if (
      !window || window.isDestroyed() || event.sender !== window.webContents ||
      event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== APP_URL
    ) {
      throw new Error("This action is available in the Honeycomb window.");
    }
    return callback(request);
  });
}

function registerHandlers() {
  handle("state", () => ({ folder, runs: runs.history() }));
  handle("inspect-providers", inspectProviders);
  handle("choose-folder", async () => {
    const selection = await dialog.showOpenDialog(window, {
      title: "Choose a project folder",
      properties: ["openDirectory"],
      defaultPath: folder?.path,
    });
    if (!selection.canceled && selection.filePaths[0]) {
      const path = selection.filePaths[0];
      folder = { name: basename(path) || path, path };
    }
    return folder;
  });
  handle("start-run", (request) => runs.start(folder, request));
  handle("stop-run", (runId) => {
    if (typeof runId !== "string") throw new Error("Invalid run.");
    runs.stop(runId);
  });
}

function createWindow() {
  window = new BrowserWindow({
    title: "Honeycomb",
    width: 1240,
    height: 820,
    minWidth: 770,
    minHeight: 600,
    backgroundColor: "#f7f7f2",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-frame-navigate", (event) => event.preventDefault());
  window.once("ready-to-show", () => window.show());
  window.once("closed", () => { window = undefined; });
  void window.loadURL(APP_URL);
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  serveRenderer();
  registerHandlers();
  createWindow();
  app.on("activate", () => {
    if (!window) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (quitting) {
    if (runs.hasActiveRun()) event.preventDefault();
    return;
  }
  if (!runs.hasActiveRun()) return;

  event.preventDefault();
  quitting = true;
  void runs.shutdown().then(() => app.quit());
});
