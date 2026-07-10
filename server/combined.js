// ============================================
// 组合服务器 - 静态文件 + y-websocket 协议
// ============================================
// 实现完整的 y-websocket 同步协议：
//   - 维护每个房间的 Y.Doc 文档状态
//   - 处理 sync step 1/2 握手
//   - 广播文档更新和 awareness 状态
// ============================================
import { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================
// y-websocket 协议常量
// ============================================
const messageSync = 0;
const messageAwareness = 1;
const messageQueryAwareness = 2;
const wsReadyStateConnecting = 0;
const wsReadyStateOpen = 1;
const wsReadyStateClosing = 2;
const wsReadyStateClosed = 3;

// ============================================
// 用户数据管理 - 注册 / 登录 / Token 验证
// ============================================
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const TOKEN_TTL = 7 * 24 * 60 * 60 * 1000; // 7 天（毫秒）

// 内存中的 token 存储：token -> { username, createdAt }
const tokens = new Map();

// 串行化写入队列，避免并发写入冲突
let writeQueue = Promise.resolve();

// 确保数据目录存在
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

// 读取用户数据（带默认值）
function readUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) {
      return {};
    }
    const data = fs.readFileSync(USERS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error('[!] 读取用户数据失败:', err.message);
    return {};
  }
}

// 原子写入用户数据（临时文件 + rename），使用串行化队列保证顺序
function writeUsers(users) {
  ensureDataDir();
  writeQueue = writeQueue.then(() => {
    return new Promise((resolve, reject) => {
      const tmpFile = USERS_FILE + '.tmp';
      fs.writeFile(tmpFile, JSON.stringify(users, null, 2), 'utf-8', (err) => {
        if (err) {
          reject(err);
          return;
        }
        fs.rename(tmpFile, USERS_FILE, (renameErr) => {
          if (renameErr) {
            reject(renameErr);
          } else {
            resolve();
          }
        });
      });
    });
  }).catch((err) => {
    console.error('[!] 写入用户数据失败:', err.message);
  });
  return writeQueue;
}

// 密码哈希（异步 scrypt + 随机 salt，避免阻塞事件循环）
function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(password, salt, 64, (err, hash) => {
      if (err) { reject(err); return; }
      resolve(salt.toString('hex') + ':' + hash.toString('hex'));
    });
  });
}

// 验证密码（异步 scrypt + timingSafeEqual 防止时序攻击）
function verifyPassword(password, stored) {
  return new Promise((resolve) => {
    try {
      const [saltHex, hashHex] = stored.split(':');
      const salt = Buffer.from(saltHex, 'hex');
      const storedHash = Buffer.from(hashHex, 'hex');
      crypto.scrypt(password, salt, 64, (err, hash) => {
        if (err) { resolve(false); return; }
        resolve(hash.length === storedHash.length && crypto.timingSafeEqual(hash, storedHash));
      });
    } catch (err) {
      resolve(false);
    }
  });
}

// 用户名验证：2-20 字符，允许字母数字下划线和中文
function isValidUsername(username) {
  if (typeof username !== 'string') return false;
  if (username.length < 2 || username.length > 20) return false;
  return /^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(username);
}

// 密码验证：8-64 字符，至少包含字母和数字
function isValidPassword(password) {
  if (typeof password !== 'string') return false;
  if (password.length < 8 || password.length > 64) return false;
  // 至少包含字母和数字，防止纯数字或纯字母弱密码
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) return false;
  return true;
}

// 生成 token（crypto.randomBytes(32)）
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// 创建 token 并存入内存
function createToken(username) {
  const token = generateToken();
  tokens.set(token, {
    username,
    createdAt: Date.now(),
  });
  return token;
}

// 验证 token 有效性（检查 7 天 TTL）
function verifyToken(token) {
  if (!token) return null;
  const record = tokens.get(token);
  if (!record) return null;
  if (Date.now() - record.createdAt > TOKEN_TTL) {
    tokens.delete(token);
    return null;
  }
  return record;
}

// ============================================
// 速率限制 - 防止暴力破解和 DoS
// ============================================
const rateLimitMap = new Map(); // key: IP -> { count, resetTime }
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 分钟窗口
const RATE_LIMIT_MAX_AUTH = 10; // 认证接口每分钟最多 10 次
const RATE_LIMIT_MAX_GENERAL = 60; // 其他 API 每分钟最多 60 次

function rateLimit(ip, maxRequests) {
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetTime) {
    entry = { count: 1, resetTime: now + RATE_LIMIT_WINDOW };
    rateLimitMap.set(ip, entry);
    return { allowed: true, remaining: maxRequests - 1 };
  }
  entry.count++;
  if (entry.count > maxRequests) {
    return { allowed: false, remaining: 0, retryAfter: Math.ceil((entry.resetTime - now) / 1000) };
  }
  return { allowed: true, remaining: maxRequests - entry.count };
}

// 定期清理过期的速率限制条目
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetTime) rateLimitMap.delete(ip);
  }
}, 5 * 60 * 1000).unref();

// 获取客户端 IP
function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
}

// ============================================
// 请求体读取（带大小限制，防止内存耗尽 DoS）
// ============================================
const MAX_BODY_SIZE = 1024 * 1024; // 1MB 最大请求体

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy(); // 中断读取
        resolve(null); // null 表示超限
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

// ============================================
// Y.Doc 持久化 - 文件存储
// ============================================
const PERSIST_DIR = path.join(DATA_DIR, 'ydocs');

if (!fs.existsSync(PERSIST_DIR)) {
  fs.mkdirSync(PERSIST_DIR, { recursive: true });
}

// 房间名 -> 安全的文件名（只保留字母数字和连字符）
function sanitizeDocName(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function getDocFilePath(docName) {
  return path.join(PERSIST_DIR, sanitizeDocName(docName) + '.ydoc');
}

// 从文件加载 Y.Doc 状态
function loadDocFromDisk(docName, doc) {
  const filePath = getDocFilePath(docName);
  try {
    if (!fs.existsSync(filePath)) return false;
    const data = fs.readFileSync(filePath);
    if (data.length > 0) {
      const update = new Uint8Array(data);
      Y.applyUpdate(doc, update);
      console.log(`[持久化] 已加载房间 "${docName}" 的数据 (${data.length} bytes)`);
      return true;
    }
  } catch (err) {
    console.error(`[持久化] 加载房间 "${docName}" 数据失败:`, err.message);
  }
  return false;
}

// 保存 Y.Doc 状态到文件（原子写入）
function saveDocToDisk(docName, doc) {
  const filePath = getDocFilePath(docName);
  try {
    const update = Y.encodeStateAsUpdate(doc);
    const tmpFile = filePath + '.tmp';
    fs.writeFileSync(tmpFile, Buffer.from(update));
    fs.renameSync(tmpFile, filePath);
  } catch (err) {
    console.error(`[持久化] 保存房间 "${docName}" 数据失败:`, err.message);
  }
}

// 防抖保存：每个房间独立的保存定时器
const saveTimers = new Map();
const SAVE_DEBOUNCE_MS = 2000;

function debouncedSaveDoc(docName, doc) {
  if (saveTimers.has(docName)) {
    clearTimeout(saveTimers.get(docName));
  }
  saveTimers.set(docName, setTimeout(() => {
    saveTimers.delete(docName);
    saveDocToDisk(docName, doc);
  }, SAVE_DEBOUNCE_MS));
}

// 保存所有房间数据到磁盘（用于优雅关闭）
function saveAllDocs() {
  for (const [docName, doc] of docs) {
    // 清除待执行的防抖定时器，立即保存
    if (saveTimers.has(docName)) {
      clearTimeout(saveTimers.get(docName));
      saveTimers.delete(docName);
    }
    saveDocToDisk(docName, doc);
  }
  console.log(`[持久化] 已保存 ${docs.size} 个房间的数据到磁盘`);
}

// ============================================
// 房间管理 - 每个房间维护一个 Y.Doc
// ============================================
const docs = new Map();
const docEmptyTimers = new Map(); // 空房间超时清理定时器

function getYDoc(docName, gc = true) {
  let doc = docs.get(docName);
  if (!doc) {
    doc = new Y.Doc();
    doc.gc = gc;
    // awareness - 使用 Map 存储每个客户端的状态
    doc.awareness = new awarenessProtocol.Awareness(doc);
    doc.conns = new Map();
    // 从磁盘加载持久化数据
    loadDocFromDisk(docName, doc);
    // 监听文档更新 -> 防抖保存到磁盘
    doc.on('update', () => {
      debouncedSaveDoc(docName, doc);
    });
    docs.set(docName, doc);
  }
  // 取消空房间清理定时器（有用户加入了）
  if (docEmptyTimers.has(docName)) {
    clearTimeout(docEmptyTimers.get(docName));
    docEmptyTimers.delete(docName);
  }
  return doc;
}

// ============================================
// 消息发送
// ============================================
function send(doc, conn, m) {
  if (conn.readyState !== wsReadyStateConnecting && conn.readyState !== wsReadyStateOpen) {
    closeConn(doc, conn);
  } else {
    try {
      conn.send(m, (err) => {
        if (err) closeConn(doc, conn);
      });
    } catch (e) {
      closeConn(doc, conn);
    }
  }
}

// 关闭连接并清理
function closeConn(doc, conn) {
  if (doc.conns.has(conn)) {
    const clientIDs = doc.conns.get(conn);
    doc.conns.delete(conn);
    // 移除该连接关联的 awareness 状态
    awarenessProtocol.removeAwarenessStates(
      doc.awareness,
      Array.from(clientIDs || []),
      null
    );
    // 移除文档更新监听器
    if (conn._updateHandler) {
      doc.off('update', conn._updateHandler);
      conn._updateHandler = null;
    }
    // 如果房间没有人了，保存数据到磁盘并设置超时清理
    if (doc.conns.size === 0) {
      // 立即保存最新状态到磁盘
      for (const [name, d] of docs) {
        if (d === doc) {
          saveDocToDisk(name, doc);
          // 设置 10 分钟超时清理：到期后销毁文档释放内存
          // 新用户加入时会从磁盘重新加载
          if (docEmptyTimers.has(name)) clearTimeout(docEmptyTimers.get(name));
          docEmptyTimers.set(name, setTimeout(() => {
            docEmptyTimers.delete(name);
            const stillEmpty = docs.get(name);
            if (stillEmpty && stillEmpty.conns.size === 0) {
              stillEmpty.destroy();
              docs.delete(name);
              console.log(`[清理] 空房间 "${name}" 已从内存释放`);
            }
          }, 10 * 60 * 1000));
          break;
        }
      }
    }
  }
  try { conn.close(); } catch (e) {}
}

// 广播 update 给房间内其他客户端
function broadcastUpdate(doc, conn, update) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageSync);
  syncProtocol.writeUpdate(encoder, update);
  const message = encoding.toUint8Array(encoder);

  for (const [client] of doc.conns) {
    if (client !== conn && client.readyState === wsReadyStateOpen) {
      send(doc, client, message);
    }
  }
}

// ============================================
// 消息处理（含文档大小限制）
// ============================================
const MAX_DOC_SIZE = 50 * 1024 * 1024; // 文档最大 50MB

function messageListener(conn, doc, message) {
  try {
    const encoder = encoding.createEncoder();
    const decoder = decoding.createDecoder(message);
    const messageType = decoding.readVarUint(decoder);

    switch (messageType) {
      case messageSync:
        // 在应用更新前检查文档大小
        if (doc.store && doc.store.clients) {
          let currentSize = 0;
          for (const updates of doc.store.clients.values()) {
            for (const u of updates) {
              if (u.struct === 'gc') continue;
              currentSize += (u.content && u.content.length) ? u.content.length * 8 : 0;
            }
          }
          if (currentSize > MAX_DOC_SIZE) {
            console.warn(`[!] 文档大小超过限制 (${currentSize} bytes)，拒绝写入`);
            return;
          }
        }
        encoding.writeVarUint(encoder, messageSync);
        syncProtocol.readSyncMessage(decoder, encoder, doc, conn);
        // 如果有回复内容，发送回去
        if (encoding.length(encoder) > 1) {
          send(doc, conn, encoding.toUint8Array(encoder));
        }
        break;

      case messageAwareness: {
        awarenessProtocol.applyAwarenessUpdate(
          doc.awareness,
          decoding.readVarUint8Array(decoder),
          conn
        );
        break;
      }

      case messageQueryAwareness:
        encoding.writeVarUint(encoder, messageQueryAwareness);
        encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(
          doc.awareness,
          Array.from(doc.awareness.getStates().keys())
        ));
        send(doc, conn, encoding.toUint8Array(encoder));
        break;

      default:
        // 未知消息类型，忽略
        break;
    }
  } catch (err) {
    console.error('[!] Message handling error:', err.message);
  }
}

// ============================================
// 设置 WebSocket 连接
// ============================================
function setupWSConnection(conn, req, docName) {
  conn.binaryType = 'arraybuffer';
  const doc = getYDoc(docName);
  doc.conns.set(conn, new Set());

  // 监听连接关闭
  conn.on('close', () => {
    closeConn(doc, conn);
  });

  conn.on('error', (err) => {
    console.error('[!] WS error:', err.message);
    closeConn(doc, conn);
  });

  // 监听消息
  conn.on('message', (message) => {
    if (typeof message === 'string') return;
    messageListener(conn, doc, new Uint8Array(message));
  });

  // 发送 sync step 1（请求客户端的状态向量）
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageSync);
  syncProtocol.writeSyncStep1(encoder, doc);
  send(doc, conn, encoding.toUint8Array(encoder));

  // 发送当前 awareness 状态
  const awarenessStates = Array.from(doc.awareness.getStates().keys());
  if (awarenessStates.length > 0) {
    const awarenessEncoder = encoding.createEncoder();
    encoding.writeVarUint(awarenessEncoder, messageAwareness);
    encoding.writeVarUint8Array(awarenessEncoder, 
      awarenessProtocol.encodeAwarenessUpdate(doc.awareness, awarenessStates)
    );
    send(doc, conn, encoding.toUint8Array(awarenessEncoder));
  }

  // 监听文档更新，广播给其他客户端
  conn._updateHandler = (update, origin) => {
    if (origin !== conn) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, messageSync);
      syncProtocol.writeUpdate(enc, update);
      send(doc, conn, encoding.toUint8Array(enc));
    }
  };
  doc.on('update', conn._updateHandler);

  // 监听 awareness 更新，广播给其他客户端
  const awarenessHandler = ({ added, updated, removed }, origin) => {
    const changedClients = added.concat(updated).concat(removed);
    if (origin !== conn) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, messageAwareness);
      encoding.writeVarUint8Array(enc,
        awarenessProtocol.encodeAwarenessUpdate(doc.awareness, changedClients)
      );
      send(doc, conn, encoding.toUint8Array(enc));
    }
  };
  doc.awareness.on('update', awarenessHandler);

  // 记录客户端 ID 用于 awareness 清理
  doc.conns.get(conn).add(doc.awareness.clientID);

  console.log(`[+] Client "${conn._username || 'unknown'}" joined room "${docName}" (${doc.conns.size} online)`);
}

// ============================================
// MIME 类型映射
// ============================================
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

// ============================================
// HTTP 服务器（静态文件 + 健康检查）
// ============================================
const server = http.createServer(async (req, res) => {
  // 健康检查
  if (req.url === '/health') {
    let totalConns = 0;
    for (const doc of docs.values()) totalConns += doc.conns.size;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // 仅暴露基本健康信息，不泄露房间名称和详情
    res.end(JSON.stringify({
      status: 'ok',
      rooms: docs.size,
      connections: totalConns,
      uptime: process.uptime(),
    }));
    return;
  }

  // ============================================
  // API 路由（注册 / 登录 / 验证 token）
  // ============================================
  const apiPath = req.url.split('?')[0];
  if (apiPath.startsWith('/api/')) {
    // CORS：仅允许同源请求，防止跨站 CSRF
    // 不反射 Origin，浏览器同源策略自动处理
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // 处理预检请求
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 速率限制
    const clientIP = getClientIP(req);
    const isAuthEndpoint = apiPath === '/api/login' || apiPath === '/api/register';
    const rl = rateLimit(clientIP, isAuthEndpoint ? RATE_LIMIT_MAX_AUTH : RATE_LIMIT_MAX_GENERAL);
    if (!rl.allowed) {
      res.writeHead(429, {
        'Content-Type': 'application/json; charset=utf-8',
        'Retry-After': String(rl.retryAfter || 60),
      });
      res.end(JSON.stringify({ ok: false, error: `请求过于频繁，请${rl.retryAfter || 60}秒后重试` }));
      return;
    }

    // 读取并解析请求体（带大小限制）
    const body = await readBody(req);
    if (body === null) {
      res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '请求体过大' }));
      return;
    }

    let parsed = {};
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: '无效的 JSON' }));
      return;
    }

    // 辅助函数：发送 JSON 响应（可附加 Set-Cookie 头）
    const sendJson = (status, payload, cookies = null) => {
      const headers = { 'Content-Type': 'application/json; charset=utf-8' };
      if (cookies) headers['Set-Cookie'] = cookies;
      res.writeHead(status, headers);
      res.end(JSON.stringify(payload));
    };

    // 构建 HttpOnly token cookie 字符串
    const makeTokenCookie = (token, maxAgeDays = 7) => {
      const parts = [
        `wb_token=${token}`,
        `Max-Age=${maxAgeDays * 86400}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
      ];
      // HTTPS 环境下添加 Secure 标志
      if (req.connection.encrypted || req.headers['x-forwarded-proto'] === 'https') {
        parts.push('Secure');
      }
      return parts.join('; ');
    };

    // 构建用户名 cookie（前端可读，非 HttpOnly）
    const makeUsernameCookie = (username, maxAgeDays = 7) => {
      const parts = [
        `wb_username=${encodeURIComponent(username)}`,
        `Max-Age=${maxAgeDays * 86400}`,
        'Path=/',
        'SameSite=Lax',
      ];
      if (req.connection.encrypted || req.headers['x-forwarded-proto'] === 'https') {
        parts.push('Secure');
      }
      return parts.join('; ');
    };

    // 从 Cookie 中提取 token（HttpOnly cookie 会自动随请求发送）
    function getTokenFromCookies(cookieHeader) {
      if (!cookieHeader) return '';
      const match = cookieHeader.match(/(?:^|;\s*)wb_token=([^;]+)/);
      return match ? match[1] : '';
    }

    // /api/register - 注册账号
    if (apiPath === '/api/register' && req.method === 'POST') {
      const { username, password } = parsed;
      if (!isValidUsername(username)) {
        sendJson(400, { ok: false, error: '用户名需为 2-20 字符，允许字母数字下划线和中文' });
        return;
      }
      if (!isValidPassword(password)) {
        sendJson(400, { ok: false, error: '密码需为 8-64 字符，且至少包含字母和数字' });
        return;
      }
      const users = readUsers();
      if (users[username]) {
        sendJson(409, { ok: false, error: '用户名已存在' });
        return;
      }
      users[username] = {
        password: await hashPassword(password),
        createdAt: Date.now(),
      };
      await writeUsers(users);
      // 注册成功后直接返回 token，免去前端二次登录
      const token = createToken(username);
      console.log(`[+] 用户注册并登录: ${username}`);
      const cookies = [makeTokenCookie(token), makeUsernameCookie(username)];
      sendJson(200, { ok: true, token, username, message: '注册成功' }, cookies);
      return;
    }

    // /api/login - 登录验证
    if (apiPath === '/api/login' && req.method === 'POST') {
      const { username, password } = parsed;
      if (!isValidUsername(username) || !isValidPassword(password)) {
        sendJson(400, { ok: false, error: '用户名或密码无效' });
        return;
      }
      const users = readUsers();
      const user = users[username];
      if (!user || !(await verifyPassword(password, user.password))) {
        sendJson(401, { ok: false, error: '用户名或密码错误' });
        return;
      }
      const token = createToken(username);
      console.log(`[+] 用户登录: ${username}`);
      const cookies = [makeTokenCookie(token), makeUsernameCookie(username)];
      sendJson(200, { ok: true, token, username }, cookies);
      return;
    }

    // /api/verify - 验证 token 有效性（支持 Cookie、body、Authorization header）
    if (apiPath === '/api/verify' && req.method === 'POST') {
      const token = getTokenFromCookies(req.headers.cookie) ||
        parsed.token ||
        (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const record = verifyToken(token);
      if (!record) {
        sendJson(401, { ok: false, error: 'token 无效或已过期' });
        return;
      }
      // 返回 token 供 WebSocket 认证使用（HttpOnly Cookie 无法被 JS 读取）
      // 前端将此 token 仅保存在内存中，不持久化到 localStorage
      sendJson(200, { ok: true, username: record.username, token });
      return;
    }

    // 未知 API 端点
    sendJson(404, { ok: false, error: '未知的 API 端点' });
    return;
  }

  // 静态文件服务
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  // 安全路径解析：使用 resolve 规范化，确保结果在 public 目录内
  const publicDir = path.join(__dirname, 'public');
  const filePath = path.resolve(publicDir, '.' + urlPath);
  if (!filePath.startsWith(publicDir + path.sep) && filePath !== publicDir) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        const indexPath = path.join(__dirname, 'public', 'index.html');
        fs.readFile(indexPath, (err2, indexData) => {
          if (err2) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(indexData);
          }
        });
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      }
      return;
    }

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    // 静态文件缓存策略：所有文件都设为 no-store，
    // 确保浏览器每次都从服务器获取最新版本，避免更新后使用旧缓存
    const cacheHeaders = {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
    };
    res.writeHead(200, cacheHeaders);
    res.end(data);
  });
});

// ============================================
// WebSocket 服务器（带 token 认证 + 消息大小限制 + 连接数限制）
// ============================================
const wss = new WebSocketServer({ server, maxPayload: 2 * 1024 * 1024 }); // 单条消息最大 2MB

// ============================================
// 心跳检测：定期 ping 所有连接，清理死连接
// ============================================
const HEARTBEAT_INTERVAL = 30000; // 30 秒检查一次

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      // 上次 ping 后未收到 pong，说明连接已死
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

// ============================================
// WebSocket 连接限制
// ============================================
const MAX_CONNECTIONS_PER_ROOM = 50;  // 每个房间最大连接数
const MAX_ROOMS = 20;                 // 最大房间数
const MAX_WS_CONN_PER_IP = 10;        // 每个 IP 最大 WS 连接数
const wsConnCountByIP = new Map();     // IP -> 当前连接数

// 定期清理已断开的 IP 计数（防止 Map 无限增长）
setInterval(() => {
  for (const [ip, count] of wsConnCountByIP) {
    if (count <= 0) wsConnCountByIP.delete(ip);
  }
}, 10 * 60 * 1000).unref();

function getRoomName(url) {
  const match = url.match(/^\/([^?]+)/);
  return match ? match[1] : 'public-board';
}

// 从 URL query 参数中提取 token
function getTokenFromURL(url) {
  try {
    const urlObj = new URL(url, 'http://localhost');
    return urlObj.searchParams.get('token') || '';
  } catch (e) {
    return '';
  }
}

// ============================================
// 统一的 WebSocket 连接处理器（心跳 + 认证 + 限流）
// ============================================
wss.on('connection', (ws, req) => {
  // 1. 心跳初始化
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // 2. IP 连接数限制（防止单 IP 大量连接）
  const clientIP = getClientIP(req);
  const ipCount = wsConnCountByIP.get(clientIP) || 0;
  if (ipCount >= MAX_WS_CONN_PER_IP) {
    ws.close(4003, '连接数过多');
    return;
  }
  wsConnCountByIP.set(clientIP, ipCount + 1);

  // 连接关闭时减少计数
  ws.on('close', () => {
    const c = wsConnCountByIP.get(clientIP) || 0;
    wsConnCountByIP.set(clientIP, Math.max(0, c - 1));
  });

  // 3. 验证 token（如有）；无 token 时允许作为访客连接
  const token = getTokenFromURL(req.url);
  const tokenRecord = verifyToken(token);

  const roomName = getRoomName(req.url);

  // 4. 房间数量限制（防止创建无限房间耗尽内存）
  if (!docs.has(roomName) && docs.size >= MAX_ROOMS) {
    ws.close(4004, '房间数量已达上限');
    return;
  }

  // 5. 房间连接数限制
  let existingDoc = docs.get(roomName);
  if (existingDoc && existingDoc.conns.size >= MAX_CONNECTIONS_PER_ROOM) {
    ws.close(4002, '房间连接数已满');
    return;
  }

  // 6. 将用户名绑定到连接上，便于审计（访客标记为 guest）
  ws._username = tokenRecord ? tokenRecord.username : 'guest';
  setupWSConnection(ws, req, roomName);
});

// ============================================
// 启动服务器
// ============================================
server.listen(PORT, HOST, () => {
  console.log(`========================================`);
  console.log(`  Whiteboard Server (y-websocket protocol)`);
  console.log(`  HTTP:  http://${HOST}:${PORT}`);
  console.log(`  WS:    ws://${HOST}:${PORT}`);
  console.log(`  Health: http://${HOST}:${PORT}/health`);
  console.log(`  Persistence: ${PERSIST_DIR}`);
  console.log(`  Started: ${new Date().toISOString()}`);
  console.log(`========================================`);
});

// ============================================
// 优雅关闭 - 保存所有数据到磁盘
// ============================================
let isShuttingDown = false;

function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[${signal}] 正在保存数据并关闭服务器...`);

  // 保存所有房间数据
  saveAllDocs();

  // 关闭所有 WebSocket 连接
  for (const doc of docs.values()) {
    for (const conn of doc.conns.keys()) {
      try { conn.close(); } catch (e) {}
    }
  }

  // 关闭 HTTP 服务器
  server.close(() => {
    console.log('[关闭] 服务器已停止');
    process.exit(0);
  });

  // 如果 5 秒内无法正常关闭，强制退出
  setTimeout(() => {
    console.error('[关闭] 超时，强制退出');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
