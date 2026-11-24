# Honeycomb

Honeycomb is a local Electron workspace for directing coding agents. The first version can run a review task with Codex or OpenCode in a folder you select.

## Start the app

Install Node.js 22.12 or later and run these commands from the project directory. The first launch downloads the Electron runtime. [Electron installation guide](https://www.electronjs.org/docs/latest/tutorial/installation)

```sh
npm ci
npm start
```

On Windows, `npm.cmd ci` and `npm.cmd start` also work from PowerShell.

1. Set up either CLI in your terminal. Codex uses its saved CLI sign-in and default model. OpenCode uses its existing CLI credentials and global default model. Honeycomb currently supports OpenCode 1.14 and later 1.x versions. [Codex CLI authentication](https://developers.openai.com/codex/noninteractive#authenticate-in-automation) · [OpenCode CLI](https://opencode.ai/docs/cli/)
2. Open **Connectors** to confirm that Honeycomb sees the CLI. **Refresh** checks installation and version. If the app cannot find a CLI on PATH, set `HONEYCOMB_CODEX_PATH` or `HONEYCOMB_OPENCODE_PATH` to its absolute executable path before launching. On Windows, use the native `.exe` for a path override.
3. In **Chats**, choose a project folder, select the connector, and enter a review task. **Run details** shows the run status and usage reported by the CLI. Use **Stop run** to cancel.

Review mode is for trusted local folders. Codex uses its read-only sandbox. OpenCode uses agent permissions for project reads and searches. Your selected CLI can send the prompt and relevant code to its configured model. Each run has a five-minute limit, and Honeycomb keeps the most recent 20 runs for the current app session.

## Project layout

| Path | Responsibility |
| --- | --- |
| `src/main` | Electron window, native folder picker, and IPC bridge |
| `src/renderer` | Chats, Workflows, and Connectors |
| `src/service` | Run lifecycle, event history, and subprocess supervision |
| `src/providers` | CLI detection and provider-specific invocation and event decoding |

See the [design order](docs/design-order.md) for the milestones and how to verify each one.
