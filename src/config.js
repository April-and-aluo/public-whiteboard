// ============================================
// config.js - 部署配置
// ============================================
// WebSocket 服务器地址（跨设备同步）
// 自动适应部署环境：
//   - HTTP 部署（如阿里云服务器）：使用同源 ws:// 连接
//   - HTTPS 部署（如 GitHub Pages）：使用 Cloudflare Workers wss:// 连接
//
// 同浏览器多标签页通过 BroadcastChannel 自动同步
// 跨浏览器/跨设备通过此 WebSocket 服务器同步
// ============================================

if (window.location.protocol === 'http:') {
  // HTTP 部署：WebSocket 使用同源连接（同一服务器）
  window.WS_URL = 'ws://' + window.location.host;
} else {
  // HTTPS 部署（GitHub Pages 等）：使用 Cloudflare Workers
  window.WS_URL = 'wss://whiteboard-ws.imaginary-swordfish.workers.dev';
}
