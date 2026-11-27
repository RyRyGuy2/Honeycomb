# Honeycomb

Honeycomb is a local Electron workspace for project reviews and questions with Codex, OpenCode and Claude Code.

## Start the app

Install Node.js 22.12 or later and run these commands from the project directory. The first launch downloads the Electron runtime. [Electron installation guide](https://www.electronjs.org/docs/latest/tutorial/installation)

```sh
npm ci
npm start
```

On Windows, `npm.cmd ci` and `npm.cmd start` also work from PowerShell.

`npm start` builds the TypeScript app before opening Electron. Use `npm run typecheck` to check the source or `npm run build` to compile the app and copy its renderer assets into `dist/`.

1. Open **Connectors** and choose **Add connector** to browse or search the catalog. **Download OpenCode** installs a verified OpenCode 1.x CLI in Honeycomb's data directory on Windows and macOS. **Refresh** checks installation and version. You can also set `HONEYCOMB_CODEX_PATH`, `HONEYCOMB_OPENCODE_PATH` or `HONEYCOMB_CLAUDE_PATH` to an absolute executable path before launching. On Windows, use the native `.exe` for a path override. [OpenCode release assets](https://github.com/anomalyco/opencode/releases/expanded_assets/v1.19.6)
2. Run `codex login` and choose ChatGPT sign-in to use Codex in **Chat**. Honeycomb uses the existing Codex CLI session in both modes. OpenCode uses its configured provider credentials. Claude Code uses its saved CLI sign-in (`claude`, then `/login`) or `ANTHROPIC_API_KEY`. Run `claude update` if Connectors reports that the CLI is too old. [Codex CLI authentication](https://developers.openai.com/codex/noninteractive#authenticate-in-automation) · [OpenCode provider setup](https://opencode.ai/docs/providers) · [Claude Code headless mode](https://code.claude.com/docs/en/headless)
3. In **Code**, add a project folder, select the connector and model, and enter a task. Use **Chat** for questions without a project. OpenCode and Claude Code use their existing model configuration with tools disabled in Chat mode.

**Google Antigravity CLI** and **GitHub Copilot CLI** are available in **Connectors → Add connector**. Install the CLIs, then run `agy` or `copilot login` in a terminal to sign in. Select **Refresh** in Honeycomb to detect them. Both use the model configured in their CLI and support project-free **Chat** and **Code** review. Antigravity uses its plan mode and Copilot limits Code review to file reads and searches. For a custom installation, set `HONEYCOMB_ANTIGRAVITY_PATH` or `HONEYCOMB_GITHUB_COPILOT_PATH` to the absolute executable path before launching Honeycomb. [Antigravity CLI setup](https://antigravity.google/docs/cli/getting-started/) · [GitHub Copilot CLI setup](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli)

### Settings

Use **Settings → Factory reset** to clear Honeycomb’s local history, saved workflows, connections, and Copilot Web sign-in. The app restarts with its defaults. Project files and Git worktrees stay on disk.

**Connector usage** shows quota windows and reset times for supported accounts, plus hourly, daily, and weekly activity recorded by Honeycomb. Codex quota uses the signed-in CLI. To show OpenCode Go quota, set `OPENCODE_GO_API_KEY` or `OPENCODE_API_KEY` to the same Go key used by the CLI before launching Honeycomb.

### Run a Smart workflow

Turn on **Smart** in the Chats composer and select the connector and model you want to orchestrate the task. Choose **Preview first step** to see its proposed worker or **Run Smart** to launch agents as needed. A straightforward request can go to one worker, which completes the task, checks its work, and replies directly. For more involved requests, the orchestrator uses the conversation and prior results to decide what to do next.

Smart favors capable free or local workers and uses quota information to conserve paid usage. If the orchestrator hits its limit, Smart picks another available model, keeps the completed results, and shows the switch in the workflow and a desktop notification. In **Settings → Smart routing**, you can change the connector order, set model strengths and billing preferences, and configure when to use Freebuff. Say “no Freebuff” in the request to exclude it for that run.

When Smart reaches a Freebuff step on Windows, it sends a notification and parks the workflow. Choose **Open Freebuff** whenever you’re ready. Honeycomb copies `/model` before opening the terminal. Paste it and press Enter to open the model picker and copy the task, then select the model, paste the task, and send it. Submit the completed reply in Honeycomb to continue. You can close the app and return to a parked handoff later.

### Plan a workflow

Choose **Plan a workflow** in Workflows to draft and refine a plan. Saved workflows live in Honeycomb’s app data and can be saved without a project. Honeycomb imports existing workflow files from projects already in its saved project list.

In Chats, type `/workflow "Review changes" Focus on the import flow` to run a saved workflow by name. You can also use its ID. The Chats sidebar opens a workflow outline with live step status, and the conversation shows the final reply. The full timeline and reported token counts and costs are available in Workflows. Code steps use the project selected in Code. Editing steps share a Git worktree, where later Code steps can review or revise the changes. Chat steps run without project access.

Choose **Freebuff** as a subagent for a manual handoff. When the workflow reaches that step, Honeycomb copies the prompt and pauses. Paste and send the prompt in Freebuff, then paste the completed reply into the workflow timeline and choose **Submit reply and continue**.

### Chat connectors

In **Connectors → Add connector**, choose **Ollama**, **FreeLLMAPI**, **LM Studio**, **OpenRouter**, **Google Gemini**, **llama.cpp**, **vLLM**, or **Custom OpenAI-compatible**. Start the provider's server if it's local, enter its API base URL and any required key, then save the connection. **Refresh models** loads the catalog, or you can enter a manual model ID. **Test model** sends a short prompt to verify the selection. Choose **Use in Chat** to start a conversation. Each saved connection can have its own server and model. API keys are encrypted using the operating system's credential storage.

On Windows, choose **Microsoft Copilot for Windows** to use the signed-in desktop app. Honeycomb opens Copilot in the foreground, sends the prompt, and reads the reply through its accessibility controls. If those controls are unavailable, send the copied prompt in Copilot and paste the reply back into Honeycomb. Copied rich-text code blocks render as code, and **Save as code** formats a reply you copied as plain source.

Choose **Copilot Web** if you want chats to run in a hidden browser. Select **Sign in to Copilot** and complete your Microsoft sign-in in the window that opens. Honeycomb closes that window when chat is ready and uses its own browser profile for background chats. If your sign-in expires, return to Connectors to sign in again.

### Code runs

Use Code with trusted local folders. In read-only review, Codex uses its read-only sandbox. OpenCode uses agent permissions for project reads and searches. Claude Code gets only its Read, Grep and Glob tools, denies `.env` reads, loads no MCP servers, slash commands or project `.claude` settings and hooks, and keeps no session on disk. Your user-level Claude Code settings and hooks still apply. Your selected CLI can send the prompt and relevant code to its configured model. Responses stream into the transcript, and adjacent tool steps are expandable. Each CLI run has a five-minute limit. Honeycomb saves projects and transcripts locally and shows the three newest chats per project until you expand the list.

Honeycomb gives each OpenCode review a temporary in-memory database. OpenCode loads its global model settings and saved provider credentials for the run. [OpenCode database setting](https://github.com/anomalyco/opencode/blob/v1.14.20/packages/opencode/src/storage/db.ts#L33-L38)

Open a saved chat to ask a follow-up with the same connector. Honeycomb includes recent prompts, replies, and recorded tool calls from that conversation. The composer shows how many earlier turns are included, shortened, or omitted. Expand **Activity** beneath a reply for the recorded tool calls, results, and errors. Choose **New chat** to start with an empty conversation.

In a Code chat with Codex, OpenCode or Claude Code, use the **Project access** selector to switch from **Read-only** to **Edit in worktree**, then send the request. Honeycomb creates a Git branch and worktree from the project's current commit and shows the base commit, worktree path, and per-file diff. Further edit requests in the same chat reuse the worktree. Use **Keep worktree** to retain the branch for review or **Discard worktree** to remove it after confirmation. Codex uses a write sandbox scoped to the worktree. OpenCode uses an edit agent with file and shell permissions in the worktree, with external paths and interactive approvals denied. Claude Code runs from the worktree with the CLI's own tool permissions.

Use the **Model** dropdown in **Chats** or **Connectors**. Honeycomb saves a separate Code choice for Codex, OpenCode and Claude Code. Claude Code offers the `sonnet`, `opus` and `haiku` aliases, which resolve to the latest model in each family. The composer offers thinking levels when the selected model advertises them. OpenCode models come from the local CLI and public catalog. A public OpenCode model must appear in the local list before selection. **Test model** sends a short OpenCode prompt to verify that the selected model can answer. [OpenCode model selection](https://opencode.ai/docs/models/)

On Windows, choose **Freebuff** as the connector in a new Code chat. The first handoff opens the installed Freebuff CLI in a separate Git worktree. Follow-ups reuse the active worktree and reopen its most recent Freebuff conversation. Honeycomb copies your draft. Paste and send it in Freebuff, where you can also choose the model. When you return to Honeycomb, completed Freebuff replies appear in the chat and the diff refreshes below. Use **View chat** on a worktree card to reopen its replies. Open **Worktree options** to start a separate worktree, keep it, or discard it.

Run `npm test` to verify release selection, download integrity, model discovery, rate-limit handling, and worktree editing.

When you switch connectors after a Freebuff handoff, Honeycomb attaches the latest completed Freebuff exchange to your next message. The receiving chat keeps the prompt and reply as context for follow-ups, including model changes. Click **Use reply** on a worktree card to attach its exchange to the current draft, or **Remove Freebuff attachment** to send without it. For a full transcript, use **Copy export command** in the worktree card, run the command in Freebuff, then attach the export from Honeycomb.

## Project layout

| Path | Responsibility |
| --- | --- |
| `src/main` | Electron window, native folder picker, and IPC bridge |
| `src/renderer` | Chats, Workflows, and Connectors |
| `src/service` | Run lifecycle, event history, and subprocess supervision |
| `src/providers` | CLI detection and provider-specific invocation and event decoding |
| `src/shared` | Types for the desktop bridge, providers, and runs |

See the [design order](docs/design-order.md) for the milestones and how to verify each one.
