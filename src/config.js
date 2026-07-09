// ============================================
// config.js - 部署配置
// ============================================
// WebSocket 服务器地址（跨设备同步）
// 部署在 Cloudflare Workers（免费，不休眠，全球边缘）
//
// 同浏览器多标签页通过 BroadcastChannel 自动同步
// 跨浏览器/跨设备通过此 WebSocket 服务器同步
// ============================================

window.WS_URL = 'wss://whiteboard-ws.imaginary-swordfish.workers.dev';
