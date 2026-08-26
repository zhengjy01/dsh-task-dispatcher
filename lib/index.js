import { defineTool, defineTool as defineTool$1 } from "@deepseek-ai/dsh-tools";
import { TickTickApi, TickTickStore } from "dsh-ticktick";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
//#region src/store.ts
/**
* dsh-task-dispatcher — config store.
*
* Persists the dispatcher configuration (poll interval, source TickTick
* project, filtering, notify toggles, and the last dispatch summary) to
* ~/.dsh/dsh-task-dispatcher.json (mode 0600). Reuses the TickTick OAuth
* credentials already stored by the dsh-ticktick plugin (~/.dsh/dsh-ticktick.json)
* — it never stores its own secrets. Reads are lazy and cached; the public
* view() never exposes tokens. The config path can be overridden with
* DSH_TASK_DISPATCHER_CONFIG (used by the smoke tests).
*/
/** Default machine-wide config location (mode 0600). */
const DEFAULT_CONFIG_FILE = path.join(homedir(), ".dsh", "dsh-task-dispatcher.json");
/** Default workspace task file written on each dispatch. */
const DEFAULT_TASK_FILE = path.join(homedir(), ".dsh", "dsh-task-dispatcher", "today-tasks.md");
/** Default worker prompt template ({title}/{content} replaced per task). */
const DEFAULT_WORKER_PROMPT = "你是 DeepSeek Harness 的独立任务执行会话。请用你手头的基础工具（bash/读写文件/glob/grep/网络/目标工具）执行下面这一项任务：\n\n任务：{title}\n说明：{content}\n\n要求：聚焦完成这一项即可；完成后在回复末尾单独输出一行：DONE";
/** Test override for the config location. */
function configPath() {
	const override = process.env.DSH_TASK_DISPATCHER_CONFIG;
	return override !== void 0 && override !== "" ? override : DEFAULT_CONFIG_FILE;
}
/** Default config (used when the file is absent or unreadable). */
function defaults() {
	return {
		enabled: true,
		announceToAgent: true,
		dispatchIntervalMinutes: 30,
		projectName: "5️⃣AI",
		projectId: "",
		dueMode: "today",
		includeUndated: true,
		notifyFlomo: true,
		flomoTag: "AI/DSH/派发",
		notifyMac: true,
		taskFile: DEFAULT_TASK_FILE,
		lastDispatchAt: "",
		lastTaskCount: 0,
		lastTaskTitles: [],
		autoExecute: false,
		retryCooldownMinutes: 60,
		workerPrompt: DEFAULT_WORKER_PROMPT,
		workerWorkspaceId: "",
		attempted: {}
	};
}
/** Parse an unknown JSON record into config (tolerates missing keys). */
function parse(raw) {
	const record = typeof raw === "object" && raw !== null ? raw : {};
	const num = (value, fallback) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
	const str = (value, fallback = "") => typeof value === "string" ? value : fallback;
	const bool = (value, fallback) => typeof value === "boolean" ? value : fallback;
	const d = defaults();
	return {
		enabled: bool(record.enabled, d.enabled),
		announceToAgent: bool(record.announceToAgent, d.announceToAgent),
		dispatchIntervalMinutes: clampInt(num(record.dispatchIntervalMinutes, d.dispatchIntervalMinutes), 0, 1440),
		projectName: str(record.projectName, d.projectName),
		projectId: str(record.projectId, ""),
		dueMode: record.dueMode === "all" ? "all" : "today",
		includeUndated: bool(record.includeUndated, d.includeUndated),
		notifyFlomo: bool(record.notifyFlomo, d.notifyFlomo),
		flomoTag: str(record.flomoTag, d.flomoTag),
		notifyMac: bool(record.notifyMac, d.notifyMac),
		taskFile: str(record.taskFile, d.taskFile),
		lastDispatchAt: str(record.lastDispatchAt, ""),
		lastTaskCount: num(record.lastTaskCount, 0),
		lastTaskTitles: Array.isArray(record.lastTaskTitles) ? record.lastTaskTitles.filter((t) => typeof t === "string") : [],
		autoExecute: bool(record.autoExecute, d.autoExecute),
		retryCooldownMinutes: clampInt(num(record.retryCooldownMinutes, d.retryCooldownMinutes), 1, 1440),
		workerPrompt: str(record.workerPrompt, d.workerPrompt),
		workerWorkspaceId: str(record.workerWorkspaceId, ""),
		attempted: typeof record.attempted === "object" && record.attempted !== null ? Object.fromEntries(Object.entries(record.attempted).filter(([, v]) => typeof v === "string")) : {}
	};
}
function clampInt(value, min, max) {
	return value < min ? min : value > max ? max : Math.floor(value);
}
/**
* Config store backed by ~/.dsh/dsh-task-dispatcher.json.
* Reads are lazy and cached; writes use mode 0600.
*/
var DispatcherStore = class {
	config = null;
	async load() {
		if (this.config !== null) return this.config;
		try {
			const raw = await readFile(configPath(), "utf8");
			this.config = parse(JSON.parse(raw));
		} catch {
			this.config = defaults();
		}
		return this.config;
	}
	async save(next) {
		this.config = next;
		await mkdir(path.dirname(configPath()), { recursive: true });
		await writeFile(configPath(), JSON.stringify(next, null, 2), { mode: 384 });
	}
	/** Public, secret-free view. */
	async view() {
		const cfg = await this.load();
		return {
			configured: true,
			enabled: cfg.enabled,
			announceToAgent: cfg.announceToAgent,
			dispatchIntervalMinutes: cfg.dispatchIntervalMinutes,
			projectName: cfg.projectName,
			projectId: cfg.projectId ?? "",
			dueMode: cfg.dueMode,
			includeUndated: cfg.includeUndated,
			notifyFlomo: cfg.notifyFlomo,
			flomoTag: cfg.flomoTag,
			notifyMac: cfg.notifyMac,
			taskFile: cfg.taskFile,
			lastDispatchAt: cfg.lastDispatchAt,
			lastTaskCount: cfg.lastTaskCount,
			lastTaskTitles: cfg.lastTaskTitles,
			autoExecute: cfg.autoExecute,
			retryCooldownMinutes: cfg.retryCooldownMinutes,
			workerPrompt: cfg.workerPrompt,
			workerWorkspaceId: cfg.workerWorkspaceId,
			configPath: configPath()
		};
	}
	/** Apply a config patch: strings/numbers/booleans replace, undefined keeps. */
	async patch(args) {
		const next = { ...await this.load() };
		if (args !== void 0 && typeof args.enabled === "boolean") next.enabled = args.enabled;
		if (args !== void 0 && typeof args.announceToAgent === "boolean") next.announceToAgent = args.announceToAgent;
		if (args !== void 0 && args.dispatchIntervalMinutes !== void 0) next.dispatchIntervalMinutes = clampInt(Number(args.dispatchIntervalMinutes), 0, 1440);
		if (args !== void 0 && typeof args.projectName === "string") next.projectName = args.projectName.trim();
		if (args !== void 0 && typeof args.projectId === "string") next.projectId = args.projectId.trim();
		if (args !== void 0 && (args.dueMode === "today" || args.dueMode === "all")) next.dueMode = args.dueMode;
		if (args !== void 0 && typeof args.includeUndated === "boolean") next.includeUndated = args.includeUndated;
		if (args !== void 0 && typeof args.notifyFlomo === "boolean") next.notifyFlomo = args.notifyFlomo;
		if (args !== void 0 && typeof args.flomoTag === "string") next.flomoTag = args.flomoTag.trim();
		if (args !== void 0 && typeof args.notifyMac === "boolean") next.notifyMac = args.notifyMac;
		if (args !== void 0 && typeof args.taskFile === "string" && args.taskFile.trim() !== "") next.taskFile = args.taskFile.trim();
		if (args !== void 0 && typeof args.autoExecute === "boolean") next.autoExecute = args.autoExecute;
		if (args !== void 0 && args.retryCooldownMinutes !== void 0) next.retryCooldownMinutes = clampInt(Number(args.retryCooldownMinutes), 1, 1440);
		if (args !== void 0 && typeof args.workerPrompt === "string" && args.workerPrompt.trim() !== "") next.workerPrompt = args.workerPrompt.trim();
		if (args !== void 0 && typeof args.workerWorkspaceId === "string") next.workerWorkspaceId = args.workerWorkspaceId.trim();
		await this.save(next);
		return this.view();
	}
	/** Record a completed dispatch summary. */
	async recordDispatch(titles) {
		const next = {
			...await this.load(),
			lastDispatchAt: (/* @__PURE__ */ new Date()).toISOString(),
			lastTaskCount: titles.length,
			lastTaskTitles: titles
		};
		await this.save(next);
		return this.view();
	}
	/** Mark a task id as attempted now (for auto-execute retry cooldown). */
	async markAttempted(taskId) {
		const cfg = await this.load();
		await this.save({
			...cfg,
			attempted: {
				...cfg.attempted,
				[taskId]: (/* @__PURE__ */ new Date()).toISOString()
			}
		});
	}
	/** Re-attempt logic: whether `now` is past the retry cooldown for a task id. */
	async canRetry(taskId, cooldownMinutes) {
		const attemptedAt = (await this.load()).attempted[taskId];
		if (attemptedAt === void 0) return true;
		return Date.now() - new Date(attemptedAt).getTime() > cooldownMinutes * 60 * 1e3;
	}
};
//#endregion
//#region src/notify.ts
/**
* dsh-task-dispatcher — notify helpers.
*
* On each dispatch, notify the user that today's tasks are queued:
*   - flomo: post one MEMO reusing the dsh-flomo credentials it already
*     stores (~/.dsh/dsh-flomo.json). Reads the same file the flomo plugin
*     uses (webhookUrl, or apiKey -> /api/prod/apis/webhook/v1/?apiKey=...),
*     so no duplicate config is needed. Tags are appended as #tag.
*   - macOS: post a Notification Center banner via osascript (best effort).
*
* Both are best-effort: a delivery failure is reported in the returned
* outcome, never thrown (dispatch must not fail because a notify failed).
*/
const execFileAsync = promisify(execFile);
/** Default flomo credential location (mirrors the dsh-flomo plugin). */
const FLOMO_CONFIG = path.join(homedir(), ".dsh", "dsh-flomo.json");
/** Read the flomo webhook URL (mirrors dsh-flomo's `store.url()`). */
async function flomoUrl() {
	let record = {};
	try {
		const raw = await readFile(FLOMO_CONFIG, "utf8");
		const parsed = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null) record = parsed;
	} catch {}
	const str = (v) => typeof v === "string" ? v : "";
	const webhook = str(record.webhookUrl).trim();
	if (webhook !== "") return webhook;
	const key = str(record.apiKey).trim();
	if (key !== "") return "https://flomoapp.com/api/prod/apis/webhook/v1/?apiKey=" + encodeURIComponent(key);
	return "";
}
/** Append #tags (space-separated) to a memo body, mirroring dsh-flomo. */
function buildFlomoContent(content, tags) {
	const body = (content ?? "").trim();
	const suffix = (tags ?? "").split(/[\s,，;；]+/).map((t) => t.trim()).filter(Boolean).map((t) => "#" + t.replace(/^#+/, "")).join(" ");
	return suffix !== "" ? body + " " + suffix : body;
}
/** Post one MEMO to flomo. Returns an outcome, never throws. */
async function flomoMemo(content, tags) {
	try {
		const url = await flomoUrl();
		if (url === "") return {
			ok: false,
			channel: "flomo",
			message: "尚未配置 flomo（~/.dsh/dsh-flomo.json 无 webhookUrl/apiKey），已跳过 flomo 通知。"
		};
		const bound = buildFlomoContent(content, tags);
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: bound }),
			signal: AbortSignal.timeout(15e3)
		});
		const body = await res.text();
		let parsed;
		try {
			parsed = JSON.parse(body);
		} catch {
			parsed = null;
		}
		if (typeof parsed === "object" && parsed !== null) {
			const code = parsed.code;
			if (typeof code === "number" && code === 0) return {
				ok: true,
				channel: "flomo",
				message: "已写入 flomo"
			};
			if (typeof code === "number") return {
				ok: false,
				channel: "flomo",
				message: "flomo 返回错误: " + String(parsed.message ?? JSON.stringify(parsed))
			};
		}
		if (!res.ok) return {
			ok: false,
			channel: "flomo",
			message: "flomo 请求失败（HTTP " + res.status + "）: " + body.slice(0, 200)
		};
		return {
			ok: true,
			channel: "flomo",
			message: "flomo 已响应: " + body.slice(0, 200)
		};
	} catch (error) {
		return {
			ok: false,
			channel: "flomo",
			message: "flomo 请求失败: " + String(error instanceof Error ? error.message : error)
		};
	}
}
/** Post a macOS Notification Center banner. Never throws. */
async function macNotify(title, subtitle, body) {
	try {
		const script = [
			"display notification " + JSON.stringify(body),
			"with title " + JSON.stringify(title),
			"subtitle " + JSON.stringify(subtitle),
			"sound name \"Glass\""
		].join(" ");
		await execFileAsync("osascript", ["-e", script]);
		return {
			ok: true,
			channel: "mac",
			message: "已发送 macOS 通知"
		};
	} catch (error) {
		return {
			ok: false,
			channel: "mac",
			message: "macOS 通知失败: " + String(error instanceof Error ? error.message : error)
		};
	}
}
//#endregion
//#region src/dispatch.ts
/**
* dsh-task-dispatcher — the dispatch core.
*
* A dispatch resolves the configured TickTick source project, pulls its
* incomplete tasks, filters to today's actionable ones (due today/overdue,
* plus undated when configured), writes a today-tasks file the agent reads,
* and notifies (flomo + macOS). The actual task execution is done by the
* agent in DSH using the existing dsh-ticktick tools; the file + notification
* simply tell the agent what to work on today and write results back.
*
* Reuses the dsh-ticktick data layer (TickTickStore + TickTickApi) so the
* same OAuth token drives everything — no duplicate credentials.
*/
/** Local calendar date as YYYY-MM-DD. */
function localDateString(d = /* @__PURE__ */ new Date()) {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** Local calendar date of an ISO dueDate, or null when unparseable. */
function localDateOf(iso) {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return null;
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** Whether a dueDate is on or before `today` (local calendar date compare). */
function dueThisDay(dueDate, today) {
	if (typeof dueDate !== "string" || dueDate === "") return false;
	const local = localDateOf(dueDate);
	return local !== null && local <= today;
}
/** Does a task qualify for today's dispatch? */
function taskQualifies(task, cfg, today) {
	if (cfg.dueMode === "all") return true;
	if (typeof task.dueDate === "string" && task.dueDate !== "") return dueThisDay(task.dueDate, today);
	return cfg.includeUndated;
}
/** Resolve the source project id by configured name (or explicit id). */
async function resolveProjectId(api, cfg) {
	const projects = await api.getProjects();
	if (cfg.projectName.trim() !== "") {
		const byName = projects.find((p) => p.name === cfg.projectName);
		if (byName !== void 0) return {
			id: byName.id,
			name: byName.name
		};
	}
	if (cfg.projectId !== void 0 && cfg.projectId.trim() !== "") {
		const byId = projects.find((p) => p.id === cfg.projectId);
		return byId !== void 0 ? {
			id: byId.id,
			name: byId.name
		} : {
			id: cfg.projectId.trim(),
			name: cfg.projectName
		};
	}
	throw new Error("未匹配到滴答清单「" + cfg.projectName + "」清单：请在 dispatcher_config 里用 projectName / projectId 指定来源清单。");
}
/** Human-readable due label (local date). */
function dueLabel(dueDate) {
	if (typeof dueDate !== "string" || dueDate === "") return "无截止";
	return localDateOf(dueDate) ?? "无截止";
}
/**
* Run one dispatch using the given store and (optionally) an injected
* TickTickApi (the smoke tests inject a fake). Writes the today-tasks file
* and notifies, then records the dispatch on the store.
*
* On the scheduled interval, notify only when the task set CHANGED since the
* last dispatch (so a repeated pull with no new tasks stays silent). A manual
* `dispatcher_run` passes { forceNotify: true } to always notify.
*/
async function doDispatch(store, api, opts = {}) {
	const cfg = await store.load();
	const today = localDateString();
	const notifies = [];
	if (!cfg.enabled) return {
		ok: false,
		message: "插件已禁用（enabled=false），本次派发跳过。",
		dispatchedAt: (/* @__PURE__ */ new Date()).toISOString(),
		projectName: cfg.projectName,
		projectId: cfg.projectId ?? "",
		taskCount: 0,
		tasks: [],
		taskFile: cfg.taskFile,
		notifies,
		changed: false,
		notified: false
	};
	const { id: projectId, name: projectName } = await resolveProjectId(api, cfg);
	const data = await api.getProjectData(projectId);
	const selected = (Array.isArray(data.tasks) ? data.tasks : []).filter((t) => t.status !== 2).filter((t) => taskQualifies(t, cfg, today)).map((t) => ({
		id: t.id,
		projectId: t.projectId,
		title: t.title,
		content: typeof t.content === "string" ? t.content : "",
		dueDate: typeof t.dueDate === "string" ? t.dueDate : "",
		priority: typeof t.priority === "number" ? t.priority : 0,
		tags: Array.isArray(t.tags) ? t.tags.filter((x) => typeof x === "string") : []
	})).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
	const titles = selected.map((t) => t.title);
	const changed = JSON.stringify([...titles].sort()) !== JSON.stringify([...cfg.lastTaskTitles].sort());
	const taskFile = cfg.taskFile;
	await mkdir(path.dirname(taskFile), { recursive: true });
	const lines = selected.map((t) => `- [ ] ${t.title}（截止 ${dueLabel(t.dueDate) || "无截止"}）`);
	await writeFile(taskFile, [
		`# 今日待执行任务 · ${today}`,
		"",
		`**来源**：滴答清单「${projectName}」 · 共 ${selected.length} 项`,
		"",
		...lines,
		"",
		"执行说明：逐项处理；完成的用 ticktick_complete 回写滴答清单，并把结果落到知识库/项目档案。"
	].join("\n") + "\n");
	const shouldNotify = (opts.forceNotify === true || changed) && selected.length > 0;
	const notified = shouldNotify && (cfg.notifyFlomo || cfg.notifyMac);
	if (shouldNotify) {
		if (cfg.notifyFlomo) {
			const body = [`📋 今日派发 · ${today} · 「${projectName}」共 ${selected.length} 项待执行`, ...selected.slice(0, 12).map((t) => `- ${t.title}`)].join("\n");
			notifies.push(await flomoMemo(body, cfg.flomoTag));
		}
		if (cfg.notifyMac) notifies.push(await macNotify("DSH 任务派发", projectName, `今日 ${selected.length} 项任务待执行（${today}）`));
	}
	await store.recordDispatch(titles);
	let extra = "";
	if (selected.length === 0) extra = "，今日无待执行任务（未发送通知）";
	else if (!shouldNotify) extra = "，任务无变化，跳过通知";
	else if (notified) extra = "，已发送通知";
	else extra = "，通知未发送（flomo/macOS 均未配置）";
	return {
		ok: true,
		message: `已拉取 ${selected.length} 项任务（来源「${projectName}」），今日任务文件已写入 ${taskFile}${extra}。`,
		dispatchedAt: (/* @__PURE__ */ new Date()).toISOString(),
		projectName,
		projectId,
		taskCount: selected.length,
		tasks: selected,
		taskFile,
		notifies,
		changed,
		notified
	};
}
//#endregion
//#region src/workspaces.ts
/**
* dsh-task-dispatcher — DSH workspace lookup.
*
* Reads the DSH host's workspace ledger (~/.dsh/storages/workspace.json,
* the `workspace` storage unit) so the auto-execute worker can be launched
* inside a chosen workspace directory. A headless DSH session takes its
* workspace from process.cwd() (`meta.cwd`), and the host attaches a session
* to a workspace when their canonical cwd/path match — so spawning the worker
* with cwd = workspace.path makes the produced session show up under that
* workspace in the GUI sidebar.
*
* The storage file is a cordis storage unit; we only ever read the
* `tables.workspaces` table and tolerate any format drift by falling back to
* an empty list. No secrets live here.
*/
/** Default machine-wide workspace ledger location. */
const DEFAULT_WORKSPACE_STORE = path.join(homedir(), ".dsh", "storages", "workspace.json");
/** Test override for the workspace ledger location. */
function workspaceStorePath() {
	const override = process.env.DSH_WORKSPACE_STORE;
	return override !== void 0 && override !== "" ? override : DEFAULT_WORKSPACE_STORE;
}
/**
* List every known DSH workspace, sorted by title. Never throws: a missing,
* unreadable, or unexpectedly-shaped ledger simply yields [].
*/
async function listWorkspaces() {
	let raw;
	try {
		raw = await readFile(workspaceStorePath(), "utf8");
	} catch {
		return [];
	}
	try {
		const parsed = JSON.parse(raw);
		const tables = typeof parsed === "object" && parsed !== null ? parsed.tables : void 0;
		const workspaces = typeof tables === "object" && tables !== null ? tables.workspaces : void 0;
		if (typeof workspaces !== "object" || workspaces === null) return [];
		return Object.entries(workspaces).map(([id, record]) => {
			const entry = typeof record === "object" && record !== null ? record : {};
			return {
				id,
				title: typeof entry.title === "string" && entry.title !== "" ? entry.title : id,
				path: typeof entry.path === "string" ? entry.path : ""
			};
		}).filter((workspace) => workspace.path !== "").sort((a, b) => a.title.localeCompare(b.title, "zh"));
	} catch {
		return [];
	}
}
/**
* Resolve a workspace id to its directory path. Returns undefined when the id
* is empty or the workspace no longer exists (caller falls back to the
* default cwd).
*/
async function resolveWorkspacePath(workspaceId) {
	if (workspaceId === "") return void 0;
	return (await listWorkspaces()).find((workspace) => workspace.id === workspaceId)?.path;
}
/** Resolve a workspace id to its display title (falls back to the id). */
async function resolveWorkspaceTitle(workspaceId) {
	if (workspaceId === "") return void 0;
	const found = (await listWorkspaces()).find((workspace) => workspace.id === workspaceId);
	return found !== void 0 ? found.title : void 0;
}
//#endregion
//#region src/executor.ts
/**
* dsh-task-dispatcher — auto-execute worker (1 task = 1 headless DSH session).
*
* When autoExecute is on, the dispatcher runs each pulled task in its own
* `dsh --profile headless "<job>"` session (a fresh one-shot agent that uses
* only the base tools: bash / fs / glob / grep / web / todo). Sessions run
* SERIALLY (one at a time) to keep cost and load predictable. After a worker
* exits cleanly, the task is completed back in TickTick (auto-complete).
*
* Worker workspace: the headless session takes its workspace from
* process.cwd() (meta.cwd) and the host attaches it to the DSH workspace
* whose directory matches — so when `workerWorkspaceId` is configured, each
* worker is spawned with cwd = that workspace's directory and shows up under
* that workspace in the GUI sidebar. Unset (or a stale id) falls back to the
* user's home directory.
*
* Re-attempt protection: a task whose worker failed is marked attempted and
* not re-run until the retry cooldown elapses, so a flaky task doesn't spin
* every interval.
*/
/** Worker command (dsh headless) is spawned from the user's home dir. */
const WORKER_TIMEOUT_MS = 600 * 1e3;
/**
* Spawn `dsh --profile headless "<prompt>"` and resolve when it exits.
* Best-effort: never throws; resolves a WorkerResult even on spawn error.
*/
async function spawnWorker(prompt, opts = {}) {
	const cwd = opts.cwd ?? homedir();
	const timeoutMs = opts.timeoutMs ?? WORKER_TIMEOUT_MS;
	return new Promise((resolve) => {
		let output = "";
		let stderr = "";
		let settled = false;
		let child = null;
		try {
			child = spawn("dsh", [
				"--profile",
				"headless",
				prompt
			], {
				cwd,
				stdio: [
					"ignore",
					"pipe",
					"pipe"
				]
			});
		} catch (error) {
			return resolve({
				ok: false,
				exitCode: null,
				output: "",
				error: String(error)
			});
		}
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child?.kill("SIGKILL");
			resolve({
				ok: false,
				exitCode: null,
				output: output + stderr,
				error: "timeout"
			});
		}, timeoutMs);
		child.stdout?.on("data", (d) => {
			output += String(d);
		});
		child.stderr?.on("data", (d) => {
			stderr += String(d);
		});
		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				ok: false,
				exitCode: null,
				output: output + stderr,
				error: String(err)
			});
		});
		child.on("exit", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				ok: code === 0,
				exitCode: code,
				output: output + stderr
			});
		});
	});
}
/** Build a worker prompt from the template + this task. */
function buildWorkerPrompt(template, task) {
	return template.replace("{title}", task.title).replace("{content}", task.content);
}
/**
* Serial auto-execute over the given tasks.
* @param opts.spawn - injectable worker spaw (tests pass a fake).
* @param opts.onComplete - injectable "mark complete" (defaults to the TickTick
*   API's completeTask).
*/
async function runAutoExecute(store, api, tasks, opts = {}) {
	const cfg = await store.load();
	const log = [];
	const outcome = {
		executed: 0,
		completed: 0,
		failed: 0,
		skipped: 0,
		log
	};
	if (!cfg.autoExecute) {
		log.push("自动执行未开启（autoExecute=false）");
		return outcome;
	}
	const workerCwd = cfg.workerWorkspaceId !== "" ? await resolveWorkspacePath(cfg.workerWorkspaceId) : void 0;
	const spawn = opts.spawn ?? ((prompt) => spawnWorker(prompt, workerCwd !== void 0 ? { cwd: workerCwd } : {}));
	const onComplete = opts.onComplete ?? ((t) => api.completeTask(t.projectId, t.id));
	for (const task of tasks) {
		if (!await store.canRetry(task.id, cfg.retryCooldownMinutes)) {
			outcome.skipped++;
			log.push("跳过「" + task.title + "」（冷却期）");
			continue;
		}
		await store.markAttempted(task.id);
		outcome.executed++;
		const worker = await spawn(buildWorkerPrompt(cfg.workerPrompt, task));
		if (worker.ok) {
			outcome.completed++;
			try {
				await onComplete(task);
				log.push("✓ 完成「" + task.title + "」");
			} catch (error) {
				log.push("完成「" + task.title + "」但回写失败: " + String(error instanceof Error ? error.message : error));
			}
		} else {
			outcome.failed++;
			log.push("✗「" + task.title + "」执行失败" + (worker.error !== void 0 ? "（" + worker.error + "）" : ""));
		}
	}
	return outcome;
}
//#endregion
//#region src/tools.ts
/** One text content block (the only render shape these tools emit). */
function text(value) {
	return [{
		type: "text",
		text: value
	}];
}
/** Status tool: config + last dispatch summary. */
function dispatcherStatusTool(ctx) {
	return defineTool$1({
		name: "dispatcher_status",
		description: "查看 dsh-task-dispatcher 插件状态：是否启用、拉取间隔（分钟）、自动执行开关、自动执行会话的工作区、任务来源清单、过滤方式、通知开关、最近一次派发结果（时间/数量/任务标题）与今日任务文件路径。不会泄露任何密钥。",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					message: {
						type: "string",
						required: true
					},
					configured: { type: "boolean" },
					enabled: { type: "boolean" },
					announceToAgent: { type: "boolean" },
					dispatchIntervalMinutes: { type: "number" },
					autoExecute: { type: "boolean" },
					retryCooldownMinutes: { type: "number" },
					workerWorkspaceId: { type: "string" },
					projectName: { type: "string" },
					projectId: { type: "string" },
					dueMode: { type: "string" },
					includeUndated: { type: "boolean" },
					notifyFlomo: { type: "boolean" },
					flomoTag: { type: "string" },
					notifyMac: { type: "boolean" },
					taskFile: { type: "string" },
					lastDispatchAt: { type: "string" },
					lastTaskCount: { type: "number" },
					lastTaskTitles: {
						type: "array",
						items: { type: "string" }
					},
					workerPrompt: { type: "string" },
					configPath: { type: "string" }
				}
			},
			render: (_args, value) => text(String(value.message ?? ""))
		},
		async execute() {
			try {
				const view = await ctx.store.view();
				const interval = view.dispatchIntervalMinutes === 0 ? "已关闭定时" : "每 " + view.dispatchIntervalMinutes + " 分钟自动拉取";
				const workerWorkspace = view.workerWorkspaceId === "" ? "默认（用户主目录）" : await resolveWorkspaceTitle(view.workerWorkspaceId) ?? view.workerWorkspaceId + "（已不存在，将回退主目录）";
				const parts = [
					"插件状态：" + (view.enabled ? "已启用" : "已禁用"),
					"拉取间隔：" + interval,
					"自动执行：" + (view.autoExecute ? "开（每任务一个 DSH 会话，串行）" : "关"),
					"执行会话工作区：" + workerWorkspace,
					"任务来源：滴答清单「" + view.projectName + "」",
					"过滤：" + (view.dueMode === "all" ? "全部未完成" : "今天到期/逾期" + (view.includeUndated ? " + 无截止" : "")),
					"通知：" + [view.notifyFlomo ? "flomo" : "", view.notifyMac ? "macOS" : ""].filter(Boolean).join("+") || "无",
					"今日任务文件：" + view.taskFile
				];
				if (view.lastDispatchAt) {
					parts.push("上次拉取：" + view.lastDispatchAt + " · " + view.lastTaskCount + " 项");
					parts.push("任务列表：" + (view.lastTaskTitles.length > 0 ? view.lastTaskTitles.join("；") : "（空）"));
				} else parts.push("上次拉取：（尚未拉取）");
				return {
					ok: true,
					message: parts.join("\n"),
					...view
				};
			} catch (error) {
				return {
					ok: false,
					message: "读取状态失败: " + String(error instanceof Error ? error.message : error)
				};
			}
		}
	});
}
/** Config tool: update dispatcher settings. */
function dispatcherConfigTool(ctx) {
	return defineTool$1({
		name: "dispatcher_config",
		description: "配置 dsh-task-dispatcher：enabled（总开关）、dispatchIntervalMinutes（每隔多少分钟自动拉取一次，0=关闭定时）、projectName 或 projectId（任务来源滴答清单，默认 5️⃣AI）、dueMode（today=今天到期/逾期，all=全部未完成）、includeUndated（是否含无截止任务）、notifyFlomo/notifyMac（通知开关）、flomoTag（flomo 标签）、taskFile（今日任务文件路径）、autoExecute（是否自动执行：为每个拉到的新任务单独开一个 DSH 会话去执行）、workerWorkspaceId（执行会话运行在哪个 DSH 工作区，传空字符串=默认主目录；用 dispatcher_status 可看到工作区 id）、retryCooldownMinutes（失败任务重试冷却分钟）、workerPrompt（执行会话的提示词模板，可用 {title}/{content}）、announceToAgent（是否在系统提示公告）。配置持久化到 ~/.dsh/dsh-task-dispatcher.json（0600）。传 reset: true 恢复默认。",
		parameters: {
			enabled: {
				type: "boolean",
				description: "插件总开关"
			},
			dispatchIntervalMinutes: {
				type: "number",
				description: "每隔多少分钟自动拉取一次滴答清单（0 关闭定时）"
			},
			projectName: {
				type: "string",
				description: "任务来源清单名（默认 5️⃣AI）"
			},
			projectId: {
				type: "string",
				description: "可选：来源清单 id（按名称解析不到时用）"
			},
			dueMode: {
				type: "string",
				enum: ["today", "all"],
				description: "today=今天到期/逾期；all=全部未完成"
			},
			includeUndated: {
				type: "boolean",
				description: "dueMode=today 时是否包含无截止日期任务"
			},
			notifyFlomo: {
				type: "boolean",
				description: "是否推送 flomo"
			},
			flomoTag: {
				type: "string",
				description: "flomo 标签（不带 #，空格分隔）"
			},
			notifyMac: {
				type: "boolean",
				description: "是否发送 macOS 通知"
			},
			taskFile: {
				type: "string",
				description: "今日任务文件路径"
			},
			autoExecute: {
				type: "boolean",
				description: "是否自动执行（每个任务单独一个 DSH 会话）"
			},
			workerWorkspaceId: {
				type: "string",
				description: "执行会话运行的 DSH 工作区 id（空字符串=默认主目录）"
			},
			retryCooldownMinutes: {
				type: "number",
				description: "失败任务重试冷却分钟"
			},
			workerPrompt: {
				type: "string",
				description: "执行会话提示词模板（{title}/{content}）"
			},
			announceToAgent: {
				type: "boolean",
				description: "是否在系统提示公告插件"
			},
			reset: {
				type: "boolean",
				description: "恢复默认配置"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					message: {
						type: "string",
						required: true
					},
					enabled: { type: "boolean" },
					dispatchIntervalMinutes: { type: "number" },
					projectName: { type: "string" },
					dueMode: { type: "string" },
					includeUndated: { type: "boolean" },
					notifyFlomo: { type: "boolean" },
					flomoTag: { type: "string" },
					notifyMac: { type: "boolean" },
					taskFile: { type: "string" },
					autoExecute: { type: "boolean" },
					workerWorkspaceId: { type: "string" },
					retryCooldownMinutes: { type: "number" },
					configPath: { type: "string" }
				}
			},
			render: (_args, value) => text(String(value.message ?? ""))
		},
		async execute(args) {
			try {
				if (args !== void 0 && args.reset === true) {
					await ctx.store.patch({
						enabled: true,
						announceToAgent: true,
						dispatchIntervalMinutes: 30,
						projectName: "5️⃣AI",
						projectId: "",
						dueMode: "today",
						includeUndated: true,
						notifyFlomo: true,
						flomoTag: "AI/DSH/派发",
						notifyMac: true,
						taskFile: "",
						autoExecute: false,
						retryCooldownMinutes: 60,
						workerWorkspaceId: ""
					});
					args = {};
				}
				const view = await ctx.store.patch(args);
				const interval = view.dispatchIntervalMinutes === 0 ? "已关闭定时" : "每 " + view.dispatchIntervalMinutes + " 分钟";
				const auto = view.autoExecute ? " · 自动执行开" : " · 自动执行关";
				const workspace = view.workerWorkspaceId === "" ? "" : " · 工作区 " + (await resolveWorkspaceTitle(view.workerWorkspaceId) ?? view.workerWorkspaceId);
				return {
					ok: true,
					message: "配置已保存：" + (view.enabled ? "启用" : "禁用") + " · " + interval + auto + workspace + " · 来源「" + view.projectName + "」",
					enabled: view.enabled,
					dispatchIntervalMinutes: view.dispatchIntervalMinutes,
					projectName: view.projectName,
					dueMode: view.dueMode,
					includeUndated: view.includeUndated,
					notifyFlomo: view.notifyFlomo,
					flomoTag: view.flomoTag,
					notifyMac: view.notifyMac,
					taskFile: view.taskFile,
					autoExecute: view.autoExecute,
					workerWorkspaceId: view.workerWorkspaceId,
					retryCooldownMinutes: view.retryCooldownMinutes,
					configPath: view.configPath
				};
			} catch (error) {
				return {
					ok: false,
					message: "配置失败: " + String(error instanceof Error ? error.message : error)
				};
			}
		}
	});
}
/** Run tool: perform a dispatch now. */
function dispatcherRunTool(ctx) {
	return defineTool$1({
		name: "dispatcher_run",
		description: "立即执行一次任务拉取：从滴答清单「5️⃣AI」（或配置的来源）拉取今天到期的任务，写入今日任务文件，并发送 flomo + macOS 通知（手动触发始终通知）。若开启 autoExecute，还会为每个拉到的新任务单独开一个 DSH 会话去执行并自动勾掉。常用于手动触发派发或验证配置。",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					message: {
						type: "string",
						required: true
					},
					dispatchedAt: { type: "string" },
					projectName: { type: "string" },
					taskCount: { type: "number" },
					taskFile: { type: "string" },
					flomoNotify: { type: "string" },
					macNotify: { type: "string" },
					autoExecuted: { type: "number" },
					autoCompleted: { type: "number" }
				}
			},
			render: (_args, value) => text(String(value.message ?? ""))
		},
		async execute() {
			try {
				const result = await doDispatch(ctx.store, ctx.api, { forceNotify: true });
				let autoExecuted = 0;
				let autoCompleted = 0;
				if (result.ok && result.tasks.length > 0) {
					if ((await ctx.store.load()).autoExecute) {
						const exec = await runAutoExecute(ctx.store, ctx.api, result.tasks);
						autoExecuted = exec.executed;
						autoCompleted = exec.completed;
					}
				}
				const flomoNotify = result.notifies.find((n) => n.channel === "flomo");
				const macNotify = result.notifies.find((n) => n.channel === "mac");
				return {
					ok: result.ok,
					message: result.message + (autoExecuted > 0 ? " 自动执行 " + autoExecuted + " 项，完成 " + autoCompleted + " 项。" : ""),
					dispatchedAt: result.dispatchedAt,
					projectName: result.projectName,
					taskCount: result.taskCount,
					taskFile: result.taskFile,
					flomoNotify: flomoNotify?.ok === true ? "ok" : flomoNotify === void 0 ? "none" : "failed",
					macNotify: macNotify?.ok === true ? "ok" : macNotify === void 0 ? "none" : "failed",
					autoExecuted,
					autoCompleted
				};
			} catch (error) {
				return {
					ok: false,
					message: "派发失败: " + String(error instanceof Error ? error.message : error)
				};
			}
		}
	});
}
/** Report tool: send the agent/session outcome summary to flomo. */
function dispatcherReportTool(ctx) {
	return defineTool$1({
		name: "dispatcher_report",
		description: "任务执行完/会话结束后，把本次执行结果汇总发一条 flomo 通知（复用 dsh-task-dispatcher 的 flomo 配置与标签）。参数：total（共几项）、completed（完成）、failed（失败）、skipped（跳过）、summary（可选的自定义说明/备注，多行）、date（可选，默认今天）。调用后由本插件读 ~/.dsh/dsh-flomo.json 发送，标签用配置 flomoTag。",
		parameters: {
			total: {
				type: "number",
				description: "本次会话任务总数（可选）"
			},
			completed: {
				type: "number",
				description: "完成数量（可选）"
			},
			failed: {
				type: "number",
				description: "失败数量（可选）"
			},
			skipped: {
				type: "number",
				description: "跳过数量（可选）"
			},
			summary: {
				type: "string",
				description: "可选：本次会话的说明/备注，多行文本"
			},
			date: {
				type: "string",
				description: "可选：日期 YYYY-MM-DD，默认今天"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					message: {
						type: "string",
						required: true
					},
					flomoNotify: { type: "string" }
				}
			},
			render: (_args, value) => text(String(value.message ?? ""))
		},
		async execute(args) {
			try {
				const cfg = await ctx.store.load();
				if (!cfg.notifyFlomo) return {
					ok: false,
					message: "flomo 通知已关闭（notifyFlomo=false），未发送。如需发送请在设置面板开启。",
					flomoNotify: "off"
				};
				if (cfg.flomoTag === "") return {
					ok: false,
					message: "未配置 flomo 标签（flomoTag 为空），未发送。请先用 dispatcher_config 设置 flomoTag。",
					flomoNotify: "off"
				};
				const date = typeof args?.date === "string" && args.date.trim() !== "" ? args.date.trim() : localDateString();
				const num = (v) => typeof v === "number" && Number.isFinite(v) ? v : 0;
				const total = num(args?.total);
				const completed = num(args?.completed);
				const failed = num(args?.failed);
				const skipped = num(args?.skipped);
				const summary = typeof args?.summary === "string" ? args.summary.trim() : "";
				const lines = ["🗂 任务派发 · " + date + " · 会话汇总"];
				if (total > 0 || completed > 0 || failed > 0 || skipped > 0) lines.push("完成：" + completed + " · 失败：" + failed + " · 跳过：" + skipped + "（共 " + total + " 项）");
				if (summary !== "") lines.push(summary);
				const result = await flomoMemo(lines.join("\n"), cfg.flomoTag);
				const flag = result.ok ? "ok" : "failed";
				return {
					ok: result.ok,
					message: result.ok ? "已发送 flomo 汇总：" + result.message : "flomo 发送失败：" + result.message,
					flomoNotify: flag
				};
			} catch (error) {
				return {
					ok: false,
					message: "发送汇总失败: " + String(error instanceof Error ? error.message : error),
					flomoNotify: "failed"
				};
			}
		}
	});
}
/** Build the tool list for registration. */
function buildTools(ctx) {
	return [
		dispatcherStatusTool(ctx),
		dispatcherConfigTool(ctx),
		dispatcherRunTool(ctx),
		dispatcherReportTool(ctx)
	];
}
//#endregion
//#region src/routes.ts
/** Route paths. */
const DISPATCHER_API = {
	config: "/api/dsh-task-dispatcher/config",
	status: "/api/dsh-task-dispatcher/status",
	run: "/api/dsh-task-dispatcher/run",
	workspaces: "/api/dsh-task-dispatcher/workspaces"
};
/** Cap on JSON request bodies. */
const MAX_JSON_BODY_BYTES = 256 * 1024;
/** Strict loopback fence for all routes. */
function isLoopbackRequest(request) {
	const address = request.socket.remoteAddress;
	if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
	const host = request.headers.host;
	if (typeof host !== "string") return false;
	let hostUrl;
	try {
		hostUrl = new URL(`http://${host}`);
	} catch {
		return false;
	}
	if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false;
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = request.headers.origin;
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
/** One JSON response. */
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"referrer-policy": "no-referrer"
	});
	res.end(payload);
}
/** Read a JSON request body (undefined when too large or unparseable). */
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		size += buffer.length;
		if (size > MAX_JSON_BODY_BYTES) return void 0;
		chunks.push(buffer);
	}
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return typeof parsed === "object" && parsed !== null ? parsed : void 0;
	} catch {
		return;
	}
}
/** Build every /api/dsh-task-dispatcher route (exact paths). */
function makeRoutes(deps) {
	const { store, api } = deps;
	const guard = (req, res, method) => {
		if (!isLoopbackRequest(req)) {
			writeJson(res, 403, { error: "forbidden: loopback-only" });
			return false;
		}
		if (req.method !== method) {
			writeJson(res, 405, { error: `method not allowed: ${req.method}` });
			return false;
		}
		return true;
	};
	return [
		{
			kind: "exact",
			path: DISPATCHER_API.config,
			handler: async (req, res) => {
				const method = req.method ?? "GET";
				if (method === "GET") {
					if (!guard(req, res, "GET")) return;
					writeJson(res, 200, await store.view());
					return;
				}
				if (method === "POST") {
					if (!guard(req, res, "POST")) return;
					const body = await readJsonBody(req);
					if (body === void 0) {
						writeJson(res, 400, { error: "invalid JSON body" });
						return;
					}
					writeJson(res, 200, await store.patch(body));
					return;
				}
				writeJson(res, 405, { error: `method not allowed: ${method}` });
			}
		},
		{
			kind: "exact",
			path: DISPATCHER_API.status,
			handler: async (req, res) => {
				if (!guard(req, res, "GET")) return;
				writeJson(res, 200, await store.view());
			}
		},
		{
			kind: "exact",
			path: DISPATCHER_API.run,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				try {
					writeJson(res, 200, await doDispatch(store, api));
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						message: "派发失败: " + String(error instanceof Error ? error.message : error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: DISPATCHER_API.workspaces,
			handler: async (req, res) => {
				if (!guard(req, res, "GET")) return;
				writeJson(res, 200, { workspaces: await listWorkspaces() });
			}
		}
	];
}
//#endregion
//#region src/index.ts
/** Stable cordis plugin name. */
const name = "task-dispatcher";
/** Services required before the dispatcher surfaces can mount. */
const inject = [
	"tools",
	"systemPrompt",
	"webServer",
	"timer"
];
/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 170;
/** Model-facing announcement: plugin presence, capabilities, and limits. */
const DISPATCHER_GUIDANCE = "本机已安装 dsh-task-dispatcher 插件（滴答清单任务派发器）：每隔一段可配置的间隔（默认每 30 分钟）自动从滴答清单「5️⃣AI」（或配置的来源）拉取今天到期/逾期的任务，写入今日任务文件（默认 ~/.dsh/dsh-task-dispatcher/today-tasks.md），并在任务发生变化时发送 flomo+macOS 通知。工具：dispatcher_status（状态）、dispatcher_config（配置拉取间隔/来源/过滤/通知/自动执行）、dispatcher_run（立即拉取一次）、dispatcher_report（执行完/会话结束后发一条 flomo 汇总）。你任务都是随手写进滴答清单的，插件会自动跟上：随时往清单里加任务，下次拉取就会带进来。当你开始一天的工作时，先用 read 读取今日任务文件，逐项执行；完成的用 ticktick_complete 回写滴答清单，并把结果落到 Obsidian 知识库/项目档案。每次执行完/告一段落后，调用 dispatcher_report 把本次完成/失败/跳过情况汇总（total/completed/failed/skipped + 可选 summary）发一条 flomo。用户提到「任务派发器 / 今日任务 / 派发 / 今天要做啥」时即指本插件，请据此协作。";
/**
* Mount the dispatcher tools, routes, announcement, and daily timer.
* @param ctx - host plugin context carrying tools/systemPrompt/webServer/timer.
* @param config - plugin config from the composition row.
*/
function apply(ctx, config) {
	const announceToAgent = config?.announceToAgent !== false;
	const enabled = config?.enabled !== false;
	const store = new DispatcherStore();
	const api = new TickTickApi(new TickTickStore());
	const toolContext = {
		store,
		api
	};
	let disposeTools;
	let disposeRoutes;
	let disposeSection;
	let disposeTimer;
	let busy = false;
	const sync = () => {
		if (disposeTools !== void 0) {
			disposeTools();
			disposeTools = void 0;
		}
		if (disposeRoutes !== void 0) {
			disposeRoutes();
			disposeRoutes = void 0;
		}
		if (disposeSection !== void 0) {
			disposeSection();
			disposeSection = void 0;
		}
		if (disposeTimer !== void 0) {
			disposeTimer();
			disposeTimer = void 0;
		}
		if (!enabled) return;
		disposeTools = ctx.effect(() => {
			const disposers = buildTools(toolContext).map((tool) => ctx.tools.register(tool));
			return () => {
				for (const dispose of disposers) dispose();
			};
		}, "dsh-task-dispatcher: tools");
		disposeRoutes = ctx.effect(() => {
			const disposers = makeRoutes(toolContext).map((route) => ctx.webServer.register(route));
			return () => {
				for (const dispose of disposers) dispose();
			};
		}, "dsh-task-dispatcher: routes");
		if (announceToAgent) disposeSection = ctx.systemPrompt.section({
			name: "plugin:dsh-task-dispatcher",
			order: SECTION_ORDER,
			text: DISPATCHER_GUIDANCE
		});
		disposeTimer = ctx.interval(() => {
			(async () => {
				if (busy) return;
				busy = true;
				try {
					const cfg = await store.load();
					if (!cfg.enabled) return;
					const minutes = cfg.dispatchIntervalMinutes;
					if (minutes <= 0) return;
					const now = Date.now();
					const last = cfg.lastDispatchAt !== "" ? new Date(cfg.lastDispatchAt).getTime() : 0;
					if (last !== 0 && now - last < minutes * 60 * 1e3) return;
					const result = await doDispatch(store, api);
					ctx.logger?.info?.("[dsh-task-dispatcher] pull: " + result.message);
					if (cfg.autoExecute && result.tasks.length > 0) {
						ctx.logger?.info?.("[dsh-task-dispatcher] auto-executing " + result.tasks.length + " task(s), serial");
						const exec = await runAutoExecute(store, api, result.tasks);
						ctx.logger?.info?.("[dsh-task-dispatcher] auto-execute: " + exec.log.join(" | "));
					}
				} catch (error) {
					ctx.logger?.warn?.("[dsh-task-dispatcher] pull failed: " + String(error instanceof Error ? error.message : error));
				} finally {
					busy = false;
				}
			})();
		}, 60 * 1e3);
	};
	sync();
}
//#endregion
export { DEFAULT_CONFIG_FILE, DEFAULT_TASK_FILE, DEFAULT_WORKER_PROMPT, DEFAULT_WORKSPACE_STORE, DISPATCHER_API, DISPATCHER_GUIDANCE, DispatcherStore, apply, buildTools, buildWorkerPrompt, configPath, defineTool, dispatcherConfigTool, dispatcherReportTool, dispatcherRunTool, dispatcherStatusTool, doDispatch, flomoMemo, inject, listWorkspaces, localDateString, macNotify, makeRoutes, name, resolveWorkspacePath, resolveWorkspaceTitle, runAutoExecute, spawnWorker, workspaceStorePath };
