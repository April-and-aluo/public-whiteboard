// ============================================
// server-deno.js - Deno Deploy WebSocket 服务器
// ============================================
// 部署到 Deno Deploy（免费，支持 WebSocket，不休眠）
// 全球边缘部署，低延迟
// ============================================

// 存储每个房间的连接
const rooms = new Map(); // roomName -> Set<WebSocket>

// 解析房间名
function getRoomName(url) {
  const match = url.match(/^\/([^?]+)/);
  return match ? match[1] : "public-board";
}

// 广播消息到房间内其他客户端
function broadcast(roomName, message, sender) {
  const room = rooms.get(roomName);
  if (!room) return;
  for (const client of room) {
    if (client !== sender && client.readyState === WebSocket.OPEN) {
      try {
        client.send(message);
      } catch (e) {
        room.delete(client);
      }
    }
  }
}

Deno.serve((req) => {
  const url = new URL(req.url);

  // 健康检查
  if (url.pathname === "/health") {
    const totalConns = Array.from(rooms.values()).reduce(
      (sum, set) => sum + set.size,
      0
    );
    return new Response(
      JSON.stringify({
        status: "ok",
        rooms: rooms.size,
        connections: totalConns,
        uptime: 0,
        timestamp: Date.now(),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  // WebSocket 升级
  if (req.headers.get("upgrade") !== "websocket") {
    return new Response("Public Whiteboard WebSocket Server", {
      headers: { "Content-Type": "text/plain" },
    });
  }

  const roomName = getRoomName(url.pathname);
  const { socket, response } = Deno.upgradeWebSocket(req);

  socket.onopen = () => {
    if (!rooms.has(roomName)) {
      rooms.set(roomName, new Set());
    }
    rooms.get(roomName).add(socket);
    console.log(`[+] 加入房间 "${roomName}" (${rooms.get(roomName).size} 人)`);
  };

  socket.onmessage = (event) => {
    broadcast(roomName, event.data, socket);
  };

  socket.onclose = () => {
    const room = rooms.get(roomName);
    if (room) {
      room.delete(socket);
      if (room.size === 0) {
        rooms.delete(roomName);
      }
    }
  };

  socket.onerror = (e) => {
    console.error("[!] 连接错误:", e.message || "unknown");
    const room = rooms.get(roomName);
    if (room) room.delete(socket);
  };

  return response;
});
