// ============================================
// y-websocket 服务器 - 实时协作展示板后端
// ============================================
// 轻量级 WebSocket 中继服务器，基于 y-websocket
// 用于在多个浏览器间同步 Yjs 文档
// ============================================

import { WebSocketServer } from 'ws';
import http from 'http';

const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';

// 存储每个房间的连接
const rooms = new Map(); // roomName -> Set<WebSocket>

// 创建 HTTP 服务器（用于健康检查）
const server = http.createServer((req, res) => {
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
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Public Whiteboard WebSocket Server');
});

// 创建 WebSocket 服务器
const wss = new WebSocketServer({ server });

// 解析房间名（从 URL 路径中提取）
function getRoomName(url) {
  // URL 格式: /public-board 或 /room-name
  const match = url.match(/^\/([^?]+)/);
  return match ? match[1] : 'public-board';
}

// 广播消息到房间内所有其他客户端
function broadcast(roomName, message, sender) {
  const room = rooms.get(roomName);
  if (!room) return;
  for (const client of room) {
    if (client !== sender && client.readyState === 1) {
      // WebSocket.OPEN === 1
      try {
        client.send(message);
      } catch (e) {
        // 忽略发送失败的连接
        room.delete(client);
      }
    }
  }
}

wss.on('connection', (ws, req) => {
  const roomName = getRoomName(req.url);
  const clientIP = req.socket.remoteAddress;

  // 加入房间
  if (!rooms.has(roomName)) {
    rooms.set(roomName, new Set());
  }
  rooms.get(roomName).add(ws);

  const roomSize = rooms.get(roomName).size;
  console.log(`[+] ${clientIP} 加入房间 "${roomName}" (当前 ${roomSize} 人)`);

  // 转发消息给房间内其他客户端
  ws.on('message', (data, isBinary) => {
    broadcast(roomName, data, ws);
  });

  // 客户端断开
  ws.on('close', () => {
    const room = rooms.get(roomName);
    if (room) {
      room.delete(ws);
      const remaining = room.size;
      console.log(`[-] ${clientIP} 离开房间 "${roomName}" (剩余 ${remaining} 人)`);
      // 如果房间为空，清理房间
      if (remaining === 0) {
        rooms.delete(roomName);
        console.log(`[x] 房间 "${roomName}" 已清空并移除`);
      }
    }
  });

  ws.on('error', (err) => {
    console.error(`[!] 连接错误:`, err.message);
    const room = rooms.get(roomName);
    if (room) room.delete(ws);
  });
});

// 定期清理无效连接（每5分钟）
setInterval(() => {
  for (const [roomName, room] of rooms) {
    for (const client of room) {
      if (client.readyState !== 1 && client.readyState !== 0) {
        room.delete(client);
      }
    }
    if (room.size === 0) {
      rooms.delete(roomName);
    }
  }
}, 5 * 60 * 1000);

server.listen(PORT, HOST, () => {
  console.log(`========================================`);
  console.log(`  公共展示板 WebSocket 服务器`);
  console.log(`  监听: ws://${HOST}:${PORT}`);
  console.log(`  健康检查: http://${HOST}:${PORT}/health`);
  console.log(`  启动时间: ${new Date().toISOString()}`);
  console.log(`========================================`);
});
