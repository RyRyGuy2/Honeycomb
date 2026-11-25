import { app, BrowserWindow, dialog, ipcMain, nativeTheme, protocol, session, shell } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claude, claudeModelCatalog, parseClaudeModel } from "../providers/claude.js";
import { listCodexChatModels } from "../providers/codex-chat.js";
import { listCodexModels } from "../providers/codex-models.js";
import { parseCodexModel } from "../providers/codex.js";
import { checkProvider, inspectProviders, providerEnvironment } from "../providers/index.js";
import { installOpenCodeRelease, managedOpenCodePath, openCodeRelease } from "../providers/opencode-install.js";
import { listOpenCodeEfforts, listOpenCodeModels, testOpenCode } from "../providers/opencode-models.js";
import { opencode, parseOpenCodeModel } from "../providers/opencode.js";
import { runProcess } from "../service/process.js";
import { createRunService } from "../service/runs.js";
import { createWorkspaceStore } from "../service/workspace.js";
import type { IpcCalls, ProjectFolder, ProviderId, WorkspaceMode } from "../shared/contracts.js";
import { asRecord } from "../shared/records.js";

const APP_URL = "honeycomb://app/";
const RENDERER_ASSETS = new Map<string, readonly [filename: string, contentType: string]>([
  ["/", ["index.html", "text/html"]],
  ["/styles.css", ["styles.css", "text/css"]],
  ["/app.js", ["app.js", "text/javascript"]],
  ["/markdown-it.js", ["markdown-it.js", "text/javascript"]],
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
let projects: ProjectFolder[] = [];
let mode: WorkspaceMode = "code";
let quitting = false;
const PROVIDER_IDS = ["codex", "opencode", "claude"] as const satisfies readonly ProviderId[];
const selectedModels: Record<ProviderId, string> = { codex: "", opencode: "", claude: "" };
const modelParsers = { codex: parseCodexModel, opencode: parseOpenCodeModel, claude: parseClaudeModel };
let downloading: Promise<void> | undefined;
const connectorAbort = new AbortController();
const connectorJobs = new Set<Promise<unknown>>();
const getOpenCodePath = () => managedOpenCodePath(app.getPath("userData"));
const modelFile = (providerId: ProviderId) => join(app.getPath("userData"), `${providerId}-model`);
const workspace = createWorkspaceStore(() => join(app.getPath("userData"), "workspace.json"));
const runs = createRunService((run) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("honeycomb:run-changed", run);
  if (run.revision === 1 || run.finishedAt) void workspace.save(workspaceState());
}, (providerId) => ({
  executable: providerId === "opencode" ? getOpenCodePath() : undefined,
  model: selectedModels[providerId],
}));

function workspaceState() {
  return { folder, projects, runs: runs.history(), mode };
}

function requireProviderId(value: unknown): ProviderId {
  const id = PROVIDER_IDS.find((providerId) => providerId === value);
  if (id) return id;
  throw new Error("Choose Codex, OpenCode or Claude Code.");
}

async function listClaudeModels(signal: AbortSignal) {
  const { connector, executable } = await checkProvider(claude, signal);
  const catalog = claudeModelCatalog(selectedModels.claude);
  return executable ? catalog : { ...catalog, localError: connector.detail || "Install Claude Code to use its models." };
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
  handle("state", workspaceState);
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
    if (providerId === "claude") return trackConnectorJob(listClaudeModels(signal));
    return trackConnectorJob(providerId === "codex"
      ? listCodexModels(selectedModels.codex, signal)
      : listOpenCodeModels(getOpenCodePath(), selectedModels.opencode, signal));
  });
  handle("list-opencode-efforts", (value) =>
    trackConnectorJob(listOpenCodeEfforts(getOpenCodePath(), parseOpenCodeModel(value), connectorAbort.signal)));
  handle("list-codex-chat-models", () => trackConnectorJob(listCodexChatModels(connectorAbort.signal)));
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
  handle("set-mode", async (value) => {
    if (value !== "code" && value !== "chat") throw new Error("Choose Code or Chat.");
    if (runs.hasActiveRun()) throw new Error("Finish or stop the response before changing modes.");
    mode = value;
    await workspace.save(workspaceState());
  });
  handle("choose-folder", async (_request, window) => {
    if (mode !== "code") throw new Error("Switch to Code to add a project.");
    const selection = await dialog.showOpenDialog(window, {
      title: "Choose a project folder",
      properties: ["openDirectory"],
      defaultPath: folder?.path,
    });
    const [path] = selection.filePaths;
    if (mode !== "code") return;
    if (!selection.canceled && path) {
      folder = projects.find((project) => project.path === path);
      if (!folder) {
        folder = { name: basename(path) || path, path };
        projects.push(folder);
      }
      await workspace.save(workspaceState());
    }
    return selection.canceled ? undefined : folder;
  });
  handle("select-project", async (path) => {
    if (mode !== "code") throw new Error("Switch to Code to open a project.");
    const project = projects.find((entry) => entry.path === path);
    if (!project) throw new Error("This project is no longer saved.");
    folder = project;
    await workspace.save(workspaceState());
    return project;
  });
  handle("start-run", (request) => runs.start(mode === "code" ? folder : undefined, { ...asRecord(request), mode }));
  handle("open-reply-link", (value) => {
    if (typeof value !== "string") throw new Error("Invalid link.");
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol)) throw new Error("Only web links can open from a reply.");
    return shell.openExternal(url.href);
  });
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
    backgroundColor: "#1e1e1e",
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
  nativeTheme.themeSource = "dark";
  const saved = await workspace.load();
  if (saved) {
    projects = saved.projects;
    folder = projects.find((project) => project.path === saved.folder?.path);
    runs.restore(saved.runs);
    if (saved.mode === "chat") mode = "chat";
  }
  await Promise.all(PROVIDER_IDS.map(async (providerId) => {
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
  event.preventDefault();
  quitting = true;
  connectorAbort.abort();
  void Promise.allSettled([runs.shutdown(), ...connectorJobs]).then(() => workspace.flush()).then(() => app.quit());
});
