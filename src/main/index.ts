import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, protocol, safeStorage, session, shell } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claude, claudeModelCatalog, parseClaudeModel } from "../providers/claude.js";
import { listCodexModels } from "../providers/codex-models.js";
import { parseCodexModel } from "../providers/codex.js";
import { listHttpChatModels, streamHttpChat } from "../providers/http-chat.js";
import { checkProvider, inspectProviders, providerEnvironment } from "../providers/index.js";
import { installOpenCodeRelease, managedOpenCodePath, openCodeRelease } from "../providers/opencode-install.js";
import { listOpenCodeEfforts, listOpenCodeModels, testOpenCode } from "../providers/opencode-models.js";
import { opencode, parseOpenCodeModel } from "../providers/opencode.js";
import { COPILOT_ID, COPILOT_NAME, createWindowsCopilot } from "../providers/windows-copilot.js";
import { createChatProfileStore, parseChatModel } from "../service/chat-profiles.js";
import { runProcess } from "../service/process.js";
import { FREEBUFF_EXPORT_PATTERN, findFreebuffTerminal, findFreebuffTranscript, openFreebuffTerminal, readFreebuffTranscript, readSavedFreebuffExchange } from "../service/freebuff.js";
import { createRunService } from "../service/runs.js";
import { createWorkspaceStore } from "../service/workspace.js";
import { createWorktreeManager } from "../service/worktree.js";
import type { CliProviderId, FreebuffContext, IpcCalls, ProjectFolder, WorkspaceMode } from "../shared/contracts.js";
import { supportsWorktreeEditing } from "../shared/editing.js";
import { asRecord } from "../shared/records.js";

const APP_URL = "honeycomb://app/";
const APP_ICON = fileURLToPath(new URL("./honeycomb-icon.png", import.meta.url));
const RENDERER_ASSETS = new Map<string, readonly [filename: string, contentType: string]>([
  ["/", ["index.html", "text/html"]],
  ["/styles.css", ["styles.css", "text/css"]],
  ["/app.js", ["app.js", "text/javascript"]],
  ["/shared/conversations.js", ["../shared/conversations.js", "text/javascript"]],
  ["/shared/chat-presets.js", ["../shared/chat-presets.js", "text/javascript"]],
  ["/shared/editing.js", ["../shared/editing.js", "text/javascript"]],
  ["/markdown-it.js", ["markdown-it.js", "text/javascript"]],
  ["/honeycomb-logo.svg", ["honeycomb-logo.svg", "image/svg+xml"]],
]);
const CONTENT_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

let mainWindow: BrowserWindow | undefined;
let folder: ProjectFolder | undefined;
let projects: ProjectFolder[] = [];
let mode: WorkspaceMode = "code";
let quitting = false;
const PROVIDER_IDS = ["codex", "opencode", "claude"] as const satisfies readonly CliProviderId[];
const selectedModels: Record<CliProviderId, string> = { codex: "", opencode: "", claude: "" };
const modelParsers = { codex: parseCodexModel, opencode: parseOpenCodeModel, claude: parseClaudeModel };
let downloading: Promise<void> | undefined;
const connectorAbort = new AbortController();
const connectorJobs = new Set<Promise<unknown>>();
const getOpenCodePath = () => managedOpenCodePath(app.getPath("userData"));
const modelFile = (providerId: CliProviderId) => join(app.getPath("userData"), `${providerId}-model`);
const workspace = createWorkspaceStore(() => join(app.getPath("userData"), "workspace.json"));
const copilot = createWindowsCopilot((text) => clipboard.writeText(text));
const chatProfiles = createChatProfileStore(() => join(app.getPath("userData"), "chat-connections.json"), {
  encrypt(key) {
    if (!safeStorage.isEncryptionAvailable() || (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text")) {
      throw new Error("Enable your system credential store before saving an API key.");
    }
    return safeStorage.encryptString(key).toString("base64");
  },
  decrypt(key) {
    try {
      return safeStorage.decryptString(Buffer.from(key, "base64"));
    } catch {
      throw new Error("Could not unlock the saved API key. Enter it again in Connectors.");
    }
  },
});
const worktrees = createWorktreeManager(
  () => join(app.getPath("userData"), "worktrees"),
  () => { void workspace.save(workspaceState()); },
);
const runs = createRunService((run) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("honeycomb:run-changed", run);
  if (run.revision === 1 || run.finishedAt) void workspace.save(workspaceState());
}, (providerId) => ({
  executable: providerId === "opencode" ? getOpenCodePath() : undefined,
  model: selectedModels[providerId],
}), worktrees, (id, selected) => {
  if (id === COPILOT_ID && process.platform === "win32") {
    return { id, name: COPILOT_NAME, stream: copilot.stream };
  }
  const profile = chatProfiles.find(id);
  if (!profile) return;
  const model = parseChatModel(selected ?? "") || profile.model || profile.manualModel || "";
  if (!model) throw new Error("Choose a model before sending.");
  const connection = chatProfiles.connection(id);
  return {
    id: profile.id, name: profile.name,
    stream: (_run, messages, signal, receive) =>
      streamHttpChat(connection, model, messages, AbortSignal.any([signal, AbortSignal.timeout(300_000)]), receive),
  };
});

function workspaceState() {
  return { folder, projects, runs: runs.history(), mode, worktrees: worktrees.records() };
}

async function removeProject(path: string) {
  const index = projects.findIndex((entry) => entry.path === path);
  const project = projects[index];
  if (!project) return false;
  const wasSelected = folder?.path === path;
  projects.splice(index, 1);
  if (wasSelected) folder = undefined;
  if (await workspace.save(workspaceState())) return true;

  if (!projects.some((entry) => entry.path === path)) projects.splice(index, 0, project);
  if (wasSelected) folder ??= project;
  await workspace.save(workspaceState());
  throw new Error("Could not save the project list. The project was kept.");
}

function requireProviderId(value: unknown): CliProviderId {
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
  handle("copy-install-command", (command) => {
    if (typeof command !== "string" || !/^npm install -g [@a-z0-9/-]+$/.test(command) || command.length > 100) {
      throw new Error("Invalid CLI install command.");
    }
    clipboard.writeText(command);
  });
  let openingFreebuff = false;
  handle("open-freebuff", async (request) => {
    const { prompt, id, replace } = asRecord(request) ?? {};
    const project = folder;
    if (mode !== "code" || !project) throw new Error("Choose a project in Code first.");
    if (id !== undefined && (typeof id !== "string" || !id)) throw new Error("Invalid Freebuff worktree.");
    if (typeof prompt !== "string" || prompt.length > 8000 || prompt.includes("\0") || (!id && !prompt.trim())) {
      throw new Error("Enter a prompt to copy to Freebuff.");
    }
    if (openingFreebuff) throw new Error("A Freebuff handoff is already opening.");
    openingFreebuff = true;
    try {
      const target = await findFreebuffTerminal();
      if (mode !== "code" || folder?.path !== project.path) throw new Error("The selected project changed. Try again.");
      let record = typeof id === "string" ? worktrees.find(id) : undefined;
      if (id && (!record || record.freebuffProject !== project.path || record.state === "discarded")) {
        throw new Error("This Freebuff worktree is no longer available.");
      }
      if (record && !(await worktrees.exists(record))) {
        if (replace !== true) throw new Error("This Freebuff folder is no longer a Git worktree. Create a replacement from its card.");
        record = undefined;
      }
      const resume = Boolean(record);
      record ??= await worktrees.create(project.path, project.path);
      if (!await workspace.save(workspaceState())) throw new Error("Could not save the Freebuff worktree.");
      if (prompt.trim()) clipboard.writeText(prompt);
      await openFreebuffTerminal(target, record.path, resume);
      return record;
    } finally {
      openingFreebuff = false;
    }
  });
  handle("review-freebuff", async (id) => {
    const record = typeof id === "string" ? worktrees.find(id) : undefined;
    if (!record?.freebuffProject || !(await worktrees.exists(record))) return { available: false };
    const [diff, transcript, savedExchange] = await Promise.all([
      worktrees.diff(record, (path, status) => status !== "added" || !FREEBUFF_EXPORT_PATTERN.test(path)),
      findFreebuffTranscript(record.path),
      readSavedFreebuffExchange(record.path),
    ]);
    return {
      available: true,
      diff,
      transcriptReady: Boolean(transcript),
      savedExchange,
    };
  });
  handle("copy-freebuff-export", () => {
    clipboard.writeText(`/export freebuff-result-${Date.now()}.md`);
  });
  handle("inspect-providers", async () => {
    const [connectors, windowsCopilot] = await Promise.all([inspectProviders(getOpenCodePath()), copilot.inspect(connectorAbort.signal)]);
    return [...connectors.map((connector) => connector.id === "opencode"
      ? { ...connector, downloadAvailable: Boolean(openCodeRelease()) }
      : connector), windowsCopilot, ...chatProfiles.list().map(({ id, name }) => ({ id, name, status: "detected" as const, chatOnly: true }))];
  });
  handle("chat-profiles", chatProfiles.list);
  handle("save-chat-profile", (request) => trackConnectorJob(chatProfiles.save(request)));
  handle("remove-chat-profile", (id) => trackConnectorJob(chatProfiles.remove(id)));
  handle("test-chat-profile", (request) => trackConnectorJob((async () => {
    const selection = asRecord(request);
    const connection = chatProfiles.connection(selection?.id);
    const signal = AbortSignal.any([connectorAbort.signal, AbortSignal.timeout(60_000)]);
    const model = parseChatModel(selection?.model);
    await streamHttpChat(connection, model, [{ role: "user", content: "Reply with the single word OK." }], signal, () => {});
  })()));
  handle("copilot-handoff", (id) => copilot.copyDraft(id));
  handle("copilot-reply", (request) => {
    const { runId, text } = asRecord(request) ?? {};
    copilot.reply(runId, text);
  });
  handle("install-opencode", installOpenCode);
  handle("list-models", (value) => {
    if (chatProfiles.find(value)) {
      return trackConnectorJob(listHttpChatModels(chatProfiles.connection(value),
        AbortSignal.any([connectorAbort.signal, AbortSignal.timeout(15_000)])));
    }
    const providerId = requireProviderId(value);
    const signal = connectorAbort.signal;
    if (providerId === "claude") return trackConnectorJob(listClaudeModels(signal));
    return trackConnectorJob(providerId === "codex"
      ? listCodexModels(selectedModels.codex, signal)
      : listOpenCodeModels(getOpenCodePath(), selectedModels.opencode, signal));
  });
  handle("list-opencode-efforts", (value) =>
    trackConnectorJob(listOpenCodeEfforts(getOpenCodePath(), parseOpenCodeModel(value), connectorAbort.signal)));
  handle("set-model", (value) => {
    const payload = asRecord(value);
    if (chatProfiles.find(payload?.providerId)) return trackConnectorJob(chatProfiles.setModel(payload?.providerId, payload?.model));
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
  handle("start-run", async (request) => {
    const payload = asRecord(request) ?? {};
    const workspaceMode = mode;
    const project = workspaceMode === "code" ? folder : undefined;
    let freebuffContext: FreebuffContext | undefined;
    if (payload.freebuff !== undefined) {
      const { worktreeId, source } = asRecord(payload.freebuff) ?? {};
      const record = typeof worktreeId === "string" ? worktrees.find(worktreeId) : undefined;
      if (!project || record?.freebuffProject !== project.path || record.state === "discarded" ||
          (source !== "saved" && source !== "export") || !(await worktrees.exists(record))) {
        throw new Error("The attached Freebuff worktree is no longer available.");
      }
      freebuffContext = source === "saved" ? await readSavedFreebuffExchange(record.path)
        : { transcript: await readFreebuffTranscript(record.path) };
      if (!freebuffContext) throw new Error("Wait for Freebuff to save a completed reply, then send again.");
    }
    if (payload.edit === true && supportsWorktreeEditing(payload.providerId) && project) {
      await worktrees.inspect(project.path);
    }
    if (mode !== workspaceMode || (project && folder?.path !== project.path)) throw new Error("The selected project changed. Try again.");
    return runs.start(project, { ...payload, mode: workspaceMode }, freebuffContext);
  });
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
  handle("keep-worktree", async (worktreeId) => {
    if (typeof worktreeId !== "string") throw new Error("Invalid worktree.");
    if (!worktrees.keep(worktreeId)) return false;
    runs.setWorktreeState(worktreeId, "kept");
    await workspace.save(workspaceState());
    return true;
  });
  handle("discard-worktree", async (worktreeId, window) => {
    if (typeof worktreeId !== "string") throw new Error("Invalid worktree.");
    const record = worktrees.find(worktreeId);
    if (!record) throw new Error("This worktree is no longer recorded.");
    if (runs.history().some((run) => run.worktree?.id === worktreeId &&
        (run.status === "running" || run.status === "stopping"))) {
      throw new Error("Stop the run before discarding its worktree.");
    }
    const { response } = await dialog.showMessageBox(window, {
      type: "warning",
      title: "Discard worktree",
      message: `Discard ${record.branch}?`,
      detail: `${record.freebuffProject ? "Close Freebuff before discarding this worktree.\n\n" : ""}Honeycomb deletes the worktree folder and the branch it created:\n${record.path}`,
      buttons: ["Cancel", "Discard worktree"],
      defaultId: 0,
      cancelId: 0,
    });
    if (response !== 1 || window.isDestroyed()) return false;
    await worktrees.discard(worktreeId);
    runs.setWorktreeState(worktreeId, "discarded");
    await workspace.save(workspaceState());
    return true;
  });
  handle("sidebar-menu", async (request, window) => {
    const { target, id, x, y } = asRecord(request) ?? {};
    if ((target !== "project" && target !== "chat") || typeof id !== "string" ||
        typeof x !== "number" || typeof y !== "number" || !Number.isSafeInteger(x) || !Number.isSafeInteger(y)) {
      throw new Error("Invalid sidebar action.");
    }
    const project = target === "project" ? projects.find((entry) => entry.path === id) : undefined;
    const turns = target === "chat" ? runs.conversation(id) : [];
    const run = turns[0];
    if (!project && !run) return false;

    const label = project ? "Remove project" : "Delete chat";
    const { width, height } = window.getContentBounds();
    const chosen = await new Promise<boolean>((resolve) => {
      Menu.buildFromTemplate([{
        label,
        enabled: !turns.some((turn) => turn.status === "running" || turn.status === "stopping"),
        click: () => resolve(true),
      }]).popup({
        window,
        x: Math.min(Math.max(0, x), width),
        y: Math.min(Math.max(0, y), height),
        callback: () => setImmediate(resolve, false),
      });
    });
    if (!chosen || window.isDestroyed()) return false;

    const { response } = await dialog.showMessageBox(window, {
      type: "warning",
      title: label,
      message: project ? `Remove ${project.name} from Honeycomb?` : "Delete this chat?",
      detail: project ? "The folder, files, and chat history will be kept." : "All messages in this conversation will be deleted.",
      buttons: ["Cancel", project ? "Remove" : "Delete"],
      defaultId: 0,
      cancelId: 0,
    });
    if (response !== 1) return false;
    return project ? removeProject(id) : runs.deleteChat(id, () => workspace.save(workspaceState()));
  });
}

function createWindow() {
  const window = new BrowserWindow({
    title: "Honeycomb",
    icon: APP_ICON,
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
  app.dock?.setIcon(APP_ICON);
  const saved = await workspace.load();
  if (saved) {
    projects = saved.projects;
    folder = projects.find((project) => project.path === saved.folder?.path);
    worktrees.restore(saved.worktrees ?? []);
    runs.restore(saved.runs);
    for (const run of runs.history()) {
      const worktree = run.worktree;
      const record = worktree && worktrees.find(worktree.id);
      if (worktree && record) run.worktree = { ...worktree, state: record.state };
    }
    if (saved.mode === "chat") mode = "chat";
  }
  await Promise.all([chatProfiles.load().catch((error) => console.error("Could not read chat connections", error)), ...PROVIDER_IDS.map(async (providerId) => {
    try {
      selectedModels[providerId] = modelParsers[providerId](await readFile(modelFile(providerId), "utf8"));
    } catch {
      // The default applies when there is no saved selection.
    }
  })]);
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
