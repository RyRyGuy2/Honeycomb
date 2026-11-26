# Honeycomb design order

Honeycomb begins as a local Electron app for directing coding agents. Codex and OpenCode are the first connectors. The first editing milestone is a single agent working in its own Git worktree, with the user reviewing a diff before it can reach the project branch.

## Scope and design source

The project request sets the desktop platform and the initial pair of connectors. The *Honeycomb Design Doc* supplies the architecture, the Chats, Workflows, and Connectors layout, the event model, and the Git review workflow. Claude Code is now a review connector. Gemini CLI can be reconsidered when the owner has access and wants to add it.

## 0. Desktop scaffold and review runs

**Implemented.** The Electron renderer sends requests through a small preload bridge. The main process owns the selected folder and hosts the orchestration service. The service starts one provider at a time, tracks run status and usage, and publishes a bounded event history to Chats. Workflows opens the built-in Solo setup. Connectors checks installed versions. The main process serves bundled assets over the app protocol and verifies the calling frame at the IPC boundary. [Electron security guide](https://www.electronjs.org/docs/latest/tutorial/security)

| Connector | First integration | Permission scope |
| --- | --- | --- |
| Codex | `codex exec --json` with the prompt on standard input and saved CLI authentication. [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive) | Codex read-only sandbox and no interactive approvals |
| Claude Code | `claude -p --output-format stream-json --verbose` with the prompt on standard input and saved CLI sign-in. [Claude Code headless mode](https://docs.claude.com/en/docs/claude-code/headless) | Code allows Read, Grep and Glob, with `.env` reads denied. Chat disables tools. Project settings, project hooks and MCP servers are excluded. |
| OpenCode | OpenCode 1.x `run --format json` with a review agent supplied for the process. The CLI session runs inside its own process. [OpenCode v1 CLI source](https://github.com/anomalyco/opencode/blob/v1.14.20/packages/opencode/src/cli/cmd/run.ts) | OpenCode tool permissions allow project reads and searches |

Run history lives in memory. The app reports provider-supplied token counts and cost when available. An executable check confirms installation. A live run uses the CLI's authentication and default model selection. The task time limit is five minutes.

**Done when** the app opens, both connector states are visible, and a user can select a folder, submit a review task, see activity and completion, and stop an active run. Verify failure handling with missing executables, bad configuration, and provider errors.

## 1. Stabilize the two connector contracts

- Record a run request and events with run ID, sequence, timestamp, provider, provider version, and terminal status. Add a local run store that can restore history and mark interrupted runs after a restart.
- Capture fixtures from supported Codex and OpenCode versions for success, failure, cancellation, and usage. Add an opt-in live smoke check against a small project for each signed-in provider.
- Validate the provider permissions against real tool behavior. Record which tools each connector can expose, which approval decisions it can honor, and where provider-specific configuration applies. Add verified process identity before crash cleanup can act on a recorded PID.
- Keep the CLI integrations until a concrete feature requires a richer surface. Evaluate the Codex app server for interactive permissions or steering. Evaluate an authenticated loopback OpenCode server when cancellation, approvals, or session control need a server API. Compare the API against the version under support. [OpenCode API reference](https://opencode.ai/docs/api)

**Done when** each provider passes the same lifecycle checks, failed runs retain enough context for diagnosis, and restarting Honeycomb restores usable run history.

## 2. Isolated editing and diff review

**Partly implemented.** The Code composer offers **Read-only** review by default and **Edit in worktree** for Codex, OpenCode and Claude Code. Honeycomb reads the project's current commit once, creates a dedicated branch and worktree under its data directory, and reports both in the reply and Run details. Follow-up edits in that conversation reuse the worktree. Chats shows the changed files, a per-file diff (including new files), and available test results. The user can keep the worktree or discard it after confirmation. Applying or merging the diff is a later milestone.

- Resolve the base commit once and create a dedicated branch and Git worktree for each editing run. Show both in Run details. Git worktrees isolate changes to the checkout. The connector's execution controls govern filesystem and command access.
- Enable editing only for providers with verified isolation and approval behavior. Surface requested approvals in Chats for providers that can pause and honor a reply. Keep the run available for review after failure or cancellation.
- Show the base commit, diff, changed files, and test output. Require the user to approve the reviewed result before a merge. If the base or target changed before approval, refresh the review.

**Next** requires an approval gate that applies a reviewed diff to the project branch, plus a refresh when the base or target moved.

## 3. Saved workflows and manual handoffs

See [`workflow-builder-design.md`](./workflow-builder-design.md), [`workflow-builder-implementation-plan.md`](./workflow-builder-implementation-plan.md), and [`workflow-builder-implementation-prompt.md`](./workflow-builder-implementation-prompt.md).

- Build on Solo with a small, versioned workflow format in `.honeycomb/workflows/`. Start with a Codex planning step followed by OpenCode implementation, with a human review gate. Let the user select either connector for each eligible step.
- Pass a short result and the relevant files to the next step. Validate dependencies, connector capabilities, and time limits before starting. Add parallel branches only after a linear workflow works end to end.

**Done when** a saved workflow can be reopened and run in a chosen project, with visible status and a user decision at the review gate.

## 4. Delegation and shared limits

- Add a local, authenticated MCP surface for delegation after handoffs work. Start with listing eligible agents, delegating a brief, and retrieving its result. Attribute each request to its parent run.
- Enforce depth, concurrency, time, and any measurable cost limits across a task before starting child runs. Show the delegated brief and result in Chats. Treat provider output as data when it enters a new run.

**Done when** the user starts one bounded delegated task, reviews both runs, and can stop the task and its active children.

## 5. Project context and more providers

Add historical usage and policy-aware cost limits as provider data becomes reliable. Evaluate Graphify against a representative local project before adding it as a context source. Add more connectors through the same run contract based on access and demand. Grow the workflow editor once the saved format is stable.

**Idea — switch providers mid-chat.** Let users choose a different provider for the next reply in a saved conversation. Show which recent turns will be sent to the new provider before submitting, and label each reply with the provider that produced it.
