export type ProviderId = "codex" | "opencode" | "claude";
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

export type RunEventData =
  | { type: "started" | "stopping" | "message" | "tool_call" | "tool_result" | "notice" | "error"; text: string }
  | { type: "finished"; status: FinishedRunStatus; text: string }
  | ({ type: "usage" } & RunUsage);

export type RunEvent = RunEventData & {
  runId: string;
  sequence: number;
  at: string;
};

export interface Run {
  id: string;
  providerId: ProviderId;
  providerName: string;
  folder?: ProjectFolder;
  mode?: WorkspaceMode;
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
  effort?: string;
  mode?: WorkspaceMode;
  model?: string;
}

export interface AppState {
  folder: ProjectFolder | undefined;
  projects: ProjectFolder[];
  runs: Run[];
  mode?: WorkspaceMode;
}

export interface IpcCalls {
  state: () => AppState;
  "inspect-providers": () => Connector[];
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
}

type Invoke<Channel extends keyof IpcCalls> =
  (...args: Parameters<IpcCalls[Channel]>) => Promise<ReturnType<IpcCalls[Channel]>>;

export interface HoneycombApi {
  getState: Invoke<"state">;
  inspectProviders: Invoke<"inspect-providers">;
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
  onRunChanged(callback: (run: Run) => void): () => void;
}
