# Workflow builder implementation prompt

Use this prompt to have a coding agent implement v1 of the workflow builder. Update the docs first if the plan changes.

```text
Implement the Honeycomb workflow builder v1 in this repository.

First read these files and follow them as the source of truth:
- docs/workflow-builder-design.md
- docs/workflow-builder-implementation-plan.md
- docs/design-order.md section 3

Assumption: implement M1 and M2 from the design doc. Do not implement M3 or the "Later" section unless I ask.

Goal:
Build a linear workflow builder with saved JSON workflows, agent steps, human review gates, per-step connector/model selection, one shared Git worktree per run, and a runnable UI in the existing Workflows view.

Hard constraints:
- Do not break existing Chats, Connectors, Freebuff, or worktree behavior.
- Preserve all existing uncommitted work in the repository. Do not revert or overwrite unrelated files.
- Workflow definitions are data, never code. No shell steps, env fields, executable paths, secrets, API keys, or tokens in workflow JSON.
- Only CLI connectors (codex, opencode, claude) are valid for agent steps.
- A blank model means the connector default. Do not replace it with a hardcoded model.
- Workflows are linear. No branches, conditions, parallel steps, or dynamic subagents.
- Never commit, merge, rebase, push, keep, or discard worktrees automatically.
- Use the existing createRunService and createWorktreeManager; do not duplicate provider streaming logic.
- All IPC must go through the existing typed handle() boundary in src/main/index.ts and preload.cts.
- Run state belongs in userData, not in the project. Definitions belong in the project at .honeycomb/workflows/.

Implementation order:
1. Add workflow types and IPC channels to src/shared/contracts.ts.
2. Add pure validation and handoff helpers in src/shared/workflows.ts.
3. Add workflow definitions/history stores under src/service/.
4. Extend createRunService with runById() and waitForRun(), and add an internal worktreeId field to StartRunRequest so steps with different providers can share one worktree.
5. Add a workflow runner that processes steps sequentially, awaits each run, pauses at gates, handles rejection loops with a revision cap, and publishes state changes.
6. Wire the new typed IPC channels and workflow-changed push event through src/main/index.ts and src/main/preload.cts.
7. Expand the Workflows sidebar and main panel in src/renderer/index.html and src/renderer/app.ts. Keep Solo available.
8. Add the editor: step add/remove/reorder, connector select, model input with blank default, effort, mode, prompt, inputs/outputs, timeout, and gate settings.
9. Add the run view: step timeline, linked run activity, worktree card, diff viewer reused from Chats, and approve/reject/stop gate controls.
10. Add tests for validation, stores, handoff bounds, runner transitions, rejection loops, stop, failure, and worktree reuse.

Acceptance criteria:
- A user can create, save, reopen, edit, and delete a workflow from the Workflows UI.
- A saved workflow can run in a chosen Git project with visible per-step status and streamed activity.
- Agent steps can use different connectors and different models; blank model uses the connector default.
- A planning step can be approved at a gate, and rejection sends bounded feedback to a named earlier step.
- An edit step creates one worktree for the workflow and every later step uses that same worktree.
- The user can review the worktree diff and keep/discard the worktree using existing controls.
- Stopping a workflow cancels the active step or closes a waiting gate and records a cancelled status.
- Run state survives app restart as interrupted/completed records without writing run history into the project.
- npm run typecheck and npm test pass.

Verification:
Run npm run typecheck and npm test before reporting done. Include the test count.

Report back with:
- files added and modified,
- any deviations from the design/implementation plan and why,
- verification results,
- anything intentionally left out.
```

## Notes for follow-up prompts

If the first implementation pass is too large, split it:

1. **Core only:** contracts, validation, stores, runner, IPC, service tests.
2. **UI:** editor and run timeline.
3. **Robustness:** restart recovery, stale-base checks, retry, keep/discard from the run view.
