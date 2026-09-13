import { defineTool, defineTool as defineTool$1 } from "@deepseek-ai/dsh-tools";
import { TickTickApi, TickTickStore } from "dsh-ticktick";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { homedir, platform } from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
//#region src/home.ts
/**
* dsh-task-dispatcher — DeepSeek Harness home resolution.
*
* Every path this plugin owns (config, task file, workspace ledger, flomo
* credentials) is derived from the harness home, never from a hardcoded
* `~/.dsh`.
*
* Resolution order (per the DSH plugin portability checklist):
*   1. the plugin's own override — a full path, used by tests / throwaway
*      instances / per-plugin relocation;
*   2. `DSH_HOME` — a launcher or a rescue capsule may relocate the whole
*      home, and the host sets `DSH_HOME` before loading plugins;
*   3. `~/.dsh` — the conventional machine-wide location.
*
* Hardcoding `~/.dsh` silently writes a second, wrong home on a relocated
* setup (the plugin then "loses" its config), so all owned paths go here.
*/
/** The harness home directory: `DSH_HOME` when set (non-empty), else ~/.dsh. */
function dshHome() {
	const shared = (process.env.DSH_HOME ?? "").trim();
	return shared !== "" ? shared : path.join(homedir(), ".dsh");
}
/**
* Resolve one owned path under the harness home.
* @param override - the plugin-specific override (empty/undefined = not set).
* @param segments - path segments below the home, e.g. `'dsh-task-dispatcher.json'`.
* @returns the override when set, else `<home>/<segments…>`.
*/
function pluginPath(override, ...segments) {
	const own = (override ?? "").trim();
	return own !== "" ? own : path.join(dshHome(), ...segments);
}
//#endregion
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
/** Default config location: DSH_HOME when set, else ~/.dsh (mode 0600). */
const DEFAULT_CONFIG_FILE = pluginPath(void 0, "dsh-task-dispatcher.json");
/** Default workspace task file written on each dispatch (under DSH_HOME). */
const DEFAULT_TASK_FILE = pluginPath(void 0, "dsh-task-dispatcher", "today-tasks.md");
/** Default minutes before an auto-execute worker is killed (was a hardcoded 10). */
const DEFAULT_WORKER_TIMEOUT_MINUTES = 30;
/** Default worker prompt template ({title}/{content} replaced per task). */
const DEFAULT_WORKER_PROMPT = "你是 DeepSeek Harness 的独立任务执行会话。请用你手头的基础工具（bash/读写文件/glob/grep/网络/目标工具）执行下面这一项任务：\n\n任务：{title}\n说明：{content}\n\n要求：聚焦完成这一项即可；完成后在回复末尾单独输出一行：DONE";
/** Config location: DSH_TASK_DISPATCHER_CONFIG → DSH_HOME → ~/.dsh (mode 0600). */
function configPath() {
	return pluginPath(process.env.DSH_TASK_DISPATCHER_CONFIG, "dsh-task-dispatcher.json");
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
		flomoStripBodyHash: true,
		notifyMac: true,
		notifyResult: true,
		notifyWechat: false,
		wechatGatewayUrl: "",
		wechatTo: "",
		wechatStateDir: "",
		taskFile: DEFAULT_TASK_FILE,
		lastDispatchAt: "",
		lastTaskCount: 0,
		lastTaskTitles: [],
		autoExecute: false,
		retryCooldownMinutes: 60,
		workerTimeoutMinutes: 30,
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
		flomoStripBodyHash: bool(record.flomoStripBodyHash, d.flomoStripBodyHash),
		notifyMac: bool(record.notifyMac, d.notifyMac),
		notifyResult: bool(record.notifyResult, d.notifyResult),
		notifyWechat: bool(record.notifyWechat, d.notifyWechat),
		wechatGatewayUrl: str(record.wechatGatewayUrl, ""),
		wechatTo: str(record.wechatTo, ""),
		wechatStateDir: str(record.wechatStateDir, ""),
		taskFile: str(record.taskFile, d.taskFile),
		lastDispatchAt: str(record.lastDispatchAt, ""),
		lastTaskCount: num(record.lastTaskCount, 0),
		lastTaskTitles: Array.isArray(record.lastTaskTitles) ? record.lastTaskTitles.filter((t) => typeof t === "string") : [],
		autoExecute: bool(record.autoExecute, d.autoExecute),
		retryCooldownMinutes: clampInt(num(record.retryCooldownMinutes, d.retryCooldownMinutes), 1, 1440),
		workerTimeoutMinutes: clampInt(num(record.workerTimeoutMinutes, d.workerTimeoutMinutes), 1, 1440),
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
			flomoStripBodyHash: cfg.flomoStripBodyHash,
			notifyMac: cfg.notifyMac,
			notifyResult: cfg.notifyResult,
			notifyWechat: cfg.notifyWechat,
			wechatGatewayUrl: cfg.wechatGatewayUrl,
			wechatTo: cfg.wechatTo,
			wechatStateDir: cfg.wechatStateDir,
			taskFile: cfg.taskFile,
			lastDispatchAt: cfg.lastDispatchAt,
			lastTaskCount: cfg.lastTaskCount,
			lastTaskTitles: cfg.lastTaskTitles,
			autoExecute: cfg.autoExecute,
			retryCooldownMinutes: cfg.retryCooldownMinutes,
			workerTimeoutMinutes: cfg.workerTimeoutMinutes,
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
		if (args !== void 0 && typeof args.flomoStripBodyHash === "boolean") next.flomoStripBodyHash = args.flomoStripBodyHash;
		if (args !== void 0 && typeof args.notifyMac === "boolean") next.notifyMac = args.notifyMac;
		if (args !== void 0 && typeof args.notifyResult === "boolean") next.notifyResult = args.notifyResult;
		if (args !== void 0 && typeof args.notifyWechat === "boolean") next.notifyWechat = args.notifyWechat;
		if (args !== void 0 && typeof args.wechatGatewayUrl === "string") next.wechatGatewayUrl = args.wechatGatewayUrl.trim();
		if (args !== void 0 && typeof args.wechatTo === "string") next.wechatTo = args.wechatTo.trim();
		if (args !== void 0 && typeof args.wechatStateDir === "string") next.wechatStateDir = args.wechatStateDir.trim();
		if (args !== void 0 && typeof args.taskFile === "string" && args.taskFile.trim() !== "") next.taskFile = args.taskFile.trim();
		if (args !== void 0 && typeof args.autoExecute === "boolean") next.autoExecute = args.autoExecute;
		if (args !== void 0 && args.retryCooldownMinutes !== void 0) next.retryCooldownMinutes = clampInt(Number(args.retryCooldownMinutes), 1, 1440);
		if (args !== void 0 && args.workerTimeoutMinutes !== void 0) next.workerTimeoutMinutes = clampInt(Number(args.workerTimeoutMinutes), 1, 1440);
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
*   - WeChat: hand the text to the local ClawBot gateway
*     (DSH-WeChatClawBot, default http://127.0.0.1:51235), which relays it to
*     the WeChat account that scanned the floating-ball QR code.
*
* All are best-effort: a delivery failure is reported in the returned
* outcome, never thrown (dispatch must not fail because a notify failed).
*/
const execFileAsync = promisify(execFile);
/** Shared flomo credential location: DSH_HOME when set, else ~/.dsh. */
const FLOMO_CONFIG = pluginPath(void 0, "dsh-flomo.json");
/**
* Default ClawBot state directory — where the WeChat gateway keeps its login
* (`accounts.json` plus `accounts/<botId>.json`, which carries the id of the
* user who scanned). Mirrors the gateway's own `STATE_DIR` default;
* `DSH_WECHAT_HOME` overrides it.
*/
function wechatStateDir(override) {
	const explicit = (override ?? "").trim();
	if (explicit !== "") return explicit;
	const env = (process.env.DSH_WECHAT_HOME ?? "").trim();
	return env !== "" ? env : path.join(homedir(), ".dsh-wechat");
}
/** Default ClawBot gateway endpoint (loopback HTTP API of the WeChat bridge). */
const WECHAT_GATEWAY_URL = "http://127.0.0.1:51235";
/** Per-message character cap (WeChat refuses very large text bubbles). */
const WECHAT_CHUNK_CHARS = 1200;
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
/**
* Full-width number sign (U+FF03). It reads as a hash mark but is a different
* code point from the ASCII '#', so flomo's tag parser — which matches
* `#word` against an ASCII hash — never turns it into a tag.
*/
const HASH_SAFE = "＃";
/**
* Replace every ASCII '#' in a memo body with the full-width '＃'.
*
* flomo parses `#word` as a tag, so a raw '#' inside body text (a task title
* like `做A #重要`, a PR number like `#91`, a markdown heading) leaks into the
* tag set. Replacing rather than deleting keeps the text readable — `#91`
* survives as `＃91`. The configured flomoTag is appended separately by
* buildFlomoContent and keeps its own ASCII '#'.
*/
function escapeHashes(value) {
	return (value ?? "").replace(/#/g, "＃");
}
/** Append #tags (space-separated) to a memo body, mirroring dsh-flomo. */
function buildFlomoContent(content, tags) {
	const body = (content ?? "").trim();
	const suffix = (tags ?? "").split(/[\s,，;；]+/).map((t) => t.trim()).filter(Boolean).map((t) => "#" + t.replace(/^#+/, "")).join(" ");
	return suffix !== "" ? body + " " + suffix : body;
}
/**
* Post one MEMO to flomo. Returns an outcome, never throws.
*
* `escapeBodyHashes` (default true) is the single choke point that keeps every
* path into flomo free of a stray ASCII '#': the body is escaped *before* the
* #tag suffix is appended, so the tag keeps its hash while the body has none.
*/
async function flomoMemo(content, tags, escapeBodyHashes = true) {
	try {
		const url = await flomoUrl();
		if (url === "") return {
			ok: false,
			channel: "flomo",
			message: "尚未配置 flomo（DSH_HOME 下的 dsh-flomo.json 无 webhookUrl/apiKey），已跳过 flomo 通知。"
		};
		const bound = buildFlomoContent(escapeBodyHashes ? escapeHashes(content) : content, tags);
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
/**
* Resolve the WeChat recipient (iLink `to_user_id`) for a ClawBot message.
*
* Order: explicit `to` option → the `userId` recorded by the ClawBot gateway
* when the user scanned the floating-ball QR code. The gateway stores it in
* `<stateDir>/accounts/<botId>.json` (`userId: <wxid>@im.wechat`) and lists the
* bot ids in `<stateDir>/accounts.json`. Returns '' when ClawBot has never been
* logged in on this machine.
*/
async function wechatRecipient(opts = {}) {
	const explicit = (opts.to ?? "").trim();
	if (explicit !== "") return explicit;
	const dir = wechatStateDir(opts.stateDir);
	const accountsDir = path.join(dir, "accounts");
	const readUserId = async (file) => {
		try {
			const parsed = JSON.parse(await readFile(file, "utf8"));
			if (typeof parsed === "object" && parsed !== null) {
				const value = parsed.userId;
				if (typeof value === "string") return value.trim();
			}
		} catch {}
		return "";
	};
	try {
		const parsed = JSON.parse(await readFile(path.join(dir, "accounts.json"), "utf8"));
		if (Array.isArray(parsed)) for (const id of [...parsed].reverse()) {
			if (typeof id !== "string" || id.trim() === "") continue;
			const found = await readUserId(path.join(accountsDir, id.trim() + ".json"));
			if (found !== "") return found;
		}
	} catch {}
	try {
		const files = (await readdir(accountsDir)).filter((f) => f.endsWith(".json") && !f.endsWith(".sync.json"));
		for (const file of files) {
			const found = await readUserId(path.join(accountsDir, file));
			if (found !== "") return found;
		}
	} catch {}
	return "";
}
/** Split long text into WeChat-sized chunks, preferring line boundaries. */
function chunkText(text, max) {
	const chunks = [];
	let current = "";
	for (const line of text.split(/\r?\n/)) {
		const next = current === "" ? line : current + "\n" + line;
		if (next.length <= max) {
			current = next;
			continue;
		}
		if (current !== "") chunks.push(current);
		if (line.length <= max) {
			current = line;
			continue;
		}
		let rest = line;
		while (rest.length > max) {
			chunks.push(rest.slice(0, max));
			rest = rest.slice(max);
		}
		current = rest;
	}
	if (current !== "") chunks.push(current);
	return chunks.length > 0 ? chunks : [text];
}
/**
* Send one text message to the user's WeChat through the ClawBot gateway.
*
* The gateway is a local loopback service started by the DSH-WeChatClawBot
* plugin; this plugin never talks to WeChat directly and stores no WeChat
* credentials. Returns an outcome, never throws — a missing gateway or a
* missing ClawBot login is reported as a failed channel, not an exception.
*/
async function wechatSend(text, opts = {}) {
	try {
		const body = (text ?? "").trim();
		if (body === "") return {
			ok: false,
			channel: "wechat",
			message: "微信通知正文为空，已跳过。"
		};
		const to = await wechatRecipient(opts);
		if (to === "") return {
			ok: false,
			channel: "wechat",
			message: "未找到微信接收人：请先用 ClawBot 悬浮球扫码登录（或在设置里填 wechatTo 显式指定）。"
		};
		const base = ((opts.gatewayUrl ?? "").trim() || "http://127.0.0.1:51235").replace(/\/+$/, "");
		const chunks = chunkText(body, WECHAT_CHUNK_CHARS);
		for (const chunk of chunks) {
			const res = await fetch(base + "/send", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					to,
					text: chunk
				}),
				signal: AbortSignal.timeout(15e3)
			});
			const raw = await res.text();
			if (!res.ok) return {
				ok: false,
				channel: "wechat",
				message: "ClawBot 网关返回 HTTP " + res.status + "：" + raw.slice(0, 200) + "（网关未启动？默认 http://127.0.0.1:51235）"
			};
		}
		return {
			ok: true,
			channel: "wechat",
			message: chunks.length > 1 ? "已发送微信通知（" + chunks.length + " 条）" : "已发送微信通知"
		};
	} catch (error) {
		return {
			ok: false,
			channel: "wechat",
			message: "微信通知失败: " + String(error instanceof Error ? error.message : error) + "（ClawBot 网关默认 http://127.0.0.1:51235）"
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
* incomplete tasks, filters to today's relevant ones, writes a today-tasks
* file the agent reads (each task: title + due date + its TickTick description
* quoted underneath), and notifies (WeChat via ClawBot + flomo + macOS). The actual task execution
* is done by the agent in DSH using the existing dsh-ticktick tools; the file
* + notification simply tell the agent what to work on today and write results
* back.
*
* 「今天相关」有两条独立判据，刻意分开（拉取按窗口、执行按截止）：
* - **拉取**：`dueDate <= today`（到期/逾期）**或** `startDate <= today`
*   （时间段任务已进窗口——TickTick 的「今天」包含这些，旧版只比 dueDate 会漏掉）。
* - **自动执行**：只有到期/逾期任务可以跑；窗口任务只进文件 + 通知，
*   因为「开始日到了」只代表可以开始，不代表今天该做完。
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
/** Whether a startDate has already arrived (start <= today, local calendar date compare). */
function startsByThisDay(startDate, today) {
	if (typeof startDate !== "string" || startDate === "") return false;
	const local = localDateOf(startDate);
	return local !== null && local <= today;
}
/**
* Does a task qualify for today's dispatch (i.e. should it be PULLED)?
*
* Two independent ways in:
* 1. 到期：dueDate <= today（今天到期/逾期）。
* 2. 进窗口：startDate <= today —— 滴答清单的「时间段任务」只要开始日到了，
*    TickTick 就算它今天的事，派发器必须一起拉，否则「今天开始的活」永远
*    不会被看见（2026-09-11 的 bug：旧判据只比 dueDate，漏了 startDate）。
*
* 注意：拉进来 ≠ 可以自动执行，能不能跑由 {@link taskIsActionable} 决定。
*/
function taskQualifies(task, cfg, today) {
	if (cfg.dueMode === "all") return true;
	if (typeof task.dueDate === "string" && task.dueDate !== "") {
		if (dueThisDay(task.dueDate, today)) return true;
		return startsByThisDay(task.startDate, today);
	}
	return cfg.includeUndated || startsByThisDay(task.startDate, today);
}
/**
* May this task be auto-executed right now?（「拉取按窗口、执行按截止」）
*
* 只有 dueDate <= today 的到期/逾期任务才允许 autoExecute；窗口任务
* （开始日已到、截止日未到）只通知不执行。无截止任务沿用 includeUndated。
*/
function taskIsActionable(task, cfg, today) {
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
* Fan one text notification out to every enabled channel.
*
* The single choke point for "push some text at the user" (dispatch notices,
* per-task execution results, the auto-execute batch tally, session reports),
* so channel behaviour — the WeChat/ClawBot relay, flomo's ASCII-# escaping,
* the macOS banner — is defined once. Failures are returned per channel and
* never thrown: a notification must not break the work it reports on.
*
* @param content - message body (never contains a channel tag).
* @param cfg - dispatcher config the channel switches are read from.
* @param opts.channels - restrict to these channels instead of the enabled ones.
* @param opts.macTitle / opts.macSubtitle / opts.macBody - banner texts.
*/
async function notifyText(content, cfg, opts = {}) {
	const results = [];
	const body = (content ?? "").trim();
	if (body === "") return results;
	const wanted = (channel, enabled) => opts.channels === void 0 ? enabled : opts.channels.includes(channel);
	if (wanted("wechat", cfg.notifyWechat)) results.push(await wechatSend(body, {
		gatewayUrl: cfg.wechatGatewayUrl,
		to: cfg.wechatTo,
		stateDir: cfg.wechatStateDir
	}));
	if (wanted("flomo", cfg.notifyFlomo)) if (cfg.flomoTag === "") results.push({
		ok: false,
		channel: "flomo",
		message: "未配置 flomo 标签（flomoTag 为空），已跳过 flomo。"
	});
	else results.push(await flomoMemo(body, cfg.flomoTag, cfg.flomoStripBodyHash));
	if (wanted("mac", cfg.notifyMac)) results.push(await macNotify(opts.macTitle ?? "DSH 任务派发", opts.macSubtitle ?? "", opts.macBody ?? (body.split("\n")[0] ?? "").slice(0, 200)));
	return results;
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
		startDate: typeof t.startDate === "string" ? t.startDate : "",
		actionable: taskIsActionable(t, cfg, today),
		priority: typeof t.priority === "number" ? t.priority : 0,
		tags: Array.isArray(t.tags) ? t.tags.filter((x) => typeof x === "string") : []
	})).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
	const titles = selected.map((t) => t.title);
	const changed = JSON.stringify([...titles].sort()) !== JSON.stringify([...cfg.lastTaskTitles].sort());
	const taskFile = cfg.taskFile;
	await mkdir(path.dirname(taskFile), { recursive: true });
	const lines = selected.map((t) => {
		const head = t.actionable ? `- [ ] ${t.title}（截止 ${dueLabel(t.dueDate) || "无截止"}）` : `- [ ] ${t.title}（进行中 · 截止 ${dueLabel(t.dueDate) || "无截止"}）`;
		const desc = t.content.trim();
		if (desc === "") return head;
		const quoted = desc.split(/\r?\n/).map((line) => line.trim() === "" ? "  >" : "  > " + line.trimEnd()).join("\n");
		return head + "\n" + quoted;
	});
	const windowCount = selected.filter((t) => !t.actionable).length;
	await writeFile(taskFile, [
		`# 今日待执行任务 · ${today}`,
		"",
		`**来源**：滴答清单「${projectName}」 · 共 ${selected.length} 项` + (windowCount > 0 ? `（其中 ${windowCount} 项为「进行中」窗口任务：开始日已到、截止日未到）` : ""),
		"",
		...lines,
		"",
		"执行说明：逐项处理（任务描述以引用块附在标题下）；完成的用 ticktick_complete 回写滴答清单，并把结果落到知识库/项目档案。",
		"",
		"自动执行范围：只有「今天到期/逾期（+ 无截止）」的任务会被 autoExecute 执行；标「进行中」的窗口任务仅在此列出、不自动执行——开始日到了只代表「可以开始」，不代表「今天必须做完」（例：「观察后真删」要等观察期结束）。"
	].join("\n") + "\n");
	const shouldNotify = (opts.forceNotify === true || changed) && selected.length > 0;
	const notified = shouldNotify && (cfg.notifyFlomo || cfg.notifyMac || cfg.notifyWechat);
	if (shouldNotify) {
		const rawBody = [
			`📋 今日派发 · ${today} · 「${projectName}」共 ${selected.length} 项待执行`,
			...selected.slice(0, 12).map((t) => t.actionable ? `- ${t.title}` : `- ${t.title}（进行中）`),
			...windowCount > 0 ? ["", `其中 ${windowCount} 项为「进行中」窗口任务（开始日已到、未到截止），仅提示、不自动执行。`] : []
		].join("\n");
		notifies.push(...await notifyText(rawBody, cfg, {
			macSubtitle: projectName,
			macBody: `今日 ${selected.length} 项任务待执行（${today}）`
		}));
	}
	await store.recordDispatch(titles);
	let extra = "";
	if (selected.length === 0) extra = "，今日无待执行任务（未发送通知）";
	else if (!shouldNotify) extra = "，任务无变化，跳过通知";
	else if (notified) {
		const okChannels = notifies.filter((n) => n.ok).map((n) => n.channel);
		extra = okChannels.length > 0 ? "，已发送通知（" + okChannels.join("/") + "）" : "，通知发送失败：" + notifies.map((n) => n.channel + " → " + n.message).join("；");
	} else extra = "，通知未发送（微信/flomo/macOS 均未开启）";
	return {
		ok: true,
		message: `已拉取 ${selected.length} 项任务（来源「${projectName}」）` + (windowCount > 0 ? `，其中 ${windowCount} 项为进行中窗口任务（不自动执行）` : "") + `，今日任务文件已写入 ${taskFile}${extra}。`,
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
/** Default workspace ledger location: DSH_HOME when set, else ~/.dsh. */
const DEFAULT_WORKSPACE_STORE = pluginPath(void 0, "storages", "workspace.json");
/** Ledger location: DSH_WORKSPACE_STORE → DSH_HOME → ~/.dsh. */
function workspaceStorePath() {
	return pluginPath(process.env.DSH_WORKSPACE_STORE, "storages", "workspace.json");
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
//#region src/executable.ts
/**
* dsh-task-dispatcher — executable resolution.
*
* The auto-execute worker shells out to the `dsh` CLI. DSH itself can be
* started by launchd (the shipped `com.dsh.web` service), whose PATH is only
* `/usr/bin:/bin`; a bare `dsh` then fails with ENOENT even though the CLI is
* installed. Resolve the binary against PATH plus the well-known install
* directories so a worker can always be spawned.
*/
/** Directories that commonly hold a globally installed CLI on this machine. */
function extraBinDirs() {
	const home = homedir();
	const dirs = [
		path.join(home, ".local", "bin"),
		"/opt/homebrew/bin",
		"/usr/local/bin",
		path.join(home, ".bun", "bin"),
		path.join(home, ".volta", "bin"),
		"/usr/bin",
		"/bin"
	];
	for (const manager of [
		".nvm/versions/node",
		".local/share/fnm/node-versions",
		".asdf/installs/nodejs"
	]) {
		const root = path.join(home, manager);
		try {
			for (const entry of readdirSync(root)) dirs.push(path.join(root, entry, "bin"));
		} catch {}
	}
	return dirs;
}
/**
* Resolve an executable name to an absolute path.
* @param name - bare executable name (without a Windows extension).
* @returns the first existing absolute path, or the bare name so that the OS
*   still performs its own PATH lookup (and reports a meaningful error).
*/
function resolveExecutable(name) {
	const suffixes = process.platform === "win32" ? [
		".cmd",
		".exe",
		".bat",
		""
	] : [""];
	const seen = /* @__PURE__ */ new Set();
	for (const dir of [...(process.env.PATH ?? "").split(path.delimiter), ...extraBinDirs()]) {
		if (dir === "" || seen.has(dir)) continue;
		seen.add(dir);
		for (const suffix of suffixes) {
			const candidate = path.join(dir, name + suffix);
			if (existsSync(candidate)) return candidate;
		}
	}
	return name;
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
*
* Result notification: dispatching is not the same as finishing. When
* `notifyResult` is on, every executed task pushes a SHORT outcome message
* through the configured channels (WeChat / flomo / macOS) as soon as its
* worker settles, and a compact batch tally follows when more than one task
* ran — so a run that happens unattended still reports back by itself instead
* of relying on the worker remembering to call `dispatcher_report`.
*/
/**
* Fallback worker timeout when no explicit `timeoutMs` is given to
* `spawnWorker`. The live auto-execute path always passes the configured
* `workerTimeoutMinutes` (default 30); this constant only covers direct calls.
*/
const DEFAULT_WORKER_TIMEOUT_MS = 1800 * 1e3;
/**
* Spawn `dsh --profile headless "<prompt>"` and resolve when it exits.
* Best-effort: never throws; resolves a WorkerResult even on spawn error.
*/
async function spawnWorker(prompt, opts = {}) {
	const cwd = opts.cwd ?? homedir();
	const timeoutMs = opts.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let child = null;
		try {
			child = spawn(resolveExecutable("dsh"), [
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
				stdout: "",
				stderr: "",
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
				output: stdout + stderr,
				stdout,
				stderr,
				error: "timeout"
			});
		}, timeoutMs);
		child.stdout?.on("data", (d) => {
			stdout += String(d);
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
				output: stdout + stderr,
				stdout,
				stderr,
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
				output: stdout + stderr,
				stdout,
				stderr
			});
		});
	});
}
/** ANSI colour escapes (the CLI colourises stderr output). */
const ANSI_ESCAPES = /\u001B\[[0-9;]*[A-Za-z]/g;
/**
* Condense a worker's final answer into one short line for the result notice.
*
* The headless runner writes ONLY the final assistant text to stdout (progress
* and reasoning go to stderr), so stdout is the answer. Blank lines and a
* trailing bare completion marker (the worker prompt asks for `DONE`) are
* dropped, and the rest is flattened and capped — a notification must stay
* readable in a chat bubble.
*/
function summarizeWorkerOutput(stdout, maxChars = 220) {
	const lines = (stdout ?? "").replace(ANSI_ESCAPES, "").replace(/\r/g, "").split("\n").map((line) => line.trim()).filter((line) => line !== "");
	while (lines.length > 0 && /^(done|完成|✅ *done)$/i.test(lines[lines.length - 1] ?? "")) lines.pop();
	const text = lines.join(" ");
	if (text === "") return "";
	return text.length <= maxChars ? text : text.slice(0, maxChars - 1) + "…";
}
/** The per-task result message. */
function taskMessage(result) {
	const lines = [(result.status === "completed" ? "✅ 任务完成 · " : "❌ 任务失败 · ") + result.title];
	if (result.summary !== "") lines.push((result.status === "completed" ? "结果：" : "原因：") + result.summary);
	if (result.status === "completed" && !result.writtenBack) lines.push("（滴答清单回写失败，请手动勾选）");
	return lines.join("\n");
}
/** The batch tally that follows a multi-task pass. */
function batchMessage(outcome) {
	const done = outcome.results.filter((r) => r.status !== "skipped");
	const lines = ["📊 本轮自动执行：完成 " + outcome.completed + " · 失败 " + outcome.failed + "（共 " + done.length + " 项）"];
	for (const r of done) lines.push((r.status === "completed" ? "- ✅ " : "- ❌ ") + r.title);
	return lines.join("\n");
}
/** Build a worker prompt from the template + this task. */
function buildWorkerPrompt(template, task) {
	return template.replace("{title}", task.title).replace("{content}", task.content);
}
/**
* Serial auto-execute over the given tasks.
* @param opts.spawn - injectable worker spawn (tests pass a fake); receives the
*   resolved timeout so a pass can be checked without a real subprocess.
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
		log,
		results: []
	};
	const notify = opts.notify ?? (async (text) => {
		await notifyText(text, cfg, {
			macTitle: "DSH 任务结果",
			macSubtitle: "自动执行"
		});
	});
	const wantsResultNotify = opts.notifyResult === true && cfg.notifyResult;
	if (!cfg.autoExecute) {
		log.push("自动执行未开启（autoExecute=false）");
		return outcome;
	}
	const workerCwd = cfg.workerWorkspaceId !== "" ? await resolveWorkspacePath(cfg.workerWorkspaceId) : void 0;
	const workerTimeoutMs = cfg.workerTimeoutMinutes * 60 * 1e3;
	const spawn = opts.spawn ?? spawnWorker;
	const onComplete = opts.onComplete ?? ((t) => api.completeTask(t.projectId, t.id));
	for (const task of tasks) {
		if (task.actionable === false) {
			outcome.skipped++;
			log.push("跳过「" + task.title + "」（进行中窗口任务：未到截止日，不自动执行）");
			outcome.results.push({
				taskId: task.id,
				title: task.title,
				status: "skipped",
				summary: "进行中窗口任务（未到截止日）",
				writtenBack: false,
				durationMs: 0
			});
			continue;
		}
		if (!await store.canRetry(task.id, cfg.retryCooldownMinutes)) {
			outcome.skipped++;
			log.push("跳过「" + task.title + "」（冷却期）");
			outcome.results.push({
				taskId: task.id,
				title: task.title,
				status: "skipped",
				summary: "仍在失败重试冷却期",
				writtenBack: false,
				durationMs: 0
			});
			continue;
		}
		await store.markAttempted(task.id);
		outcome.executed++;
		const startedAt = Date.now();
		const worker = await spawn(buildWorkerPrompt(cfg.workerPrompt, task), {
			...workerCwd !== void 0 ? { cwd: workerCwd } : {},
			timeoutMs: workerTimeoutMs
		});
		const durationMs = Date.now() - startedAt;
		const summary = summarizeWorkerOutput(worker.stdout);
		if (worker.ok) {
			outcome.completed++;
			let writtenBack = true;
			try {
				await onComplete(task);
				log.push("✓ 完成「" + task.title + "」");
			} catch (error) {
				writtenBack = false;
				log.push("完成「" + task.title + "」但回写失败: " + String(error instanceof Error ? error.message : error));
			}
			const result = {
				taskId: task.id,
				title: task.title,
				status: "completed",
				summary,
				writtenBack,
				durationMs
			};
			outcome.results.push(result);
			if (wantsResultNotify) await notify(taskMessage(result));
		} else {
			outcome.failed++;
			const reason = worker.error !== void 0 ? worker.error === "timeout" ? "执行超时（" + cfg.workerTimeoutMinutes + " 分钟，已 SIGKILL）" : worker.error : "worker 退出码 " + String(worker.exitCode);
			const result = {
				taskId: task.id,
				title: task.title,
				status: "failed",
				summary: reason,
				writtenBack: false,
				durationMs
			};
			outcome.results.push(result);
			log.push("✗「" + task.title + "」执行失败（" + reason + "）");
			if (wantsResultNotify) await notify(taskMessage(result));
		}
	}
	if (wantsResultNotify && outcome.results.filter((r) => r.status !== "skipped").length > 1) await notify(batchMessage(outcome));
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
		description: "查看 dsh-task-dispatcher 插件状态：是否启用、拉取间隔（分钟）、自动执行开关、自动执行会话的工作区、worker 超时（分钟）、任务来源清单、过滤方式、通知开关、最近一次派发结果（时间/数量/任务标题）与今日任务文件路径。不会泄露任何密钥。",
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
					workerTimeoutMinutes: { type: "number" },
					workerWorkspaceId: { type: "string" },
					projectName: { type: "string" },
					projectId: { type: "string" },
					dueMode: { type: "string" },
					includeUndated: { type: "boolean" },
					notifyFlomo: { type: "boolean" },
					flomoTag: { type: "string" },
					flomoStripBodyHash: { type: "boolean" },
					notifyMac: { type: "boolean" },
					notifyResult: { type: "boolean" },
					notifyWechat: { type: "boolean" },
					wechatGatewayUrl: { type: "string" },
					wechatTo: { type: "string" },
					wechatStateDir: { type: "string" },
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
					"worker 超时：" + view.workerTimeoutMinutes + " 分钟（到点 SIGKILL）",
					"执行会话工作区：" + workerWorkspace,
					"任务来源：滴答清单「" + view.projectName + "」",
					"过滤：" + (view.dueMode === "all" ? "全部未完成" : "今天到期/逾期" + (view.includeUndated ? " + 无截止" : "") + " + 进行中窗口任务（开始日已到、截止日未到；仅提示不自动执行）"),
					"通知通道：" + ([
						view.notifyWechat ? "微信 ClawBot" + (view.wechatTo !== "" ? "（指定 " + view.wechatTo + "）" : "（自动识别接收人）") : "",
						view.notifyFlomo ? "flomo" : "",
						view.notifyMac ? "macOS" : ""
					].filter(Boolean).join(" + ") || "无"),
					"执行结果回执：" + (view.notifyResult ? "开（自动执行的每个任务结束后推一条简明结果，多任务再补一条汇总）" : "关（不推送执行结果）"),
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
		description: "配置 dsh-task-dispatcher：enabled（总开关）、dispatchIntervalMinutes（每隔多少分钟自动拉取一次，0=关闭定时）、projectName 或 projectId（任务来源滴答清单，默认 5️⃣AI）、dueMode（today=今天到期/逾期，all=全部未完成）、includeUndated（是否含无截止任务）、notifyResult（自动执行结束后是否推送「每个任务的简明结果 + 批次汇总」，默认 true）、notifyWechat/notifyFlomo/notifyMac（通知通道开关：微信 ClawBot / flomo / macOS）、wechatGatewayUrl（ClawBot 网关地址，默认 http://127.0.0.1:51235）、wechatTo（微信接收人 id，留空自动用 ClawBot 扫码登录的那个账号）、wechatStateDir（ClawBot 状态目录，默认 ~/.dsh-wechat；也认环境变量 DSH_WECHAT_HOME）、testWechat（保存后立即发一条测试微信消息）、flomoTag（flomo 标签）、flomoStripBodyHash（发到 flomo 的通知/汇总正文里的井号# 是否替换成全角＃，避免 flomo 把#词误识别成标签；flomoTag 标签本身保留）、taskFile（今日任务文件路径）、autoExecute（是否自动执行：为每个拉到的新任务单独开一个 DSH 会话去执行）、workerWorkspaceId（执行会话运行在哪个 DSH 工作区，传空字符串=默认主目录；用 dispatcher_status 可看到工作区 id）、retryCooldownMinutes（失败任务重试冷却分钟）、workerTimeoutMinutes（单个执行会话的超时分钟数，默认 30，到点 SIGKILL 该 worker；范围 1–1440）、workerPrompt（执行会话的提示词模板，可用 {title}/{content}）、announceToAgent（是否在系统提示公告）。配置持久化到 DSH_HOME 下的 dsh-task-dispatcher.json（默认 ~/.dsh，0600）。传 reset: true 恢复默认。",
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
			flomoStripBodyHash: {
				type: "boolean",
				description: "发到 flomo 的通知/汇总正文里的井号# 替换成全角＃（默认 true）"
			},
			notifyMac: {
				type: "boolean",
				description: "是否发送 macOS 通知"
			},
			notifyResult: {
				type: "boolean",
				description: "自动执行结束后是否推送结果（每任务一条简明结果 + 多任务批次汇总；走已开启的通知通道）"
			},
			notifyWechat: {
				type: "boolean",
				description: "是否通过微信机器人 ClawBot 推送通知（需要本机已装 DSH-WeChatClawBot 且已扫码登录）"
			},
			wechatGatewayUrl: {
				type: "string",
				description: "ClawBot 网关地址（默认 http://127.0.0.1:51235）"
			},
			wechatTo: {
				type: "string",
				description: "微信接收人 id（留空=自动使用 ClawBot 扫码登录的账号）"
			},
			wechatStateDir: {
				type: "string",
				description: "ClawBot 状态目录（默认 ~/.dsh-wechat，环境变量 DSH_WECHAT_HOME 优先）"
			},
			testWechat: {
				type: "boolean",
				description: "保存配置后立即发一条测试微信消息（验证通道）"
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
			workerTimeoutMinutes: {
				type: "number",
				description: "单个执行会话的超时分钟数（默认 30；到点 SIGKILL 该 worker）"
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
					flomoStripBodyHash: { type: "boolean" },
					notifyMac: { type: "boolean" },
					notifyResult: { type: "boolean" },
					notifyWechat: { type: "boolean" },
					wechatGatewayUrl: { type: "string" },
					wechatTo: { type: "string" },
					wechatStateDir: { type: "string" },
					taskFile: { type: "string" },
					autoExecute: { type: "boolean" },
					workerWorkspaceId: { type: "string" },
					retryCooldownMinutes: { type: "number" },
					workerTimeoutMinutes: { type: "number" },
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
						flomoStripBodyHash: true,
						notifyMac: true,
						notifyResult: true,
						notifyWechat: false,
						wechatGatewayUrl: "",
						wechatTo: "",
						wechatStateDir: "",
						taskFile: "",
						autoExecute: false,
						retryCooldownMinutes: 60,
						workerTimeoutMinutes: 30,
						workerWorkspaceId: ""
					});
					args = {};
				}
				const wantsTest = args !== void 0 && args.testWechat === true;
				const sanitized = { ...args ?? {} };
				delete sanitized.testWechat;
				const view = await ctx.store.patch(sanitized);
				let testLine = "";
				if (wantsTest) {
					const probe = await wechatSend("【DSH 任务派发器】微信通知通道测试：收到这条说明微信通知已生效。", {
						gatewayUrl: view.wechatGatewayUrl,
						to: view.wechatTo,
						stateDir: view.wechatStateDir
					});
					testLine = probe.ok ? " 微信测试消息已发送。" : " 微信测试失败：" + probe.message;
				}
				const interval = view.dispatchIntervalMinutes === 0 ? "已关闭定时" : "每 " + view.dispatchIntervalMinutes + " 分钟";
				const auto = view.autoExecute ? " · 自动执行开" : " · 自动执行关";
				const timeout = " · worker 超时 " + view.workerTimeoutMinutes + " 分钟";
				const workspace = view.workerWorkspaceId === "" ? "" : " · 工作区 " + (await resolveWorkspaceTitle(view.workerWorkspaceId) ?? view.workerWorkspaceId);
				return {
					ok: true,
					message: "配置已保存：" + (view.enabled ? "启用" : "禁用") + " · " + interval + auto + timeout + workspace + " · 来源「" + view.projectName + "」" + testLine + " · 通知：" + ([
						view.notifyWechat ? "微信" : "",
						view.notifyFlomo ? "flomo" : "",
						view.notifyMac ? "macOS" : ""
					].filter(Boolean).join("+") || "无"),
					enabled: view.enabled,
					dispatchIntervalMinutes: view.dispatchIntervalMinutes,
					projectName: view.projectName,
					dueMode: view.dueMode,
					includeUndated: view.includeUndated,
					notifyResult: view.notifyResult,
					notifyFlomo: view.notifyFlomo,
					flomoTag: view.flomoTag,
					flomoStripBodyHash: view.flomoStripBodyHash,
					notifyMac: view.notifyMac,
					notifyWechat: view.notifyWechat,
					wechatGatewayUrl: view.wechatGatewayUrl,
					wechatTo: view.wechatTo,
					wechatStateDir: view.wechatStateDir,
					taskFile: view.taskFile,
					autoExecute: view.autoExecute,
					workerWorkspaceId: view.workerWorkspaceId,
					retryCooldownMinutes: view.retryCooldownMinutes,
					workerTimeoutMinutes: view.workerTimeoutMinutes,
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
		description: "立即执行一次任务拉取：从滴答清单「5️⃣AI」（或配置的来源）拉取今天相关的任务（今天到期/逾期 + 无截止 + 开始日已到的「进行中」窗口任务），写入今日任务文件，并发送微信（ClawBot）+ flomo + macOS 通知（手动触发始终通知；按配置开关决定发哪几路）。若开启 autoExecute，只为**今天到期/逾期**的项单独开一个 DSH 会话去执行并自动勾掉；标「进行中」的窗口任务仅列出、不自动执行。常用于手动触发派发或验证配置。",
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
					wechatNotify: { type: "string" },
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
						const exec = await runAutoExecute(ctx.store, ctx.api, result.tasks, { notifyResult: true });
						autoExecuted = exec.executed;
						autoCompleted = exec.completed;
					}
				}
				const flag = (channel) => {
					const hit = result.notifies.find((n) => n.channel === channel);
					return hit === void 0 ? "none" : hit.ok ? "ok" : "failed";
				};
				return {
					ok: result.ok,
					message: result.message + (autoExecuted > 0 ? " 自动执行 " + autoExecuted + " 项，完成 " + autoCompleted + " 项。" : ""),
					dispatchedAt: result.dispatchedAt,
					projectName: result.projectName,
					taskCount: result.taskCount,
					taskFile: result.taskFile,
					wechatNotify: flag("wechat"),
					flomoNotify: flag("flomo"),
					macNotify: flag("mac"),
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
/** Report tool: send the agent/session outcome summary to WeChat (and/or flomo). */
function dispatcherReportTool(ctx) {
	return defineTool$1({
		name: "dispatcher_report",
		description: "任务执行完/会话结束后，把本次执行结果汇总发一条通知：默认发到微信（通过 ClawBot 网关，读 dsh-task-dispatcher 的微信配置）；flomo 只在配置里开启 notifyFlomo 时才一并发送。参数：total（共几项）、completed（完成）、failed（失败）、skipped（跳过）、summary（可选的自定义说明/备注，多行）、date（可选，默认今天）。channels 可临时指定本次要发哪几路（wechat/flomo/mac），不传则用配置开关。",
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
			},
			channels: {
				type: "array",
				items: { type: "string" },
				description: "可选：本次发送渠道，可选值 wechat/flomo/mac（不传=按配置开关）"
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
					wechatNotify: { type: "string" },
					flomoNotify: { type: "string" },
					macNotify: { type: "string" }
				}
			},
			render: (_args, value) => text(String(value.message ?? ""))
		},
		async execute(args) {
			try {
				const cfg = await ctx.store.load();
				const requested = Array.isArray(args?.channels) ? (args?.channels).filter((c) => typeof c === "string") : [];
				const use = (channel, configured) => requested.length > 0 ? requested.includes(channel) : configured;
				const wantWechat = use("wechat", cfg.notifyWechat);
				const wantFlomo = use("flomo", cfg.notifyFlomo);
				const wantMac = use("mac", cfg.notifyMac);
				if (!wantWechat && !wantFlomo && !wantMac) return {
					ok: false,
					message: "通知渠道全部关闭（微信/flomo/macOS），未发送。请在设置面板或 dispatcher_config 开启。",
					wechatNotify: "off",
					flomoNotify: "off",
					macNotify: "off"
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
				const results = await notifyText(lines.join("\n"), cfg, {
					...requested.length > 0 ? { channels: requested } : {},
					macTitle: "DSH 任务派发",
					macSubtitle: "会话汇总 " + date,
					macBody: lines.slice(0, 2).join(" · ")
				});
				const sent = results.filter((r) => r.ok).map((r) => r.message);
				const problems = results.filter((r) => !r.ok).map((r) => r.channel + "：" + r.message);
				const flagOf = (channel, wanted) => {
					if (!wanted) return "off";
					const hit = results.find((n) => n.channel === channel);
					return hit === void 0 ? "failed" : hit.ok ? "ok" : "failed";
				};
				return {
					ok: problems.length === 0,
					message: (sent.length > 0 ? "已发送汇总（" + sent.join("；") + "）" : "汇总未发送") + (problems.length > 0 ? "；失败：" + problems.join("；") : ""),
					wechatNotify: flagOf("wechat", wantWechat),
					flomoNotify: flagOf("flomo", wantFlomo),
					macNotify: flagOf("mac", wantMac)
				};
			} catch (error) {
				return {
					ok: false,
					message: "发送汇总失败: " + String(error instanceof Error ? error.message : error),
					wechatNotify: "failed",
					flomoNotify: "failed",
					macNotify: "failed"
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
//#region src/deferred.ts
/**
* dsh-task-dispatcher — deferred TickTick sync control plane.
*
* The queue is written to TickTick by a standalone Node script driven by a
* launchd timer, and that split is deliberate: the flush must be able to happen
* while **DSH is closed** (a session that ended at 21:00 should still land in
* TickTick at 21:12), which an in-process timer can never guarantee. This module
* is therefore the control plane, not the engine:
*
*   - it reads the *same* queue file (`<DSH_HOME>/dsh-ticktick-pending.json`),
*   - it computes the *same* idle verdict the script computes (newest session
*     log mtime across the whole harness home, not just one session),
*   - and it lets the settings panel change the thresholds, flush by hand, and
*     install/reload/remove the launchd timer.
*
* The queue file is the only contract between the two halves, so no behaviour
* is duplicated: the write path (credentials, dedupe, parentId, dueDate
* rollover) lives in the script and stays there.
*/
/** launchd label shared with the standalone script's timer. */
const TIMER_LABEL = "com.dsh.ticktick-deferred-sync";
/** Queue file (also read/written by the standalone script). */
function queuePath() {
	return path.join(dshHome(), "dsh-ticktick-pending.json");
}
/** Where the script is installed for the timer to run. */
function installedScriptPath() {
	return path.join(dshHome(), "scripts", "ticktick-pending.mjs");
}
/** The copy shipped inside this plugin (works on a machine that never had it). */
function bundledScriptPath() {
	const here = path.dirname(fileURLToPath(import.meta.url));
	return path.join(path.dirname(here), "scripts", "ticktick-pending.mjs");
}
/** launchd plist path (macOS only). */
function timerPlistPath() {
	return path.join(homedir(), "Library", "LaunchAgents", "com.dsh.ticktick-deferred-sync.plist");
}
/** Default queue contents, used when the file does not exist yet. */
function defaultQueue() {
	return {
		version: 1,
		idleMinutes: 10,
		maxPerSession: 3,
		projectId: "6aa654ffe4b094f3c163a198",
		tags: ["ai"],
		tasks: [],
		lastFlushAt: null,
		lastFlushResult: null
	};
}
/** Newest session-log mtime under `<home>/sessions` (0 when none). */
function newestSessionMtime(sessionsDir = path.join(dshHome(), "sessions")) {
	let newest = 0;
	const walk = (dir, depth) => {
		if (depth > 3) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full, depth + 1);
			else if (/^session.*\.jsonl\.zstd$/.test(entry.name)) try {
				const mtime = statSync(full).mtimeMs;
				if (mtime > newest) newest = mtime;
			} catch {}
		}
	};
	walk(sessionsDir, 0);
	return newest;
}
/** Run one child process, never throwing. */
function run(command, args, timeoutMs = 12e4) {
	return new Promise((resolve) => {
		execFile(command, [...args], {
			timeout: timeoutMs,
			maxBuffer: 8 * 1024 * 1024
		}, (error, stdout, stderr) => {
			resolve({
				code: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
				stdout: String(stdout),
				stderr: String(stderr)
			});
		});
	});
}
/** Coerce the queue file, tolerating a hand-edited or partial file. */
function coerceQueue(raw) {
	const base = defaultQueue();
	if (typeof raw !== "object" || raw === null) return base;
	const obj = raw;
	const num = (value, fallback, min, max) => typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
	return {
		version: typeof obj.version === "number" ? obj.version : base.version,
		idleMinutes: num(obj.idleMinutes, base.idleMinutes, 1, 1440),
		maxPerSession: num(obj.maxPerSession, base.maxPerSession, 1, 50),
		projectId: typeof obj.projectId === "string" && obj.projectId !== "" ? obj.projectId : base.projectId,
		tags: Array.isArray(obj.tags) ? obj.tags.filter((tag) => typeof tag === "string") : base.tags,
		tasks: Array.isArray(obj.tasks) ? obj.tasks.filter((task) => typeof task === "object" && task !== null) : [],
		lastFlushAt: typeof obj.lastFlushAt === "string" ? obj.lastFlushAt : null,
		lastFlushResult: typeof obj.lastFlushResult === "string" ? obj.lastFlushResult : null
	};
}
/** The control plane. */
var DeferredController = class {
	/** Read the queue (defaults when absent/corrupt). */
	async readQueue() {
		try {
			return coerceQueue(JSON.parse(await readFile(queuePath(), "utf8")));
		} catch {
			return defaultQueue();
		}
	}
	/** Persist the queue with owner-only permissions. */
	async writeQueue(queue) {
		const file = queuePath();
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, JSON.stringify(queue, null, 2) + "\n", { mode: 384 });
	}
	/** Which copy of the script would run. */
	resolveScript() {
		const installed = installedScriptPath();
		if (existsSync(installed)) return {
			path: installed,
			source: "installed"
		};
		const bundled = bundledScriptPath();
		if (existsSync(bundled)) return {
			path: bundled,
			source: "bundled"
		};
		return {
			path: installed,
			source: "missing"
		};
	}
	/** Read the timer's plist + launchd state. */
	async timerState() {
		const supported = platform() === "darwin";
		const plistPath = timerPlistPath();
		const installed = supported && existsSync(plistPath);
		let intervalSeconds = 0;
		if (installed) try {
			const text = await readFile(plistPath, "utf8");
			const match = /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(text);
			intervalSeconds = match === null ? 0 : Number(match[1]);
		} catch {
			intervalSeconds = 0;
		}
		let loaded = false;
		let detail = "";
		if (supported) {
			const printed = await run("launchctl", ["print", "gui/" + String(process.getuid?.() ?? 0) + "/com.dsh.ticktick-deferred-sync"], 15e3);
			loaded = printed.code === 0;
			if (installed && !loaded) detail = printed.stderr.trim().split("\n")[0] ?? "";
		}
		return {
			supported,
			label: TIMER_LABEL,
			plistPath,
			installed,
			loaded,
			intervalSeconds,
			detail
		};
	}
	/** The full panel payload. */
	async status() {
		const queue = await this.readQueue();
		const script = this.resolveScript();
		const newest = newestSessionMtime();
		const idleMs = newest === 0 ? Number.POSITIVE_INFINITY : Date.now() - newest;
		const idleMinutesNow = newest === 0 ? -1 : Math.floor(idleMs / 6e4);
		const isIdle = newest === 0 || idleMs >= queue.idleMinutes * 6e4;
		const timer = await this.timerState();
		const tasks = queue.tasks.map((task) => ({
			title: typeof task.title === "string" ? task.title : "(无标题)",
			parentKey: typeof task.parentKey === "string" ? task.parentKey : "",
			dueDate: typeof task.dueDate === "string" ? task.dueDate : "",
			stagedBy: typeof task.stagedBy === "string" ? task.stagedBy : ""
		}));
		return {
			ok: true,
			message: [
				"待同步 " + String(queue.tasks.length) + " 条（顶层 " + String(tasks.filter((task) => task.parentKey === "").length) + "）",
				"阈值 " + String(queue.idleMinutes) + " 分钟",
				newest === 0 ? "暂无会话日志" : "当前已静默 " + String(idleMinutesNow) + " 分钟",
				isIdle ? "可同步" : "仍在活跃",
				timer.supported ? timer.loaded ? "定时器运行中（每 " + String(timer.intervalSeconds) + " 秒检查）" : "定时器未运行" : "非 macOS：无 launchd 定时器，只能手动写入"
			].join(" · "),
			queueFile: queuePath(),
			scriptPath: script.path,
			scriptSource: script.source,
			bundledScriptPath: bundledScriptPath(),
			idleMinutes: queue.idleMinutes,
			maxPerSession: queue.maxPerSession,
			projectId: queue.projectId,
			tags: queue.tags,
			pending: queue.tasks.length,
			pendingTop: tasks.filter((task) => task.parentKey === "").length,
			tasks,
			idleMinutesNow,
			newestSessionAt: newest === 0 ? "" : new Date(newest).toISOString(),
			isIdle,
			lastFlushAt: queue.lastFlushAt ?? "",
			lastFlushResult: queue.lastFlushResult ?? "",
			timer
		};
	}
	/**
	* Change the thresholds.
	*
	* `idleMinutes` / `maxPerSession` live in the queue file (the script reads it
	* on every run, so a change applies to the very next tick). `intervalSeconds`
	* lives in the launchd plist, so it is written and the timer reloaded — a
	* plist edit alone is not picked up by an already-loaded job.
	*/
	async patchConfig(patch) {
		const queue = await this.readQueue();
		const notes = [];
		if (patch.idleMinutes !== void 0) {
			queue.idleMinutes = Math.max(1, Math.min(1440, Math.floor(patch.idleMinutes)));
			notes.push("静默阈值 = " + String(queue.idleMinutes) + " 分钟");
		}
		if (patch.maxPerSession !== void 0) {
			queue.maxPerSession = Math.max(1, Math.min(50, Math.floor(patch.maxPerSession)));
			notes.push("单会话顶层上限 = " + String(queue.maxPerSession));
		}
		await this.writeQueue(queue);
		let output = "";
		if (patch.intervalSeconds !== void 0) {
			const seconds = Math.max(30, Math.min(3600, Math.floor(patch.intervalSeconds)));
			const timer = await this.writeTimer(seconds);
			output = timer.output;
			notes.push("定时器检查间隔 = " + String(seconds) + " 秒");
			if (!timer.ok) return {
				ok: false,
				message: "阈值已保存，但定时器重载失败：" + timer.message,
				output,
				status: await this.status()
			};
		}
		return {
			ok: true,
			message: "已更新：" + notes.join("；") + "（阈值写入队列文件，脚本下次运行即生效）",
			output,
			status: await this.status()
		};
	}
	/** Write the plist for `intervalSeconds` and reload the timer. */
	async writeTimer(intervalSeconds) {
		if (platform() !== "darwin") return {
			ok: false,
			message: "当前平台不是 macOS，launchd 定时器不可用；可用「立即写入」手动同步。",
			output: ""
		};
		const install = await this.installScript(false);
		const script = this.resolveScript();
		if (script.source === "missing") return {
			ok: false,
			message: "找不到 ticktick-pending.mjs（插件自带副本也缺失）。",
			output: install.output
		};
		const node = process.execPath;
		const home = dshHome();
		const plist = [
			"<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
			"<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
			"<plist version=\"1.0\">",
			"<dict>",
			"  <key>Label</key><string>com.dsh.ticktick-deferred-sync</string>",
			"  <key>ProgramArguments</key>",
			"  <array>",
			"    <string>" + node + "</string>",
			"    <string>" + script.path + "</string>",
			"    <string>flush</string>",
			"  </array>",
			"  <key>StartInterval</key><integer>" + String(intervalSeconds) + "</integer>",
			"  <key>StandardOutPath</key><string>" + path.join(home, "ticktick-deferred-sync.launchd.out") + "</string>",
			"  <key>StandardErrorPath</key><string>" + path.join(home, "ticktick-deferred-sync.launchd.err") + "</string>",
			"</dict>",
			"</plist>",
			""
		].join("\n");
		const plistPath = timerPlistPath();
		await mkdir(path.dirname(plistPath), { recursive: true });
		await writeFile(plistPath, plist, { mode: 420 });
		const uid = String(process.getuid?.() ?? 0);
		const bootout = await run("launchctl", ["bootout", "gui/" + uid + "/com.dsh.ticktick-deferred-sync"], 2e4);
		const bootstrap = await run("launchctl", [
			"bootstrap",
			"gui/" + uid,
			plistPath
		], 2e4);
		const output = ["bootout: " + String(bootout.code) + " " + bootout.stderr.trim(), "bootstrap: " + String(bootstrap.code) + " " + bootstrap.stderr.trim()].filter((line) => line.trim() !== "").join("\n");
		if (bootstrap.code !== 0) return {
			ok: false,
			message: "launchctl bootstrap 失败（详情见下方输出）。",
			output
		};
		const state = await this.timerState();
		return {
			ok: state.loaded,
			message: state.loaded ? "定时器已安装并加载：每 " + String(state.intervalSeconds) + " 秒检查一次，静默满 " + String((await this.readQueue()).idleMinutes) + " 分钟后写入。" : "已写入 plist 但 launchctl 未确认加载。",
			output
		};
	}
	/** Remove the timer (the queue file is left alone). */
	async removeTimer() {
		if (platform() !== "darwin") return {
			ok: false,
			message: "当前平台不是 macOS，无 launchd 定时器可移除。",
			output: ""
		};
		const bootout = await run("launchctl", ["bootout", "gui/" + String(process.getuid?.() ?? 0) + "/com.dsh.ticktick-deferred-sync"], 2e4);
		let removed = false;
		try {
			const { rm } = await import("node:fs/promises");
			await rm(timerPlistPath(), { force: true });
			removed = true;
		} catch {
			removed = false;
		}
		return {
			ok: true,
			message: removed ? "定时器已移除（队列文件保留，可用「立即写入」手动同步）。" : "定时器已卸载，但 plist 删除失败。",
			output: "bootout: " + String(bootout.code) + " " + bootout.stderr.trim()
		};
	}
	/** Copy the bundled script into `<home>/scripts` (skipped when already there). */
	async installScript(force) {
		const bundled = bundledScriptPath();
		const installed = installedScriptPath();
		if (!existsSync(bundled)) return {
			ok: false,
			message: "插件自带的 ticktick-pending.mjs 不存在：" + bundled,
			output: ""
		};
		if (existsSync(installed) && !force) return {
			ok: true,
			message: "本地脚本已存在，未覆盖：" + installed,
			output: ""
		};
		await mkdir(path.dirname(installed), { recursive: true });
		await copyFile(bundled, installed);
		return {
			ok: true,
			message: (force ? "已更新" : "已安装") + "本地脚本：" + installed,
			output: ""
		};
	}
	/** Write the queue to TickTick now (runs the script's `flush`). */
	async flush(force) {
		const script = this.resolveScript();
		if (script.source === "missing") return {
			ok: false,
			message: "找不到 ticktick-pending.mjs，无法写入。",
			output: ""
		};
		const args = [script.path, "flush"];
		if (force) args.push("--force");
		const result = await run(process.execPath, args);
		const output = [result.stdout.trim(), result.stderr.trim()].filter((line) => line !== "").join("\n");
		return {
			ok: result.code === 0,
			message: result.code === 0 ? "已执行写入（输出见下方；「仍在活跃，跳过」是正常结果）。" : "写入失败（退出码 " + String(result.code) + "）。",
			output,
			status: await this.status()
		};
	}
};
//#endregion
//#region src/routes.ts
/** Route paths. */
const DISPATCHER_API = {
	probe: "/api/dsh-task-dispatcher/probe",
	config: "/api/dsh-task-dispatcher/config",
	status: "/api/dsh-task-dispatcher/status",
	run: "/api/dsh-task-dispatcher/run",
	workspaces: "/api/dsh-task-dispatcher/workspaces",
	deferred: "/api/dsh-task-dispatcher/deferred",
	deferredConfig: "/api/dsh-task-dispatcher/deferred/config",
	deferredFlush: "/api/dsh-task-dispatcher/deferred/flush",
	deferredTimer: "/api/dsh-task-dispatcher/deferred/timer"
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
	const deferred = new DeferredController();
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
			path: DISPATCHER_API.probe,
			handler: (req, res) => {
				if (!guard(req, res, "GET")) return;
				writeJson(res, 200, {
					ok: true,
					plugin: "dsh-task-dispatcher"
				});
			}
		},
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
		},
		{
			kind: "exact",
			path: DISPATCHER_API.deferred,
			handler: async (req, res) => {
				if (!guard(req, res, "GET")) return;
				writeJson(res, 200, await deferred.status());
			}
		},
		{
			kind: "exact",
			path: DISPATCHER_API.deferredConfig,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (body === void 0) {
					writeJson(res, 400, { error: "invalid JSON body" });
					return;
				}
				const patch = {};
				if (typeof body.idleMinutes === "number") patch.idleMinutes = body.idleMinutes;
				if (typeof body.maxPerSession === "number") patch.maxPerSession = body.maxPerSession;
				if (typeof body.intervalSeconds === "number") patch.intervalSeconds = body.intervalSeconds;
				writeJson(res, 200, await deferred.patchConfig(patch));
			}
		},
		{
			kind: "exact",
			path: DISPATCHER_API.deferredFlush,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				writeJson(res, 200, await deferred.flush(body?.force === true));
			}
		},
		{
			kind: "exact",
			path: DISPATCHER_API.deferredTimer,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const action = typeof body?.action === "string" ? body.action : "reload";
				if (action === "uninstall") {
					writeJson(res, 200, await deferred.removeTimer());
					return;
				}
				if (action === "install-script") {
					writeJson(res, 200, await deferred.installScript(body?.force === true));
					return;
				}
				const current = await deferred.status();
				const interval = typeof body?.intervalSeconds === "number" ? body.intervalSeconds : current.timer.intervalSeconds || 120;
				writeJson(res, 200, await deferred.writeTimer(interval));
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
const DISPATCHER_GUIDANCE = "本机已安装 dsh-task-dispatcher 插件（滴答清单任务派发器）：每隔一段可配置的间隔（默认每 30 分钟）自动从滴答清单「5️⃣AI」（或配置的来源）拉取今天到期/逾期的任务，写入今日任务文件（默认 DSH_HOME 下的 dsh-task-dispatcher/today-tasks.md，DSH_HOME 未设时回落 ~/.dsh），并在任务发生变化时发送通知（默认走**微信**：通过本机微信机器人 ClawBot 的网关 127.0.0.1:51235 把消息发到扫码登录的那个微信；flomo / macOS 通道保留，由配置开关决定）。工具：dispatcher_status（状态）、dispatcher_config（配置拉取间隔/来源/过滤/通知渠道/自动执行/worker 超时；testWechat 可发测试消息）、dispatcher_run（立即拉取一次）、dispatcher_report（执行完/会话结束后发一条汇总，默认发微信）。自动执行的单个 worker 有超时保护（workerTimeoutMinutes，默认 30 分钟，到点 SIGKILL），可在设置面板或 dispatcher_config 调整。你任务都是随手写进滴答清单的，插件会自动跟上：随时往清单里加任务，下次拉取就会带进来。当你开始一天的工作时，先用 read 读取今日任务文件，逐项执行；完成的用 ticktick_complete 回写滴答清单，并把结果落到 Obsidian 知识库/项目档案。**执行结果回执（notifyResult，默认开）**：自动执行的每个任务在 worker 结束后会**自动**推一条简明结果（✅/❌ + 标题 + 一句话结果）到已开启的通知通道（默认微信），多任务再补一条批次汇总——这条不依赖 worker 自己记得汇报。每次执行完/告一段落后，还要调用 dispatcher_report 把本次完成/失败/跳过情况汇总（total/completed/failed/skipped + 可选 summary），它会按配置把汇总发到微信（默认通道）。用户提到「任务派发器 / 今日任务 / 派发 / 今天要做啥」时即指本插件，请据此协作。";
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
						const exec = await runAutoExecute(store, api, result.tasks, { notifyResult: true });
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
export { DEFAULT_CONFIG_FILE, DEFAULT_TASK_FILE, DEFAULT_WORKER_PROMPT, DEFAULT_WORKER_TIMEOUT_MINUTES, DEFAULT_WORKER_TIMEOUT_MS, DEFAULT_WORKSPACE_STORE, DISPATCHER_API, DISPATCHER_GUIDANCE, DeferredController, DispatcherStore, HASH_SAFE, TIMER_LABEL, WECHAT_GATEWAY_URL, apply, buildFlomoContent, buildTools, buildWorkerPrompt, bundledScriptPath, coerceQueue, configPath, defaultQueue, defineTool, dispatcherConfigTool, dispatcherReportTool, dispatcherRunTool, dispatcherStatusTool, doDispatch, dshHome, escapeHashes, flomoMemo, inject, installedScriptPath, listWorkspaces, localDateString, macNotify, makeRoutes, name, newestSessionMtime, notifyText, pluginPath, queuePath, resolveWorkspacePath, resolveWorkspaceTitle, runAutoExecute, spawnWorker, summarizeWorkerOutput, timerPlistPath, wechatRecipient, wechatSend, wechatStateDir, workspaceStorePath };
