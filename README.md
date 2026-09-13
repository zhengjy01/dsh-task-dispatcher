# dsh-task-dispatcher — TickTick daily task dispatcher

Use TickTick (滴答清单) as DSH's daily task dispatcher: a cordis timer pulls today's due tasks from the configured source list (default `In progress`), writes them to today's task file, and notifies via **WeChat (ClawBot)**, flomo, or macOS (configurable). The agent reads the file, works through the items, and writes results back to TickTick with `ticktick_complete`.

> Reuses the already-installed `dsh-ticktick` plugin (its data layer + OAuth credentials in `~/.dsh/dsh-ticktick.json`) — no duplicate configuration.

## Features

- **Interval dispatch**: cordis `ctx.interval` polls every minute and dispatches when the configured interval (minutes) has elapsed; 0 disables the timer; `dispatcher_run` dispatches manually anytime.
- **Task source**: default the `In progress` list (`projectName` / `projectId` configurable); `dueMode=today` pulls due-today/overdue + undated, `dueMode=all` pulls all incomplete.
- **Today task file**: writes a Markdown checklist (default `~/.dsh/dsh-task-dispatcher/today-tasks.md`).
- **Execution-result receipts (`notifyResult`, on by default)**: every auto-executed task pushes a SHORT outcome message (`OK`/`FAIL` + title + a one-line result, or the failure reason such as a worker timeout) as soon as its worker settles, plus a compact batch tally when a pass runs more than one task - a run reports back by itself instead of relying on the worker calling `dispatcher_report`. The summary is the worker's **stdout final answer** (progress/reasoning go to stderr), stripped of ANSI and the `DONE` marker and capped at 220 characters.
- **Notify on change only**: `notifyWechat` (WeChat, relayed through the local [DSH-WeChatClawBot](https://github.com/lubaiUwU/DSH-WeChatClawBot) gateway; the recipient is auto-detected) + `notifyFlomo` (reuses `~/.dsh/dsh-flomo.json`) + `notifyMac` (osascript); a repeated pull with no new tasks stays silent.
- **WeChat notifications (ClawBot)**: the plugin POSTs the text to the local gateway `/send` (default `http://127.0.0.1:51235`), which relays it to the WeChat account that scanned the QR code. The plugin never talks to WeChat directly and stores no WeChat credentials. The recipient defaults to the `userId` recorded in the ClawBot state dir (`~/.dsh-wechat`, override with `DSH_WECHAT_HOME`) under `accounts/<botId>.json`, or can be set explicitly with `wechatTo`; long bodies are split into 1200-character chunks. An unavailable channel only marks that channel as failed — it never fails the dispatch.
- **Auto-execute (autoExecute)**: when on, each pulled task runs in its own `dsh --profile headless` session (serial, one task per session); success writes back to TickTick via `ticktick_complete`; failed tasks wait out the retry cooldown.
- **Worker timeout (workerTimeoutMinutes)**: each auto-execute worker is SIGKILLed after this many minutes (default **30**, range 1–1440), configurable via `dispatcher_config` / the settings panel. It used to be a hardcoded 10 minutes, which killed long-but-healthy tasks and reported them as failures.
- **Worker workspace (workerWorkspaceId)**: the auto-execute worker session runs in the user's home dir by default; set a DSH workspace id and the worker spawns with cwd = that workspace's directory, so files are written there and the produced session shows up under that workspace in the GUI sidebar. The settings panel provides a workspace dropdown (list read from `~/.dsh/storages/workspace.json`); empty = home dir.
- **Deferred-sync panel (agent -> TickTick)**: the settings page configures the write-back path directly - silence threshold (`idleMinutes`), per-session top-level cap, and the launchd check interval - and shows the queue, the **whole-harness** idle time, timer state and the last flush result. Buttons: save thresholds, flush now, force flush, reload timer. The control plane only reads the queue file and drives the script/timer; the writing itself stays in the standalone script + launchd, so a flush still happens **while DSH is closed**, and no write logic is duplicated between the two halves. Routes: `GET /api/dsh-task-dispatcher/deferred`, `POST .../deferred/{config,flush,timer}`.
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

Current release: **v0.3.0** ([CHANGELOG](CHANGELOG.md) · [Releases](https://github.com/zhengjy01/dsh-task-dispatcher/releases) · [npm](https://www.npmjs.com/package/dsh-task-dispatcher)).

## Dev

```sh
pnpm install
pnpm build && node tests/smoke.mjs
```

## License

MIT