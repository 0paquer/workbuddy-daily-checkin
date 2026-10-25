#!/usr/bin/env node
/**
 * WorkBuddy 每日自动签到（本机登录态直签）
 * ------------------------------------------------------------------
 * 原理：
 *   读取本机 WorkBuddy 登录态票据（endpoint.json），通过 wbipc 命名管道完成
 *   带认证的会话，再用受控 HTTP 代理（wb.request/http.fetch，host 自动注入登录态）
 *   调用后端签到接口 POST /v2/billing/meter/daily-checkin。
 *
 * 特点：
 *   - 零依赖：仅 Node.js 内置模块（net / crypto / fs / os / path）。
 *   - 零配置：复用客户端本地登录态，不提取、不重放任何 token。
 *   - 幂等：重复调用返回 code=10001「今天已签到」，视为成功（exit 0）。
 *   - 可移植：自动从用户主目录定位数据目录，支持环境变量覆盖。
 *   - 可复用：本文件同时是 CLI 与库（require('./checkin').runCheckin）。
 *   - 成长中心：本地连续签到天数统计（累计 / 当前 / 最长），不依赖接口字段，
 *     断网或接口改版也不影响，仅写入本机一个 JSON 历史文件。
 *
 * 退出码：0=成功/已签；1=业务异常；2=缺少登录态；3=连接握手失败；4=调用失败；5=未找到 node。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { connect } = require('./src/wbipc');

// ------------------------------------------------------------------
// 退出码
// ------------------------------------------------------------------
const EXIT = {
  OK: 0,
  BUSINESS: 1,
  NO_AUTH: 2,
  CONNECT: 3,
  CALL: 4,
  NO_NODE: 5,
};

const CHECKIN_PATH = '/v2/billing/meter/daily-checkin';
const STATUS_PATH = '/v2/billing/meter/checkin-activity-status'; // 可选；部分版本 404，不影响签到

// ------------------------------------------------------------------
// 配置与发现
// ------------------------------------------------------------------
/**
 * 定位 endpoint.json。显式环境变量优先；缺失即报错，不静默回退。
 * @returns {string}
 */
function findEndpointFile() {
  if (process.env.WBIP_ENDPOINT_FILE) return process.env.WBIP_ENDPOINT_FILE;
  const candidates = [];
  if (process.env.WORKBUDDY_HOME) {
    candidates.push(path.join(process.env.WORKBUDDY_HOME, 'wbipc', 'endpoint.json'));
  }
  candidates.push(path.join(os.homedir(), '.workbuddy', 'wbipc', 'endpoint.json'));
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, '.workbuddy', 'wbipc', 'endpoint.json'));
  }
  candidates.push(path.join(os.homedir(), 'AppData', 'Roaming', '.workbuddy', 'wbipc', 'endpoint.json'));
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) { /* ignore */ }
  }
  return candidates[0];
}

const ENDPOINT_FILE = findEndpointFile();
const LOG_FILE = process.env.WBIP_LOG || path.join(path.dirname(ENDPOINT_FILE), 'checkin.log');
const HISTORY_FILE = process.env.WBIP_CHECKIN_HISTORY ||
  path.join(path.dirname(ENDPOINT_FILE), 'checkin-history.json');

// 直连模式：同时提供管道与票据，跳过读取 endpoint.json
const RAW_ENDPOINT = process.env.WBIP_ENDPOINT || null;
const RAW_TICKET = process.env.WBIP_TICKET || null;

// ------------------------------------------------------------------
// 日志
// ------------------------------------------------------------------
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) { /* 忽略日志写入失败 */ }
  console.log(line);
}

/**
 * 解析命令行参数。
 * @returns {{status:boolean, json:boolean}}
 */
function parseArgs(argv) {
  const a = (argv || process.argv.slice(2));
  return {
    status: a.includes('--status') || a.includes('-s'),
    json: a.includes('--json') || a.includes('-j'),
    noStats: a.includes('--no-stats') || a.includes('-S'),
  };
}

// ------------------------------------------------------------------
// 核心签到流程（库友好：返回结果对象，不直接退出进程）
// ------------------------------------------------------------------
/**
 * 执行一次签到。
 * @param {{endpointFile?:string, endpoint?:string, ticket?:string, status?:boolean}} [opts]
 * @returns {Promise<{ok:boolean, code:number, message:string, status?:number, body?:object}>}
 */
async function runCheckin(opts = {}) {
  let endpoint, ticket;

  if (opts.endpoint && opts.ticket) {
    endpoint = opts.endpoint; ticket = opts.ticket;
  } else {
    const file = opts.endpointFile || findEndpointFile();
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) {
      throw withCode(new Error(`无法读取登录态文件 ${file}：${e.message}`), EXIT.NO_AUTH);
    }
    endpoint = raw.endpoint; ticket = raw.ticket;
    if (!endpoint || !ticket) {
      throw withCode(new Error('endpoint.json 缺少 endpoint 或 ticket 字段'), EXIT.NO_AUTH);
    }
  }

  const session = await connect(endpoint, ticket).catch((e) =>
    Promise.reject(withCode(e, EXIT.CONNECT)));

  try {
    // 查询活动状态：--status 时打印；成长中心也复用同一请求，失败则忽略。
    let activity = null;
    if (opts.status || opts.growth !== false) {
      try {
        const st = await session.httpFetch('GET', STATUS_PATH);
        if (opts.status) log(`[状态] HTTP ${st.status} ${JSON.stringify(st.body)}`);
        if (opts.growth !== false && st.status === 200 && st.body) activity = st.body;
      } catch (e) {
        if (opts.status) log(`[状态] 查询失败（忽略）: ${e.message}`);
      }
    }

    const res = await session.httpFetch('POST', CHECKIN_PATH);
    const { status: httpStatus, body } = res;

    let result;
    if (httpStatus === 200 && (body === null || body.code === 0 || body.code === undefined)) {
      result = { ok: true, code: EXIT.OK, message: '签到成功', status: httpStatus, body };
    } else if (body && body.code === 10001) {
      result = { ok: true, code: EXIT.OK, message: '今日已签到', status: httpStatus, body };
    } else if (httpStatus >= 200 && httpStatus < 300) {
      result = { ok: true, code: EXIT.OK, message: `HTTP ${httpStatus}`, status: httpStatus, body };
    } else {
      const err = withCode(new Error(`接口异常 HTTP ${httpStatus}`), EXIT.BUSINESS);
      err.detail = body;
      throw err;
    }

    // 成长中心：本地连续签到统计（鲁棒，不依赖接口字段）。
    if (opts.track !== false && result.ok) {
      try {
        const dates = loadHistory(HISTORY_FILE);
        dates.add(ymd(new Date()));
        saveHistory(HISTORY_FILE, dates);
        result.streak = computeStreak(dates);
      } catch (_) { /* 统计失败不影响签到结果 */ }
    }
    if (activity) result.activity = activity;
    return result;
  } finally {
    session.close();
  }
}

/** 给错误附加 code 字段（供 CLI 决定退出码）。 */
function withCode(err, code) {
  err.code = code;
  return err;
}

// ------------------------------------------------------------------
// 成长中心统计（本地连续签到天数，鲁棒且不依赖接口字段）
// ------------------------------------------------------------------
/** 本机时区的本地日期 YYYY-MM-DD。 */
function ymd(d) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

/** 两个 'YYYY-MM-DD' 之间的天数差（b - a）。 */
function dayDiff(a, b) {
  const ms = Date.parse(b + 'T00:00:00') - Date.parse(a + 'T00:00:00');
  return Math.round(ms / 86400000);
}

/** 读取历史日期集合（文件不存在或格式错误都视为空）。 */
function loadHistory(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && Array.isArray(j.dates)) return new Set(j.dates);
  } catch (_) { /* 忽略 */ }
  return new Set();
}

/** 落盘历史日期集合（按日期排序，便于人读/ diff）。 */
function saveHistory(file, set) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ dates: [...set].sort() }, null, 2));
  } catch (_) { /* 忽略写入失败 */ }
}

/**
 * 计算连续签到统计。
 * @param {Set<string>} dates 形如 ['2026-10-24', ...] 的日期集合
 * @returns {{total:number, current:number, longest:number}}
 */
function computeStreak(dates) {
  const arr = [...dates].sort();
  const today = ymd(new Date());
  // 只统计「不晚于今天」的日期（忽略异常的未来日期）。
  const valid = arr.filter((d) => dayDiff(d, today) >= 0);
  const total = valid.length;
  if (total === 0) return { total: 0, current: 0, longest: 0 };
  let longest = 1, run = 1;
  for (let i = 1; i < valid.length; i++) {
    const diff = dayDiff(valid[i - 1], valid[i]);
    if (diff === 1) { run++; if (run > longest) longest = run; }
    else if (diff > 1) { run = 1; }
    // diff === 0 视为同一天重复记录，跳过
  }
  // 当前连续天数：以最近一次 ≤ 今天的签到日为锚点倒推；若该日不是今天/昨天则视为已断签。
  let current = 0;
  const last = valid[valid.length - 1];
  const gap = dayDiff(last, today); // >= 0
  if (gap <= 1) {
    current = 1;
    const idx = arr.indexOf(last);
    for (let i = idx; i > 0; i--) {
      if (dayDiff(arr[i - 1], arr[i]) === 1) current++;
      else break;
    }
  }
  return { total, current, longest };
}

// ------------------------------------------------------------------
// CLI 入口
// ------------------------------------------------------------------
if (require.main === module) {
  const { status, json, noStats } = parseArgs();
  runCheckin({ status, track: !noStats })
    .then((r) => {
      const extra = (r.body && (r.body.msg || (r.body.data && JSON.stringify(r.body.data)))) || '';
      log(`[OK] ${r.message} ✅ ${extra}`);
      if (r.streak) {
        const s = r.streak;
        log(`[成长中心] 累计签到 ${s.total} 天 ｜ 当前连续 ${s.current} 天 ｜ 最长连续 ${s.longest} 天`);
      }
      if (r.activity) log(`[活动状态] ${JSON.stringify(r.activity)}`);
      if (json) console.log(JSON.stringify(r));
      process.exit(r.code);
    })
    .catch((e) => {
      const code = (typeof e.code === 'number') ? e.code : EXIT.CALL;
      log(`[FAIL] ${e.message}`);
      if (json) console.log(JSON.stringify({ ok: false, code, message: e.message }));
      process.exit(code);
    });
}

module.exports = { runCheckin, findEndpointFile, EXIT, CHECKIN_PATH, STATUS_PATH, HISTORY_FILE, computeStreak, loadHistory, saveHistory };
