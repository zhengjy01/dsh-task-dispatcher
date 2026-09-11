# Changelog

> `dsh-task-dispatcher` 的全部版本变更。本文件由 `scripts/release.mjs` 在发布时自动补写。
> 格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。
> 说明：0.1.4 及更早的条目依据 git 历史与 npm 发布时间回填。

## [Unreleased]

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
