// ============================================
// yjs-sync.js - Yjs 文档同步层 + 连接管理
// ============================================
// 负责管理共享 Yjs 文档的生命周期和实时同步
// 连接优先级：
//   1. 自建 y-websocket 服务器（最稳定，生产环境）
//   2. y-webrtc 公共信令服务器（备用，P2P）
// 通过配置 WS_URL 切换
// ============================================

import * as Y from './yjs-bundle.js?v=20260710g';
import { WebsocketProvider, WebrtcProvider } from './yjs-bundle.js?v=20260710g';

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
  constructor(roomId = 'free-board') {
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
    this._authToken = null;
  }

  // 初始化连接
  connect(userName, authToken, roomId = null) {
    if (roomId) this.roomId = roomId;
    this.userName = userName;
    this._authToken = authToken || null;
    this.userId = this._generateId();
    this.userColor = USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];

    // 创建 Yjs 文档
    this.doc = new Y.Doc();

    // 创建共享数据结构
    this.strokes = this.doc.getArray('strokes');
    this.images = this.doc.getArray('images');
    this.texts = this.doc.getArray('texts');

    // 始终启用 BroadcastChannel（同浏览器跨标签页同步）
    this._setupBroadcastChannel();

    // 尝试连接 WebSocket 服务器（跨设备同步）
    if (WS_URL) {
      this._connectWebSocket();
    } else {
      // 无 WebSocket 服务器时，使用 WebRTC P2P 模式
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
    this.texts.observe(() => {
      if (this.onDataChange) this.onDataChange('texts');
    });
  }

  // 设置 BroadcastChannel（同浏览器跨标签页同步）
  _setupBroadcastChannel() {
    const channelName = 'whiteboard-' + this.roomId;
    this.bcChannel = new BroadcastChannel(channelName);

    // 广播本地文档更新
    this.doc.on('update', (update, origin) => {
      // 只广播本地产生的更新，避免循环
      if (origin === this.bcChannel || origin === 'remote') return;
      this.bcChannel.postMessage({ type: 'sync', update: Y.encodeStateAsUpdate(this.doc) });
    });

    // 接收远程更新
    this.bcChannel.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === 'sync' && msg.update) {
        Y.applyUpdate(this.doc, new Uint8Array(msg.update), this.bcChannel);
        if (this.onDataChange) this.onDataChange('sync');
      } else if (msg.type === 'awareness') {
        this._bcAwareness(msg.data);
      }
    };

    // 广播 awareness
    this._bcAwarenessTimer = setInterval(() => {
      if (this.bcChannel && this.userName) {
        this.bcChannel.postMessage({
          type: 'awareness',
          data: {
            clientId: this.userId,
            state: {
              user: { name: this.userName, color: this.userColor, userId: this.userId },
              cursor: this._lastCursor || null,
            },
          },
        });
      }
    }, 1000);

    // 立即广播一次
    setTimeout(() => {
      if (this.bcChannel && this.userName) {
        this.bcChannel.postMessage({
          type: 'awareness',
          data: {
            clientId: this.userId,
            state: {
              user: { name: this.userName, color: this.userColor, userId: this.userId },
              cursor: this._lastCursor || null,
            },
          },
        });
      }
    }, 100);

    // 接收远程 awareness（带时间戳，用于过期清理）
    this._bcAwarenessStates = new Map();
    this._bcAwareness = (data) => {
      // state 为 null 表示该用户已离开
      if (data.state === null) {
        this._bcAwarenessStates.delete(data.clientId);
      } else {
        this._bcAwarenessStates.set(data.clientId, {
          ...data.state,
          _ts: Date.now(),
        });
      }
      // 触发 awareness 变化回调
      if (this.onAwarenessChange) {
        this.onAwarenessChange(this.getOnlineUsers());
      }
    };

    // 定期清理过期的 BroadcastChannel awareness 状态（超过5秒未更新视为离线）
    this._bcCleanupTimer = setInterval(() => {
      let changed = false;
      const now = Date.now();
      for (const [clientId, state] of this._bcAwarenessStates) {
        if (now - state._ts > 5000) {
          this._bcAwarenessStates.delete(clientId);
          changed = true;
        }
      }
      if (changed && this.onAwarenessChange) {
        this.onAwarenessChange(this.getOnlineUsers());
      }
    }, 2000);

    console.log('[Yjs] BroadcastChannel 已启用（跨标签页同步）');
  }

  // WebSocket 模式连接（推荐，生产环境）
  _connectWebSocket() {
    try {
      // 通过 params 传递 token，y-websocket 会正确拼接到 URL 末尾：
      // ws://host:port/roomname?token=xxx
      this.provider = new WebsocketProvider(WS_URL, this.roomId, this.doc, {
        connect: true,
        params: this._authToken ? { token: this._authToken } : {},
        // 重连退避策略：初始 1 秒，最大 30 秒，避免频繁重连
        reconnectDelay: 1000,
        maxReconnectDelay: 30000,
      });

      let wsConnected = false;
      this._wsRetryCount = 0;

      // 连接状态监听
      this.provider.on('status', (event) => {
        this.connectionState = event.status; // 'connected' | 'disconnected'
        if (event.status === 'connected') {
          wsConnected = true;
          this._wsRetryCount = 0; // 连接成功后重置重试计数
        } else if (event.status === 'disconnected') {
          this._wsRetryCount = (this._wsRetryCount || 0) + 1;
          console.warn(`[Yjs] WebSocket 断开（第 ${this._wsRetryCount} 次）`);
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
  addImage(x, y, w, h, dataUrl, rotation = 0, opacity = 1, scale = 1) {
    if (!this.images) return;
    const img = new Y.Map();
    img.set('x', x);
    img.set('y', y);
    img.set('w', w);
    img.set('h', h);
    img.set('dataUrl', dataUrl);
    img.set('userId', this.userId);
    img.set('userName', this.userName);
    img.set('createdAt', Date.now());
    img.set('id', this._generateId());
    img.set('rotation', rotation);
    img.set('opacity', opacity);
    img.set('scale', scale);
    this.images.push([img]);
    return img.get('id');
  }

  // 更新图片属性（大小、角度、透明度等）
  updateImageProps(id, props) {
    if (!this.images) return;
    for (let i = 0; i < this.images.length; i++) {
      const img = this.images.get(i);
      if (img.get('id') === id) {
        if (props.x !== undefined) img.set('x', props.x);
        if (props.y !== undefined) img.set('y', props.y);
        if (props.w !== undefined) img.set('w', props.w);
        if (props.h !== undefined) img.set('h', props.h);
        if (props.rotation !== undefined) img.set('rotation', props.rotation);
        if (props.opacity !== undefined) img.set('opacity', props.opacity);
        if (props.scale !== undefined) img.set('scale', props.scale);
        return;
      }
    }
  }

  // 删除指定图片（通过索引）
  removeImage(index) {
    if (!this.images || index < 0 || index >= this.images.length) return;
    this.images.delete(index, 1);
  }

  // 删除指定图片（通过 ID）
  removeImageById(id) {
    if (!this.images) return false;
    for (let i = this.images.length - 1; i >= 0; i--) {
      const img = this.images.get(i);
      if (img.get('id') === id) {
        this.images.delete(i, 1);
        return true;
      }
    }
    return false;
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
        userName: img.get('userName') || '未知用户',
        createdAt: img.get('createdAt') || 0,
        rotation: img.get('rotation') || 0,
        opacity: img.get('opacity') !== undefined ? img.get('opacity') : 1,
        scale: img.get('scale') !== undefined ? img.get('scale') : 1,
        index: i,
      });
    }
    return result;
  }

  // ===== 文字操作 =====

  // 添加一段文字
  addText(x, y, content, fontSize = 24, color = '#422006', rotation = 0, opacity = 1, scale = 1) {
    if (!this.texts) return;
    const text = new Y.Map();
    text.set('x', x);
    text.set('y', y);
    text.set('content', content);
    text.set('fontSize', fontSize);
    text.set('color', color);
    text.set('rotation', rotation);
    text.set('opacity', opacity);
    text.set('scale', scale);
    text.set('userId', this.userId);
    text.set('userName', this.userName);
    text.set('createdAt', Date.now());
    text.set('id', this._generateId());
    this.texts.push([text]);
    return text.get('id');
  }

  // 更新文字属性
  updateTextProps(id, props) {
    if (!this.texts) return;
    for (let i = 0; i < this.texts.length; i++) {
      const text = this.texts.get(i);
      if (text.get('id') === id) {
        if (props.x !== undefined) text.set('x', props.x);
        if (props.y !== undefined) text.set('y', props.y);
        if (props.content !== undefined) text.set('content', props.content);
        if (props.fontSize !== undefined) text.set('fontSize', props.fontSize);
        if (props.color !== undefined) text.set('color', props.color);
        if (props.rotation !== undefined) text.set('rotation', props.rotation);
        if (props.opacity !== undefined) text.set('opacity', props.opacity);
        if (props.scale !== undefined) text.set('scale', props.scale);
        return;
      }
    }
  }

  // 删除指定文字（通过 ID）
  removeTextById(id) {
    if (!this.texts) return false;
    for (let i = this.texts.length - 1; i >= 0; i--) {
      const text = this.texts.get(i);
      if (text.get('id') === id) {
        this.texts.delete(i, 1);
        return true;
      }
    }
    return false;
  }

  // 获取所有文字
  getAllTexts() {
    if (!this.texts) return [];
    const result = [];
    for (let i = 0; i < this.texts.length; i++) {
      const t = this.texts.get(i);
      result.push({
        id: t.get('id'),
        x: t.get('x'),
        y: t.get('y'),
        content: t.get('content') || '',
        fontSize: t.get('fontSize') || 24,
        color: t.get('color') || '#422006',
        rotation: t.get('rotation') || 0,
        opacity: t.get('opacity') !== undefined ? t.get('opacity') : 1,
        scale: t.get('scale') !== undefined ? t.get('scale') : 1,
        userId: t.get('userId'),
        userName: t.get('userName') || '未知用户',
        createdAt: t.get('createdAt') || 0,
        index: i,
      });
    }
    return result;
  }

  // ===== Awareness 光标操作 =====

  // 更新光标位置
  updateCursor(x, y) {
    this._lastCursor = (x !== null && y !== null) ? { x, y } : null;
    if (this.provider) {
      this.provider.awareness.setLocalStateField('cursor', this._lastCursor);
    }
    // 通过 BroadcastChannel 广播光标
    if (this.bcChannel) {
      this.bcChannel.postMessage({
        type: 'awareness',
        data: {
          clientId: this.userId,
          state: {
            user: { name: this.userName, color: this.userColor, userId: this.userId },
            cursor: this._lastCursor,
          },
        },
      });
    }
  }

  // 清除光标
  clearCursor() {
    if (this.provider) {
      this.provider.awareness.setLocalStateField('cursor', null);
    }
    if (this.bcChannel) {
      this.bcChannel.postMessage({
        type: 'awareness',
        data: {
          clientId: this.userId,
          state: {
            user: { name: this.userName, color: this.userColor, userId: this.userId },
            cursor: null,
          },
        },
      });
    }
  }

  // 获取所有在线用户信息
  getOnlineUsers() {
    const users = [];

    // 从 provider awareness 获取
    if (this.provider) {
      const states = this.provider.awareness.getStates();
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
    }

    // 从 BroadcastChannel 获取其他标签页的用户（过滤过期状态）
    if (this._bcAwarenessStates) {
      const now = Date.now();
      for (const [clientId, state] of this._bcAwarenessStates) {
        // 跳过超过5秒未更新的状态（已离线）
        if (state._ts && now - state._ts > 5000) continue;
        const user = state.user;
        if (user && !users.find(u => u.userId === user.userId)) {
          users.push({
            clientId,
            name: user.name,
            color: user.color,
            userId: user.userId,
            cursor: state.cursor,
          });
        }
      }
    }

    // 如果没有其他用户，至少显示自己
    if (users.length === 0 && this.userName) {
      users.push({
        clientId: 'self',
        name: this.userName,
        color: this.userColor,
        userId: this.userId,
        cursor: null,
      });
    }

    return users;
  }

  // 获取所有远程用户（非本地）的光标
  getRemoteCursors() {
    const cursors = [];

    // 从 provider awareness 获取
    if (this.provider) {
      const states = this.provider.awareness.getStates();
      const localId = this.provider.awareness.clientID;
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
    }

    // 从 BroadcastChannel 获取其他标签页的光标
    if (this._bcAwarenessStates) {
      for (const [clientId, state] of this._bcAwarenessStates) {
        const user = state.user;
        const cursor = state.cursor;
        if (user && cursor && user.userId !== this.userId) {
          cursors.push({
            clientId,
            name: user.name,
            color: user.color,
            cursor,
          });
        }
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
    // 通过 BroadcastChannel 发送离开消息
    if (this.bcChannel && this.userName) {
      this.bcChannel.postMessage({
        type: 'awareness',
        data: {
          clientId: this.userId,
          state: null, // null 表示离开
        },
      });
    }

    if (this._bcAwarenessTimer) {
      clearInterval(this._bcAwarenessTimer);
      this._bcAwarenessTimer = null;
    }
    if (this._bcCleanupTimer) {
      clearInterval(this._bcCleanupTimer);
      this._bcCleanupTimer = null;
    }
    if (this.bcChannel) {
      this.bcChannel.close();
      this.bcChannel = null;
    }
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
    this.texts = null;
  }
}

// 导出单例
export const yjsSync = new YjsSync();
