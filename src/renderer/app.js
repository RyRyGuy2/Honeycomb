const api = window.honeycomb;
const get = (id) => document.getElementById(id);
const viewButtons = document.querySelectorAll("[data-view]");
const promptField = get("prompt");
const providerField = get("provider");
const runButton = get("run-task");
const chatStatus = get("chat-status");

const statusLabels = {
  running: "Running",
  stopping: "Stopping",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
};
const connectorLabels = {
  detected: "Detected",
  missing: "Not installed",
  unavailable: "Unavailable",
  checking: "Checking",
};
const connectorDescriptions = {
  codex: "Uses the Codex CLI’s read-only sandbox.",
  opencode: "Uses OpenCode’s agent permissions to read and search the project.",
};
const number = new Intl.NumberFormat();
const usd = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", maximumFractionDigits: 4,
});

let folder;
let selectedRunId;
let choosing = false;
let checking = false;
let starting = false;
let actionError = "";
let lastThreadId;
let connectors = [
  { id: "codex", name: "Codex", status: "checking" },
  { id: "opencode", name: "OpenCode", status: "checking" },
];
const runs = new Map();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showView(name) {
  for (const button of viewButtons) {
    const selected = button.dataset.view === name;
    get(button.dataset.view).hidden = !selected;
    if (selected) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
}

function history() {
  return [...runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function remember(run) {
  if ((runs.get(run.id)?.revision ?? -1) >= run.revision) return;
  runs.set(run.id, run);
  for (const old of history().slice(20)) runs.delete(old.id);
}

function activeRun() {
  return [...runs.values()].find((run) => run.status === "running" || run.status === "stopping");
}

function projectRuns() {
  return history().filter((run) => run.folder.path === folder?.path);
}

function statusDot(status) {
  const dot = element("span", "status-dot");
  dot.setAttribute("aria-hidden", "true");
  dot.dataset.status = status;
  return dot;
}

function showError(error) {
  actionError = error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
  renderControls();
}

function renderControls() {
  const active = activeRun();
  const busy = Boolean(active) || starting;
  const stop = get("stop-run");
  const provider = connectors.find((connector) => connector.id === providerField.value);
  get("choose-folder").disabled = choosing || busy;
  get("new-task").hidden = !selectedRunId || busy;
  stop.hidden = !active;
  stop.disabled = active?.status === "stopping";
  stop.textContent = stop.disabled ? "Stopping…" : "Stop run";
  runButton.disabled = !folder || busy || choosing || !promptField.value.trim() || provider?.status !== "detected";
  chatStatus.dataset.error = String(Boolean(actionError));

  let message = actionError;
  if (!message && !folder) message = "Choose a project folder to run a task.";
  if (!message && active) message = `${active.providerName} is ${statusLabels[active.status].toLowerCase()}.`;
  if (!message && provider?.status === "checking") message = `Checking for ${provider.name}…`;
  if (!message && provider?.status !== "detected") message = `${provider?.name ?? "The connector"} is unavailable. See Connectors for details.`;
  if (chatStatus.textContent !== message) chatStatus.textContent = message;
}

function renderSidebar() {
  get("folder-name").textContent = folder?.name ?? "Choose a folder";
  const path = get("folder-path");
  path.hidden = !folder;
  path.textContent = folder?.path ?? "";
  path.title = folder?.path ?? "";

  const list = get("run-list");
  const items = projectRuns().map((run) => {
    const button = element("button", "history-item");
    button.type = "button";
    button.title = run.prompt;
    if (run.id === selectedRunId) button.setAttribute("aria-current", "true");
    button.append(
      element("span", "history-name", run.prompt.replace(/\s+/g, " ")),
      element("span", "history-meta", `${run.providerName} · ${statusLabels[run.status]}`),
    );
    button.addEventListener("click", () => selectRun(run.id));
    return button;
  });
  list.replaceChildren(...(items.length ? items : [element("p", "", "No runs yet.")]));
}

function feedEntry(author, text, className = "") {
  const card = element("article", `feed-entry ${className}`);
  card.append(element("h2", "", author), element("p", "", text));
  return card;
}

function renderThread(run) {
  const thread = get("thread");
  const feed = get("feed");
  const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 55;
  get("welcome").hidden = Boolean(run);
  feed.hidden = !run;

  if (!run) {
    lastThreadId = undefined;
    feed.replaceChildren();
    return;
  }

  const entries = [feedEntry("You", run.prompt, "user")];
  for (const event of run.events) {
    if (event.type === "message") {
      entries.push(feedEntry(run.providerName, event.text));
    }
    if (["started", "stopping", "tool_call", "tool_result", "error", "finished"].includes(event.type)) {
      entries.push(element("p", `feed-line ${event.type}`, event.text));
    }
  }
  feed.replaceChildren(...entries);
  if (atBottom || run.id !== lastThreadId) thread.scrollTop = thread.scrollHeight;
  lastThreadId = run.id;
}

function facts(items) {
  const list = element("dl", "run-facts");
  for (const [label, value] of items) {
    const row = element("div");
    row.append(element("dt", "", label), element("dd", "", value));
    list.append(row);
  }
  return list;
}

function renderDetails(run) {
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
  const labels = { inputTokens: "Input tokens", outputTokens: "Output tokens", cachedTokens: "Cached input", costUsd: "Reported cost" };
  const totals = Object.entries(labels)
    .filter(([key]) => run.usage[key] !== undefined)
    .map(([key, label]) => [label, (key === "costUsd" ? usd : number).format(run.usage[key])]);
  const active = run.status === "running" || run.status === "stopping";
  const emptyUsage = active ? "Waiting for usage data." : "The provider reported no usage.";
  usage.append(totals.length ? facts(totals) : element("p", "empty-details", emptyUsage));

  panel.replaceChildren(
    heading,
    facts([["Project", run.folder.name], ["Workflow", "Solo"]]),
    usage,
  );
}

function renderChats() {
  const run = runs.get(selectedRunId);
  renderSidebar();
  renderThread(run);
  renderDetails(run);
  renderControls();
}

function selectRun(id) {
  selectedRunId = id;
  renderChats();
}

function renderConnectors() {
  const refresh = get("refresh-connectors");
  refresh.disabled = checking;
  refresh.textContent = checking ? "Checking…" : "Refresh";
  const detected = connectors.filter((connector) => connector.status === "detected").length;
  const summary = checking ? "Checking connectors…" : `${detected} of ${connectors.length} connectors detected`;
  const summaryStatus = checking ? "checking" : (detected ? "detected" : "missing");
  get("connector-summary").replaceChildren(statusDot(summaryStatus), summary);
  const cards = connectors.map((connector) => {
    const card = element("section", "connector-card");
    const header = element("header");
    const name = element("div", "connector-name");
    const mark = element("span", `connector-monogram ${connector.id}`, connector.name[0]);
    mark.setAttribute("aria-hidden", "true");
    name.append(mark, element("h2", "", connector.name));

    const state = element("span", "run-state connector-status");
    state.dataset.status = connector.status;
    state.append(statusDot(connector.status), connectorLabels[connector.status]);
    header.append(name, state);
    card.append(header, element("p", "", connectorDescriptions[connector.id]));

    if (connector.version) card.append(element("p", "connector-version", `CLI version ${connector.version}`));
    if (connector.status === "missing") card.append(element("p", "", "Install the CLI and make it available on PATH."));
    if (connector.detail) card.append(element("p", "", connector.detail));

    const use = element("button", "button button-small", `Use ${connector.name}`);
    use.type = "button";
    use.disabled = connector.status !== "detected";
    use.addEventListener("click", () => {
      providerField.value = connector.id;
      actionError = "";
      showView("chats");
      renderControls();
      promptField.focus();
    });
    card.append(use);
    return card;
  });
  get("connector-list").replaceChildren(...cards);
}

async function refreshConnectors() {
  if (checking) return;
  checking = true;
  renderConnectors();
  try {
    connectors = await api.inspectProviders();
  } catch {
    connectors = connectors.map((connector) => ({
      ...connector, status: "unavailable", detail: "The installation check could not run.",
    }));
  } finally {
    checking = false;
    renderConnectors();
    renderControls();
  }
}

for (const button of viewButtons) {
  button.addEventListener("click", () => showView(button.dataset.view));
}
get("use-solo").addEventListener("click", () => {
  showView("chats");
  promptField.focus();
});
get("refresh-connectors").addEventListener("click", refreshConnectors);
get("stop-run").addEventListener("click", async () => {
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
  selectRun(undefined);
  promptField.focus();
});

get("choose-folder").addEventListener("click", async () => {
  choosing = true;
  actionError = "";
  renderControls();
  try {
    const selection = await api.chooseFolder();
    if (selection?.path !== folder?.path) {
      folder = selection;
      selectedRunId = projectRuns()[0]?.id;
    }
  } catch (error) {
    showError(error);
  } finally {
    choosing = false;
    renderChats();
  }
});

for (const example of document.querySelectorAll("[data-prompt]")) {
  example.addEventListener("click", () => {
    promptField.value = example.dataset.prompt;
    actionError = "";
    renderControls();
    promptField.focus();
  });
}
promptField.addEventListener("input", () => {
  actionError = "";
  renderControls();
});
providerField.addEventListener("change", () => {
  actionError = "";
  renderControls();
});

get("composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (runButton.disabled) return;
  const draft = promptField.value;
  starting = true;
  actionError = "";
  renderControls();
  try {
    selectedRunId = await api.startRun({ providerId: providerField.value, prompt: draft });
    if (promptField.value === draft) promptField.value = "";
  } catch (error) {
    showError(error);
  } finally {
    starting = false;
    renderChats();
  }
});

api.onRunChanged((run) => {
  remember(run);
  if (run.revision === 1 && run.folder.path === folder?.path) selectedRunId = run.id;
  renderChats();
});

renderChats();
void refreshConnectors();
api.getState().then((state) => {
  folder = state.folder;
  for (const run of state.runs) remember(run);
  selectedRunId ??= projectRuns()[0]?.id;
  renderChats();
}).catch(showError);
