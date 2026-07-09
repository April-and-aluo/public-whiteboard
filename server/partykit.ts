// PartyKit 服务器逻辑
// 部署到 Cloudflare Workers 后作为 Yjs 中继和持久化存储
// 本地开发时可作为 WebSocket 服务器运行

import { onConnect } from "y-partykit";
import * as Y from "yjs";

export default {
  async fetch(request, env, ctx) {
    // 健康检查端点
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", time: Date.now() }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("Public Whiteboard Server", { status: 200 });
  },

  async websocket(conn) {
    // WebSocket 连接由 onConnect 处理
  },
};

// Yjs 文档同步 - 每个 Durable Object 管理一个画板房间
export async function handleYjsConnect(server: any) {
  server.onConnect((conn: WebSocket) => {
    // 连接建立时的日志
    console.log(`[Yjs] 新连接: ${conn.url}`);
  });
}
