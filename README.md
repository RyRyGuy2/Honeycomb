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
2. Run `codex login` and choose ChatGPT sign-in to use Codex in **Chat**. Honeycomb uses the existing Codex CLI session in both modes. OpenCode uses its configured provider credentials. Claude Code uses its saved CLI sign-in (`claude`, then `/login`) or `ANTHROPIC_API_KEY`; run `claude update` if Connectors reports the CLI as too old. [Claude Code headless mode](https://code.claude.com/docs/en/headless) · [Codex CLI authentication](https://developers.openai.com/codex/noninteractive#authenticate-in-automation) · [OpenCode provider setup](https://opencode.ai/docs/providers)
3. In **Code**, add a project folder, select the connector and model, and enter a task. Use **Chat** for text-only questions without a project. Both modes list models from the selected CLI. Claude Code in Chat runs with every tool turned off.

Use Code with trusted local folders. Codex uses its read-only sandbox. OpenCode uses agent permissions for project reads and searches. Claude Code gets only its Read, Grep and Glob tools, denies `.env` reads, loads no MCP servers, slash commands or project `.claude` settings and hooks, and keeps no session on disk. Your user-level Claude Code settings and hooks still apply. Your selected CLI can send the prompt and relevant code to its configured model. Responses stream into the transcript, and adjacent tool steps are expandable. Each run has a five-minute limit. Honeycomb saves projects and transcripts locally and shows the three newest chats per project until you expand the list.

Honeycomb gives each OpenCode review a temporary in-memory database. OpenCode loads its global model settings and saved provider credentials for the run. [OpenCode database setting](https://github.com/anomalyco/opencode/blob/v1.14.20/packages/opencode/src/storage/db.ts#L33-L38)

Use the **Model** dropdown in **Chats** or **Connectors**. Honeycomb saves a separate Code choice for Codex, OpenCode and Claude Code. Claude Code offers the `sonnet`, `opus` and `haiku` aliases, which resolve to the latest model in each family. The composer offers thinking levels when the selected model advertises them. OpenCode models come from the local CLI and public catalog. A public OpenCode model must appear in the local list before selection. **Test model** sends a short OpenCode prompt to verify that the selected model can answer. [OpenCode model selection](https://opencode.ai/docs/models/)

Run `npm test` to verify release selection, download integrity, model discovery, and rate-limit handling.

## Project layout

| Path | Responsibility |
| --- | --- |
| `src/main` | Electron window, native folder picker, and IPC bridge |
| `src/renderer` | Chats, Workflows, and Connectors |
| `src/service` | Run lifecycle, event history, and subprocess supervision |
| `src/providers` | CLI detection and provider-specific invocation and event decoding |
| `src/shared` | Types for the desktop bridge, providers, and runs |

See the [design order](docs/design-order.md) for the milestones and how to verify each one.
