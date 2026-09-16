#!/usr/bin/env node
/**
 * ticktick-pending.mjs —— 滴答清单「延迟同步」暂存队列
 *
 * 规则（2026-09-13 用户定稿）：
 *   1. 会话进行中**不**直接往滴答清单建任务，只 stage 进本队列；
 *   2. DSH 整体不活跃（最近一个 session 日志 mtime 距今 >= idleMinutes）后才由 flush 真正写入；
 *   3. 一个会话的顶层任务尽可能少（默认上限 3，超出要 --force）；大任务用父任务 + 子任务（parentKey）。
 *
 * 用法：
 *   node ticktick-pending.mjs status
 *   node ticktick-pending.mjs stage --file tasks.json          # [{title, content, dueDate?, parentKey?}...]
 *   node ticktick-pending.mjs stage --json '{"title":"...","content":"..."}'
 *   node ticktick-pending.mjs flush [--force] [--dry-run]
 *   node ticktick-pending.mjs config --idle-minutes 10 --max-per-session 3
 *
 * 队列：$DSH_HOME/dsh-ticktick-pending.json（0600）
 * 日志：$DSH_HOME/dsh-ticktick-pending.log
 * 凭据复用 dsh-ticktick 的 $DSH_HOME/dsh-ticktick.json
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const QUEUE_PATH = path.join(DSH_HOME, 'dsh-ticktick-pending.json');
const CRED_PATH = path.join(DSH_HOME, 'dsh-ticktick.json');
const LOG_PATH = path.join(DSH_HOME, 'dsh-ticktick-pending.log');
const SESSIONS_DIR = path.join(DSH_HOME, 'sessions');
const LOOPBACK_REFRESH = 'http://127.0.0.1:3080/api/dsh-ticktick/oauth/refresh';

const DEFAULT_CONFIG = {
  version: 1,
  idleMinutes: 10,
  maxPerSession: 3,
  projectId: '6aa654ffe4b094f3c163a198', // To do
  tags: ['ai'],
  tasks: [],
  lastFlushAt: null,
  lastFlushResult: null,
};

// ---------------------------------------------------------------- utils

function log(line) {
  const stamp = new Date().toISOString();
  const text = `[${stamp}] ${line}\n`;
  try {
    fs.appendFileSync(LOG_PATH, text, { mode: 0o600 });
  } catch {}
  process.stdout.write(text);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeQueue(q) {
  const tmp = `${QUEUE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(q, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, QUEUE_PATH);
  try {
    fs.chmodSync(QUEUE_PATH, 0o600);
  } catch {}
}

function loadQueue() {
  const q = readJson(QUEUE_PATH, null);
  if (!q || typeof q !== 'object') return { ...DEFAULT_CONFIG };
  return { ...DEFAULT_CONFIG, ...q, tasks: Array.isArray(q.tasks) ? q.tasks : [] };
}

function parseArgs(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else flags._.push(a);
  }
  return flags;
}

function todayLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// all-day dueDate 的本地日历日：滴答用 UTC 零点（本地 08:00）表示，直接给纯日期即可
function dueToApi(dateStr) {
  return dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? `${dateStr}T00:00:00+0800` : dateStr;
}

// 滴答会把 `#词` 解析成任务标签：标题与描述里的半角 # 一律换全角 ＃（2026-09-14 规则；#91 仍读作 ＃91）
function escapeHashes(s) {
  return String(s == null ? '' : s).replace(/#/g, '＃');
}

/** DSH 整体是否已经安静够久 */
function newestSessionMtime() {
  let newest = 0;
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/^session.*\.jsonl\.zstd$/.test(e.name)) {
        try {
          const m = fs.statSync(full).mtimeMs;
          if (m > newest) newest = m;
        } catch {}
      }
    }
  };
  walk(SESSIONS_DIR, 0);
  return newest;
}

function idleInfo(idleMinutes) {
  const newest = newestSessionMtime();
  const idleMs = Date.now() - newest;
  return {
    newestSessionAt: newest ? new Date(newest).toISOString() : null,
    idleMinutes: Math.floor(idleMs / 60000),
    required: idleMinutes,
    isIdle: newest === 0 ? true : idleMs >= idleMinutes * 60000,
  };
}

// ---------------------------------------------------------------- api

function loadCreds() {
  const c = readJson(CRED_PATH, null);
  if (!c || !c.accessToken) throw new Error(`未找到滴答凭据（${CRED_PATH}），请先授权 dsh-ticktick`);
  return c;
}

function apiBase(creds) {
  return creds.region === 'intl' ? 'https://api.ticktick.com/open/v1' : 'https://api.dida365.com/open/v1';
}

async function tryRefreshToken(creds) {
  // 1) 优先走 dsh web 的 loopback 刷新路由（会顺带写回凭据文件）
  try {
    const r = await fetch(LOOPBACK_REFRESH, { method: 'POST' });
    if (r.ok) {
      const fresh = readJson(CRED_PATH, null);
      if (fresh?.accessToken) {
        log('  令牌已通过 loopback 路由刷新');
        return fresh;
      }
    }
  } catch {}
  // 2) 回退：直连官方 oauth/token
  try {
    if (!creds.clientId || !creds.clientSecret || !creds.refreshToken) return null;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
    });
    const host = creds.region === 'intl' ? 'https://ticktick.com' : 'https://dida365.com';
    const r = await fetch(`${host}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!r.ok) return null;
    const t = await r.json();
    const merged = { ...creds, accessToken: t.access_token, refreshToken: t.refresh_token || creds.refreshToken };
    fs.writeFileSync(CRED_PATH, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
    log('  令牌已通过官方 oauth/token 刷新');
    return merged;
  } catch {
    return null;
  }
}

async function api(creds, method, apiPath, body) {
  const headers = { Authorization: `Bearer ${creds.accessToken}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(apiBase(creds) + apiPath, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { status: r.status, json, text };
}

async function withAuth(creds, fn) {
  let res = await fn(creds);
  if (res.status === 401) {
    const fresh = await tryRefreshToken(creds);
    if (fresh) res = await fn(fresh);
  }
  return res;
}

// ---------------------------------------------------------------- commands

function cmdStatus() {
  const q = loadQueue();
  const idle = idleInfo(q.idleMinutes);
  const byParent = new Map();
  for (const t of q.tasks) byParent.set(t.parentKey || null, (byParent.get(t.parentKey || null) || 0) + 1);
  console.log('滴答清单延迟同步队列');
  console.log(`  队列文件     : ${QUEUE_PATH}`);
  console.log(`  待同步任务   : ${q.tasks.length}（顶层 ${q.tasks.filter((t) => !t.parentKey).length}）`);
  console.log(`  不活跃阈值   : ${q.idleMinutes} 分钟 · 当前已静默 ${idle.idleMinutes} 分钟 → ${idle.isIdle ? '可同步' : '仍在活跃，跳过'}`);
  console.log(`  最近活动会话 : ${idle.newestSessionAt || '(无)'}`);
  console.log(`  上次同步     : ${q.lastFlushAt || '(从未)'} ${q.lastFlushResult ? '· ' + q.lastFlushResult : ''}`);
  if (q.tasks.length) {
    console.log('  明细：');
    for (const t of q.tasks) {
      console.log(`    - ${t.parentKey ? '  └ ' : ''}${t.title}  [${t.dueDate || '无日期'}] ${t.stagedBy ? '· ' + t.stagedBy : ''}`);
    }
  }
}

function cmdStage(flags) {
  const q = loadQueue();
  let payload = null;
  if (typeof flags.file === 'string') {
    payload = readJson(path.resolve(flags.file), null);
    if (!payload) throw new Error(`无法读取 --file ${flags.file}`);
  } else if (typeof flags.json === 'string') {
    payload = JSON.parse(flags.json);
  } else if (flags._.length) {
    payload = JSON.parse(flags._.join(' '));
  }
  if (!payload) throw new Error('用法：stage --file tasks.json | --json \'{"title":...}\'');
  const list = Array.isArray(payload) ? payload : [payload];

  const stagedBy = flags.by || process.env.DSH_SESSION_ID || `session-${new Date().toISOString().slice(0, 10)}`;
  const maxPerSession = Number(flags['max-per-session'] || q.maxPerSession || 3);
  const force = flags.force === true;

  const existingTitles = new Set(q.tasks.map((t) => t.title));
  const topLevelOfSession = q.tasks.filter((t) => !t.parentKey && t.stagedBy === stagedBy).length;
  const incomingTop = list.filter((t) => !t.parentKey).length;
  if (!force && topLevelOfSession + incomingTop > maxPerSession) {
    throw new Error(
      `本会话已暂存 ${topLevelOfSession} 个顶层任务，再加 ${incomingTop} 个会超过上限 ${maxPerSession}。` +
        `\n规则：一个会话顶层任务尽可能少、以最终结果为导向；大任务请用一个父任务 + 子任务（parentKey）。` +
        `\n确有必要时用 --force。`,
    );
  }

  const keyMap = new Map();
  const added = [];
  // 先注册父任务 key（父可能在本批里）
  for (const t of list) {
    const key = t.key || crypto.randomUUID().slice(0, 8);
    keyMap.set(t.key || key, key);
    if (t.parentKey && keyMap.has(t.parentKey)) t.parentKey = keyMap.get(t.parentKey);
  }
  for (const t of list) {
    const key = keyMap.get(t.key) || crypto.randomUUID().slice(0, 8);
    let parentKey = t.parentKey || null;
    if (parentKey && keyMap.has(parentKey)) parentKey = keyMap.get(parentKey);
    if (!t.title) throw new Error('任务缺少 title');
    const title = escapeHashes(String(t.title).trim());
    if (existingTitles.has(title)) {
      log(`  跳过（队列里已有同名）：${title}`);
      continue;
    }
    const entry = {
      key,
      title,
      content: escapeHashes(t.content || ''),
      // To do 不带日期（2026-09-14 规则）：未显式传 dueDate 就保持无日期
      dueDate: t.dueDate || null,
      tags: Array.isArray(t.tags) && t.tags.length ? t.tags : q.tags,
      projectId: t.projectId || q.projectId,
      parentKey,
      stagedAt: new Date().toISOString(),
      stagedBy,
    };
    q.tasks.push(entry);
    existingTitles.add(entry.title);
    added.push(entry.title);
  }
  writeQueue(q);
  log(`暂存 ${added.length} 个任务（stagedBy=${stagedBy}）：${added.join('；') || '(无)'}`);
  const idle = idleInfo(q.idleMinutes);
  console.log(`不活跃阈值 ${q.idleMinutes} 分钟，当前静默 ${idle.idleMinutes} 分钟——${idle.isIdle ? '可同步' : '等安静下来后由定时器写入'}`);
}

async function cmdFlush(flags) {
  const q = loadQueue();
  const dryRun = flags['dry-run'] === true;
  const force = flags.force === true;
  if (!q.tasks.length) {
    if (flags.verbose) log('队列为空，无需同步');
    return;
  }
  const idle = idleInfo(q.idleMinutes);
  if (!idle.isIdle && !force && !dryRun) {
    log(`跳过同步：DSH 仍在活跃（静默 ${idle.idleMinutes} 分钟 < ${q.idleMinutes} 分钟），队列保持 ${q.tasks.length} 条`);
    return;
  }

  let creds;
  try {
    creds = loadCreds();
  } catch (e) {
    log(`跳过同步：${e.message}`);
    return;
  }

  // 去重：目标清单里已存在的未完成任务标题
  const existing = new Set();
  {
    const res = await withAuth(creds, (c) => api(c, 'GET', `/project/${q.projectId}/data`));
    if (res.status !== 200) {
      log(`跳过同步：读取清单失败 HTTP ${res.status} ${String(res.text).slice(0, 120)}`);
      return;
    }
    for (const t of res.json?.tasks || []) if (!t.status) existing.add(t.title);
  }

  const createdIds = new Map(); // localKey -> ticktick id
  const doneKeys = new Set();
  const results = [];

  const parents = q.tasks.filter((t) => !t.parentKey);
  const childrenOf = (key) => q.tasks.filter((t) => t.parentKey === key);

  const createOne = async (t, parentId) => {
    if (existing.has(t.title)) {
      doneKeys.add(t.key);
      results.push(`跳过(已存在): ${t.title}`);
      return null;
    }
    if (dryRun) {
      results.push(`[dry-run] 将创建: ${t.title}${parentId ? ` (父 ${parentId})` : ''}`);
      return 'dry-run';
    }
    const body = {
      title: escapeHashes(t.title),
      projectId: t.projectId || q.projectId,
      content: escapeHashes(t.content || ''),
      tags: t.tags?.length ? t.tags : ['ai'],
    };
    // 落 To do 不带日期（2026-09-14 规则）：只有显式传了 dueDate 才写；不再补默认/顺延
    if (t.dueDate) body.dueDate = dueToApi(t.dueDate);
    if (parentId) body.parentId = parentId;
    const res = await withAuth(creds, (c) => api(c, 'POST', '/task', body));
    if (res.status === 200 && res.json?.id) {
      doneKeys.add(t.key);
      existing.add(t.title);
      results.push(`已创建: ${t.title}`);
      return res.json.id;
    }
    results.push(`失败 HTTP ${res.status}: ${t.title} ${String(res.text).slice(0, 120)}`);
    return null;
  };

  for (const p of parents) {
    const pid = await createOne(p, null);
    if (pid) createdIds.set(p.key, pid);
    for (const c of childrenOf(p.key)) {
      const realParent = pid || createdIds.get(p.key) || null;
      if (c.parentKey && !realParent) {
        results.push(`失败(父任务未创建): ${c.title}`);
        continue;
      }
      await createOne(c, realParent);
    }
  }
  // 父任务不在队列里的“孤儿”子任务：降级为顶层创建，避免丢失
  for (const t of q.tasks.filter((t) => t.parentKey && !parents.some((p) => p.key === t.parentKey))) {
    await createOne(t, null);
  }

  const remaining = q.tasks.filter((t) => !doneKeys.has(t.key));
  q.tasks = remaining;
  q.lastFlushAt = new Date().toISOString();
  q.lastFlushResult = results.length ? results.join(' | ') : '无变化';
  if (!dryRun) writeQueue(q);
  log(`同步完成：新建/跳过 ${doneKeys.size} 条，剩余待处理 ${remaining.length} 条` + (dryRun ? '（dry-run，未写入滴答）' : ''));
  for (const r of results) console.log('  ' + r);
}

function cmdConfig(flags) {
  const q = loadQueue();
  if (typeof flags['idle-minutes'] === 'string') q.idleMinutes = Number(flags['idle-minutes']);
  if (typeof flags['max-per-session'] === 'string') q.maxPerSession = Number(flags['max-per-session']);
  if (typeof flags['project-id'] === 'string') q.projectId = flags['project-id'];
  if (typeof flags.tags === 'string') q.tags = flags.tags.split(/[,\s]+/).filter(Boolean);
  writeQueue(q);
  console.log(`已更新：idleMinutes=${q.idleMinutes} maxPerSession=${q.maxPerSession} projectId=${q.projectId} tags=${JSON.stringify(q.tags)}`);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const cmd = flags._.shift() || 'status';
  switch (cmd) {
    case 'status':
      cmdStatus();
      break;
    case 'stage':
      cmdStage(flags);
      break;
    case 'flush':
      await cmdFlush(flags);
      break;
    case 'config':
      cmdConfig(flags);
      break;
    default:
      console.error(`未知命令：${cmd}（可选 status / stage / flush / config）`);
      process.exit(2);
  }
}

main().catch((e) => {
  log(`错误：${e?.message || e}`);
  process.exit(1);
});
