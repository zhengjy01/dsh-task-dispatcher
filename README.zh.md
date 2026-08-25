# dsh-task-dispatcher — 滴答清单任务派发器

把滴答清单（TickTick）当作 DSH 的**每日任务派发器**：插件内置 cordis 定时器，每天早上（默认 08:30）从滴答清单「5️⃣AI」拉取今天到期的任务，写入今日任务文件，并发送 **flomo + macOS** 通知。agent 读取今日任务文件后逐项执行，完成的用 `ticktick_complete` 回写滴答清单。

> 依赖本机已安装的 `dsh-ticktick` 插件（复用其数据层与 OAuth 凭据 `~/.dsh/dsh-ticktick.json`），无需重复配置。

## 特性

- **每日定时派发**：cordis `ctx.interval` 每分钟轮询，到配置的时刻自动派发一次；`dispatcher_run` 可随时手动派发。
- **任务来源**：默认滴答清单「5️⃣AI」，可按 `projectName` / `projectId` 配置；`dueMode=today` 拉「今天到期/逾期 + 无截止」，`dueMode=all` 拉全部未完成。
- **今日任务文件**：每次派发把任务写成 Markdown 任务清单（默认 `~/.dsh/dsh-task-dispatcher/today-tasks.md`）。
- **通知**：`notifyFlomo`（复用 `~/.dsh/dsh-flomo.json` 凭据，标签可配置）+ `notifyMac`（osascript 通知）。
- **agent 工具**：`dispatcher_status` / `dispatcher_config` / `dispatcher_run` + Web 设置面板「任务派发器」。

## 安装

```sh
dsh plugin --profile web add link:/path/to/dsh-task-dispatcher
# 重启 dsh web 生效
```

## 配置（`~/.dsh/dsh-task-dispatcher.json`，0600）

| 字段 | 说明 | 默认 |
|---|---|---|
| `enabled` | 插件总开关 | `true` |
| `dispatchHour` / `dispatchMinute` | 每日派发时刻 | `8` / `30` |
| `projectName` / `projectId` | 来源滴答清单 | `5️⃣AI` |
| `dueMode` | `today`=今天到期/逾期；`all`=全部未完成 | `today` |
| `includeUndated` | 是否包含无截止任务 | `true` |
| `notifyFlomo` / `flomoTag` | flomo 通知与标签 | `true` / `AI/DSH/派发` |
| `notifyMac` | macOS 通知 | `true` |
| `taskFile` | 今日任务文件路径 | `~/.dsh/dsh-task-dispatcher/today-tasks.md` |

## 使用

派发后读取今日任务文件，按 `- [ ]` 逐项执行；完成一项就在滴答清单里勾掉（`ticktick_complete`）。

```sh
# 手动派发一次
dispatcher_run
# 查看状态
dispatcher_status
```

## 开发

```sh
pnpm install
pnpm build && node tests/smoke.mjs
```

## License

MIT
