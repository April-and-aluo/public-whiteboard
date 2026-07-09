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
// 房间管理 - 每个房间维护一个 Y.Doc
// ============================================
const docs = new Map();

function getYDoc(docName, gc = true) {
  let doc = docs.get(docName);
  if (!doc) {
    doc = new Y.Doc();
    doc.gc = gc;
    // awareness - 使用 Map 存储每个客户端的状态
    doc.awareness = new awarenessProtocol.Awareness(doc);
    doc.conns = new Map();
    docs.set(docName, doc);
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
    // 如果房间没有人了，删除文档释放内存
    if (doc.conns.size === 0) {
      for (const [name, d] of docs) {
        if (d === doc) {
          docs.delete(name);
          break;
        }
      }
      doc.destroy();
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
// 消息处理
// ============================================
function messageListener(conn, doc, message) {
  try {
    const encoder = encoding.createEncoder();
    const decoder = decoding.createDecoder(message);
    const messageType = decoding.readVarUint(decoder);

    switch (messageType) {
      case messageSync:
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

  console.log(`[+] Client joined room "${docName}" (${doc.conns.size} online)`);
}

// ============================================
// MIME 类型映射
// ============================================
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
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
const server = http.createServer((req, res) => {
  // 健康检查
  if (req.url === '/health') {
    let totalConns = 0;
    for (const doc of docs.values()) totalConns += doc.conns.size;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      rooms: docs.size,
      connections: totalConns,
      roomDetails: Array.from(docs.entries()).map(([name, doc]) => ({
        name,
        connections: doc.conns.size,
        awarenessStates: doc.awareness.getStates().size,
      })),
      uptime: process.uptime(),
      timestamp: Date.now(),
    }));
    return;
  }

  // 静态文件服务
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  const safePath = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(__dirname, 'public', safePath);

  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
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
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

// ============================================
// WebSocket 服务器
// ============================================
const wss = new WebSocketServer({ server });

function getRoomName(url) {
  const match = url.match(/^\/([^?]+)/);
  return match ? match[1] : 'public-board';
}

wss.on('connection', (ws, req) => {
  const roomName = getRoomName(req.url);
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
  console.log(`  Started: ${new Date().toISOString()}`);
  console.log(`========================================`);
});
