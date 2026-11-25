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

### Chat connectors

In **Connectors → Add connector**, choose **Ollama**, **FreeLLMAPI**, **LM Studio**, **OpenRouter**, **Google Gemini**, **llama.cpp**, **vLLM**, or **Custom OpenAI-compatible**. Start the provider's server if it's local, enter its API base URL and any required key, then save the connection. **Refresh models** loads the catalog, or you can enter a manual model ID. **Test model** sends a short prompt to verify the selection. Choose **Use in Chat** to start a conversation. Each saved connection can have its own server and model. API keys are encrypted using the operating system's credential storage.

On Windows, choose **Microsoft Copilot for Windows** to use the signed-in desktop app. Honeycomb can send text through the app's accessibility controls and bring the completed reply back. Keep the original Copilot conversation open for automatic follow-ups. If the controls are unavailable, Honeycomb guides you through sending the copied prompt and pasting the reply.

### Code runs

Use Code with trusted local folders. In read-only review, Codex uses its read-only sandbox. OpenCode uses agent permissions for project reads and searches. Claude Code gets only its Read, Grep and Glob tools, denies `.env` reads, loads no MCP servers, slash commands or project `.claude` settings and hooks, and keeps no session on disk. Your user-level Claude Code settings and hooks still apply. Your selected CLI can send the prompt and relevant code to its configured model. Responses stream into the transcript, and adjacent tool steps are expandable. Each CLI run has a five-minute limit. Honeycomb saves projects and transcripts locally and shows the three newest chats per project until you expand the list.

Honeycomb gives each OpenCode review a temporary in-memory database. OpenCode loads its global model settings and saved provider credentials for the run. [OpenCode database setting](https://github.com/anomalyco/opencode/blob/v1.14.20/packages/opencode/src/storage/db.ts#L33-L38)

Open a saved chat to ask a follow-up with the same connector. Honeycomb includes recent prompts, replies, and recorded tool calls from that conversation. The composer shows how many earlier turns are included, shortened, or omitted. Expand **Activity** beneath a reply for the recorded tool calls, results, and errors. Choose **New chat** to start with an empty conversation.

In a Code chat with Codex, OpenCode or Claude Code, use the **Project access** selector to switch from **Read-only** to **Edit in worktree**, then send the request. Honeycomb creates a Git branch and worktree from the project's current commit and shows the base commit, worktree path, and per-file diff. Further edit requests in the same chat reuse the worktree. Use **Keep worktree** to retain the branch for review or **Discard worktree** to remove it after confirmation. Codex uses a write sandbox scoped to the worktree. OpenCode uses an edit agent with file and shell permissions in the worktree, with external paths and interactive approvals denied. Claude Code runs from the worktree with the CLI's own tool permissions.

Use the **Model** dropdown in **Chats** or **Connectors**. Honeycomb saves a separate Code choice for Codex, OpenCode and Claude Code. Claude Code offers the `sonnet`, `opus` and `haiku` aliases, which resolve to the latest model in each family. The composer offers thinking levels when the selected model advertises them. OpenCode models come from the local CLI and public catalog. A public OpenCode model must appear in the local list before selection. **Test model** sends a short OpenCode prompt to verify that the selected model can answer. [OpenCode model selection](https://opencode.ai/docs/models/)

On Windows, choose **Freebuff** as the connector in a new Code chat. The first handoff opens the installed Freebuff CLI in a separate Git worktree. Follow-ups reuse the active worktree and reopen its most recent Freebuff conversation. Honeycomb copies your draft. Paste and send it in Freebuff, where you can also choose the model. Back in Honeycomb, the latest diff refreshes automatically. Open **Worktree options** to start a separate worktree, keep it, or discard it.

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
