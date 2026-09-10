# dsh-task-dispatcher — 滴答清单任务派发器

把滴答清单（TickTick）当作 DSH 的**任务派发器**：插件内置 cordis 定时器，按可配置的间隔（默认每 30 分钟）从滴答清单「5️⃣AI」拉取今天到期的任务，写入今日任务文件，并**仅在任务有变化时**发送 **flomo + macOS** 通知。agent 读取今日任务文件后逐项执行，完成的用 `ticktick_complete` 回写滴答清单。

> 因为任务都是随手写进滴答清单的，插件会自动跟上：你随时加任务，下次拉取就带进来。

> 依赖本机已安装的 `dsh-ticktick` 插件（复用其数据层与 OAuth 凭据 `~/.dsh/dsh-ticktick.json`），无需重复配置。

## 特性

- **按间隔自动拉取**：cordis `ctx.interval` 每分钟轮询，距上次拉取超过配置间隔（分钟）就拉取一次；间隔 0 = 关闭定时；`dispatcher_run` 可随时手动拉取。
- **任务来源**：默认滴答清单「5️⃣AI」，可按 `projectName` / `projectId` 配置；`dueMode=today` 拉「今天到期/逾期 + 无截止」，`dueMode=all` 拉全部未完成。
- **今日任务文件**：每次拉取把任务写成 Markdown 清单（默认 `~/.dsh/dsh-task-dispatcher/today-tasks.md`）；每项任务除了标题与截止日期，还会把它在滴答清单里的**描述（备注）**以引用块形式附在标题下，agent 读文件时连同描述一起读。
- **有变化才通知**：`notifyFlomo`（复用 `~/.dsh/dsh-flomo.json` 凭据，标签可配置）+ `notifyMac`（osascript）；任务集无变化时保持安静，避免刷屏。
- **自动执行（autoExecute）**：开启后，为每个拉到的新任务**单独开一个 `dsh --profile headless` 会话**（串行，一任务一会话）去执行；worker 只带基础工具（bash/文件/glob/grep/网络/目标工具）；执行成功即用 `ticktick_complete` 回写滴答清单勾掉；失败任务在重试冷却期内不重复跑。
- **选择执行会话的工作区（workerWorkspaceId）**：默认 worker 会话在用户主目录下运行；配置某个 DSH 工作区 id 后，worker 以该工作区目录为 cwd 启动，产生的会话会在该目录下读写文件，并在 GUI 侧边栏自动归入该工作区。设置面板提供工作区下拉（列表来自 `~/.dsh/storages/workspace.json`），留空 = 默认主目录。
- **agent 工具**：`dispatcher_status` / `dispatcher_config` / `dispatcher_run` + Web 设置面板「任务派发器」。

## 兼容性

要求 **DeepSeek Harness ≥ 0.1.5-rc.1**（已在包清单的 `dsh.engines.dsh` 中声明，DSH 插件市场据此显示兼容版本），并已在 **0.1.5-rc.1** 上实测通过。本构建包含 DSH 0.1.5 的适配：工具结果的严格校验契约（lossless-JSON 快照、`additionalProperties: false` 的 schema 校验、`output.render` 必须返回 `ContentBlock[]`），以及不依赖宿主 PATH 的可执行文件解析（launchd 托管的宿主 `PATH` 只有 `/usr/bin:/bin`）。

## 安装

```sh
# from npm (published package)
dsh plugin --profile web add dsh-task-dispatcher

# or local development
dsh plugin --profile web add link:/path/to/dsh-task-dispatcher
# 重启 dsh web 生效
```

## 配置（`~/.dsh/dsh-task-dispatcher.json`，0600）

| 字段 | 说明 | 默认 |
|---|---|---|
| `enabled` | 插件总开关 | `true` |
| `dispatchIntervalMinutes` | 每隔多少分钟自动拉取一次（0 = 关闭定时） | `30` |
| `autoExecute` | 是否自动执行（每个任务单独一个 DSH 会话，串行） | `false` |
| `retryCooldownMinutes` | 失败任务重试冷却分钟 | `60` |
| `workerPrompt` | 执行会话提示词模板（`{title}`/`{content}`） | 内置 |
| `workerWorkspaceId` | 执行会话运行的 DSH 工作区 id（空 = 默认主目录；见设置面板工作区下拉） | `''` |
| `projectName` / `projectId` | 来源滴答清单 | `5️⃣AI` |
| `dueMode` | `today`=今天到期/逾期；`all`=全部未完成 | `today` |
| `includeUndated` | 是否包含无截止任务 | `true` |
| `notifyFlomo` / `flomoTag` | flomo 通知与标签（仅任务有变化时） | `true` / `AI/DSH/派发` |
| `notifyMac` | macOS 通知（仅任务有变化时） | `true` |
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
