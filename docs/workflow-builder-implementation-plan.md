# Workflow builder implementation plan

**Status:** Ready to implement.  
**Design source:** [`workflow-builder-design.md`](./workflow-builder-design.md)  
**Scope:** v1 linear workflows: saved definitions, agent steps, human gates, per-step connector/model, one shared worktree, and a runnable editor UI.

This plan is for M1 and M2 of the design doc. M3 and “Later” items stay out of scope unless requested.

## 1. locked decisions

These are fixed for v1:

1. Workflow definitions live in the selected project at `.honeycomb/workflows/<id>.json`.
2. The definition format is `version: 1`.
3. Agent steps use CLI connectors only: `codex`, `opencode`, `claude`.
4. Each agent step has `model?: string`; an empty string means the connector default.
5. Workflows are linear. No conditions, branches, or parallel steps.
6. A workflow run creates at most one Git worktree and reuses it for every step.
7. Read-only steps run in that worktree too when one exists, so every step sees the same files.
8. Gates approve, reject with feedback, or stop. Rejection reruns a named earlier agent step with a bounded revision count.
9. The runner never commits, merges, rebases, or pushes.
10. Run state and history stay in Honeycomb's `userData`, not in the project.
11. Underlying agent runs remain normal Honeycomb runs and stay visible in Chats; the Workflows timeline links to them.
12. No shell steps, secrets, tokens, environment fields, or arbitrary executable paths can be stored in a workflow.

## 2. current integration points

Reuse these; do not replace them.

| Area | Current code | How workflows use it |
| --- | --- | --- |
| Run lifecycle | `src/service/runs.ts` `createRunService()` | Each agent step starts one normal run. |
| Worktree isolation | `src/service/worktree.ts` `createWorktreeManager()` | One worktree per workflow run. |
| Providers | `src/providers/*` | Existing Codex/OpenCode/Claude adapters and model catalogs. |
| Editing support | `src/shared/editing.ts` `supportsWorktreeEditing()` | Validate `mode: "edit"` steps. |
| IPC | `src/shared/contracts.ts`, `src/main/preload.cts`, `src/main/index.ts` `handle()` | Add typed workflow channels behind the same frame check. |
| Renderer views | `src/renderer/index.html`, `src/renderer/app.ts` `showView()` | Expand the existing Workflows/Solo view. |
| Persistence pattern | `src/service/chat-profiles.ts` | Mirror atomic JSON writes for workflow stores. |
| Tests | `test/*.test.mjs` | Add pure, service, IPC-shape, and UI-logic coverage. |

## 3. files to add

| File | Responsibility |
| --- | --- |
| `src/shared/workflows.ts` | Pure types, schema validation, prompt handoff builder, and bounded result extraction helpers. Importable by both main and renderer. |
| `src/service/workflow-store.ts` | Project-local `.honeycomb/workflows/` CRUD with safe ids, atomic writes, and size limits. |
| `src/service/workflow-runner.ts` | Linear state machine: start steps, await runs, wait for gates, revision loops, stop, persistence. |
| `src/service/workflow-history.ts` | `userData/workflow-runs.json` store for run records and summaries. |
| `src/renderer/workflow-editor.ts` | Renderer helpers for step forms, model inputs, timeline rows, and gate cards. Keep DOM code out of `app.ts` where practical. |
| `test/workflow-validation.test.mjs` | Schema, handoff bounds, model default, gate target, and revision-limit tests. |
| `test/workflow-store.test.mjs` | Save/read/list/delete, unsafe ids, path traversal, malformed files. |
| `test/workflow-runner.test.mjs` | Fake run service: success, approve, reject loop, failure, stop, worktree reuse, usage aggregation, event order. |

Types used over IPC go in `src/shared/contracts.ts`, not in `src/shared/workflows.ts`.

## 4. contracts to add

In `src/shared/contracts.ts`:

```ts
export type WorkflowStepType = "agent" | "gate";
export type WorkflowStepMode = "review" | "edit";
export type WorkflowRunStatus =
  | "running" | "waiting_for_gate" | "completed" | "failed" | "cancelled" | "interrupted";

export interface WorkflowDefaults {
  provider?: CliProviderId;
  model?: string;
  effort?: string;
  timeoutMs?: number;
}

export interface WorkflowAgentStep {
  id: string;
  type: "agent";
  title: string;
  provider: CliProviderId;
  model?: string;
  effort?: string;
  mode?: WorkflowStepMode;
  prompt: string;
  inputs?: string[];
  outputs?: string[];
  timeoutMs?: number;
}

export interface WorkflowGateStep {
  id: string;
  type: "gate";
  title: string;
  prompt: string;
  approveLabel?: string;
  rejectLabel?: string;
  onReject?: { target: string; maxRevisions: number };
}

export type WorkflowStep = WorkflowAgentStep | WorkflowGateStep;

export interface WorkflowDefinition {
  version: 1;
  id: string;
  name: string;
  description?: string;
  defaults?: WorkflowDefaults;
  steps: WorkflowStep[];
}

export interface WorkflowSummary {
  id: string;
  name: string;
  description?: string;
  stepCount: number;
}

export interface AgentStepResult {
  stepId: string;
  runId: string;
  status: FinishedRunStatus;
  summary: string;
  files: string[];
  diff?: RunDiff;
  tests: string[];
  usage: RunUsage;
}

export type WorkflowDecision = "approve" | "reject" | "stop";

export interface GateDecision {
  gateId: string;
  decision: WorkflowDecision;
  note?: string;
  at: string;
}

export interface WorkflowRunRecord {
  id: string;
  projectPath: string;
  workflowId: string;
  definition: WorkflowDefinition;
  status: WorkflowRunStatus;
  stepIndex: number;
  startedAt: string;
  finishedAt?: string;
  baseCommit?: string;
  worktree?: RunWorktree;
  results: AgentStepResult[];
  decisions: GateDecision[];
  revisions: Record<string, number>;
  usage: RunUsage;
  message?: string;
}
```

IPC calls to add:

```ts
"workflow-list": (projectPath: string) => WorkflowSummary[];
"workflow-read": (request: { projectPath: string; id: string }) => WorkflowDefinition;
"workflow-save": (request: { projectPath: string; definition: unknown }) => WorkflowSummary;
"workflow-delete": (request: { projectPath: string; id: string }) => void;
"workflow-validate": (definition: unknown) => string[];
"workflow-start": (request: { projectPath: string; id: string }) => WorkflowRunRecord;
"workflow-decide": (request: { runId: string; gateId: string; decision: WorkflowDecision; note?: string }) => WorkflowRunRecord;
"workflow-stop": (runId: string) => void;
"workflow-list-runs": (projectPath: string) => WorkflowRunRecord[];
"workflow-read-run": (runId: string) => WorkflowRunRecord;
```

Add a push channel `honeycomb:workflow-changed` and preload method `onWorkflowChanged(callback): () => void`.

## 5. run service changes

`createRunService()` currently has one active run and does not expose a terminal promise for a specific `runId`. Add two small methods:

```ts
runById(id: string): Run | undefined;
waitForRun(id: string): Promise<Run>;
```

`waitForRun()` resolves when that run reaches `completed`, `failed`, or `cancelled`. Do not change the existing publish or event shape.

Extend `StartRunRequest` with an internal field:

```ts
/** Use this existing Honeycomb worktree instead of creating one from chat history. */
worktreeId?: string;
```

In `runs.start()`:

- resolve `worktreeId` through `worktrees.find()` and `worktrees.exists()`,
- reject ids outside the selected project,
- use the resolved worktree when `edit` is true,
- keep the existing conversation-based worktree behavior unchanged.

This lets workflow steps with different providers share one worktree without violating the “same provider per chat” rule.

## 6. shared validation and handoff

`src/shared/workflows.ts` exposes:

```ts
validateWorkflow(value: unknown): string[]
parseWorkflow(value: unknown): WorkflowDefinition
buildHandoffPrompt(request: HandoffRequest): string
extractStepResult(run: Run, step: WorkflowAgentStep): AgentStepResult
```

Validation rules:

- `version === 1`;
- safe id matching `^[a-z0-9][a-z0-9-]{0,63}$`;
- at least one agent step;
- unique step ids;
- gates follow an agent step;
- `onReject.target` names an earlier agent step;
- `maxRevisions` is 1–5;
- `provider` is a CLI connector id;
- `mode: "edit"` only for `supportsWorktreeEditing()` providers;
- `model` is a string up to 512 chars; empty means default;
- `effort` is a string up to 64 chars; empty means default;
- `prompt` is 1–8000 chars with no NUL;
- `timeoutMs` is 30,000–300,000;
- `inputs` and `outputs` only use allowed tokens from the design doc;
- unknown top-level and step fields are rejected.

Handoff builder:

- never includes the raw transcript;
- includes only declared inputs;
- caps summary 8,000 chars, diff 32,000 chars, files 100 paths, feedback 4,000 chars, total 64,000 chars;
- adds a truncation notice when anything is shortened;
- labels provider output as untrusted context;
- always ends with the current step prompt.

`extractStepResult()`:

- summary: last `message` event text, else the `finished` event text;
- files: `run.diff?.files.map(path)` for edit steps;
- tests: `test_result` events;
- usage: `run.usage`;
- diff: `run.diff`.

## 7. stores

### Workflow store

`createWorkflowStore(projectPathFor: () => string | undefined)`:

- directory: `<project>/.honeycomb/workflows/`;
- only safe ids;
- reject symlink/path escape by resolving and checking containment;
- max file size 64 KB;
- parse with `parseWorkflow()`;
- write `${id}.json.tmp` then rename;
- return summaries sorted by name.

### Workflow history store

`createWorkflowHistoryStore(filename: () => string)`:

- JSON shape `{ version: 1, runs: WorkflowRunRecord[] }`;
- cap at 100 runs, dropping oldest terminal runs first;
- cap each record's results and decisions to 100 entries;
- mirror `chat-profiles.ts` atomic writes;
- mark active runs `interrupted` on load.

## 8. runner

`createWorkflowRunner({ runs, worktrees, history, publish })` returns `start`, `decide`, `stop`, `list`, `read`, and `shutdown`.

Start sequence:

1. Reject if a workflow or ordinary run is already active.
2. Load the saved definition by project path and id.
3. Validate again in the main process.
4. Check selected CLI connectors are detected; best-effort model catalog check.
5. If any step has `mode: "edit"`, verify the project is a Git repo, call `worktrees.inspect()`, then `worktrees.create()` once and store the record.
6. Create the `WorkflowRunRecord` with `status: "running"`, `stepIndex: 0`, `baseCommit`, and `worktree`.
7. Process steps sequentially.

Agent step execution:

1. Build a prompt with `buildHandoffPrompt()`.
2. Call `runs.start(project, { providerId, prompt, model, effort, mode: "code", edit, worktreeId }, undefined)`.
3. Publish a workflow event linking `stepId` to `runId`.
4. Await `runs.waitForRun(runId)`.
5. Store `extractStepResult()` and aggregate usage.
6. Terminal failure stops the workflow with `status: "failed"`.

Gate execution:

1. Set `status: "waiting_for_gate"` and publish.
2. Wait for `decide()` matching the current gate id.
3. `approve`: advance to the next step.
4. `stop`: finish as `cancelled`.
5. `reject`: require `note`; increment `revisions[target]`; if over `maxRevisions`, fail; otherwise set `stepIndex` to the target step and rerun with `feedback`.

Stop behavior:

- if a run is active, call `runs.stop(stepRunId)`;
- if waiting at a gate, finish immediately;
- keep the worktree active for review;
- never discard automatically.

Publish on every state change. The renderer can combine `workflow-changed` with existing `run-changed` events; do not duplicate provider stream events into the workflow record.

## 9. main process wiring

In `src/main/index.ts`:

- instantiate the three new services next to `runs`, `worktrees`, and `chatProfiles`;
- load workflow history during startup;
- register the new `handle()` channels;
- validate `projectPath` against `folder.path` for all definition operations;
- validate `runId` ownership for decide/stop/read;
- include workflow runs in `workspaceState()` only as summaries if needed;
- call `workflowRunner.shutdown()` during app shutdown.

All new handlers must pass through the existing `handle()` frame-origin check. Do not add direct `ipcMain.handle()` calls.

## 10. preload and renderer

Preload adds typed wrappers for each new channel and `onWorkflowChanged()` following `onRunChanged()`.

Renderer work in `src/renderer/index.html` and `src/renderer/app.ts`:

- Workflows sidebar gains **New workflow**, a saved-workflow list, and a recent-runs list.
- Main panel gains `workflow-editor` and `workflow-run` sections beside the existing Solo card.
- `showView("workflows")` loads definitions and runs on first open and after saves.
- Editor state: `workflowDraft`, `workflowDirty`, `selectedWorkflowId`, `selectedWorkflowRunId`.
- Step forms:
  - agent: title, connector select, model text/combobox, effort, mode, prompt, inputs, outputs, timeout;
  - gate: title, prompt, approve/reject labels, reject target, max revisions.
- Model input uses `listModels(provider)` for suggestions; blank displays as **Connector default**.
- Save calls `workflow-validate` first and shows returned errors inline.
- Run view:
  - vertical timeline from step order;
  - status per step;
  - active step events from the linked `Run` via `onRunChanged()`;
  - worktree card with base commit, branch, path, keep/discard buttons;
  - diff viewer reused from Chats;
  - gate card with approve, textarea for feedback, reject, and stop.
- Keep Solo unchanged and available.

## 11. verification

Run after implementation:

```powershell
npm run typecheck
npm test
```

Expected new tests:

- validation rejects unknown fields, bad gate targets, non-linear ids, invalid models/modes/timeouts;
- blank model survives round-trip and remains blank in the definition;
- handoff caps and truncation notice;
- store rejects `../`, absolute paths, and unsafe ids;
- runner happy path with two agent steps and one gate;
- runner reject loop reruns the correct target and respects `maxRevisions`;
- runner failure stops the workflow and preserves prior results;
- runner stop cancels the active run;
- all edit steps share one worktree id;
- usage is aggregated across steps.

Manual smoke:

1. Create a workflow with Codex review step, approve gate, OpenCode edit step, and final review gate.
2. Save it and reopen it from `.honeycomb/workflows/`.
3. Run it in a small Git project.
4. Approve the plan, review the worktree diff, reject once with feedback, then approve.
5. Stop a separate run mid-step and confirm status is cancelled.
6. Confirm no workflow file contains secrets or run history.

## 12. done criteria

v1 is done when a user can create, save, reopen, edit, run, approve, reject, stop, and review a linear workflow entirely in the UI, with per-step connector/model selection, a shared worktree, visible diff review, and passing typecheck/tests.
