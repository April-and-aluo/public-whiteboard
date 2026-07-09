// ============================================
// 组合服务器 - 静态文件 + WebSocket 中继
// ============================================
import { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// MIME 类型映射
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

// 存储每个房间的连接
const rooms = new Map();

// 创建 HTTP 服务器（静态文件 + 健康检查）
const server = http.createServer((req, res) => {
  // 健康检查
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      rooms: rooms.size,
      connections: Array.from(rooms.values()).reduce((sum, set) => sum + set.size, 0),
      uptime: process.uptime(),
      timestamp: Date.now(),
    }));
    return;
  }

  // 静态文件服务
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  // 安全检查：防止目录遍历
  const safePath = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(__dirname, 'public', safePath);

  // 确保文件在 public 目录内
  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // 文件不存在，返回 index.html（SPA 支持）
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

// 创建 WebSocket 服务器
const wss = new WebSocketServer({ server });

// 解析房间名
function getRoomName(url) {
  const match = url.match(/^\/([^?]+)/);
  return match ? match[1] : 'public-board';
}

// 广播消息
function broadcast(roomName, message, sender) {
  const room = rooms.get(roomName);
  if (!room) return;
  for (const client of room) {
    if (client !== sender && client.readyState === 1) {
      try {
        client.send(message);
      } catch (e) {
        room.delete(client);
      }
    }
  }
}

wss.on('connection', (ws, req) => {
  const roomName = getRoomName(req.url);
  const clientIP = req.socket.remoteAddress;

  if (!rooms.has(roomName)) {
    rooms.set(roomName, new Set());
  }
  rooms.get(roomName).add(ws);

  const roomSize = rooms.get(roomName).size;
  console.log(`[+] ${clientIP} joined "${roomName}" (${roomSize} online)`);

  ws.on('message', (data) => {
    broadcast(roomName, data, ws);
  });

  ws.on('close', () => {
    const room = rooms.get(roomName);
    if (room) {
      room.delete(ws);
      const remaining = room.size;
      console.log(`[-] ${clientIP} left "${roomName}" (${remaining} online)`);
      if (remaining === 0) {
        rooms.delete(roomName);
      }
    }
  });

  ws.on('error', (err) => {
    console.error(`[!] Error:`, err.message);
    const room = rooms.get(roomName);
    if (room) room.delete(ws);
  });
});

// 定期清理
setInterval(() => {
  for (const [roomName, room] of rooms) {
    for (const client of room) {
      if (client.readyState !== 1 && client.readyState !== 0) {
        room.delete(client);
      }
    }
    if (room.size === 0) rooms.delete(roomName);
  }
}, 300000);

server.listen(PORT, HOST, () => {
  console.log(`========================================`);
  console.log(`  Whiteboard Server (Static + WebSocket)`);
  console.log(`  HTTP:  http://${HOST}:${PORT}`);
  console.log(`  WS:    ws://${HOST}:${PORT}`);
  console.log(`  Health: http://${HOST}:${PORT}/health`);
  console.log(`  Started: ${new Date().toISOString()}`);
  console.log(`========================================`);
});
