'use strict';

/**
 * wbipc.js — WorkBuddy 本地 IPC（命名管道）客户端库
 * ------------------------------------------------------------------
 * 负责与本机 WorkBuddy 桌面端托管的 wbipc 守护进程建立会话：
 *   1. 连接命名管道（Windows Named Pipe）；
 *   2. 完成双向 HMAC-SHA256 挑战-响应握手；
 *   3. 通过 broker/GetPipe 打开受控 HTTP 代理通道（host 自动注入登录态）；
 *   4. 暴露 httpFetch() 调用后端接口。
 *
 * 本模块零依赖（仅 Node 内置模块），可同时作为库被 require 与独立测试。
 */

const net = require('net');
const crypto = require('crypto');

// ------------------------------------------------------------------
// 协议常量（与 wbipc host 端保持一致）
// ------------------------------------------------------------------
const PROTOCOL_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 15000;

const CONTROL_CHANNEL = 'broker/GetPipe';
const REQUEST_PIPE = 'wb.request';
const HTTP_FETCH_METHOD = 'http.fetch';

const MSG = {
  HELLO: 'session_hello',
  CHALLENGE: 'session_challenge',
  PROVE: 'session_prove',
  HELLO_ACK: 'session_hello_ack',
  HELLO_ERROR: 'session_hello_error',
};

// ------------------------------------------------------------------
// 认证原语
// ------------------------------------------------------------------
/**
 * 票据 ID：ticket 的 SHA-256 前 16 位十六进制。
 * @param {string} ticket
 * @returns {string}
 */
function ticketIdOf(ticket) {
  return crypto.createHash('sha256').update(ticket, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 构造 transcript（字节序列），用于双方分别计算证明。
 * @param {'client'|'server'} role
 * @param {{protocol:number,endpoint:string,clientNonce:string,serverNonce:string}} t
 * @returns {Buffer}
 */
function encodeTranscript(role, t) {
  const parts = [
    role === 'server' ? 'wbipc-s' : 'wbipc-c',
    String(t.protocol),
    t.endpoint,
    t.clientNonce,
    t.serverNonce,
  ];
  const bufs = [];
  for (const p of parts) {
    const x = Buffer.from(p, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(x.length, 0);
    bufs.push(len, x);
  }
  return Buffer.concat(bufs);
}

/**
 * 计算 HMAC-SHA256 证明（base64url）。
 * @param {string} ticket
 * @param {'client'|'server'} role
 * @param {object} transcript
 * @returns {string}
 */
function computeProof(ticket, role, transcript) {
  return crypto.createHmac('sha256', Buffer.from(ticket, 'utf8'))
    .update(encodeTranscript(role, transcript))
    .digest('base64url');
}

// ------------------------------------------------------------------
// 会话
// ------------------------------------------------------------------
/**
 * 建立 wbipc 会话（连接 + 握手），返回 Session 对象。
 * @param {string} endpoint 命名管道路径，例如 \\\\.\\pipe\\wbipc-xxxx
 * @param {string} ticket   endpoint.json 中的一次性票据
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<WbipcSession>}
 */
function connect(endpoint, ticket, opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const clientNonce = crypto.randomBytes(16).toString('base64url');
    const sock = net.connect(endpoint);

    let buffer = Buffer.alloc(0);     // 字节级缓冲，UTF-8 安全
    const pending = new Map();        // id -> {res, rej}
    let nextId = 1;
    let settled = false;
    let ready = false;
    let reqChannel = null;            // 缓存的 wb.request 通道名
    let timer = null;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    };

    /** @typedef {object} WbipcSession */
    const session = {
      /** 原始管道路径 */
      get endpoint() { return endpoint; },

      /**
       * 发送一条 JSON-RPC 消息并等待响应。
       * @param {string} method
       * @param {object} params
       * @param {'call'} [mode]
       * @returns {Promise<object>}
       */
      invoke(method, params, mode) {
        return new Promise((res, rej) => {
          const id = nextId++;
          const msg = { jsonrpc: '2.0', method, id, params };
          if (mode) msg.mode = mode;
          pending.set(id, { res, rej });
          sock.write(JSON.stringify(msg) + '\n');
        });
      },

      /**
       * 打开（并缓存）wb.request 受控 HTTP 代理通道。
       * @returns {Promise<string>} 通道名，例如 c:wb.request
       */
      async openRequestChannel() {
        if (reqChannel) return reqChannel;
        const gp = await session.invoke(CONTROL_CHANNEL, { pipe: REQUEST_PIPE });
        if (!gp || !gp.channel) throw new Error('GetPipe 未返回通道');
        reqChannel = gp.channel;
        return reqChannel;
      },

      /**
       * 经受控代理调用后端（host 自动注入登录态）。
       * @param {'GET'|'POST'|'PUT'|'DELETE'} method
       * @param {string} path
       * @param {{query?:object, body?:object}} [options]
       * @returns {Promise<{status:number|undefined, body:object|null}>}
       */
      async httpFetch(method, path, options = {}) {
        const channel = await session.openRequestChannel();
        const params = { method, path, query: options.query || {}, headers: {} };
        if (options.body !== undefined) {
          params.body_b64 = Buffer.from(JSON.stringify(options.body)).toString('base64');
        }
        const r = await session.invoke(`${channel}/${HTTP_FETCH_METHOD}`, params, 'call');
        let body = null;
        if (r && r.body_b64) {
          try { body = JSON.parse(Buffer.from(r.body_b64, 'base64').toString('utf8')); }
          catch (_) { body = null; }
        }
        return { status: r && r.status, body };
      },

      /** 关闭连接 */
      close() {
        if (timer) clearTimeout(timer);
        try { sock.destroy(); } catch (_) { /* noop */ }
      },
    };

    sock.on('connect', () => {
      sock.write(JSON.stringify({
        type: MSG.HELLO,
        protocol_min: PROTOCOL_VERSION,
        protocol_max: PROTOCOL_VERSION,
        client_nonce: clientNonce,
        ticket_id: ticketIdOf(ticket),
      }) + '\n');
    });

    sock.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let idx;
      // 按换行符切分帧（UTF-8 安全：先累积字节，再整体解码）
      while ((idx = buffer.indexOf(0x0a)) >= 0) {
        const lineBuf = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const line = lineBuf.toString('utf8').trim();
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch (_) { continue; }

        if (m.type === MSG.CHALLENGE) {
          const transcript = {
            protocol: PROTOCOL_VERSION,
            endpoint,
            clientNonce,
            serverNonce: m.server_nonce,
          };
          sock.write(JSON.stringify({
            type: MSG.PROVE,
            client_proof: computeProof(ticket, 'client', transcript),
          }) + '\n');
        } else if (m.type === MSG.HELLO_ACK) {
          ready = true; settled = true;
          if (timer) clearTimeout(timer);
          resolve(session);
        } else if (m.type === MSG.HELLO_ERROR) {
          fail(new Error(`握手失败: ${m.code || ''} ${m.message || ''}`.trim()));
        } else if (typeof m.id === 'number') {
          const h = pending.get(m.id);
          if (h) {
            pending.delete(m.id);
            if (m.error) h.rej(new Error(`${m.error.code || ''}: ${m.error.message || ''}`.trim()));
            else h.res(m.result);
          }
        }
      }
    });

    sock.on('error', (e) => {
      if (!ready) fail(new Error(`连接管道失败: ${e.message}（WorkBuddy 客户端是否已启动？）`));
    });
    sock.on('close', () => {
      if (!settled && !ready) fail(new Error('管道在握手前关闭'));
    });

    timer = setTimeout(() => {
      fail(new Error(`连接超时（${timeoutMs / 1000}s）`));
    }, timeoutMs);
  });
}

module.exports = {
  connect,
  ticketIdOf,
  computeProof,
  encodeTranscript,
  PROTOCOL_VERSION,
  DEFAULT_TIMEOUT_MS,
  CONTROL_CHANNEL,
  REQUEST_PIPE,
  HTTP_FETCH_METHOD,
  MSG,
};
