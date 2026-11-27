import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, Notification, protocol, safeStorage, session, shell } from "electron";
import { mkdir, mkdtemp, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claude, claudeModelCatalog, parseClaudeModel } from "../providers/claude.js";
import { listCodexModels } from "../providers/codex-models.js";
import { parseCodexModel } from "../providers/codex.js";
import { WEB_COPILOT_ID, WEB_COPILOT_NAME, WEB_COPILOT_PARTITION, createCopilotWeb } from "../providers/copilot-web.js";
import { listHttpChatModels, streamHttpChat } from "../providers/http-chat.js";
import { checkProvider, inspectProviders, providerEnvironment } from "../providers/index.js";
import { installOpenCodeRelease, managedOpenCodePath, openCodeRelease } from "../providers/opencode-install.js";
import { listOpenCodeEfforts, listOpenCodeModels, testOpenCode } from "../providers/opencode-models.js";
import { opencode, parseOpenCodeModel } from "../providers/opencode.js";
import { parseEffort } from "../providers/stream.js";
import { COPILOT_ID, COPILOT_NAME, createWindowsCopilot } from "../providers/windows-copilot.js";
import { createChatProfileStore, parseChatModel } from "../service/chat-profiles.js";
import { applyFactoryReset, requestFactoryReset } from "../service/factory-reset.js";
import { runProcess } from "../service/process.js";
import { FREEBUFF_EXPORT_PATTERN, findFreebuffCommand, findFreebuffTerminal, findFreebuffTranscript, openFreebuffTerminal, readFreebuffTranscript, readSavedFreebuffExchange, readSavedFreebuffExchanges } from "../service/freebuff.js";
import { createFreebuffSessions } from "../service/freebuff-session.js";
import { createConnectorQuotas } from "../service/connector-quota.js";
import { createRunService } from "../service/runs.js";
import { createSmartWorkflows } from "../service/smart-workflow.js";
import { parseSmartSettings } from "../service/smart-routing.js";
import type { SmartCatalogEntry } from "../service/smart-routing.js";
import { createWorkflowRunner } from "../service/workflow-runner.js";
import { MAX_PLAN_GOAL, workflowPlanPrompt, workflowPlanReply } from "../service/workflow-planner.js";
import type { PlannerCatalog } from "../service/workflow-planner.js";
import { createWorkflowRunStore } from "../service/workflow-runs.js";
import { createWorkflowStore } from "../service/workflows.js";
import { createWorkspaceStore } from "../service/workspace.js";
import { createWorktreeManager } from "../service/worktree.js";
import type { CliProviderId, FreebuffContext, IpcCalls, ProjectFolder, SmartRunRequest, SmartSettings, WorkflowChange, WorkflowDefinition, WorkspaceMode } from "../shared/contracts.js";
import { CLI_PROVIDER_IDS } from "../shared/contracts.js";
import { conversationContext, runMode } from "../shared/conversations.js";
import { isCliProvider, supportsWorktreeEditing } from "../shared/editing.js";
import { asRecord } from "../shared/records.js";
import { boundedText, MAX_FREEBUFF_REPLY, resolveWorkflowCommand, validateWorkflow, workflowRequiresProject } from "../shared/workflows.js";

const APP_URL = "honeycomb://app/";
const APP_ICON = fileURLToPath(new URL("./honeycomb-icon.png", import.meta.url));
const RENDERER_ASSETS = new Map<string, readonly [filename: string, contentType: string]>([
  ["/", ["index.html", "text/html"]],
  ["/styles.css", ["styles.css", "text/css"]],
  ["/app.js", ["app.js", "text/javascript"]],
  ["/copilot-clipboard.js", ["copilot-clipboard.js", "text/javascript"]],
  ["/smart.js", ["smart.js", "text/javascript"]],
  ["/xterm.js", ["xterm.js", "text/javascript"]],
  ["/xterm.css", ["xterm.css", "text/css"]],
  ["/shared/connectors.js", ["../shared/connectors.js", "text/javascript"]],
  ["/shared/conversations.js", ["../shared/conversations.js", "text/javascript"]],
  ["/shared/chat-presets.js", ["../shared/chat-presets.js", "text/javascript"]],
  ["/shared/editing.js", ["../shared/editing.js", "text/javascript"]],
  ["/shared/contracts.js", ["../shared/contracts.js", "text/javascript"]],
  ["/shared/workflows.js", ["../shared/workflows.js", "text/javascript"]],
  ["/markdown-it.js", ["markdown-it.js", "text/javascript"]],
  ["/honeycomb-logo.svg", ["honeycomb-logo.svg", "image/svg+xml"]],
]);
const CONTENT_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-elem 'self' 'unsafe-inline'",
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
let resetting = false;
let pendingMutations = 0;
const readOnlyCalls = new Set<keyof IpcCalls>([
  "state", "inspect-providers", "chat-profiles", "list-models", "list-opencode-efforts",
  "review-freebuff", "list-workflows", "list-workflow-runs",
  "smart-settings", "connector-quotas",
]);
const selectedModels: Record<CliProviderId, string> = { codex: "", opencode: "", claude: "", antigravity: "", "github-copilot": "" };
const modelParsers = {
  codex: parseCodexModel, opencode: parseOpenCodeModel, claude: parseClaudeModel,
  antigravity: parseChatModel, "github-copilot": parseChatModel,
};
let downloading: Promise<void> | undefined;
const connectorAbort = new AbortController();
const quotas = createConnectorQuotas(connectorAbort.signal);
const connectorJobs = new Set<Promise<unknown>>();
const getOpenCodePath = () => managedOpenCodePath(app.getPath("userData"));
const modelFile = (providerId: CliProviderId) => join(app.getPath("userData"), `${providerId}-model`);
const workspace = createWorkspaceStore(() => join(app.getPath("userData"), "workspace.json"));
const copilot = createWindowsCopilot((text) => clipboard.writeText(text));
const copilotWeb = createCopilotWeb();
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
function send(channel: string, value: unknown) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, value);
}

const runs = createRunService((run) => {
  send("honeycomb:run-changed", run);
  if (run.revision === 1 || run.finishedAt) void workspace.save(workspaceState());
}, (providerId) => ({
  executable: providerId === "opencode" ? getOpenCodePath() : undefined,
  model: selectedModels[providerId],
}), worktrees, (id, selected) => {
  if (id === COPILOT_ID && process.platform === "win32") {
    return { id, name: COPILOT_NAME, stream: copilot.stream };
  }
  if (id === WEB_COPILOT_ID) return { id, name: WEB_COPILOT_NAME, stream: copilotWeb.stream };
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
const workflowStore = createWorkflowStore(() => app.getPath("userData"));
const workflowRunStore = createWorkflowRunStore(() => join(app.getPath("userData"), "workflow-runs.json"));
const smartRunStore = createWorkflowRunStore(() => join(app.getPath("userData"), "smart-runs.json"));
const smartSettingsPath = () => join(app.getPath("userData"), "smart-settings.json");
let smartSettings = parseSmartSettings(undefined);
let settingsWrites = Promise.resolve();
const freebuffSessions = createFreebuffSessions({
  copy: (text) => clipboard.writeText(text),
  send: (event) => send("honeycomb:freebuff-terminal", event),
});
const smartNotifications = new Map<string, Notification>();
const workflowRuns = createWorkflowRunner({
  runs,
  save: (records) => { void workflowRunStore.save(records); },
  publish: (run) => send("honeycomb:workflow-changed", { type: "run", run } satisfies WorkflowChange),
  onFreebuffHandoff(prompt) {
    let copied = false;
    try {
      clipboard.writeText(prompt);
      copied = true;
    } catch (error) {
      console.error("Could not copy the Freebuff workflow prompt", error);
    }
    try {
      if (!Notification.isSupported()) return;
      const notice = new Notification({
        title: "Workflow waiting for Freebuff",
        body: copied ? "Prompt copied. Paste and send it in Freebuff, then return with the reply."
          : "Open the workflow run to copy the prompt, then send it in Freebuff.",
      });
      notice.on("click", () => {
        mainWindow?.show();
        mainWindow?.focus();
      });
      notice.show();
    } catch (error) {
      console.error("Could not show the Freebuff workflow notification", error);
    }
  },
});

const smartWorkflows = createSmartWorkflows({
  runs,
  available: smartCatalog,
  openCodeEfforts: smartOpenCodeEfforts,
  canStart: () => !workflowRuns.hasActiveRun() && !quitting && !resetting,
  save: (records) => smartRunStore.save(records),
  publish(run) {
    if (run.smart?.pending?.kind !== "freebuff") {
      smartNotifications.get(run.id)?.close();
      smartNotifications.delete(run.id);
    }
    send("honeycomb:workflow-changed", { type: "run", run } satisfies WorkflowChange);
  },
  notify(run) {
    try {
      if (!Notification.isSupported()) return;
      const notice = new Notification({
        title: "Smart workflow waiting for Freebuff",
        body: "Open Honeycomb when you’re ready to choose the model and send the task.",
      });
      notice.on("click", () => {
        mainWindow?.show();
        mainWindow?.focus();
        send("honeycomb:workflow-changed", { type: "open", runId: run.id } satisfies WorkflowChange);
      });
      notice.on("close", () => smartNotifications.delete(run.id));
      smartNotifications.set(run.id, notice);
      notice.show();
    } catch (error) {
      console.error("Could not show the Smart Freebuff notification", error);
    }
  },
  async inspectChanges(run) {
    const record = worktrees.find(run.worktree?.id ?? "");
    if (!record) throw new Error("The workflow worktree could not be inspected.");
    const diff = await worktrees.diff(record);
    return diff.files.length ? diff.files.slice(0, 12).map((file) => `${file.status} ${file.path}`).join(", ") : "No changes.";
  },
});

function workflowIsBusy() {
  return workflowRuns.hasActiveRun() || smartWorkflows.busy();
}

let catalogCache: { at: number; entries: Omit<SmartCatalogEntry, "quota">[] } | undefined;
const smartEffortCache = new Map<string, { expires: number; efforts: string[] }>();
async function smartOpenCodeEfforts(model: string) {
  const known = smartEffortCache.get(model);
  if (known && known.expires > Date.now()) return known.efforts;
  const efforts = await trackConnectorJob(listOpenCodeEfforts(getOpenCodePath(), model, connectorAbort.signal));
  if (smartEffortCache.size >= 50) smartEffortCache.clear();
  smartEffortCache.set(model, { expires: Date.now() + 300_000, efforts });
  return efforts;
}

async function smartCatalog(settings: SmartSettings, forceQuota = false): Promise<SmartCatalogEntry[]> {
  if (!catalogCache || Date.now() - catalogCache.at > 60_000) {
    const inspected = await trackConnectorJob(inspectProviders(getOpenCodePath()));
    const detected = inspected.flatMap(({ id, status }) => status === "detected" && isCliProvider(id) ? [id] : []);
    const entries = await Promise.all(detected.map(async (connector) => ({
      connector,
      catalog: await trackConnectorJob(listCliModels(connector, connectorAbort.signal))
        .catch(() => ({ models: [], selected: selectedModels[connector] })),
    })));
    catalogCache = { at: Date.now(), entries };
  }
  const entries: Omit<SmartCatalogEntry, "quota">[] = [...catalogCache.entries];
  if (await findFreebuffCommand().catch(() => undefined)) {
    const preferred = settings.strengths.filter(({ connector }) => connector === "freebuff").map(({ model }) => model);
    const models = [...new Set([...preferred, "DeepSeek V4.1 Flash Slow", "GPT-6.1 Terra"])];
    entries.push({ connector: "freebuff", catalog: {
      selected: models[0] ?? "",
      models: models.map((id) => ({ id, name: id, available: true, online: true })),
    } });
  }
  return Promise.all(entries.map(async (entry) => ({ ...entry, quota: await trackConnectorJob(quotas.get(entry.connector, forceQuota)) })));
}

function notifyWorkflowDefinitions() {
  send("honeycomb:workflow-changed", { type: "definitions" } satisfies WorkflowChange);
}

async function startSavedWorkflow(workflow: WorkflowDefinition, project: ProjectFolder | undefined, goal?: string) {
  if (runs.hasActiveRun() || workflowIsBusy()) throw new Error("Finish or stop the active run before starting a workflow.");
  const needsProject = workflowRequiresProject(workflow);
  if (needsProject) {
    if (!project) throw new Error("Choose a project in Code to run this workflow’s Code steps.");
    if (workflow.steps.some((step) => step.kind === "agent" && step.edit)) await worktrees.inspect(project.path);
    if (mode !== "code" || folder?.path !== project.path) throw new Error("The selected project changed. Try again.");
  }
  if (runs.hasActiveRun() || workflowIsBusy()) throw new Error("Finish or stop the active run before starting a workflow.");
  return workflowRuns.start(needsProject ? project : undefined, workflow, goal);
}

function workspaceState() {
  const history = runs.history().flatMap((run) => run.workflowPlanner
    ? run.finishedAt ? [{ ...run, prompt: "", events: [] }] : []
    : [run]);
  return { folder, projects, runs: history, mode, worktrees: worktrees.records() };
}

async function smartRequest(value: unknown) {
  const request = asRecord(value);
  const goal = typeof request?.goal === "string" ? request.goal.trim() : "";
  const access = request?.access;
  if (!goal || goal.length > 8_000 || goal.includes("\0")) throw new Error("Enter a Smart task of up to 8,000 characters.");
  if (access !== "chat" && access !== "review" && access !== "edit") throw new Error("Choose a valid access setting.");
  const project = access === "chat" ? undefined : folder;
  if (access === "chat" ? mode !== "chat" : mode !== "code" || !project || project.path !== request?.projectPath) {
    throw new Error("Choose the project and workspace for this Smart task.");
  }
  const turns = typeof request?.conversationId === "string" ? runs.conversation(request.conversationId) : [];
  if (request?.conversationId !== undefined && (!turns.length || turns.some((turn) => turn.workflowPlanner || turn.workflowRunId ||
      runMode(turn) !== (project ? "code" : "chat") || turn.folder?.path !== project?.path))) {
    throw new Error("Open the original chat before starting Smart with its context.");
  }
  if (access === "edit" && project) {
    await worktrees.inspect(project.path);
    if (folder?.path !== project.path || mode !== "code") throw new Error("The selected project changed. Try again.");
  }
  const context = JSON.stringify(conversationContext(turns.filter(({ finishedAt }) => finishedAt)).messages.slice(-4)
    .map(({ user, assistant }) => ({ user: boundedText(user, 900), assistant: boundedText(assistant, 1_300) })));
  const selection = asRecord(request?.orchestrator);
  const connector = selection?.connector;
  if (!isCliProvider(connector)) throw new Error("Choose a CLI connector and model to orchestrate the workflow.");
  const task: SmartRunRequest = {
    goal, access, orchestrator: {
      connector, model: modelParsers[connector](selection?.model ?? ""),
      effort: parseEffort(selection?.effort, connector) ?? "",
    },
  };
  return { task, project, context };
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
  if (isCliProvider(value)) return value;
  throw new Error("Choose a CLI connector.");
}

async function listClaudeModels(signal: AbortSignal) {
  const { connector, executable } = await checkProvider(claude, signal);
  const catalog = claudeModelCatalog(selectedModels.claude);
  return executable ? catalog : { ...catalog, localError: connector.detail || "Install Claude Code to use its models." };
}

function listCliModels(providerId: CliProviderId, signal: AbortSignal) {
  if (providerId === "claude") return listClaudeModels(signal);
  if (providerId === "antigravity" || providerId === "github-copilot") {
    return Promise.resolve({ models: [], selected: selectedModels[providerId], localError: "Uses the model configured in the CLI." });
  }
  return providerId === "codex" ? listCodexModels(selectedModels.codex, signal)
    : listOpenCodeModels(getOpenCodePath(), selectedModels.opencode, signal);
}

function listConnectionModels(id: string) {
  return listHttpChatModels(chatProfiles.connection(id), AbortSignal.any([connectorAbort.signal, AbortSignal.timeout(15_000)]));
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
  ipcMain.handle(`honeycomb:${channel}`, async (event, request: unknown) => {
    const window = mainWindow;
    if (
      !window || window.isDestroyed() || event.sender !== window.webContents ||
      event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== APP_URL
    ) {
      throw new Error("This action is available in the Honeycomb window.");
    }
    if (resetting || quitting) throw new Error("Honeycomb is closing.");
    const mutates = !readOnlyCalls.has(channel);
    if (mutates) pendingMutations++;
    try {
      return await callback(request, window);
    } finally {
      if (mutates) pendingMutations--;
    }
  });
}

function registerHandlers() {
  const openingSmartFreebuff = new Set<string>();
  handle("state", workspaceState);
  handle("factory-reset", async (_request, window) => {
    function ensureIdle() {
      if (runs.hasActiveRun() || workflowIsBusy()) {
        throw new Error("Finish or stop the current chat or workflow before resetting.");
      }
      if (pendingMutations > 1) {
        throw new Error("Finish the current action, then try resetting again.");
      }
    }
    ensureIdle();
    const { response } = await dialog.showMessageBox(window, {
      type: "warning",
      title: "Factory reset Honeycomb",
      message: "Erase Honeycomb’s local data and restart?",
      detail: "This permanently clears chat and workflow history, Honeycomb’s saved workflows, saved projects, connector settings and API keys, app-managed downloads, and the Copilot Web sign-in. Project files and Git worktrees stay on disk.",
      buttons: ["Cancel", "Reset and restart"],
      defaultId: 0,
      cancelId: 0,
    });
    if (response !== 1 || window.isDestroyed() || quitting) return false;
    ensureIdle();
    resetting = true;
    try {
      await requestFactoryReset(app.getPath("userData"));
    } catch (error) {
      resetting = false;
      throw new Error("Could not schedule the factory reset. Your local data is still available.", { cause: error });
    }
    app.relaunch();
    setImmediate(() => app.quit());
    return true;
  });
  handle("copy-install-command", (command) => {
    if (typeof command !== "string" || !/^npm install -g [@a-z0-9/-]+(?:@latest)?$/.test(command) || command.length > 100) {
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
    const [diff, transcript, savedExchanges] = await Promise.all([
      worktrees.diff(record, (path, status) => status !== "added" || !FREEBUFF_EXPORT_PATTERN.test(path)),
      findFreebuffTranscript(record.path),
      readSavedFreebuffExchanges(record.path),
    ]);
    return {
      available: true,
      diff,
      transcriptReady: Boolean(transcript),
      savedExchanges,
    };
  });
  handle("copy-freebuff-export", () => {
    clipboard.writeText(`/export freebuff-result-${Date.now()}.md`);
  });
  handle("inspect-providers", async () => {
    catalogCache = undefined;
    smartEffortCache.clear();
    const [connectors, windowsCopilot] = await Promise.all([inspectProviders(getOpenCodePath()), copilot.inspect(connectorAbort.signal)]);
    return [...connectors.map((connector) => connector.id === "opencode"
      ? { ...connector, downloadAvailable: Boolean(openCodeRelease()) }
      : connector), windowsCopilot, { id: WEB_COPILOT_ID, name: WEB_COPILOT_NAME, status: "detected", chatOnly: true },
      ...chatProfiles.list().map(({ id, name }) => ({ id, name, status: "detected" as const, chatOnly: true }))];
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
  handle("sign-in-copilot-web", () => trackConnectorJob(copilotWeb.signIn(connectorAbort.signal)));
  handle("install-opencode", installOpenCode);
  handle("list-models", (value) => {
    const profile = chatProfiles.find(value);
    if (profile) return trackConnectorJob(listConnectionModels(profile.id));
    const providerId = requireProviderId(value);
    return trackConnectorJob(listCliModels(providerId, connectorAbort.signal));
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
      catalogCache = undefined;
    })());
  });
  handle("test-opencode", () =>
    trackConnectorJob(testOpenCode(getOpenCodePath(), selectedModels.opencode, connectorAbort.signal)));
  handle("set-mode", async (value) => {
    if (value !== "code" && value !== "chat") throw new Error("Choose Code or Chat.");
    if (runs.hasActiveRun()) throw new Error("Finish or stop the response before changing modes.");
    if (workflowIsBusy()) throw new Error("Finish or stop the workflow before changing modes.");
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
    if (workflowIsBusy()) throw new Error("Finish or stop the running workflow first.");
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
    if (workflowIsBusy()) throw new Error("Finish or stop the running workflow first.");
    const { providerId, prompt, conversationId, effort, model, edit } = payload;
    return runs.start(project, { providerId, prompt, conversationId, effort, model, edit, mode: workspaceMode }, freebuffContext);
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
    smartWorkflows.setWorktreeState(worktreeId, "kept");
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
    if ([...workflowRuns.history(), ...smartWorkflows.history()].some((run) => run.worktree?.id === worktreeId &&
        (run.status === "running" || run.status === "waiting" || run.status === "stopping"))) {
      throw new Error("Finish or stop the workflow before discarding its worktree.");
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
    smartWorkflows.setWorktreeState(worktreeId, "discarded");
    await workspace.save(workspaceState());
    return true;
  });
  handle("list-workflows", () => workflowStore.list());
  handle("plan-workflow", async (value) => {
    if (runs.hasActiveRun() || workflowIsBusy()) throw new Error("Finish or stop the current run before planning.");
    const payload = asRecord(value);
    const profile = chatProfiles.find(payload?.providerId);
    const providerId = profile?.id ?? requireProviderId(payload?.providerId);
    const cli = isCliProvider(providerId) ? providerId : undefined;
    let model = cli ? modelParsers[cli](payload?.model ?? "") : parseChatModel(payload?.model ?? "");
    const goal = typeof payload?.prompt === "string" ? payload.prompt.trim() : "";
    if (!goal || goal.length > MAX_PLAN_GOAL || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(goal)) {
      throw new Error(`Enter a workflow goal of 1 to ${MAX_PLAN_GOAL} characters.`);
    }
    const previous = payload?.previous === undefined ? undefined : validateWorkflow(payload.previous);
    const history = Array.isArray(payload?.history) ? payload.history.slice(-2).map((entry: unknown) => {
      const turn = asRecord(entry);
      if (typeof turn?.prompt !== "string" || typeof turn.reply !== "string") return "";
      return `User: ${turn.prompt.slice(0, 350)}\nPlanner: ${turn.reply.slice(0, 250)}`;
    }).join("\n") : "";
    const available = (await inspectProviders(getOpenCodePath())).flatMap((connector) =>
      connector.status === "detected" && isCliProvider(connector.id) ? [connector.id] : []);
    if (cli && !available.includes(cli)) throw new Error("Choose an installed connector to plan this workflow.");
    const catalogs = await Promise.all(available.map(async (id) => {
      const catalog = await trackConnectorJob(listCliModels(id, connectorAbort.signal)).catch(() => undefined);
      return [id, {
        models: catalog?.models.filter((entry) => entry.available) ?? [],
        defaultEfforts: catalog?.defaultEfforts,
      }] as const;
    }));
    const models: PlannerCatalog = new Map([...catalogs, ["freebuff", { models: [], defaultEfforts: undefined }]]);
    const profileModels = profile ? await trackConnectorJob(listConnectionModels(profile.id)) : undefined;
    const selectable = cli ? models.get(cli)?.models : profileModels?.models.filter((entry) => entry.available);
    if (model && !selectable?.some((entry) => entry.id === model)) throw new Error("Choose a model listed for the planner connector.");
    if (profile) model ||= profileModels?.selected ?? "";
    if (workflowIsBusy()) throw new Error("Finish or stop the workflow before planning.");
    const id = runs.start(undefined, {
      providerId, model, modelOverride: model, mode: "chat", workflowPlanner: true,
      prompt: workflowPlanPrompt(goal, models, previous, history),
    });
    const run = await runs.waitForRun(id);
    try {
      return workflowPlanReply(run, models, previous);
    } catch (error) {
      return { reply: error instanceof Error ? error.message : "Could not generate a workflow.", usage: run.usage, failed: true };
    }
  });
  handle("save-workflow", async (value) => {
    const saved = await workflowStore.save(value);
    notifyWorkflowDefinitions();
    return saved;
  });
  handle("delete-workflow", async (value) => {
    const removed = await workflowStore.remove(value);
    if (removed) notifyWorkflowDefinitions();
    return removed;
  });
  handle("list-workflow-runs", () => [...workflowRuns.history(), ...smartWorkflows.history()]);
  handle("start-workflow", async (value) => {
    if (typeof value !== "string") throw new Error("Invalid workflow.");
    const project = mode === "code" ? folder : undefined;
    const workflow = (await workflowStore.list()).find((entry) => entry.id === value);
    if (!workflow) throw new Error("This workflow is no longer saved.");
    return startSavedWorkflow(workflow, project);
  });
  handle("run-workflow-command", async (value) => {
    const { argument, projectPath } = asRecord(value) ?? {};
    if (typeof argument !== "string" || argument.length > 8_000 || argument.includes("\0")) throw new Error("Enter a valid workflow command.");
    const project = mode === "code" && folder?.path === projectPath ? folder : undefined;
    const { workflow, goal } = resolveWorkflowCommand(argument, await workflowStore.list());
    return startSavedWorkflow(workflow, project, goal);
  });
  handle("stop-workflow", async (value) => {
    if (typeof value !== "string") throw new Error("Invalid workflow run.");
    if (smartWorkflows.find(value)) {
      if (openingSmartFreebuff.has(value)) throw new Error("Wait for the Freebuff terminal to open, then stop the workflow.");
      freebuffSessions.closeRun(value);
      await smartWorkflows.stop(value);
    } else {
      await workflowRuns.stop(value);
    }
  });
  handle("workflow-decision", (value) => workflowRuns.decide(value));
  handle("copy-workflow-freebuff", (value) => clipboard.writeText(workflowRuns.freebuffPrompt(value)));
  handle("submit-workflow-freebuff", (value) => workflowRuns.submitFreebuffReply(value));
  handle("smart-settings", () => smartSettings);
  handle("save-smart-settings", async (value) => {
    const settings = parseSmartSettings(value);
    const file = smartSettingsPath();
    const op = settingsWrites.then(async () => {
      await mkdir(app.getPath("userData"), { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify(settings), { mode: 0o600 });
      await rename(`${file}.tmp`, file);
      smartSettings = settings;
    });
    settingsWrites = op.catch(() => undefined);
    await op;
    return settings;
  });
  handle("connector-quotas", (force) => Promise.all(
    CLI_PROVIDER_IDS.map((connector) => trackConnectorJob(quotas.get(connector, force === true))),
  ));
  handle("preview-smart", async (value) => {
    const { task, project, context } = await smartRequest(value);
    return smartWorkflows.preview(task, project, context, smartSettings);
  });
  handle("start-smart", async (value) => {
    const { task, project, context } = await smartRequest(value);
    return smartWorkflows.start(task, project, context, smartSettings);
  });
  handle("answer-smart", (value) => {
    const { runId, answer } = asRecord(value) ?? {};
    smartWorkflows.answer(runId, answer);
  });
  handle("resume-smart", (id) => smartWorkflows.resume(id));
  handle("reroute-smart", (id) => {
    if (typeof id === "string" && openingSmartFreebuff.has(id)) throw new Error("Wait for the Freebuff terminal to open, then choose another connector.");
    smartWorkflows.reroute(id);
    freebuffSessions.closeRun(id);
  });
  handle("open-smart-freebuff", async (id) => {
    const { run, pending, step } = smartWorkflows.pendingFreebuff(id);
    if (openingSmartFreebuff.has(run.id)) throw new Error("This Freebuff handoff is already opening.");
    openingSmartFreebuff.add(run.id);
    let temporary: string | undefined;
    function cleanup() {
      if (temporary) void rmdir(temporary).catch(() => undefined);
    }
    try {
      const target = await findFreebuffCommand();
      smartWorkflows.pendingFreebuff(id);
      let cwd: string;
      if (step.edit && run.folder) {
        const current = run.worktree && worktrees.find(run.worktree.id);
        if (run.worktree && (!current || current.state === "discarded" || !await worktrees.exists(current))) {
          throw new Error("The workflow worktree is no longer available.");
        }
        smartWorkflows.pendingFreebuff(id);
        const worktree = current ?? await worktrees.create(run.folder.path);
        await smartWorkflows.attachFreebuffWorktree(id, worktree);
        await workspace.flush();
        cwd = worktree.path;
      } else {
        temporary = await mkdtemp(join(tmpdir(), "honeycomb-freebuff-"));
        cwd = temporary;
      }
      return await freebuffSessions.open(run.id, target, cwd, pending.prompt, () => {
        return !quitting && !resetting && run.status === "waiting" && run.smart.pending === pending;
      }, cleanup);
    } catch (error) {
      cleanup();
      throw error;
    } finally {
      openingSmartFreebuff.delete(run.id);
    }
  });
  handle("copy-smart-freebuff", (value) => {
    const { runId, item } = asRecord(value) ?? {};
    const { pending } = smartWorkflows.pendingFreebuff(runId);
    if (item !== "model" && item !== "task") throw new Error("Choose which Freebuff text to copy.");
    clipboard.writeText(item === "model" ? "/model" : pending.prompt);
  });
  handle("reply-smart-freebuff", async (value) => {
    const { runId, reply, model } = asRecord(value) ?? {};
    const { run, step } = smartWorkflows.pendingFreebuff(runId);
    if (openingSmartFreebuff.has(run.id)) throw new Error("Wait for the Freebuff terminal to open before submitting.");
    if (typeof reply !== "string" || !reply.trim() || reply.trim().length > MAX_FREEBUFF_REPLY || reply.includes("\0")) {
      throw new Error("Enter a completed Freebuff reply.");
    }
    freebuffSessions.closeRun(runId);
    const record = step.edit && run.worktree ? worktrees.find(run.worktree.id) : undefined;
    const diff = record ? await worktrees.diff(record).catch(() => undefined) : undefined;
    smartWorkflows.replyFreebuff(runId, reply, model, diff);
  });
  handle("freebuff-terminal-input", (value) => {
    const { id, data, enter } = asRecord(value) ?? {};
    freebuffSessions.input(id, data, enter);
  });
  handle("close-freebuff-terminal", (id) => freebuffSessions.close(id));
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
  window.once("closed", () => {
    mainWindow = undefined;
    if (process.platform !== "darwin" && BrowserWindow.getAllWindows().length) app.quit();
  });
  void window.loadURL(APP_URL);
}

app.whenReady().then(async () => {
  try {
    await applyFactoryReset(app.getPath("userData"), async () => {
      for (const browser of [session.defaultSession, session.fromPartition(WEB_COPILOT_PARTITION)]) {
        await browser.clearData();
        await browser.clearAuthCache();
      }
    });
  } catch (error) {
    console.error("Could not finish the factory reset", error);
    dialog.showErrorBox("Factory reset could not finish", "Close any programs using Honeycomb’s data and reopen Honeycomb to retry.");
    app.exit(1);
    return;
  }
  nativeTheme.themeSource = "dark";
  if (process.platform === "win32") app.setAppUserModelId(app.isPackaged ? "Honeycomb" : process.execPath);
  app.dock?.setIcon(APP_ICON);
  const saved = await workspace.load();
  if (saved) {
    projects = saved.projects;
    folder = projects.find((project) => project.path === saved.folder?.path);
    worktrees.restore(saved.worktrees ?? []);
    runs.restore(saved.runs);
    void workspace.save(workspaceState());
    for (const run of runs.history()) {
      const worktree = run.worktree;
      const record = worktree && worktrees.find(worktree.id);
      if (worktree && record) run.worktree = { ...worktree, state: record.state };
    }
    if (saved.mode === "chat") mode = "chat";
  }
  workflowRuns.restore(await workflowRunStore.load());
  smartWorkflows.restore(await smartRunStore.load());
  void smartRunStore.save(smartWorkflows.history());
  try {
    smartSettings = parseSmartSettings(JSON.parse(await readFile(smartSettingsPath(), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("Could not read Smart settings", error);
  }
  await workflowStore.importLegacy(projects.map((project) => project.path)).catch((error) => {
    console.error("Could not finish importing project workflows", error);
  });
  await Promise.all([chatProfiles.load().catch((error) => console.error("Could not read chat connections", error)), ...CLI_PROVIDER_IDS.map(async (providerId) => {
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
    if (!mainWindow && !resetting && !quitting) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (quitting) {
    if (runs.hasActiveRun() || workflowIsBusy() || connectorJobs.size) event.preventDefault();
    return;
  }
  event.preventDefault();
  quitting = true;
  connectorAbort.abort();
  void (async () => {
    // Close waiting gates first, then let the run service finish the active provider process.
    freebuffSessions.closeAll();
    await Promise.allSettled([workflowRuns.shutdown(), smartWorkflows.shutdown()]);
    await Promise.allSettled([runs.shutdown(), ...connectorJobs]);
    await Promise.allSettled([workspace.flush(), workflowRunStore.flush(), smartRunStore.flush(), settingsWrites]);
    app.quit();
  })();
});
