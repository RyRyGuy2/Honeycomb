import { app, BrowserWindow, dialog, ipcMain, protocol, session } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listCodexModels } from "../providers/codex-models.js";
import { parseCodexModel } from "../providers/codex.js";
import { inspectProviders, providerEnvironment } from "../providers/index.js";
import { installOpenCodeRelease, managedOpenCodePath, openCodeRelease } from "../providers/opencode-install.js";
import { listOpenCodeModels, testOpenCode } from "../providers/opencode-models.js";
import { opencode, parseOpenCodeModel } from "../providers/opencode.js";
import { runProcess } from "../service/process.js";
import { createRunService } from "../service/runs.js";
import type { IpcCalls, ProjectFolder, ProviderId } from "../shared/contracts.js";
import { asRecord } from "../shared/records.js";

const APP_URL = "honeycomb://app/";
const RENDERER_ASSETS = new Map<string, readonly [filename: string, contentType: string]>([
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

let mainWindow: BrowserWindow | undefined;
let folder: ProjectFolder | undefined;
let quitting = false;
const selectedModels: Record<ProviderId, string> = { codex: "", opencode: "" };
const modelParsers = { codex: parseCodexModel, opencode: parseOpenCodeModel };
let downloading: Promise<void> | undefined;
const connectorAbort = new AbortController();
const connectorJobs = new Set<Promise<unknown>>();
const getOpenCodePath = () => managedOpenCodePath(app.getPath("userData"));
const modelFile = (providerId: ProviderId) => join(app.getPath("userData"), `${providerId}-model`);
const runs = createRunService((run) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("honeycomb:run-changed", run);
}, (providerId) => ({
  executable: providerId === "opencode" ? getOpenCodePath() : undefined,
  model: selectedModels[providerId],
}));

function requireProviderId(value: unknown): ProviderId {
  if (value === "codex" || value === "opencode") return value;
  throw new Error("Choose Codex or OpenCode.");
}

function trackConnectorJob<T>(job: Promise<T>) {
  connectorJobs.add(job);
  const remove = () => connectorJobs.delete(job);
  void job.then(remove, remove);
  return job;
}

function installOpenCode() {
  const release = openCodeRelease();
  if (!release) throw new Error("OpenCode downloads are available inside Honeycomb on Windows and macOS.");
  downloading ??= installOpenCodeRelease(app.getPath("userData"), release, async (file, version) => {
    const result = await runProcess({
      file, args: ["--version"], env: { ...providerEnvironment(), ...opencode.probeEnvironment },
      timeoutMs: 12_000, signal: connectorAbort.signal,
    });
    if (result.code !== 0 || opencode.parseVersion(result.output) !== version) {
      throw new Error("The downloaded OpenCode CLI did not report the expected version.");
    }
  }, fetch, connectorAbort.signal).finally(() => {
    downloading = undefined;
  });
  return trackConnectorJob(downloading);
}

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

function handle<Channel extends keyof IpcCalls>(
  channel: Channel,
  callback: (request: unknown, window: BrowserWindow) => ReturnType<IpcCalls[Channel]> | Promise<ReturnType<IpcCalls[Channel]>>,
) {
  ipcMain.handle(`honeycomb:${channel}`, (event, request: unknown) => {
    const window = mainWindow;
    if (
      !window || window.isDestroyed() || event.sender !== window.webContents ||
      event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== APP_URL
    ) {
      throw new Error("This action is available in the Honeycomb window.");
    }
    return callback(request, window);
  });
}

function registerHandlers() {
  handle("state", () => ({ folder, runs: runs.history() }));
  handle("inspect-providers", async () => {
    const connectors = await inspectProviders(getOpenCodePath());
    return connectors.map((connector) => connector.id === "opencode"
      ? { ...connector, downloadAvailable: Boolean(openCodeRelease()) }
      : connector);
  });
  handle("install-opencode", installOpenCode);
  handle("list-models", (value) => {
    const providerId = requireProviderId(value);
    const signal = connectorAbort.signal;
    return trackConnectorJob(providerId === "codex"
      ? listCodexModels(selectedModels.codex, signal)
      : listOpenCodeModels(getOpenCodePath(), selectedModels.opencode, signal));
  });
  handle("set-model", (value) => {
    const payload = asRecord(value);
    const providerId = requireProviderId(payload?.providerId);
    const model = modelParsers[providerId](payload?.model);
    return trackConnectorJob((async () => {
      await mkdir(app.getPath("userData"), { recursive: true });
      await writeFile(modelFile(providerId), model, "utf8");
      selectedModels[providerId] = model;
    })());
  });
  handle("test-opencode", () =>
    trackConnectorJob(testOpenCode(getOpenCodePath(), selectedModels.opencode, connectorAbort.signal)));
  handle("choose-folder", async (_request, window) => {
    const selection = await dialog.showOpenDialog(window, {
      title: "Choose a project folder",
      properties: ["openDirectory"],
      defaultPath: folder?.path,
    });
    const [path] = selection.filePaths;
    if (!selection.canceled && path) {
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
  const window = new BrowserWindow({
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
  mainWindow = window;
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-frame-navigate", (event) => event.preventDefault());
  window.once("ready-to-show", () => window.show());
  window.once("closed", () => { mainWindow = undefined; });
  void window.loadURL(APP_URL);
}

app.whenReady().then(async () => {
  await Promise.all((["codex", "opencode"] as const).map(async (providerId) => {
    try {
      selectedModels[providerId] = modelParsers[providerId](await readFile(modelFile(providerId), "utf8"));
    } catch {
      // The default applies when there is no saved selection.
    }
  }));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  serveRenderer();
  registerHandlers();
  createWindow();
  app.on("activate", () => {
    if (!mainWindow) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (quitting) {
    if (runs.hasActiveRun() || connectorJobs.size) event.preventDefault();
    return;
  }
  if (!runs.hasActiveRun() && !connectorJobs.size) return;

  event.preventDefault();
  quitting = true;
  connectorAbort.abort();
  void Promise.allSettled([runs.shutdown(), ...connectorJobs]).then(() => app.quit());
});
