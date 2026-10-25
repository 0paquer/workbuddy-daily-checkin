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
    if (opts.status) {
      try {
        const st = await session.httpFetch('GET', STATUS_PATH);
        log(`[状态] HTTP ${st.status} ${JSON.stringify(st.body)}`);
      } catch (e) {
        log(`[状态] 查询失败（忽略）: ${e.message}`);
      }
    }

    const res = await session.httpFetch('POST', CHECKIN_PATH);
    const { status: httpStatus, body } = res;

    if (httpStatus === 200 && (body === null || body.code === 0 || body.code === undefined)) {
      return { ok: true, code: EXIT.OK, message: '签到成功', status: httpStatus, body };
    }
    if (body && body.code === 10001) {
      return { ok: true, code: EXIT.OK, message: '今日已签到', status: httpStatus, body };
    }
    if (httpStatus >= 200 && httpStatus < 300) {
      return { ok: true, code: EXIT.OK, message: `HTTP ${httpStatus}`, status: httpStatus, body };
    }
    const err = withCode(new Error(`接口异常 HTTP ${httpStatus}`), EXIT.BUSINESS);
    err.detail = body;
    throw err;
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
// CLI 入口
// ------------------------------------------------------------------
if (require.main === module) {
  const { status, json } = parseArgs();
  runCheckin({ status })
    .then((r) => {
      const extra = (r.body && (r.body.msg || (r.body.data && JSON.stringify(r.body.data)))) || '';
      log(`[OK] ${r.message} ✅ ${extra}`);
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

module.exports = { runCheckin, findEndpointFile, EXIT, CHECKIN_PATH, STATUS_PATH };
