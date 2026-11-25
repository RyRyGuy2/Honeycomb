# Honeycomb workflow builder design

**Status:** Design only. Not implemented.

This document refines section 3 of [`design-order.md`](./design-order.md). It describes a small, linear workflow builder that reuses Honeycomb's existing connector, run, worktree, and diff plumbing.

## 1. Summary

Add saved, versioned workflows to the **Workflows** view. A workflow is an ordered list of agent steps and human decision gates. Each agent step chooses a connector, an optional model, an effort level, and a prompt. Steps run one at a time. Short results and the relevant files are passed forward. Gates pause the run until the user approves, rejects with feedback, or stops.

Version 1 is intentionally linear: no parallel branches, no dynamic agent spawning, no automatic merge, and no arbitrary shell steps. The goal is to make a repeatable “plan → implement → review” flow reliable before adding graph features.

## 2. Goals

- Let a user create, save, reopen, edit, and run a workflow in a chosen project folder.
- Support Codex, OpenCode, and Claude Code as step connectors, subject to each connector's capability.
- Allow a different connector and model per step. A blank model means “use the connector default.”
- Reuse the existing run service, provider adapters, worktree manager, event stream, usage reporting, and diff viewer.
- Pass bounded context between steps instead of entire transcripts.
- Keep at least one human gate for every editing workflow.
- Keep workflow run state inspectable and stoppable.
- Store definitions in the project so they can be reviewed alongside code.

## 3. Non-goals for v1

- Parallel branches or conditional DAG execution.
- Automatic commit, merge, rebase, or push.
- Freely nested subagents or MCP delegation.
- Shell/command steps defined in workflow JSON.
- Secrets, API keys, tokens, or environment variables in workflow files.
- Cross-project or cloud-synced workflows.
- Changing the provider midway through a single run outside the saved step order.

These can be added later behind the same step and event contracts.

## 4. Architecture

The existing boundary stays unchanged:

- **Renderer:** owns the Workflows UI. It never spawns a provider or reads arbitrary files directly.
- **Preload:** exposes typed IPC methods for workflow CRUD and run control.
- **Main process:** owns project folder access, schema validation, provider execution, worktrees, and run state.
- **Shared contracts:** define `WorkflowDefinition`, `WorkflowStep`, `WorkflowRunState`, `WorkflowEvent`, and gate decisions.

A new `WorkflowRunner` in the main process composes the existing `createRunService` and `WorktreeManager` rather than duplicating provider streaming. Each agent step becomes one ordinary Honeycomb run with a generated `runId`; the workflow keeps a parent `workflowRunId` so the Chats timeline and run details can be linked.

If any step uses `mode: "edit"`, the runner creates one worktree for the whole workflow run and uses it as the working directory for every step. That keeps a planning step and a later edit step looking at the same files. If no step edits, the workflow runs read-only in the selected project folder.

## 5. Workflow file format

Definitions live in the selected project at:

```text
.honeycomb/workflows/<workflow-id>.json
```

The file id must be URL-safe and match the filename: `^[a-z0-9][a-z0-9-]{0,63}$`.

### Example

```json
{
  "version": 1,
  "id": "plan-implement-review",
  "name": "Plan, implement, review",
  "description": "Plan with Codex, implement with OpenCode, then require human review.",
  "defaults": {
    "provider": "codex",
    "model": "",
    "effort": "medium",
    "timeoutMs": 300000
  },
  "steps": [
    {
      "id": "plan",
      "type": "agent",
      "title": "Plan",
      "provider": "codex",
      "model": "gpt-5-codex",
      "effort": "high",
      "mode": "review",
      "prompt": "Inspect the project and write a short implementation plan.",
      "inputs": ["project"],
      "outputs": ["summary", "files"],
      "timeoutMs": 300000
    },
    {
      "id": "approve-plan",
      "type": "gate",
      "title": "Approve plan",
      "prompt": "Review the plan before implementation.",
      "approveLabel": "Continue",
      "rejectLabel": "Revise plan",
      "onReject": { "target": "plan", "maxRevisions": 2 }
    },
    {
      "id": "implement",
      "type": "agent",
      "title": "Implement",
      "provider": "opencode",
      "model": "anthropic/claude-sonnet-4-20250514",
      "effort": "",
      "mode": "edit",
      "prompt": "Implement the approved plan. Keep all changes in this worktree.",
      "inputs": ["previous.summary", "previous.files", "feedback"],
      "outputs": ["summary", "files", "diff", "tests"],
      "timeoutMs": 300000
    },
    {
      "id": "review-changes",
      "type": "gate",
      "title": "Review changes",
      "prompt": "Approve the diff, or send feedback for another implementation pass.",
      "approveLabel": "Approve",
      "rejectLabel": "Revise",
      "onReject": { "target": "implement", "maxRevisions": 3 }
    }
  ]
}
```

### Fields

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | `1` | Workflow format version. Unknown versions are rejected. |
| `id` | string | Stable id; must match the filename. |
| `name` | string | Display name. |
| `description` | string | Optional short explanation. |
| `defaults` | object | Optional defaults inherited by agent steps. |
| `defaults.provider` | `ProviderId` | Default connector. |
| `defaults.model` | string | Default model id; empty means connector default. |
| `defaults.effort` | string | Default thinking effort where supported. |
| `defaults.timeoutMs` | number | Default per-step timeout. Maximum is 300000 in v1. |
| `steps` | array | Ordered steps. At least one agent step is required. |

### Agent step

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Unique step id. |
| `type` | `"agent"` | Runs a connector. |
| `title` | string | Short label for the timeline. |
| `provider` | `ProviderId` | Connector id: `codex`, `opencode`, or `claude`. |
| `model` | string | Optional; empty or omitted uses the connector default. |
| `effort` | string | Optional; empty or omitted uses the connector default. |
| `mode` | `"review"` or `"edit"` | Default is `review`. `edit` requires a supported connector and a Git project. |
| `prompt` | string | User-authored instruction. Maximum 8000 characters. |
| `inputs` | string[] | Context supplied to the step. See below. |
| `outputs` | string[] | Declarative result fields shown in the run view. |
| `timeoutMs` | number | Overrides the default timeout. |

### Gate step

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Unique step id. |
| `type` | `"gate"` | Pauses for a human decision. |
| `title` | string | Short label for the timeline. |
| `prompt` | string | What the user is approving. |
| `approveLabel` | string | Optional button label; default is “Continue”. |
| `rejectLabel` | string | Optional button label; default is “Send feedback”. |
| `onReject.target` | string | Id of an earlier agent step to rerun. |
| `onReject.maxRevisions` | number | 1–5; caps feedback loops. |

### Allowed inputs

- `project`: project name and path.
- `previous.summary`: bounded summary of the immediately preceding agent result.
- `previous.files`: relevant changed or referenced file paths.
- `previous.diff`: bounded diff text, only when a worktree exists.
- `previous.tests`: test commands and results reported by the previous step.
- `feedback`: the latest rejection note, if present.
- `worktree`: base commit, branch, and path when a worktree exists.

Workflow JSON never includes `cwd`, `args`, `env`, credentials, or shell commands.

## 6. Handoff contract

Each agent step returns a bounded result:

```ts
interface AgentStepResult {
  runId: string;
  status: "completed" | "failed" | "cancelled";
  summary: string;
  files: string[];
  diff?: string;
  tests?: string[];
  usage?: RunUsage;
}
```

The runner builds the next prompt from declared `inputs`, not from the raw transcript. Provider output is treated as untrusted data: delimited, escaped where necessary, and capped. Suggested limits:

- summary: 8,000 characters,
- diff: 32,000 characters,
- files: 100 paths,
- total handoff context: 64,000 characters,
- gate feedback: 4,000 characters.

If a result is shortened, the next prompt and run view say so. The full run remains available in the linked Chats transcript.

## 7. Runtime state machine

```text
idle
  -> running
  -> waiting_for_gate
  -> running
  -> completed | failed | cancelled | interrupted
```

The runner:

1. Loads and validates the definition.
2. Checks connector availability and model compatibility.
3. Creates one worktree if any step uses `mode: "edit"`.
4. Iterates steps in order.
5. For an agent step, starts a normal Honeycomb run, relays its events, waits for a terminal status, and stores a bounded `AgentStepResult`.
6. For a gate, stores its state and waits for `approve`, `reject`, or `stop`.
7. On approve, advances to the next step.
8. On reject, increments the target step's revision count and reruns that step with `feedback`.
9. On `maxRevisions` exceeded, fails the run with an actionable message.
10. On final completion, leaves any worktree in place for the user to keep or discard.

Only one step is active at a time. Stop cancels the active provider run and marks the workflow cancelled. Failed steps do not auto-retry in v1; the user can rerun the workflow or reject a gate that targets the failed step.

## 8. Persistence

Definitions are project-local and intended to be committed with the project. Run state and history stay in Honeycomb's application data so runs do not dirty the Git checkout:

```text
<userData>/workflows/<projectHash>/runs/<workflowRunId>.json
```

A run record stores:

- workflow id and a frozen copy of the definition,
- selected project path and base commit,
- worktree record id, branch, and path,
- current step index and status,
- bounded step results and gate decisions,
- aggregated usage,
- terminal status and timestamps.

On app restart, active runs are marked `interrupted`. Resume from the last completed step is a later milestone; v1 keeps the record visible and lets the user start a fresh run.

## 9. IPC surface

Add typed channels following the existing preload pattern:

| Channel | Request | Result |
| --- | --- | --- |
| `workflow:list` | `{ projectPath }` | `WorkflowSummary[]` |
| `workflow:read` | `{ projectPath, id }` | `WorkflowDefinition` |
| `workflow:save` | `{ projectPath, definition }` | `WorkflowSummary` |
| `workflow:delete` | `{ projectPath, id }` | `void` |
| `workflow:start` | `{ projectPath, id }` | `WorkflowRunState` |
| `workflow:decide` | `{ runId, gateId, decision, note? }` | `WorkflowRunState` |
| `workflow:stop` | `{ runId }` | `void` |
| `workflow:listRuns` | `{ projectPath }` | `WorkflowRunSummary[]` |
| `workflow:readRun` | `{ runId }` | `WorkflowRunState` |
| `workflow:event` | push channel | `WorkflowEvent` |

The main process reuses its existing calling-frame verification and rejects paths outside the selected project.

## 10. Renderer UI

The Workflows view gains three sections:

- **Solo** — unchanged currently.
- **Saved** — list of workflow definitions with **New**, **Open**, **Duplicate**, **Save**, **Save as**, and **Delete**.
- **Runs** — recent workflow runs with status and links to their timelines.

### Editor

The editor shows metadata and an ordered step list. Each row has move up/down, duplicate, and remove controls. The step form changes by type:

- Agent: title, connector, model, effort, mode, prompt, inputs, outputs, timeout.
- Gate: title, prompt, approve/reject labels, rejection target, maximum revisions.

The model control is a free-text/combobox seeded from the selected connector's catalog. Blank is displayed as **Connector default** and stored as `""`. Effort follows the same pattern. Validation errors appear inline, and **Run** is disabled until the definition is valid and the selected connector is detected.

### Run view

The run view is a vertical timeline:

- step title, connector, model, mode, and status,
- streamed text, tool activity, usage, and notices relayed from the underlying run,
- worktree card with base commit, branch, path, and keep/discard actions,
- diff viewer reused from Chats,
- gate card with approve, send feedback, and stop actions.

The user's gate decision is shown in the timeline. A rejected decision shows the feedback and the revision number of the rerun.

## 11. Validation

Validation runs on save and again on start.

- Supported `version`.
- Safe `id` that matches the filename.
- Unique step ids.
- At least one agent step.
- Gates must follow an agent step; the final step of an editing workflow should be a gate.
- `onReject.target` must name an earlier agent step.
- `maxRevisions` is 1–5.
- Connector ids are known; editing connectors must satisfy `supportsWorktreeEditing()`.
- Model ids are checked against the selected connector's catalog when available; blank is always valid.
- Effort values are parsed by the connector where supported.
- `timeoutMs` is between 30,000 and 300,000.
- Prompts and gate notes respect length limits.
- No unknown fields are silently accepted.
- No secret-like field names are allowed in definitions.

Model availability is rechecked at run time because connector catalogs can change between save and run.

## 12. Security

- Workflow JSON is data, never code. There is no step type that can execute arbitrary shell commands.
- The main process owns all file access and provider execution.
- The project path and workflow id are validated before any read or write.
- Provider output passed to another step is treated as untrusted prompt content and bounded.
- Read-only steps keep the existing no-edit permissions.
- Edit steps use the existing scoped worktree permissions for Codex, OpenCode, and Claude Code.
- External directories, `.env` reads, interactive approvals, project settings, and MCP servers stay denied where the connector contract already denies them.
- One worktree per workflow run; no branch is applied or merged automatically.
- Credentials remain in the provider CLI configuration or environment, never in workflow files.
- Event history and handoff text are bounded to prevent unbounded memory growth.

## 13. Events

```ts
type WorkflowEvent =
  | { type: "workflow/started"; workflowRunId: string; workflowId: string }
  | { type: "step/started"; stepId: string; runId?: string }
  | { type: "step/event"; stepId: string; event: StreamEvent }
  | { type: "step/completed"; stepId: string; result: AgentStepResult }
  | { type: "step/failed"; stepId: string; message: string }
  | { type: "gate/waiting"; gateId: string }
  | { type: "gate/decided"; gateId: string; decision: GateDecision }
  | { type: "worktree/created"; baseCommit: string; branch: string; path: string }
  | { type: "usage"; usage: RunUsage }
  | { type: "workflow/completed"; workflowRunId: string }
  | { type: "workflow/failed"; workflowRunId: string; message: string }
  | { type: "workflow/cancelled"; workflowRunId: string };
```

The renderer receives a bounded history plus live events. Delta events may be truncated for storage, but terminal results, gate decisions, and usage are retained.

## 14. Failure handling

| Failure | Behavior |
| --- | --- |
| Connector not detected | Fail before starting; show connector setup guidance. |
| Model not found | Fail before starting with the provider's actionable message. |
| Missing Git repository | Reject workflows containing edit steps before creating a worktree. |
| Provider sign-in failure | Fail the step, preserve earlier results, show the existing sign-in guidance. |
| Timeout or user stop | Cancel the active run, attach any partial diff, mark workflow cancelled. |
| Gate reject | Rerun the target step with feedback until `maxRevisions` is reached. |
| Revision limit exceeded | Fail the workflow with the gate and revision count. |
| App restart during a run | Mark the run `interrupted`; keep the record for inspection. |
| Project HEAD moved during run | Show a stale-base warning at the gate; never auto-merge. |

## 15. Testing

- **Schema tests:** version handling, safe ids, unique steps, gate targets, model defaults, timeout bounds, unknown fields.
- **Save/read tests:** round-trip `.honeycomb/workflows/*.json`, duplicate ids, path traversal rejection.
- **Handoff tests:** bounded summary/diff/files, feedback injection, escaping, truncation notice.
- **Runner tests with fake providers:** happy path, gate approve, gate reject loop, revision limit, failure, stop, worktree reuse, usage aggregation, event ordering.
- **IPC tests:** main-process validation, out-of-project paths, malformed decisions.
- **Renderer tests:** editor forms, model selector default state, inline validation, timeline, gate decisions, diff display.
- **Integration smoke:** `plan → implement → review` using Codex then OpenCode on a small Git fixture.

## 16. Milestones

### M1 — Format and linear runner

Implement schema, `.honeycomb/workflows/` persistence, `WorkflowRunner`, gate decisions, and fake-provider tests. **Done when** a saved workflow runs linearly in a chosen project, pauses at a gate, and shows status and results.

### M2 — Editor and run UI

Replace the Workflows placeholder with Saved, Runs, and the step editor. Add connector/model selectors and inline validation. Reuse the Chats diff viewer. **Done when** a user can create, edit, save, and run a workflow without hand-editing JSON.

### M3 — Robustness

Add interrupted-run display, manual step retry, stale-base warnings, worktree keep/discard from the run view, and smoke checks with all three connectors. **Done when** failures and cancellations leave an inspectable, recoverable run.

### Later

Parallel branches, conditional edges, MCP delegation, automatic apply/merge gates, historical cost limits, and shared workflow templates.

## 17. Acceptance criteria for v1

A user can:

1. Open **Workflows**, create a saved workflow, and choose Codex for planning and OpenCode for implementation.
2. Select a different model for each step or leave the model blank to use the connector default.
3. Run it in a Git project and see each step's status, streamed output, and usage.
4. Review a plan at a gate and either continue or send feedback that reruns the planning step.
5. Review the implementation diff in a dedicated worktree and either approve or send feedback that reruns the implementation step.
6. Stop the run at any point and keep or discard the worktree afterward.
7. Reopen the workflow from `.honeycomb/workflows/` and run it again.
