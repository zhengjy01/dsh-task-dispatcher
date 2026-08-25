import { defineTool, defineTool as defineTool$1 } from "@deepseek-ai/dsh-tools";
import { TickTickApi, TickTickStore } from "dsh-ticktick";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
//#region src/store.ts
/**
* dsh-task-dispatcher — config store.
*
* Persists the dispatcher configuration (dispatch time, source TickTick
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
		dispatchHour: 8,
		dispatchMinute: 30,
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
		lastTaskTitles: []
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
		dispatchHour: clampInt(num(record.dispatchHour, d.dispatchHour), 0, 23),
		dispatchMinute: clampInt(num(record.dispatchMinute, d.dispatchMinute), 0, 59),
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
		lastTaskTitles: Array.isArray(record.lastTaskTitles) ? record.lastTaskTitles.filter((t) => typeof t === "string") : []
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
			dispatchHour: cfg.dispatchHour,
			dispatchMinute: cfg.dispatchMinute,
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
			configPath: configPath()
		};
	}
	/** Apply a config patch: strings/numbers/booleans replace, undefined keeps. */
	async patch(args) {
		const next = { ...await this.load() };
		if (args !== void 0 && typeof args.enabled === "boolean") next.enabled = args.enabled;
		if (args !== void 0 && typeof args.announceToAgent === "boolean") next.announceToAgent = args.announceToAgent;
		if (args !== void 0 && args.dispatchHour !== void 0) next.dispatchHour = clampInt(Number(args.dispatchHour), 0, 23);
		if (args !== void 0 && args.dispatchMinute !== void 0) next.dispatchMinute = clampInt(Number(args.dispatchMinute), 0, 59);
		if (args !== void 0 && typeof args.projectName === "string") next.projectName = args.projectName.trim();
		if (args !== void 0 && typeof args.projectId === "string") next.projectId = args.projectId.trim();
		if (args !== void 0 && (args.dueMode === "today" || args.dueMode === "all")) next.dueMode = args.dueMode;
		if (args !== void 0 && typeof args.includeUndated === "boolean") next.includeUndated = args.includeUndated;
		if (args !== void 0 && typeof args.notifyFlomo === "boolean") next.notifyFlomo = args.notifyFlomo;
		if (args !== void 0 && typeof args.flomoTag === "string") next.flomoTag = args.flomoTag.trim();
		if (args !== void 0 && typeof args.notifyMac === "boolean") next.notifyMac = args.notifyMac;
		if (args !== void 0 && typeof args.taskFile === "string" && args.taskFile.trim() !== "") next.taskFile = args.taskFile.trim();
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
/** Whether a dueDate string is on or before `today` (calendar date compare). */
function dueThisDay(dueDate, today) {
	if (typeof dueDate !== "string" || dueDate === "") return false;
	const datePart = dueDate.slice(0, 10);
	return /^\d{4}-\d{2}-\d{2}$/.test(datePart) && datePart <= today;
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
/** Human-readable due label. */
function dueLabel(dueDate) {
	if (typeof dueDate !== "string" || dueDate === "") return "无截止";
	return dueDate.slice(0, 10);
}
/**
* Run one dispatch using the given store and (optionally) an injected
* TickTickApi (the smoke tests inject a fake). Writes the today-tasks file
* and notifies, then records the dispatch on the store.
*/
async function doDispatch(store, api) {
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
		notifies
	};
	const { id: projectId, name: projectName } = await resolveProjectId(api, cfg);
	const data = await api.getProjectData(projectId);
	const selected = (Array.isArray(data.tasks) ? data.tasks : []).filter((t) => t.status !== 2).filter((t) => taskQualifies(t, cfg, today)).map((t) => ({
		id: t.id,
		projectId: t.projectId,
		title: t.title,
		dueDate: typeof t.dueDate === "string" ? t.dueDate : "",
		priority: typeof t.priority === "number" ? t.priority : 0,
		tags: Array.isArray(t.tags) ? t.tags.filter((x) => typeof x === "string") : []
	})).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
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
	if (cfg.notifyFlomo) {
		const body = [`📋 今日派发 · ${today} · 「${projectName}」共 ${selected.length} 项待执行`, ...selected.slice(0, 12).map((t) => `- ${t.title}`)].join("\n");
		notifies.push(await flomoMemo(body, cfg.flomoTag));
	}
	if (cfg.notifyMac) notifies.push(await macNotify("DSH 任务派发", projectName, `今日 ${selected.length} 项任务待执行（${today}）`));
	await store.recordDispatch(selected.map((t) => t.title));
	return {
		ok: true,
		message: `已派发 ${selected.length} 项任务（来源「${projectName}」），今日任务文件已写入 ${taskFile}。`,
		dispatchedAt: (/* @__PURE__ */ new Date()).toISOString(),
		projectName,
		projectId,
		taskCount: selected.length,
		tasks: selected,
		taskFile,
		notifies
	};
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
		description: "查看 dsh-task-dispatcher 插件状态：是否启用、每日派发时间、任务来源清单、过滤方式、通知开关、最近一次派发结果（时间/数量/任务标题）与今日任务文件路径。不会泄露任何密钥。",
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
					dispatchHour: { type: "number" },
					dispatchMinute: { type: "number" },
					dispatchTime: { type: "string" },
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
					configPath: { type: "string" }
				}
			},
			render: (_args, value) => text(String(value.message ?? ""))
		},
		async execute() {
			try {
				const view = await ctx.store.view();
				const now = /* @__PURE__ */ new Date();
				const next = new Date(now);
				next.setHours(view.dispatchHour, view.dispatchMinute, 0, 0);
				if (next <= now) next.setDate(next.getDate() + 1);
				const parts = [
					"插件状态：" + (view.enabled ? "已启用" : "已禁用"),
					"每日派发：" + String(view.dispatchHour).padStart(2, "0") + ":" + String(view.dispatchMinute).padStart(2, "0"),
					"下次派发：" + localLabel(next),
					"任务来源：滴答清单「" + view.projectName + "」",
					"过滤：" + (view.dueMode === "all" ? "全部未完成" : "今天到期/逾期" + (view.includeUndated ? " + 无截止" : "")),
					"通知：" + [view.notifyFlomo ? "flomo" : "", view.notifyMac ? "macOS" : ""].filter(Boolean).join("+") || "无",
					"今日任务文件：" + view.taskFile
				];
				if (view.lastDispatchAt) {
					parts.push("上次派发：" + view.lastDispatchAt + " · " + view.lastTaskCount + " 项");
					parts.push("任务列表：" + (view.lastTaskTitles.length > 0 ? view.lastTaskTitles.join("；") : "（空）"));
				} else parts.push("上次派发：（尚未派发）");
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
		description: "配置 dsh-task-dispatcher：enabled（总开关）、dispatchHour/dispatchMinute（每日派发时刻，如 8/30）、projectName 或 projectId（任务来源滴答清单，默认 5️⃣AI）、dueMode（today=今天到期/逾期，all=全部未完成）、includeUndated（是否含无截止任务）、notifyFlomo/notifyMac（通知开关）、flomoTag（flomo 标签）、taskFile（今日任务文件路径）、announceToAgent（是否在系统提示公告）。配置持久化到 ~/.dsh/dsh-task-dispatcher.json（0600）。传 reset: true 恢复默认。",
		parameters: {
			enabled: {
				type: "boolean",
				description: "插件总开关"
			},
			dispatchHour: {
				type: "number",
				description: "每日派发小时（0-23）"
			},
			dispatchMinute: {
				type: "number",
				description: "每日派发分钟（0-59）"
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
					dispatchTime: { type: "string" },
					projectName: { type: "string" },
					dueMode: { type: "string" },
					includeUndated: { type: "boolean" },
					notifyFlomo: { type: "boolean" },
					flomoTag: { type: "string" },
					notifyMac: { type: "boolean" },
					taskFile: { type: "string" },
					configPath: { type: "string" }
				}
			},
			render: (_args, value) => text(String(value.message ?? ""))
		},
		async execute(args) {
			try {
				if (args !== void 0 && args.reset === true) await ctx.store.patch({
					enabled: false,
					announceToAgent: true,
					dispatchHour: 8,
					dispatchMinute: 30,
					projectName: "5️⃣AI",
					projectId: "",
					dueMode: "today",
					includeUndated: true,
					notifyFlomo: true,
					flomoTag: "AI/DSH/派发",
					notifyMac: true,
					taskFile: ""
				});
				const view = await ctx.store.patch(args);
				const time = String(view.dispatchHour).padStart(2, "0") + ":" + String(view.dispatchMinute).padStart(2, "0");
				return {
					ok: true,
					message: "配置已保存：" + (view.enabled ? "启用" : "禁用") + " · 每日 " + time + " · 来源「" + view.projectName + "」",
					enabled: view.enabled,
					dispatchTime: time,
					projectName: view.projectName,
					dueMode: view.dueMode,
					includeUndated: view.includeUndated,
					notifyFlomo: view.notifyFlomo,
					flomoTag: view.flomoTag,
					notifyMac: view.notifyMac,
					taskFile: view.taskFile,
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
		description: "立即执行一次任务派发：从滴答清单「5️⃣AI」（或配置的来源）拉取今天到期的任务，写入今日任务文件，并发送 flomo + macOS 通知。常用于手动触发派发或验证配置。",
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
					macNotify: { type: "string" }
				}
			},
			render: (_args, value) => text(String(value.message ?? ""))
		},
		async execute() {
			try {
				const result = await doDispatch(ctx.store, ctx.api);
				const flomoNotify = result.notifies.find((n) => n.channel === "flomo");
				const macNotify = result.notifies.find((n) => n.channel === "mac");
				return {
					ok: result.ok,
					message: result.message,
					dispatchedAt: result.dispatchedAt,
					projectName: result.projectName,
					taskCount: result.taskCount,
					taskFile: result.taskFile,
					flomoNotify: flomoNotify?.ok === true ? "ok" : "failed",
					macNotify: macNotify?.ok === true ? "ok" : "failed"
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
/** Build the tool list for registration. */
function buildTools(ctx) {
	return [
		dispatcherStatusTool(ctx),
		dispatcherConfigTool(ctx),
		dispatcherRunTool(ctx)
	];
}
/** Local date-time label for a Date. */
function localLabel(d) {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
//#endregion
//#region src/routes.ts
/** Route paths. */
const DISPATCHER_API = {
	config: "/api/dsh-task-dispatcher/config",
	status: "/api/dsh-task-dispatcher/status",
	run: "/api/dsh-task-dispatcher/run"
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
const DISPATCHER_GUIDANCE = "本机已安装 dsh-task-dispatcher 插件（滴答清单任务派发器）：每天早上（默认 08:30）会把滴答清单「5️⃣AI」（或配置的来源）中今天到期/逾期的任务写入今日任务文件（默认 ~/.dsh/dsh-task-dispatcher/today-tasks.md），并发送 flomo+macOS 通知。工具：dispatcher_status（状态）、dispatcher_config（配置派发时间/来源/过滤/通知）、dispatcher_run（立即派发一次）。当你开始一天的工作时，先用 read 读取今日任务文件，逐项执行；完成的用 ticktick_complete 回写滴答清单，并把结果落到 Obsidian 知识库/项目档案。用户提到「任务派发器 / 今日任务 / 派发 / 今天要做啥」时即指本插件，请据此协作。";
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
				try {
					const cfg = await store.load();
					if (!cfg.enabled) return;
					const now = /* @__PURE__ */ new Date();
					if (now.getHours() !== cfg.dispatchHour || now.getMinutes() !== cfg.dispatchMinute) return;
					if (cfg.lastDispatchAt.slice(0, 16) === localDateString(now) + "T" + String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0")) return;
					const result = await doDispatch(store, api);
					ctx.logger?.info?.("[dsh-task-dispatcher] dispatch: " + result.message);
				} catch (error) {
					ctx.logger?.warn?.("[dsh-task-dispatcher] dispatch failed: " + String(error instanceof Error ? error.message : error));
				}
			})();
		}, 60 * 1e3);
	};
	sync();
}
//#endregion
export { DEFAULT_CONFIG_FILE, DEFAULT_TASK_FILE, DISPATCHER_API, DISPATCHER_GUIDANCE, DispatcherStore, apply, buildTools, configPath, defineTool, dispatcherConfigTool, dispatcherRunTool, dispatcherStatusTool, doDispatch, flomoMemo, inject, localDateString, macNotify, makeRoutes, name };
