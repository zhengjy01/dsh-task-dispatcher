# dsh-task-dispatcher — TickTick daily task dispatcher

Use TickTick (滴答清单) as DSH's daily task dispatcher: a cordis timer pulls each morning (default 08:30) today's due tasks from the 5️⃣AI list, writes them to today's task file, and notifies via **flomo + macOS**. The agent reads the file, works through the items, and writes results back to TickTick with `ticktick_complete`.

> Reuses the already-installed `dsh-ticktick` plugin (its data layer + OAuth credentials in `~/.dsh/dsh-ticktick.json`) — no duplicate configuration.

## Features

- **Interval dispatch**: cordis `ctx.interval` polls every minute and dispatches when the configured interval (minutes) has elapsed; 0 disables the timer; `dispatcher_run` dispatches manually anytime.
- **Task source**: default the 5️⃣AI list (`projectName` / `projectId` configurable); `dueMode=today` pulls due-today/overdue + undated, `dueMode=all` pulls all incomplete.
- **Today task file**: writes a Markdown checklist (default `~/.dsh/dsh-task-dispatcher/today-tasks.md`).
- **Notify on change only**: `notifyFlomo` (reuses `~/.dsh/dsh-flomo.json`) + `notifyMac` (osascript); a repeated pull with no new tasks stays silent.
- **Auto-execute (autoExecute)**: when on, each pulled task runs in its own `dsh --profile headless` session (serial, one task per session); success writes back to TickTick via `ticktick_complete`; failed tasks wait out the retry cooldown.
- **Worker timeout (workerTimeoutMinutes)**: each auto-execute worker is SIGKILLed after this many minutes (default **30**, range 1–1440), configurable via `dispatcher_config` / the settings panel. It used to be a hardcoded 10 minutes, which killed long-but-healthy tasks and reported them as failures.
- **Worker workspace (workerWorkspaceId)**: the auto-execute worker session runs in the user's home dir by default; set a DSH workspace id and the worker spawns with cwd = that workspace's directory, so files are written there and the produced session shows up under that workspace in the GUI sidebar. The settings panel provides a workspace dropdown (list read from `~/.dsh/storages/workspace.json`); empty = home dir.
- **Agent tools**: `dispatcher_status` / `dispatcher_config` / `dispatcher_run` / `dispatcher_report` + a Web settings panel.

## Compatibility

Requires **DeepSeek Harness ≥ 0.1.5-rc.1** (declared as `dsh.engines.dsh` in the package manifest, so the DSH plugin marketplace can report it) and is verified against **0.1.5-rc.1**. This build carries the DSH 0.1.5 adaptations: the strict tool-result contract (lossless-JSON snapshot, `additionalProperties: false` schema validation, and `output.render` returning `ContentBlock[]`) plus executable resolution that survives a launchd-started host whose `PATH` is only `/usr/bin:/bin`.

## Install

```sh
# from npm (published package)
dsh plugin --profile web add dsh-task-dispatcher

# or local development
dsh plugin --profile web add link:/path/to/dsh-task-dispatcher
# restart dsh web to activate
```

Current release: **v0.2.0** ([CHANGELOG](CHANGELOG.md) · [Releases](https://github.com/zhengjy01/dsh-task-dispatcher/releases) · [npm](https://www.npmjs.com/package/dsh-task-dispatcher)).

## Dev

```sh
pnpm install
pnpm build && node tests/smoke.mjs
```

## License

MIT