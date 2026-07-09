// ============================================
// config.js - 部署配置
// ============================================
// WebSocket 服务器地址（跨设备同步）
// 自动适应部署环境：
//   - HTTP 部署（如阿里云服务器）：使用同源 ws:// 连接
//   - HTTPS 部署（如 GitHub Pages）：使用 Cloudflare Workers wss:// 连接
//
// API 服务地址（注册 / 登录 / 验证）：
//   - HTTP 部署：使用同源相对路径（空字符串）
//   - HTTPS 部署（GitHub Pages 等）：暂无 API 服务，留空以备将来配置
//
// 同浏览器多标签页通过 BroadcastChannel 自动同步
// 跨浏览器/跨设备通过此 WebSocket 服务器同步
// ============================================

if (window.location.protocol === 'http:') {
  // HTTP 部署：WebSocket 使用同源连接（同一服务器）
  window.WS_URL = 'ws://' + window.location.host;
  // HTTP 部署：API 使用同源相对路径
  window.API_URL = '';
} else {
  // HTTPS 部署（GitHub Pages 等）：使用 Cloudflare Workers
  window.WS_URL = 'wss://whiteboard-ws.imaginary-swordfish.workers.dev';
  // HTTPS 部署：暂无 API 服务（GitHub Pages 不支持后端），留空以备将来配置
  window.API_URL = '';
}
