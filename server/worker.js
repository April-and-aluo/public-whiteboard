// Cloudflare Worker - WebSocket 中继服务器
// 部署到 Cloudflare Workers 免费计划
// 使用 Durable Objects 维护 WebSocket 连接状态

// Durable Object - 管理单个房间的连接
export class WhiteboardRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Set();
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // 接受连接
    server.accept();
    this.sessions.add(server);

    // 转发消息
    server.addEventListener("message", (event) => {
      for (const ws of this.sessions) {
        if (ws !== server) {
          try { ws.send(event.data); } catch (e) {}
        }
      }
    });

    // 清理
    server.addEventListener("close", () => {
      this.sessions.delete(server);
    });

    server.addEventListener("error", () => {
      this.sessions.delete(server);
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 健康检查
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", timestamp: Date.now() }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // 非 WebSocket 请求
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Public Whiteboard WebSocket Server", {
        headers: { "Content-Type": "text/plain" },
      });
    }

    // 获取房间名（从路径提取）
    const roomName = url.pathname.slice(1) || "public-board";

    // 获取或创建 Durable Object
    const id = env.WHITEBOARD_ROOM.idFromName(roomName);
    const stub = env.WHITEBOARD_ROOM.get(id);

    // 转发请求到 Durable Object
    return stub.fetch(request);
  },
};
