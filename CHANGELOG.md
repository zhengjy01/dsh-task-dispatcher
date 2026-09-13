# Changelog

> `dsh-task-dispatcher` 的全部版本变更。本文件由 `scripts/release.mjs` 在发布时自动补写。
> 格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。
> 说明：0.1.4 及更早的条目依据 git 历史与 npm 发布时间回填。

## [Unreleased]

## [0.3.0] - 2026-09-13

### 新增 (Added)

- **延迟同步的图形化配置（设置面板）**：面板新增「延迟同步（agent → 滴答清单）」区块——此前静默阈值、检查间隔这些参数只存在于队列 JSON 与 launchd plist 里，只能用命令行改。
  - **可看**：队列条数（顶层/子任务明细）、当前静默分钟（**全机** DSH 口径）、阈值、定时器是否在跑、上次写入时间与结果、当前用的是插件自带脚本还是本地已安装的那份。
  - **可改**：**静默阈值**（分钟）、**单会话顶层上限**、**定时器检查间隔**（秒——改完自动重载 launchd，因为已加载的 job 不会自己重读 plist）。
  - **可点**：「保存阈值」「立即写入」「强制写入」「重载定时器」。
  - **控制面与执行面分离**：写入仍由独立脚本 + launchd 完成（**DSH 关着也能写**），插件只做配置与观测；两者共用同一个队列文件（`$DSH_HOME/dsh-ticktick-pending.json`），不重复实现任何写入逻辑（去重、parentId、dueDate 顺延都留在脚本里）。
  - 新增 4 条 loopback 路由：`GET /api/dsh-task-dispatcher/deferred`、`POST .../deferred/config`、`POST .../deferred/flush`、`POST .../deferred/timer`。
  - 脚本随包分发（`scripts/ticktick-pending.mjs`）：没有该脚本的机器可从面板一键安装并把定时器指过去。

- **微信通知通道（ClawBot）**：派发通知与会话汇总可发到微信——插件把正文 POST 给本机 **DSH-WeChatClawBot** 网关的 `/send`（默认 `http://127.0.0.1:51235`），由它转发给扫码登录的那个微信。插件本身不直连微信、不存任何微信凭据。
  - 新配置：`notifyWechat`（开关）、`wechatGatewayUrl`（网关地址，空 = 默认 51235）、`wechatTo`（接收人 id，空 = **自动识别**：读 ClawBot 状态目录里的 `accounts/<botId>.json` 的 `userId`）、`wechatStateDir`（状态目录，空 = `$DSH_WECHAT_HOME` 或 `~/.dsh-wechat`）。
  - 接收人自动识别失败 / 网关没起 / ClawBot 未登录时，只把该通道记为失败并说明原因，**不影响派发本身**（通知永远是 best-effort）。
  - 长正文按 1200 字符自动分条发送（微信单条文本有上限）。
- **执行结果回执（`notifyResult`，默认开）**：派发只是开始，跑完也要说话。自动执行的每个任务在 worker 结束后**自动**推一条简明结果（`✅ 任务完成 · 标题` + 一句话结果摘要；失败则 `❌ 任务失败 · 标题` + 原因，如「执行超时（30 分钟，已 SIGKILL）」），一轮跑超过 1 项时再补一条批次汇总（完成/失败计数 + 逐项 ✅/❌）。**不依赖 worker 自己记得汇报**，走已开启的通知通道（默认微信）。
  - 摘要正确性有依据：headless runner 只把**最终答复写 stdout**（进度/思考走 stderr），`spawnWorker` 因此把两个流分开收集，`summarizeWorkerOutput()` 取 stdout、剥 ANSI、丢空行与结尾的 `DONE` 标记、压平并截断到 220 字——微信气泡里读得完。
  - 通知是**显式 opt-in**：`runAutoExecute` 只有调用方传 `notifyResult: true` 且配置 `notifyResult !== false` 时才发，测试/其它调用方零副作用。
  - 新增配置 `notifyResult`（设置面板同步加开关）。
- 新增统一出口 `notifyText(content, cfg, opts)`：派发通知、执行结果、批次汇总、会话汇总共用同一套通道语义（微信原样 / flomo 转义井号 / macOS 横幅），`channels` 可临时指定；macOS 文案可定制。
- `dispatcher_config` 新增 `testWechat: true`：保存配置后立刻发一条测试微信，用来验证通道。
- `dispatcher_report` 新增 `channels` 参数（`wechat`/`flomo`/`mac`），可临时指定本次发哪几路；返回值新增 `wechatNotify`。

### 其它 (Changed)

- 通知正文抽成一份，微信与 flomo 共用：微信原样发送（无标签解析），flomo 仍在其出口做半角 `#` → 全角 `＃` 的替换。
- `dispatcher_run` / `dispatcher_status` 的返回值与状态文案列出微信通道与「执行结果回执」开关；`dispatcher_report` 不再写死 flomo，并改为复用 `notifyText`（含 macOS 横幅）。
- `WorkerResult` 把 stdout / stderr 分开收集（`output` 仍是合并结果，向后兼容）。
- 设置面板新增「微信通知」开关、ClawBot 网关地址、微信接收人输入框（留空 = 自动识别）。
- 通知渠道默认值不变（`notifyFlomo: true`、`notifyWechat: false`），避免影响没装 ClawBot 的用户。


### 修复 (Fixed)

- **配置/缓存/账本路径认 `DSH_HOME`**：`src/store.ts`（`dsh-task-dispatcher.json`、today-tasks）、`src/workspaces.ts`（宿主 `storages/workspace.json`）、`src/notify.ts`（共享 `dsh-flomo.json`）此前用 `path.join(homedir(), '.dsh', …)` 解析——搬迁过 home 的机器（launcher / 救援胶囊）会写到错误的 `~/.dsh`，插件「丢配置」。新增共享 `src/home.ts`（`dshHome()` / `pluginPath()`），解析顺序统一为 **插件覆盖变量（`DSH_TASK_DISPATCHER_CONFIG` / `DSH_WORKSPACE_STORE`）→ `DSH_HOME` → `~/.dsh`**；路径说明/公告/描述同步补 `DSH_HOME` 口径。smoke 新增 run 11（7 项断言）。可移植性门禁静态体检的「写 `.dsh` 但不认 `DSH_HOME`」warn 消失。

## [0.2.0] - 2026-09-13

### 新增 (Added)

- **worker 超时改为可配置（`workerTimeoutMinutes`，默认 30 分钟）**：`src/executor.ts` 里写死的 `WORKER_TIMEOUT_MS = 10 分钟` 对长任务太短——2026-09-12 三个自动执行任务全部跑到 10 分钟被 SIGKILL，`ok=false` → 派发汇总报「完成 0 项」，其中一条其实已经把上游 PR 评论发出去了（假失败）；超时任务还会进 60 分钟冷却，表现为「派发了但一项都没完成」。现在超时来自 `dispatcher_config` / 设置面板的 `workerTimeoutMinutes`（范围 1–1440，默认 30），`runAutoExecute` 把解析后的 `timeoutMs` 传给每个 worker；直接调 `spawnWorker` 时的兜底常量 `DEFAULT_WORKER_TIMEOUT_MS` 同步改为 30 分钟。smoke 覆盖「默认 30 分钟传给 spawn」「配置 45 分钟生效」「到点真的 SIGKILL（error=timeout）」。

### 修复 (Fixed)

- **漏拉「今天开始」的时间段任务**：`taskQualifies()` 只比较 `dueDate`，完全不读 `startDate` —— 滴答清单里「开始=今天、截止=未来」的窗口任务在 TickTick 里算今天的事，却被判为「未到期」而永不派发。现在拉取判据为「`dueDate <= today` **或** `startDate <= today`」。
- 新增 `taskIsActionable()`，把「是否拉取」与「是否可自动执行」拆开（**拉取按窗口、执行按截止**）：窗口任务只进今日任务文件 + 通知（标注「进行中」），`autoExecute` 绝不执行它 —— 否则「观察后真删 X」这类任务（开始日=今天、截止日=两周后）会在当天就做出不可逆操作。
- **`dispatcher_report`（会话汇总）漏做井号处理**：`flomoStripBodyHash` 此前只作用于派发通知，会话汇总走 `flomoMemo(lines.join('\n'), …)` 却没有经过它，于是正文里的 PR 号（`#91` / `#759` / `#76`）被 flomo 解析成标签、污染标签集（2026-09-11 20:42 那条汇总即为此）。
  - 修法不是补一处调用，而是把处理**下沉到唯一出口 `flomoMemo(content, tags, escapeBodyHashes)`**：派发通知与会话汇总共用同一条路径，今后任何新增的 flomo 出口都默认受保护。
  - 语义同时从「删除 `#`」改为**「替换成全角 `＃`」**（`escapeHashes()`，常量 `HASH_SAFE`）：`#91` 不再消失、仍读作 `＃91`；全角 `＃` 与半角 `#` 是不同的码位，flomo 的标签解析只认半角，因此不会再生成杂散标签。标签后缀在转义**之后**拼接，保持半角 `#`。
  - 设置面板开关文案由「剥掉正文里的井号」改为「正文里的井号 # 替换成全角 ＃」。
  - smoke 新增 run 9 覆盖该路径（含 09-11 那条汇总的真实正文）。

### 其它 (Changed)

- **新增 `/api/dsh-task-dispatcher/probe` 存活探针**（loopback-only、只读）：`dsh-release-kit` 的可移植性门禁默认打这个路由确认插件真的挂载。
- **接入发布前可移植性门禁**：仓库复制进 `scripts/portability.mjs` 与 `PORTABILITY-SOP.md`，`package.json` 增加 `verify` / `verify:full` / `verify:quick`。发布前必须在隔离 `DSH_HOME`（空 profile + tarball，不走 `link:`）跑出 `✅ 通过`。
- README 双语补充 `workerTimeoutMinutes` 配置说明。

## [0.1.5] - 2026-09-11

### 修复 (Fixed)

- fix(release): dry-run 不再触发真实 registry 校验；CHANGELOG peer 摘要只列 dsh 包

### 其它 (Changed)

- chore(release): 版本纪律工具链（release.mjs / RELEASE.md / CHANGELOG）

### 兼容性 (Compatibility)

- DSH：`>=0.1.5-rc.1`
- Node：`^22.19.0 || >=24.0.0`
- DSH peer：^0.1.0-rc.6 || ^0.1.1-rc.1 || ^0.1.2-alpha.1 || ^0.1.5-rc.1
- 运行时依赖：`dsh-ticktick@^0.1.4`

## [0.1.4] - 2026-09-11

### 其它 (Changed)

- DSH 0.1.5-rc.1 依赖线对齐：客户端类型迁移，宿主 peer 闭包补齐
- 运行时依赖 `dsh-ticktick` 提升到 `^0.1.4`

### 兼容性 (Compatibility)

- DSH：`>=0.1.5-rc.1`
- Node：`^22.19.0 || >=24.0.0`
- peer：`^0.1.0-rc.6 || ^0.1.1-rc.1 || ^0.1.2-alpha.1 || ^0.1.5-rc.1`
- 运行时依赖：`dsh-ticktick@^0.1.4`

### 迁移说明 (Migration)

- 无破坏性变更（`0.1.x` 内为依赖对齐与兼容声明修正）。

## [0.1.3] - 2026-09-10

### 其它 (Changed)

- peer 范围改为并集并纳入 `^0.1.5-rc.1`（让插件市场显示「兼容最新版」）
- 移除已退役的 peer：`@deepseek-ai/dsh-client-runtime` / `@deepseek-ai/dsh-client-ui-slots`

### 兼容性 (Compatibility)

- DSH：`>=0.1.5-rc.1`

## [0.1.2] - 2026-09-10

### 新增 (Added)

- 声明 DSH 兼容性：`dsh.engines.dsh = >=0.1.5-rc.1`，README 双语补「兼容性 / Compatibility」小节

### 修复 (Fixed)

- `fix(0.1.5)`：用扩展 PATH 解析 `dsh` CLI，使 headless worker 能正常 spawn

## [0.1.1] - 2026-09-10

### 新增 (Added)

- worker 执行会话可选工作区（`workerWorkspaceId`）
- `dispatcher_report` 工具：会话结束后汇总本次执行结果（total/completed/failed/skipped）发到 flomo

### 修复 (Fixed)

- 状态 schema 去重 `autoExecute` / `retryCooldown`

## [0.1.0] - 2026-08-26

### 新增 (Added)

- 首个发布
- 用滴答清单「5️⃣AI」当每日任务派发器：cordis 定时器拉取今天到期任务
- 写入今日任务文件（`~/.dsh/dsh-task-dispatcher/today-tasks.md`）
- 任务变化时通知：flomo + macOS 通知（`flomoStripBodyHash` 默认剥掉正文 `#`）
- 来源清单 / 过滤 / 通知 / 自动执行等配置项与 `dispatcher_*` 工具

### 兼容性 (Compatibility)

- Node：`^22.19.0 || >=24.0.0`
