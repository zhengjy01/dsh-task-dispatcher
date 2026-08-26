# dsh-task-dispatcher — TickTick daily task dispatcher

Use TickTick (滴答清单) as DSH's daily task dispatcher: a cordis timer pulls each morning (default 08:30) today's due tasks from the 5️⃣AI list, writes them to today's task file, and notifies via **flomo + macOS**. The agent reads the file, works through the items, and writes results back to TickTick with `ticktick_complete`.

> Reuses the already-installed `dsh-ticktick` plugin (its data layer + OAuth credentials in `~/.dsh/dsh-ticktick.json`) — no duplicate configuration.

## Features

- **Interval dispatch**: cordis `ctx.interval` polls every minute and dispatches when the configured interval (minutes) has elapsed; 0 disables the timer; `dispatcher_run` dispatches manually anytime.
- **Task source**: default the 5️⃣AI list (`projectName` / `projectId` configurable); `dueMode=today` pulls due-today/overdue + undated, `dueMode=all` pulls all incomplete.
- **Today task file**: writes a Markdown checklist (default `~/.dsh/dsh-task-dispatcher/today-tasks.md`).
- **Notify on change only**: `notifyFlomo` (reuses `~/.dsh/dsh-flomo.json`) + `notifyMac` (osascript); a repeated pull with no new tasks stays silent.
- **Auto-execute (autoExecute)**: when on, each pulled task runs in its own `dsh --profile headless` session (serial, one task per session); success writes back to TickTick via `ticktick_complete`; failed tasks wait out the retry cooldown.
- **Worker workspace (workerWorkspaceId)**: the auto-execute worker session runs in the user's home dir by default; set a DSH workspace id and the worker spawns with cwd = that workspace's directory, so files are written there and the produced session shows up under that workspace in the GUI sidebar. The settings panel provides a workspace dropdown (list read from `~/.dsh/storages/workspace.json`); empty = home dir.
- **Agent tools**: `dispatcher_status` / `dispatcher_config` / `dispatcher_run` / `dispatcher_report` + a Web settings panel.

## Install

```sh
dsh plugin --profile web add link:/path/to/dsh-task-dispatcher
# restart dsh web to activate
```

## Dev

```sh
pnpm install
pnpm build && node tests/smoke.mjs
```

## License

MIT