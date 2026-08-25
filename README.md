# dsh-task-dispatcher — TickTick daily task dispatcher

Use TickTick (滴答清单) as DSH's daily task dispatcher: a cordis timer pulls each morning (default 08:30) today's due tasks from the 5️⃣AI list, writes them to today's task file, and notifies via **flomo + macOS**. The agent reads the file, works through the items, and writes results back to TickTick with `ticktick_complete`.

> Reuses the already-installed `dsh-ticktick` plugin (its data layer + OAuth credentials in `~/.dsh/dsh-ticktick.json`) — no duplicate configuration.

## Features

- **Daily timed dispatch**: cordis `ctx.interval` polls every minute and dispatches at the configured time; `dispatcher_run` dispatches manually anytime.
- **Task source**: default the 5️⃣AI list (`projectName` / `projectId` configurable); `dueMode=today` pulls due-today/overdue + undated, `dueMode=all` pulls all incomplete.
- **Today task file**: writes a Markdown checklist (default `~/.dsh/dsh-task-dispatcher/today-tasks.md`).
- **Notify**: `notifyFlomo` (reuses `~/.dsh/dsh-flomo.json`) + `notifyMac` (osascript).
- **Agent tools**: `dispatcher_status` / `dispatcher_config` / `dispatcher_run` + a Web settings panel.

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
