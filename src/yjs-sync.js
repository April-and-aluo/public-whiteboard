// ============================================
// yjs-sync.js - Yjs 文档同步层 + 连接管理
// ============================================
// 负责管理共享 Yjs 文档的生命周期和实时同步
// 连接优先级：
//   1. 自建 y-websocket 服务器（最稳定，生产环境）
//   2. y-webrtc 公共信令服务器（备用，P2P）
// 通过配置 WS_URL 切换
// ============================================

import * as Y from './yjs-bundle.js';
import { WebsocketProvider, WebrtcProvider } from './yjs-bundle.js';

// ============================================
// 配置区
// ============================================
// 部署后修改为你自己的 WebSocket 服务器地址
// 例如: 'wss://whiteboard-server.fly.dev'
// 留空则使用 y-webrtc 公共信令服务器（P2P 模式）
const WS_URL = window.WS_URL || '';

// Yjs 文档结构：
// Y.Doc
// ├── strokes: Y.Array<Y.Map>  // 笔画集合
// │   每条: { points, color, width, userId }
// ├── images: Y.Array<Y.Map>   // 图片集合
// │   每张: { x, y, w, h, dataUrl, userId }
// └── awareness                // 临时状态
//     每用户: { cursor: {x,y}, name, color }

// 用户颜色调色板
const USER_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#22c55e',
  '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899',
  '#10b981', '#f43f5e', '#8b5cf6', '#14b8a6',
];

export class YjsSync {
  constructor(roomId = 'public-board') {
    this.roomId = roomId;
    this.doc = null;
    this.provider = null;
    this.strokes = null;
    this.images = null;
    this.userId = null;
    this.userName = null;
    this.userColor = null;
    this.connectionState = 'disconnected';
    this.onConnectionChange = null;
    this.onAwarenessChange = null;
    this.onDataChange = null;
  }

  // 初始化连接
  connect(userName) {
    this.userName = userName;
    this.userId = this._generateId();
    this.userColor = USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];

    // 创建 Yjs 文档
    this.doc = new Y.Doc();

    // 创建共享数据结构
    this.strokes = this.doc.getArray('strokes');
    this.images = this.doc.getArray('images');

    // 优先使用 WebSocket 服务器（更稳定，不受 NAT 影响）
    if (WS_URL) {
      this._connectWebSocket();
    } else {
      // 回退到 y-webrtc P2P 模式（无需自建服务器）
      this._connectWebRTC();
    }

    this._notifyConnectionChange();

    // 数据变化监听
    this.strokes.observe(() => {
      if (this.onDataChange) this.onDataChange('strokes');
    });
    this.images.observe(() => {
      if (this.onDataChange) this.onDataChange('images');
    });
  }

  // WebSocket 模式连接（推荐，生产环境）
  _connectWebSocket() {
    try {
      this.provider = new WebsocketProvider(WS_URL, this.roomId, this.doc, {
        connect: true,
        awareness: true,
      });

      let wsConnected = false;

      // 连接状态监听
      this.provider.on('status', (event) => {
        this.connectionState = event.status; // 'connected' | 'disconnected'
        if (event.status === 'connected') {
          wsConnected = true;
        }
        this._notifyConnectionChange();
      });

      // 先注册 awareness 变化监听
      this.provider.awareness.on('change', () => {
        if (this.onAwarenessChange) {
          this.onAwarenessChange(this.getOnlineUsers());
        }
      });

      // 设置 awareness 用户信息
      this.provider.awareness.setLocalStateField('user', {
        name: this.userName,
        color: this.userColor,
        userId: this.userId,
      });

      this.connectionState = 'connecting';
      console.log('[Yjs] WebSocket 模式连接中:', WS_URL);

      // 3秒后检查是否连接成功，未成功则回退到 WebRTC
      setTimeout(() => {
        if (!wsConnected && this.connectionState !== 'connected') {
          console.warn('[Yjs] WebSocket 连接超时，回退到 WebRTC P2P 模式');
          try { this.provider.destroy(); } catch(e) {}
          this.provider = null;
          this._connectWebRTC();
        }
      }, 3000);

    } catch (err) {
      console.warn('[Yjs] WebSocket 连接失败，回退到 WebRTC:', err);
      this._connectWebRTC();
    }
  }

  // WebRTC 模式连接（备用，P2P）
  _connectWebRTC() {
    try {
      this.provider = new WebrtcProvider(this.roomId, this.doc, {
        signaling: [
          'wss://signaling.yjs.dev',
          'wss://y-webrtc-signaling-eu.herokuapp.com',
          'wss://y-webrtc-signaling-us.herokuapp.com',
        ],
        maxConns: 20,
      });

      // 先注册 awareness 变化监听
      this.provider.awareness.on('change', () => {
        if (this.onAwarenessChange) {
          this.onAwarenessChange(this.getOnlineUsers());
        }
      });

      // 设置 awareness 用户信息
      this.provider.awareness.setLocalStateField('user', {
        name: this.userName,
        color: this.userColor,
        userId: this.userId,
      });

      this.connectionState = 'connected';
      console.log('[Yjs] WebRTC 模式连接（P2P）');
    } catch (err) {
      console.warn('[Yjs] 同步连接失败，将以本地模式运行:', err);
      this.connectionState = 'local';
    }
  }

  // 生成唯一用户 ID
  _generateId() {
    return 'u_' + Math.random().toString(36).substring(2, 11) + Date.now().toString(36);
  }

  // 通知连接状态变化
  _notifyConnectionChange() {
    if (this.onConnectionChange) {
      this.onConnectionChange(this.connectionState);
    }
  }

  // ===== 笔画操作 =====

  // 添加一条笔画
  addStroke(points, color, width) {
    if (!this.strokes) return;
    const stroke = new Y.Map();
    stroke.set('points', points);
    stroke.set('color', color);
    stroke.set('width', width);
    stroke.set('userId', this.userId);
    stroke.set('id', this._generateId());
    this.strokes.push([stroke]);
    return stroke.get('id');
  }

  // 删除指定笔画（通过索引）
  removeStroke(index) {
    if (!this.strokes || index < 0 || index >= this.strokes.length) return;
    this.strokes.delete(index, 1);
  }

  // 删除指定笔画（通过 ID）
  removeStrokeById(id) {
    if (!this.strokes) return;
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      const stroke = this.strokes.get(i);
      if (stroke.get('id') === id) {
        this.strokes.delete(i, 1);
        return true;
      }
    }
    return false;
  }

  // 撤销自己最近一笔
  undoLastStroke() {
    if (!this.strokes) return false;
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      const stroke = this.strokes.get(i);
      if (stroke.get('userId') === this.userId) {
        this.strokes.delete(i, 1);
        return true;
      }
    }
    return false;
  }

  // 获取所有笔画
  getAllStrokes() {
    if (!this.strokes) return [];
    const result = [];
    for (let i = 0; i < this.strokes.length; i++) {
      const s = this.strokes.get(i);
      result.push({
        id: s.get('id'),
        points: s.get('points'),
        color: s.get('color'),
        width: s.get('width'),
        userId: s.get('userId'),
        index: i,
      });
    }
    return result;
  }

  // ===== 图片操作 =====

  // 添加一张图片
  addImage(x, y, w, h, dataUrl) {
    if (!this.images) return;
    const img = new Y.Map();
    img.set('x', x);
    img.set('y', y);
    img.set('w', w);
    img.set('h', h);
    img.set('dataUrl', dataUrl);
    img.set('userId', this.userId);
    img.set('id', this._generateId());
    this.images.push([img]);
    return img.get('id');
  }

  // 更新图片位置
  updateImagePosition(id, x, y) {
    if (!this.images) return;
    for (let i = 0; i < this.images.length; i++) {
      const img = this.images.get(i);
      if (img.get('id') === id) {
        img.set('x', x);
        img.set('y', y);
        return;
      }
    }
  }

  // 获取所有图片
  getAllImages() {
    if (!this.images) return [];
    const result = [];
    for (let i = 0; i < this.images.length; i++) {
      const img = this.images.get(i);
      result.push({
        id: img.get('id'),
        x: img.get('x'),
        y: img.get('y'),
        w: img.get('w'),
        h: img.get('h'),
        dataUrl: img.get('dataUrl'),
        userId: img.get('userId'),
      });
    }
    return result;
  }

  // ===== Awareness 光标操作 =====

  // 更新光标位置
  updateCursor(x, y) {
    if (!this.provider) return;
    this.provider.awareness.setLocalStateField('cursor', { x, y });
  }

  // 清除光标
  clearCursor() {
    if (!this.provider) return;
    this.provider.awareness.setLocalStateField('cursor', null);
  }

  // 获取所有在线用户信息
  getOnlineUsers() {
    if (!this.provider) return [];
    const states = this.provider.awareness.getStates();
    const users = [];
    for (const [clientId, state] of states) {
      const user = state.user;
      if (user) {
        users.push({
          clientId,
          name: user.name,
          color: user.color,
          userId: user.userId,
          cursor: state.cursor,
        });
      }
    }
    return users;
  }

  // 获取所有远程用户（非本地）的光标
  getRemoteCursors() {
    if (!this.provider) return [];
    const states = this.provider.awareness.getStates();
    const localId = this.provider.awareness.clientID;
    const cursors = [];
    for (const [clientId, state] of states) {
      if (clientId === localId) continue;
      const user = state.user;
      const cursor = state.cursor;
      if (user && cursor) {
        cursors.push({
          clientId,
          name: user.name,
          color: user.color,
          cursor,
        });
      }
    }
    return cursors;
  }

  // 获取当前用户信息
  getCurrentUser() {
    return {
      userId: this.userId,
      name: this.userName,
      color: this.userColor,
    };
  }

  // 断开连接
  disconnect() {
    if (this.provider) {
      this.provider.disconnect();
      this.provider.destroy();
      this.provider = null;
    }
    if (this.doc) {
      this.doc.destroy();
      this.doc = null;
    }
    this.strokes = null;
    this.images = null;
  }
}

// 导出单例
export const yjsSync = new YjsSync();
