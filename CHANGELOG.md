# Changelog

> `dsh-task-dispatcher` 的全部版本变更。本文件由 `scripts/release.mjs` 在发布时自动补写。
> 格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。
> 说明：0.1.4 及更早的条目依据 git 历史与 npm 发布时间回填。

## [Unreleased]

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
