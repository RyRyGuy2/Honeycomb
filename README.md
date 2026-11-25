# Honeycomb

Honeycomb is a local Electron workspace for directing coding agents. The first version can run a review task with Codex or OpenCode in a folder you select.

## Start the app

Install Node.js 22.12 or later and run these commands from the project directory. The first launch downloads the Electron runtime. [Electron installation guide](https://www.electronjs.org/docs/latest/tutorial/installation)

```sh
npm ci
npm start
```

On Windows, `npm.cmd ci` and `npm.cmd start` also work from PowerShell.

`npm start` builds the TypeScript app before opening Electron. Use `npm run typecheck` to check the source or `npm run build` to compile the app and copy its renderer assets into `dist/`.

1. Open **Connectors** and choose **Add connector** to browse or search the catalog. **Download OpenCode** installs a verified OpenCode 1.x CLI in Honeycomb's data directory on Windows and macOS. **Refresh** checks installation and version. You can also set `HONEYCOMB_CODEX_PATH` or `HONEYCOMB_OPENCODE_PATH` to an absolute executable path before launching. On Windows, use the native `.exe` for a path override. [OpenCode release assets](https://github.com/anomalyco/opencode/releases/expanded_assets/v1.19.6)
2. Set up the model provider if it requires credentials. Codex uses its saved CLI sign-in and default model. OpenCode uses its existing provider credentials and global default model. Honeycomb supports OpenCode 1.14 and newer, including 2.x. [Codex CLI authentication](https://developers.openai.com/codex/noninteractive#authenticate-in-automation) · [OpenCode provider setup](https://opencode.ai/docs/providers)
3. In **Chats**, choose a project folder, select the connector, and enter a review task. **Run details** shows the run status and usage reported by the CLI. Use **Stop run** to cancel.

Review mode is for trusted local folders. Codex uses its read-only sandbox. OpenCode uses agent permissions for project reads and searches. Your selected CLI can send the prompt and relevant code to its configured model. Each run has a five-minute limit, and Honeycomb keeps the most recent 20 runs for the current app session.

Honeycomb gives each OpenCode review a temporary in-memory database. OpenCode loads its global model settings and saved provider credentials for the run. [OpenCode database setting](https://github.com/anomalyco/opencode/blob/v1.14.20/packages/opencode/src/storage/db.ts#L33-L38)

Use the **Model** dropdown in **Chats** or **Connectors**. Honeycomb saves a separate choice for Codex and OpenCode, and each picker offers the CLI default. Codex models come from the installed Codex CLI. OpenCode models come from the local CLI and public catalog. A public OpenCode model must appear in the local list before selection. **Test model** sends a short OpenCode prompt to verify that the selected model can answer. [OpenCode model selection](https://opencode.ai/docs/models/)

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
