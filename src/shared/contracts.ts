export type CliProviderId = "codex" | "opencode" | "claude";
export type ChatProfileId = `chat:${string}`;
export type ProviderId = CliProviderId | ChatProfileId | "windows-copilot";
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
  | { available: true; diff: RunDiff; transcriptReady: boolean; savedExchange?: FreebuffExchange };

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
  copilotHandoff?: "prompt" | "reply";
  folder?: ProjectFolder;
  mode?: WorkspaceMode;
  /** True when this turn was asked to edit inside an isolated Git worktree. */
  edit?: boolean;
  worktree?: RunWorktree;
  diff?: RunDiff;
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
}

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
  "inspect-providers": () => Connector[];
  "chat-profiles": () => ChatProfile[];
  "save-chat-profile": (profile: SaveChatProfile) => ChatProfile;
  "remove-chat-profile": (id: ChatProfileId) => void;
  "test-chat-profile": (selection: { id: ChatProfileId; model: string }) => void;
  "copilot-handoff": (runId: string) => void;
  "copilot-reply": (request: { runId: string; text: string }) => void;
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
}

type Invoke<Channel extends keyof IpcCalls> =
  (...args: Parameters<IpcCalls[Channel]>) => Promise<ReturnType<IpcCalls[Channel]>>;

export interface HoneycombApi {
  copyInstallCommand: Invoke<"copy-install-command">;
  openFreebuff: Invoke<"open-freebuff">;
  reviewFreebuff: Invoke<"review-freebuff">;
  copyFreebuffExport: Invoke<"copy-freebuff-export">;
  getState: Invoke<"state">;
  inspectProviders: Invoke<"inspect-providers">;
  chatProfiles: Invoke<"chat-profiles">;
  saveChatProfile: Invoke<"save-chat-profile">;
  removeChatProfile: Invoke<"remove-chat-profile">;
  testChatProfile: Invoke<"test-chat-profile">;
  copilotHandoff: Invoke<"copilot-handoff">;
  copilotReply: Invoke<"copilot-reply">;
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
  onRunChanged(callback: (run: Run) => void): () => void;
}
