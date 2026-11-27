export const CLI_PROVIDER_IDS = ["codex", "opencode", "claude", "antigravity", "github-copilot"] as const;
export type CliProviderId = typeof CLI_PROVIDER_IDS[number];
export type ChatProfileId = `chat:${string}`;
export type ProviderId = CliProviderId | ChatProfileId | "windows-copilot" | "copilot-web";
export type WorkspaceMode = "code" | "chat";
export type ConnectorStatus = "checking" | "detected" | "missing" | "unavailable";

export interface Connector {
  id: ProviderId;
  name: string;
  status: ConnectorStatus;
  version?: string;
  detail?: string;
  managed?: boolean;
  downloadAvailable?: boolean;
  chatOnly?: boolean;
}

export type ChatPresetId = "ollama" | "freellmapi" | "lm-studio" | "openrouter" | "gemini" | "llama-cpp" | "vllm" | "custom";

export interface ChatProfile {
  id: ChatProfileId;
  preset: ChatPresetId;
  name: string;
  baseUrl: string;
  model: string;
  manualModel?: string;
  hasApiKey: boolean;
}

export interface SaveChatProfile {
  id?: ChatProfileId;
  preset: ChatPresetId;
  name: string;
  baseUrl: string;
  manualModel: string;
  apiKey?: string;
}

export interface ModelCatalog {
  models: Array<{ id: string; name: string; available: boolean; online: boolean; efforts?: string[]; defaultEffort?: string }>;
  selected: string;
  defaultEfforts?: string[];
  localError?: string;
  onlineError?: string;
}

export interface ModelSelection {
  providerId: ProviderId;
  model: string;
}

export interface ProjectFolder {
  name: string;
  path: string;
}

export interface RunUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  costUsd?: number;
}

export type FinishedRunStatus = "completed" | "failed" | "cancelled";
export type RunStatus = "running" | "stopping" | FinishedRunStatus;

export type WorktreeState = "active" | "kept" | "discarded";

/** The branch and worktree an editing run works in. */
export interface RunWorktree {
  id: string;
  branch: string;
  path: string;
  baseCommit: string;
  state: WorktreeState;
}

/** A worktree record Honeycomb can clean up later. */
export interface WorktreeRecord extends RunWorktree {
  freebuffProject?: string;
  repository: string;
  createdAt: string;
}

export type DiffStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffFile {
  path: string;
  status: DiffStatus;
  patch: string;
  truncated?: boolean;
}

export interface RunDiff {
  baseCommit: string;
  files: DiffFile[];
  truncated?: boolean;
}

export interface FreebuffExchange {
  prompt?: string;
  reply: string;
}

export type FreebuffContext = FreebuffExchange | { transcript: string };

export interface FreebuffAttachment {
  worktreeId: string;
  source: "saved" | "export";
}

export type FreebuffReview =
  | { available: false }
  | { available: true; diff: RunDiff; transcriptReady: boolean; savedExchanges: FreebuffExchange[] };

export type RunEventData =
  | { type: "started" | "stopping" | "message" | "tool_call" | "tool_result" | "notice" | "error"; text: string }
  | { type: "finished"; status: FinishedRunStatus; text: string }
  | { type: "test_result"; text: string; passed: boolean }
  | ({ type: "usage" } & RunUsage);

export type RunEvent = RunEventData & {
  runId: string;
  sequence: number;
  at: string;
};

export interface ConversationContextSummary {
  includedTurns: number;
  omittedTurns: number;
  shortenedTurns: number;
}

export interface Run {
  id: string;
  conversationId?: string;
  turnIndex?: number;
  context?: ConversationContextSummary;
  freebuffContext?: FreebuffContext;
  providerId: ProviderId;
  providerName: string;
  copilotThread?: string;
  copilotWebThread?: string;
  copilotHandoff?: "prompt" | "reply";
  folder?: ProjectFolder;
  mode?: WorkspaceMode;
  /** True when this turn was asked to edit inside an isolated Git worktree. */
  edit?: boolean;
  worktree?: RunWorktree;
  diff?: RunDiff;
  /** The workflow run that started this turn, when it came from a workflow step. */
  workflowRunId?: string;
  workflowPlanner?: true;
  /** Effective model when a connector or chat connection supplies one. */
  model?: string;
  /** Per-run model chosen by a workflow step. Blank turns use the connector selection. */
  modelOverride?: string;
  /** Per-run time limit in milliseconds. */
  timeoutMs?: number;
  prompt: string;
  startedAt: string;
  finishedAt?: string;
  status: RunStatus;
  events: RunEvent[];
  usage: RunUsage;
  revision: number;
}

export interface StartRunRequest {
  providerId: ProviderId;
  prompt: string;
  conversationId?: string;
  freebuff?: FreebuffAttachment;
  effort?: string;
  mode?: WorkspaceMode;
  model?: string;
  /** Request an edit in a dedicated Git worktree instead of a read-only review. */
  edit?: boolean;
  /** Workflow steps run in an existing worktree instead of creating one. */
  worktreeId?: string;
  /** Set for turns started by a workflow step. */
  workflowRunId?: string;
  /** Model chosen by a workflow step. */
  modelOverride?: string;
  /** Time limit for this run. */
  timeoutMs?: number;
}

export type WorkflowStepKind = "agent" | "gate";

/** One connector run inside a workflow. */
export type WorkflowProviderId = CliProviderId | "freebuff";

export interface WorkflowAgentStep {
  id: string;
  kind: "agent";
  title: string;
  providerId: WorkflowProviderId;
  /** Blank uses the connector's own model selection. */
  model: string;
  /** Blank uses the connector default thinking level. */
  effort: string;
  mode: WorkspaceMode;
  /** Ask the connector to edit in the workflow worktree. */
  edit: boolean;
  prompt: string;
  /** Earlier steps whose results are handed to this step. */
  inputs: string[];
  /** Names this step's result for later steps. */
  output: string;
  timeoutMs: number;
}

/** A decision point between agent steps. */
export interface WorkflowGateStep {
  id: string;
  kind: "gate";
  title: string;
  /** Earlier agent step that receives a rejection. */
  feedbackStepId: string;
  /** Earlier agent whose verdict drives the gate. Omit for human review. */
  judgeStepId?: string;
  maxRevisions: number;
}

export type WorkflowStep = WorkflowAgentStep | WorkflowGateStep;

/** A saved workflow. Definitions are data only and live in the project. */
export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
}

export interface SavedWorkflow extends WorkflowDefinition {
  updatedAt: string;
}

export type WorkflowStepStatus = "pending" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "skipped";
export type FinishedWorkflowStatus = "completed" | "failed" | "cancelled" | "interrupted";
export type WorkflowRunStatus = "running" | "waiting" | "stopping" | FinishedWorkflowStatus;

export interface WorkflowStepRun {
  stepId: string;
  status: WorkflowStepStatus;
  runId?: string;
  startedAt?: string;
  finishedAt?: string;
  /** Rejections handled at this gate. */
  revisions?: number;
  detail?: string;
  freebuffReply?: string;
  usage?: RunUsage;
}

/** A workflow run record. Honeycomb keeps these in userData, never in the project. */
export interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowName: string;
  definition: WorkflowDefinition;
  folder?: ProjectFolder;
  goal?: string;
  status: WorkflowRunStatus;
  startedAt: string;
  finishedAt?: string;
  currentIndex: number;
  steps: WorkflowStepRun[];
  worktree?: RunWorktree;
  diff?: RunDiff;
  error?: string;
  usage?: RunUsage;
  smart?: SmartRunState;
  revision: number;
}

export type SmartConnector = CliProviderId | "freebuff";
export type SmartStrength = "fast" | "coding" | "deep";
export type SmartFreebuffPolicy = "fallback" | "prefer" | "explicit" | "off";

export interface SmartSettings {
  order: SmartConnector[];
  disabled: SmartConnector[];
  freebuff: SmartFreebuffPolicy;
  strengths: Array<{ connector: SmartConnector; model: string; strengths: SmartStrength[] }>;
  allowOverage: boolean;
}

export interface SmartRunRequest {
  goal: string;
  projectPath?: string;
  conversationId?: string;
  access: "chat" | "review" | "edit";
}

export interface SmartChoice {
  connector: SmartConnector;
  model: string;
  effort: string;
  reason: string;
}

export interface SmartRunState {
  access: SmartRunRequest["access"];
  context: string;
  settings: SmartSettings;
  freebuffDirective: "exclude" | "request" | "default";
  selection: Record<string, SmartChoice>;
  attempts: number;
  reply?: string;
  answer?: string;
  pending?: { kind: "question"; question: string } | { kind: "freebuff"; stepId: string; prompt: string };
}

export interface QuotaWindow {
  id: string;
  label: string;
  remaining: number;
  unit: "percent" | "hours" | "credits" | "requests" | "usd";
  resetsAt?: number;
  durationMinutes?: number;
  models?: string[];
}

export interface ConnectorQuota {
  connector: ProviderId | "freebuff";
  status: "available" | "unavailable" | "stale";
  checkedAt?: number;
  windows: QuotaWindow[];
}

export interface FreebuffTerminalEvent {
  id: string;
  data?: string;
  state?: "copied" | "clipboard-error" | "closed";
}

export interface WorkflowPlanRequest {
  providerId: CliProviderId | ChatProfileId;
  model: string;
  prompt: string;
  previous?: WorkflowDefinition;
  history?: Array<{ prompt: string; reply: string }>;
}

export interface WorkflowPlanReply {
  reply: string;
  workflow?: WorkflowDefinition;
  usage: RunUsage;
  failed?: true;
}

export type WorkflowGateDecision = "approved" | "rejected";

export interface WorkflowDecisionRequest {
  runId: string;
  decision: WorkflowGateDecision;
  feedback?: string;
}

export type WorkflowChange =
  | { type: "run"; run: WorkflowRun }
  | { type: "open"; runId: string }
  | { type: "definitions" };

export interface AppState {
  folder: ProjectFolder | undefined;
  projects: ProjectFolder[];
  runs: Run[];
  mode?: WorkspaceMode;
  worktrees?: WorktreeRecord[];
}

export interface SidebarMenuRequest {
  target: "chat" | "project";
  id: string;
  x: number;
  y: number;
}

export interface IpcCalls {
  "copy-install-command": (command: string) => void;
  "open-freebuff": (request: { prompt: string; id?: string; replace?: boolean }) => WorktreeRecord;
  "review-freebuff": (id: string) => FreebuffReview;
  "copy-freebuff-export": () => void;
  state: () => AppState;
  "factory-reset": () => boolean;
  "inspect-providers": () => Connector[];
  "chat-profiles": () => ChatProfile[];
  "save-chat-profile": (profile: SaveChatProfile) => ChatProfile;
  "remove-chat-profile": (id: ChatProfileId) => void;
  "test-chat-profile": (selection: { id: ChatProfileId; model: string }) => void;
  "copilot-handoff": (runId: string) => void;
  "copilot-reply": (request: { runId: string; text: string }) => void;
  "sign-in-copilot-web": () => void;
  "install-opencode": () => void;
  "list-models": (providerId: ProviderId) => ModelCatalog;
  "list-opencode-efforts": (model: string) => string[];
  "set-model": (selection: ModelSelection) => void;
  "test-opencode": () => void;
  "choose-folder": () => ProjectFolder | undefined;
  "set-mode": (mode: WorkspaceMode) => void;
  "select-project": (path: string) => ProjectFolder;
  "start-run": (request: StartRunRequest) => string;
  "open-reply-link": (url: string) => void;
  "stop-run": (runId: string) => void;
  "keep-worktree": (worktreeId: string) => boolean;
  "discard-worktree": (worktreeId: string) => boolean;
  "sidebar-menu": (request: SidebarMenuRequest) => boolean;
  "list-workflows": () => SavedWorkflow[];
  "plan-workflow": (request: WorkflowPlanRequest) => WorkflowPlanReply;
  "save-workflow": (workflow: WorkflowDefinition) => SavedWorkflow;
  "delete-workflow": (id: string) => boolean;
  "list-workflow-runs": () => WorkflowRun[];
  "start-workflow": (id: string) => string;
  "run-workflow-command": (request: { argument: string; projectPath?: string }) => string;
  "stop-workflow": (runId: string) => void;
  "workflow-decision": (request: WorkflowDecisionRequest) => void;
  "copy-workflow-freebuff": (request: { runId: string; stepId: string }) => void;
  "submit-workflow-freebuff": (request: { runId: string; stepId: string; reply: string }) => void;
  "smart-settings": () => SmartSettings;
  "save-smart-settings": (settings: SmartSettings) => SmartSettings;
  "connector-quotas": (refresh: boolean) => ConnectorQuota[];
  "preview-smart": (request: SmartRunRequest) => { choice?: SmartChoice; reply?: string };
  "start-smart": (request: SmartRunRequest) => string;
  "answer-smart": (request: { runId: string; answer: string }) => void;
  "resume-smart": (runId: string) => void;
  "reroute-smart": (runId: string) => void;
  "open-smart-freebuff": (runId: string) => string;
  "copy-smart-freebuff": (request: { runId: string; item: "model" | "task" }) => void;
  "reply-smart-freebuff": (request: { runId: string; reply: string; model?: string }) => void;
  "freebuff-terminal-input": (request: { id: string; data: string; enter: boolean }) => void;
  "close-freebuff-terminal": (id: string) => void;
}

type Invoke<Channel extends keyof IpcCalls> =
  (...args: Parameters<IpcCalls[Channel]>) => Promise<ReturnType<IpcCalls[Channel]>>;

export interface HoneycombApi {
  copyInstallCommand: Invoke<"copy-install-command">;
  openFreebuff: Invoke<"open-freebuff">;
  reviewFreebuff: Invoke<"review-freebuff">;
  copyFreebuffExport: Invoke<"copy-freebuff-export">;
  getState: Invoke<"state">;
  factoryReset: Invoke<"factory-reset">;
  inspectProviders: Invoke<"inspect-providers">;
  chatProfiles: Invoke<"chat-profiles">;
  saveChatProfile: Invoke<"save-chat-profile">;
  removeChatProfile: Invoke<"remove-chat-profile">;
  testChatProfile: Invoke<"test-chat-profile">;
  copilotHandoff: Invoke<"copilot-handoff">;
  copilotReply: Invoke<"copilot-reply">;
  signInCopilotWeb: Invoke<"sign-in-copilot-web">;
  installOpenCode: Invoke<"install-opencode">;
  listModels: Invoke<"list-models">;
  listOpenCodeEfforts: Invoke<"list-opencode-efforts">;
  setModel: Invoke<"set-model">;
  listOpenCodeModels(): Promise<ModelCatalog>;
  setOpenCodeModel(model: string): Promise<void>;
  testOpenCode: Invoke<"test-opencode">;
  chooseFolder: Invoke<"choose-folder">;
  setMode: Invoke<"set-mode">;
  selectProject: Invoke<"select-project">;
  startRun: Invoke<"start-run">;
  openReplyLink: Invoke<"open-reply-link">;
  stopRun: Invoke<"stop-run">;
  keepWorktree: Invoke<"keep-worktree">;
  discardWorktree: Invoke<"discard-worktree">;
  showSidebarMenu: Invoke<"sidebar-menu">;
  listWorkflows: Invoke<"list-workflows">;
  planWorkflow: Invoke<"plan-workflow">;
  saveWorkflow: Invoke<"save-workflow">;
  deleteWorkflow: Invoke<"delete-workflow">;
  listWorkflowRuns: Invoke<"list-workflow-runs">;
  startWorkflow: Invoke<"start-workflow">;
  runWorkflowCommand: Invoke<"run-workflow-command">;
  stopWorkflow: Invoke<"stop-workflow">;
  decideWorkflow: Invoke<"workflow-decision">;
  copyWorkflowFreebuff: Invoke<"copy-workflow-freebuff">;
  submitWorkflowFreebuff: Invoke<"submit-workflow-freebuff">;
  smartSettings: Invoke<"smart-settings">;
  saveSmartSettings: Invoke<"save-smart-settings">;
  connectorQuotas: Invoke<"connector-quotas">;
  previewSmart: Invoke<"preview-smart">;
  startSmart: Invoke<"start-smart">;
  answerSmart: Invoke<"answer-smart">;
  resumeSmart: Invoke<"resume-smart">;
  rerouteSmart: Invoke<"reroute-smart">;
  openSmartFreebuff: Invoke<"open-smart-freebuff">;
  copySmartFreebuff: Invoke<"copy-smart-freebuff">;
  replySmartFreebuff: Invoke<"reply-smart-freebuff">;
  freebuffTerminalInput: Invoke<"freebuff-terminal-input">;
  closeFreebuffTerminal: Invoke<"close-freebuff-terminal">;
  onFreebuffTerminal(callback: (event: FreebuffTerminalEvent) => void): () => void;
  onRunChanged(callback: (run: Run) => void): () => void;
  onWorkflowChanged(callback: (change: WorkflowChange) => void): () => void;
}
