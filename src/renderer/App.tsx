import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type { ConnectorStatus, ModelCatalog, ProjectFolder, ProviderId, Run, RunEvent, RunStatus } from "../shared/contracts.js";
import {
  activeRun, chatModelDisabled, chatModelValue, chooseFolder, connectorDescriptions, connectorFor, connectorLabels, controls,
  downloadOpenCode, effortLabel, focusLater, generalChats, getVersion, isCodexChat, loadForView, markdown, newTask, number,
  openCatalog, openProject, openReplyLink, projectRuns, providerNames, refreshConnectors, refreshModels, saveModel,
  selectConnector, selectRun, selectedRun, setCatalogQuery, setPrompt, setProvider, setThinking, showView, state, statusLabels,
  signInClaude, stopRun, submitTask, subscribe, switchMode, testOpenCode, thinking, toggleProject, toggleToolGroup, usageLabels, usd,
  useConnector,
} from "./store.js";
import type { View } from "./store.js";

function StatusDot({ status }: { status: ConnectorStatus | RunStatus }) {
  return <span className="status-dot" aria-hidden="true" data-status={status} />;
}

const icons: Record<View, ReactNode> = {
  chats: (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M6 4.5h12A2.5 2.5 0 0 1 20.5 7v8a2.5 2.5 0 0 1-2.5 2.5h-7l-5 3v-3A2.5 2.5 0 0 1 3.5 15V7A2.5 2.5 0 0 1 6 4.5Z" />
      <path d="M8 9h8m-8 4h5" />
    </svg>
  ),
  workflows: (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="9" y="3.5" width="6" height="5" rx="1.2" />
      <path d="M12 8.5v3m-6 3v-3h12v3" />
      <rect x="3" y="14.5" width="6" height="5" rx="1.2" />
      <rect x="15" y="14.5" width="6" height="5" rx="1.2" />
    </svg>
  ),
  connectors: (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M9 3.5v5m6-5v5m-9 0h12m-11 0v3a5 5 0 0 0 10 0v-3m-5 8v4" />
    </svg>
  ),
};
const viewLabels: Record<View, string> = { chats: "Chats", workflows: "Workflows", connectors: "Connectors" };

function Rail() {
  return (
    <div className="app-rail">
      <div className="brand">
        <img className="brand-mark" src="./honeycomb-logo.svg" alt="Honeycomb" width="32" height="32" />
      </div>
      <nav className="navigation" aria-label="Main navigation">
        {(["chats", "workflows", "connectors"] as const).map((view) => (
          <button
            key={view} type="button" data-view={view} aria-label={viewLabels[view]}
            aria-controls={`${view}-sidebar ${view}`}
            aria-current={state.view === view ? "page" : undefined}
            hidden={view === "workflows" && state.mode === "chat"}
            onClick={() => showView(view)}
          >
            {icons[view]}
          </button>
        ))}
      </nav>
    </div>
  );
}

function HistoryButton({ run, onSelect }: { run: Run; onSelect: () => void }) {
  return (
    <button
      type="button" className="history-item" title={run.prompt}
      aria-current={run.id === state.selectedRunId ? "true" : undefined} onClick={onSelect}
    >
      <span className="history-name">{run.prompt.replace(/\s+/g, " ")}</span>
      <span className="history-meta">{`${run.providerName} · ${statusLabels[run.status]}`}</span>
    </button>
  );
}

function ProjectGroup({ project }: { project: ProjectFolder }) {
  const chats = projectRuns(project.path);
  const expanded = state.expandedProjects.has(project.path);
  return (
    <section className="project-group">
      <button
        type="button" className="folder-picker" title={project.path}
        aria-current={project.path === state.folder?.path ? "true" : undefined}
        onClick={() => void openProject(project)}
      >
        <span className="folder-icon" />
        <span className="history-name">{project.name}</span>
      </button>
      <div className="project-chats">
        {(expanded ? chats : chats.slice(0, 3)).map((run) => (
          <HistoryButton key={run.id} run={run} onSelect={() => void openProject(project, run.id)} />
        ))}
        {chats.length > 3 && (
          <button
            type="button" className="history-item history-more" aria-expanded={expanded}
            aria-label={expanded ? `Show fewer chats in ${project.name}` : `Show more chats in ${project.name}`}
            onClick={() => toggleProject(project.path)}
          >
            {expanded ? "Show less" : "..."}
          </button>
        )}
      </div>
    </section>
  );
}

function RunList() {
  if (state.mode === "chat") {
    const chats = generalChats();
    return (
      <div id="run-list" className="run-list">
        {chats.length ? chats.map((run) => <HistoryButton key={run.id} run={run} onSelect={() => selectRun(run.id)} />)
          : <p>No chats yet.</p>}
      </div>
    );
  }
  return (
    <div id="run-list" className="run-list">
      {state.projects.length ? state.projects.map((project) => <ProjectGroup key={project.path} project={project} />)
        : <p>No saved projects yet.</p>}
    </div>
  );
}

function Sidebar() {
  const { busy } = controls();
  const locked = state.choosing || busy;
  const chat = state.mode === "chat";
  return (
    <div className="sidebar">
      <aside id="chats-sidebar" className="sidebar-panel" aria-labelledby="chats-sidebar-title" hidden={state.view !== "chats"}>
        <div className="workspace-mode" role="group" aria-label="Workspace mode">
          {(["code", "chat"] as const).map((mode) => (
            <button
              key={mode} type="button" data-mode={mode} aria-pressed={state.mode === mode} disabled={locked}
              onClick={() => void switchMode(mode)}
            >
              {mode === "code" ? "Code" : "Chat"}
            </button>
          ))}
        </div>
        <h2 id="chats-sidebar-title" className="sidebar-title">Chats</h2>
        <button type="button" id="new-task" className="button sidebar-action" disabled={locked} onClick={newTask}>
          <span aria-hidden="true">+</span> New chat
        </button>
        <button type="button" id="choose-folder" className="button sidebar-action" disabled={locked} hidden={chat}
          onClick={() => void chooseFolder()}>
          <span aria-hidden="true">+</span> Add project
        </button>
        <div className="sidebar-section run-history">
          <h3 id="history-title">{chat ? "Recent chats" : "Projects"}</h3>
          <RunList />
        </div>
      </aside>

      <aside id="workflows-sidebar" className="sidebar-panel" aria-labelledby="workflows-sidebar-title" hidden={state.view !== "workflows"}>
        <h2 id="workflows-sidebar-title" className="sidebar-title">Workflows</h2>
        <div className="sidebar-list">
          <button type="button" id="select-solo" className="sidebar-item" aria-current="true" aria-controls="workflows"
            onClick={() => document.getElementById("solo-title")?.focus()}>
            <span className="workflow-marker" aria-hidden="true" />
            Solo
          </button>
        </div>
      </aside>

      <aside id="connectors-sidebar" className="sidebar-panel" aria-labelledby="connectors-sidebar-title" hidden={state.view !== "connectors"}>
        <h2 id="connectors-sidebar-title" className="sidebar-title">Connectors</h2>
        <button type="button" id="add-connector" className="button sidebar-action" aria-controls="connector-catalog"
          aria-current={state.catalogOpen ? "true" : undefined} onClick={openCatalog}>
          <span aria-hidden="true">+</span> Add connector
        </button>
        <div className="sidebar-list">
          {(["codex", "opencode", "claude"] as const).map((id) => {
            const connector = connectorFor(id);
            return (
              <button
                key={id} type="button" className="sidebar-item" data-connector={id} aria-controls="connector-detail"
                aria-current={!state.catalogOpen && id === state.selectedConnectorId ? "true" : undefined}
                onClick={() => selectConnector(id)}
              >
                <span className={id === "codex" ? "connector-monogram" : `connector-monogram ${id}`} aria-hidden="true">
                  {id === "opencode" ? "O" : "C"}
                </span>
                <span className="connector-row">
                  <span>{providerNames[id]}</span>
                  <span className="connector-row-status">
                    {connector && <><StatusDot status={connector.status} />{connectorLabels[connector.status]}</>}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        <button type="button" id="refresh-connectors" className="button sidebar-action" disabled={state.checking}
          onClick={() => void refreshConnectors()}>
          {state.checking ? "Checking…" : "Refresh"}
        </button>
      </aside>
    </div>
  );
}

function ToolActivity({ events, groupKey }: { events: RunEvent[]; groupKey: string }) {
  return (
    <details
      className="tool-activity" open={state.openToolGroups.has(groupKey)}
      onToggle={(event) => toggleToolGroup(groupKey, event.currentTarget.open)}
    >
      <summary>
        Tool activity
        <span className="tool-count">{`${events.length} ${events.length === 1 ? "update" : "updates"}`}</span>
      </summary>
      <ol>
        {events.map((event) => "text" in event && <li key={event.sequence}>{event.text}</li>)}
      </ol>
    </details>
  );
}

function FeedEntries({ run }: { run: Run }) {
  const entries: ReactNode[] = [
    <article key="prompt" className="feed-entry user"><h2>You</h2><p>{run.prompt}</p></article>,
  ];
  let tools: RunEvent[] = [];
  const flushTools = () => {
    const first = tools[0];
    if (!first) return;
    const key = `${first.runId}:${first.sequence}`;
    entries.push(<ToolActivity key={key} groupKey={key} events={tools} />);
    tools = [];
  };
  for (const event of run.events) {
    if (event.type === "usage") continue;
    if (event.type === "tool_call" || event.type === "tool_result") {
      tools.push(event);
      continue;
    }
    flushTools();
    if (event.type === "message") {
      entries.push(
        <article key={event.sequence} className="agent-reply">
          <h2 className="visually-hidden">{run.providerName}</h2>
          <div className="markdown" dangerouslySetInnerHTML={{ __html: markdown.render(event.text) }} />
        </article>,
      );
    } else {
      entries.push(<p key={event.sequence} className={`feed-line ${event.type}`}>{event.text}</p>);
    }
  }
  flushTools();
  return <>{entries}</>;
}

function Thread({ run }: { run: Run | undefined }) {
  const thread = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const lastThreadId = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const node = thread.current;
    if (!node) return;
    if (run && (atBottom.current || run.id !== lastThreadId.current)) node.scrollTop = node.scrollHeight;
    lastThreadId.current = run?.id;
  });
  const chat = state.mode === "chat";
  return (
    <div
      id="thread" className="thread" ref={thread}
      onScroll={(event) => {
        const node = event.currentTarget;
        atBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 55;
      }}
    >
      <div id="welcome" className="welcome" hidden={Boolean(run)}>
        <img className="welcome-mark" src="./honeycomb-logo.svg" alt="" width="76" height="76" />
        <h2 id="welcome-title">{chat ? "Ask a question" : "Start a review run"}</h2>
        <p id="welcome-description">
          {chat ? "Choose a model and start a conversation." : "Choose a project and ask Codex, OpenCode or Claude Code to investigate."}
        </p>
        <div id="prompt-ideas" className="prompt-ideas" aria-label="Example tasks" hidden={chat}>
          <button type="button" data-prompt="Summarize the repository layout and point me to the main entry points."
            onClick={(event) => setPrompt(event.currentTarget.dataset.prompt ?? "", true)}>
            Map the repository <span aria-hidden="true">↗</span>
          </button>
          <button type="button" data-prompt="Find the test entry points and explain how to run them."
            onClick={(event) => setPrompt(event.currentTarget.dataset.prompt ?? "", true)}>
            Find the tests <span aria-hidden="true">↗</span>
          </button>
        </div>
      </div>
      <div
        id="feed" className="feed" hidden={!run}
        onClick={(event) => {
          const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
          if (!link) return;
          event.preventDefault();
          if (/^https?:$/.test(link.protocol)) openReplyLink(link.href);
        }}
      >
        {run && <FeedEntries run={run} />}
      </div>
    </div>
  );
}

function shortModelName(model: ModelCatalog["models"][number]) {
  return (model.name === model.id ? model.id.split("/").pop() ?? model.id : model.name).replace(/\s+\([^)]*\)$/, "");
}

function ModelOptions({ providerId, chat }: { providerId: ProviderId; chat: boolean }) {
  const catalog = state.modelCatalogs[providerId];
  const loading = Boolean(state.modelRequests[providerId]);
  const providerName = providerNames[providerId];
  const selected = chat ? chatModelValue(providerId)
    : state.pendingModel?.providerId === providerId ? state.pendingModel.model : catalog?.selected ?? "";
  // The composer shows the thinking level next to the selected model.
  const suffix = chat && !chatModelDisabled(providerId) ? " · " + effortLabel(thinking(providerId).current) : "";
  const label = (text: string, value: string) => {
    if (!suffix || value !== selected) return text;
    return (text.length > 22 ? text.slice(0, 21) + "…" : text) + suffix;
  };
  const models = catalog?.models ?? [];
  const local = models.filter((model) => model.available);
  const online = models.filter((model) => !model.available);
  const savedMissing = selected && !models.some((model) => model.id === selected && model.available);
  const option = (model: ModelCatalog["models"][number]) => (
    <option key={model.id} value={model.id} disabled={!model.available}>
      {label(chat ? shortModelName(model) : model.name === model.id ? model.id : `${model.name} (${model.id})`, model.id)}
    </option>
  );
  return (
    <>
      <option value="">{label(loading && !catalog ? "Loading models…" : `${providerName} default`, "")}</option>
      <optgroup label={`Listed by ${providerName}`} hidden={!local.length && !savedMissing}>
        {local.map(option)}
        {savedMissing && (
          <option value={selected}>
            {label(chat ? selected.split("/").pop() ?? selected : `${selected} (saved selection)`, selected)}
          </option>
        )}
      </optgroup>
      <optgroup label="Online catalog · may require setup" hidden={!online.length}>
        {online.map(option)}
      </optgroup>
    </>
  );
}

function Composer() {
  const { runDisabled, message } = controls();
  const chat = state.mode === "chat";
  const providerId = state.provider;
  const think = thinking(providerId);
  const modelDisabled = chatModelDisabled(providerId);
  const thinkingLoading = state.effortRequests.has(think.key);
  return (
    <div className="composer-area">
      <form id="composer" className="composer" onSubmit={(event) => { event.preventDefault(); void submitTask(); }}>
        <label className="visually-hidden" htmlFor="prompt">Task for the agent</label>
        <textarea
          id="prompt" rows={3} maxLength={8000} placeholder={chat ? "Ask a question…" : "Ask about your project…"}
          value={state.prompt} onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends; Shift+Enter (and Enter while an IME is composing) inserts a new line.
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void submitTask();
          }}
        />
        <div className="composer-actions">
          <div className="composer-options">
            <label className="visually-hidden" htmlFor="provider">Connector</label>
            <select id="provider" className="composer-select" value={providerId}
              onChange={(event) => setProvider(event.target.value as ProviderId)}>
              <option value="codex">Codex</option>
              <option value="opencode">OpenCode</option>
              <option value="claude">Claude Code</option>
            </select>
            <span id="chat-model-control">
              <label className="visually-hidden" htmlFor="chat-model">Model</label>
              <select id="chat-model" className="composer-select" disabled={modelDisabled}
                value={state.modelCatalogs[providerId] || isCodexChat(providerId) ? chatModelValue(providerId) : ""}
                onChange={(event) => void saveModel(true, event.target.value)}>
                <ModelOptions providerId={providerId} chat />
              </select>
            </span>
            <label className="visually-hidden" htmlFor="thinking-level">Thinking level</label>
            <select
              id="thinking-level" className="composer-select" value={think.selected}
              disabled={!think.choices.length || modelDisabled}
              title={thinkingLoading ? "Looking for thinking levels…" : think.choices.length ? "Thinking level" : "This model uses its default thinking level"}
              onChange={(event) => setThinking(event.target.value)}
            >
              <option value="">Thinking: default</option>
              {think.choices.map((value) => <option key={value} value={value}>{effortLabel(value)}</option>)}
            </select>
          </div>
          <button type="submit" id="run-task" className="button button-primary" disabled={runDisabled}>
            <span id="send-label">{chat ? "Send" : "Run task"}</span> <span aria-hidden="true">→</span>
          </button>
        </div>
      </form>
      <p id="chat-status" className="chat-status" role="status" aria-live="polite" data-error={String(Boolean(state.actionError))}>
        {message}
      </p>
    </div>
  );
}

function Facts({ items }: { items: ReadonlyArray<readonly [label: string, value: string]> }) {
  return (
    <dl className="run-facts">
      {items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
  );
}

function RunDetails({ run }: { run: Run | undefined }) {
  if (!run) return <div id="run-details"><p className="empty-details">Run status and reported usage appear here.</p></div>;
  const totals: Array<readonly [string, string]> = [];
  for (const [key, label] of usageLabels) {
    const value = run.usage[key];
    if (value !== undefined) totals.push([label, (key === "costUsd" ? usd : number).format(value)]);
  }
  const active = run.status === "running" || run.status === "stopping";
  return (
    <div id="run-details">
      <div className="detail-top">
        <h3>{run.providerName}</h3>
        <span className="run-state"><StatusDot status={run.status} />{statusLabels[run.status]}</span>
      </div>
      {run.folder && <Facts items={[["Project", run.folder.name], ["Workflow", "Solo"]]} />}
      <section className="run-usage">
        <h3>Usage</h3>
        {totals.length ? <Facts items={totals} />
          : <p className="empty-details">{active ? "Waiting for usage data." : "The provider reported no usage."}</p>}
      </section>
    </div>
  );
}

function Chats() {
  const run = selectedRun();
  const active = activeRun();
  const title = run?.prompt.replace(/\s+/g, " ") ?? (state.mode === "chat" ? "New chat" : "New task");
  return (
    <main id="chats" className={state.mode === "chat" ? "workspace chat-only" : "workspace"} hidden={state.view !== "chats"}>
      <section className="chat-pane" aria-labelledby="chat-title">
        <div className="chat-header">
          <h1 id="chat-title" title={run ? title : ""}>{title}</h1>
          <button type="button" id="stop-run" className="button button-small" hidden={!active}
            disabled={active?.status === "stopping"} onClick={() => void stopRun()}>
            {active?.status === "stopping" ? "Stopping…" : "Stop run"}
          </button>
        </div>
        <Thread run={run} />
        <Composer />
      </section>
      <aside className="details" aria-labelledby="details-title">
        <h2 id="details-title">Run details</h2>
        <RunDetails run={run} />
      </aside>
    </main>
  );
}

function Workflows() {
  return (
    <main id="workflows" className="library" hidden={state.view !== "workflows"}>
      <div className="library-header">
        <h1 id="solo-title" tabIndex={-1}>Solo</h1>
        <p>One agent reviews the selected project and reports in Chats.</p>
      </div>
      <section className="workflow-card" aria-labelledby="solo-title">
        <div className="workflow-flow" aria-label="Your task, then one agent, then a run report">
          <div className="workflow-step">Your task</div>
          <div className="workflow-link" aria-hidden="true">→</div>
          <div className="workflow-step workflow-agent">Codex, OpenCode or Claude Code</div>
          <div className="workflow-link" aria-hidden="true">→</div>
          <div className="workflow-step">Run report</div>
        </div>
        <div className="workflow-footer">
          <button type="button" id="use-solo" className="button button-primary"
            onClick={() => { showView("chats"); focusLater("prompt"); }}>
            Use Solo <span aria-hidden="true">→</span>
          </button>
        </div>
      </section>
    </main>
  );
}

function ConnectorCatalog() {
  const query = state.catalogQuery.trim().toLowerCase();
  const results = state.connectors.filter(({ name, id }) => `${name} ${connectorDescriptions[id]}`.toLowerCase().includes(query));
  return (
    <section id="connector-catalog" aria-labelledby="connector-catalog-title" hidden={!state.catalogOpen}>
      <div className="library-header">
        <h1 id="connector-catalog-title">Add connector</h1>
        <p>Find a coding agent to use in Honeycomb.</p>
      </div>
      <label className="visually-hidden" htmlFor="connector-search">Search connectors</label>
      <input id="connector-search" className="connector-input" type="search" placeholder="Search connectors" autoComplete="off"
        value={state.catalogQuery} onChange={(event) => setCatalogQuery(event.target.value)} />
      <div id="connector-results" className="connector-results" aria-live="polite">
        {results.length ? results.map((connector) => (
          <article key={connector.id} className="connector-result">
            <div>
              <h2>{connector.name}</h2>
              <p className="connector-note">{connectorDescriptions[connector.id]}</p>
              <p className="connector-note">{connectorLabels[connector.status]}</p>
            </div>
            <div className="connector-actions">
              <button type="button" className="button button-small"
                onClick={() => { selectConnector(connector.id); focusLater("connector-title"); }}>
                {`View ${connector.name}`}
              </button>
              {connector.downloadAvailable && !(connector.managed && connector.status === "detected") && (
                <button type="button" className="button button-small button-primary" disabled={state.connectorBusy}
                  onClick={() => { selectConnector("opencode"); void downloadOpenCode(); }}>
                  Download OpenCode
                </button>
              )}
            </div>
          </article>
        )) : <p className="connector-note">No connectors match your search.</p>}
      </div>
    </section>
  );
}

function ConnectorSettings() {
  const id = state.selectedConnectorId;
  const connector = connectorFor(id);
  const catalog = state.modelCatalogs[id];
  const loading = Boolean(state.modelRequests[id]);
  const note = connector?.detail || (connector?.status === "missing" ? "Install the CLI and make it available on PATH." : "");
  const modelStatus = loading ? "Looking for models…" : [
    catalog?.localError,
    catalog?.onlineError,
    catalog?.models.some((model) => !model.available) ? "Online-only models must be available in your OpenCode setup before selection." : "",
  ].filter(Boolean).join(" ");
  const selected = state.pendingModel?.providerId === id ? state.pendingModel.model : catalog?.selected ?? "";
  if (!connector) return null;
  return (
    <div id="connector-settings" hidden={state.catalogOpen}>
      <div className="library-header connector-heading">
        <span id="connector-mark" className={id === "codex" ? "connector-monogram" : `connector-monogram ${id}`} aria-hidden="true">
          {connector.name.charAt(0)}
        </span>
        <div>
          <h1 id="connector-title" tabIndex={-1}>{connector.name}</h1>
          <p id="connector-description">{connectorDescriptions[id]}</p>
        </div>
      </div>
      <section id="connector-detail" className="connector-card" aria-labelledby="connector-title">
        <dl className="connector-facts">
          <div>
            <dt>Installation</dt>
            <dd id="connector-status" className="run-state" role="status">
              <StatusDot status={connector.status} />{connectorLabels[connector.status]}
            </dd>
          </div>
          <div id="connector-version-row" hidden={!connector.version}>
            <dt>CLI version</dt>
            <dd id="connector-version">{connector.version ?? ""}</dd>
          </div>
        </dl>
        <p id="connector-detail-note" className="connector-note" hidden={!note}>{note}</p>
        <button type="button" id="use-connector" className="button button-primary" disabled={connector.status !== "detected"}
          onClick={useConnector}>
          {`Use ${connector.name}`}
        </button>
        <div className="connector-model-settings">
          <div className="model-field">
            <label htmlFor="connector-model">Model</label>
            <div className="connector-actions">
              <select id="connector-model" className="connector-input" aria-describedby="model-status"
                disabled={loading || state.connectorBusy || !catalog} value={catalog ? selected : ""}
                onChange={(event) => void saveModel(false, event.target.value)}>
                <ModelOptions providerId={id} chat={false} />
              </select>
              <button type="button" id="refresh-models" className="button" disabled={loading || state.connectorBusy}
                onClick={() => void refreshModels(id)}>
                Refresh models
              </button>
            </div>
            <p id="model-status" className="connector-note" role="status">{modelStatus}</p>
          </div>
        </div>
        <div id="opencode-actions" hidden={id !== "opencode"}>
          <button type="button" id="download-opencode" className="button" disabled={state.connectorBusy}
            hidden={!connector.downloadAvailable || (connector.managed === true && connector.status === "detected")}
            onClick={() => void downloadOpenCode()}>
            Download OpenCode
          </button>
          <button type="button" id="test-opencode" className="button"
            disabled={connector.status !== "detected" || state.connectorBusy || Boolean(state.modelRequests.opencode)}
            onClick={testOpenCode}>
            Test model
          </button>
          <p className="connector-note">The test sends a short prompt using your selected model.</p>
        </div>
        <div id="claude-actions" hidden={id !== "claude" || connector.status !== "detected"}>
          <button type="button" id="sign-in-claude" className="button" disabled={state.connectorBusy}
            onClick={() => void signInClaude()}>
            {connector.signedIn ? "Sign in again" : "Sign in"}
          </button>
          <p className="connector-note">
            {connector.signedIn ? "Claude Code is signed in." : "Opens Claude Code’s sign-in in a new window. Finish it in your browser."}
          </p>
        </div>
      </section>
      <p id="connector-action-status" className="connector-note" role="status"
        hidden={state.connectorAction.provider !== id} data-provider={state.connectorAction.provider}>
        {state.connectorAction.text}
      </p>
      <p className="connector-note">Sign in or set a default model in the CLI before running a task.</p>
    </div>
  );
}

function Connectors() {
  return (
    <main id="connectors" className="library" hidden={state.view !== "connectors"}>
      <ConnectorCatalog />
      <ConnectorSettings />
    </main>
  );
}

export function App() {
  useSyncExternalStore(subscribe, getVersion);
  useEffect(loadForView);
  return (
    <>
      <Rail />
      <Sidebar />
      <Chats />
      <Workflows />
      <Connectors />
    </>
  );
}
