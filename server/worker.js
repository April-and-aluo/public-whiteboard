// ============================================
// Cloudflare Worker - y-websocket 协议服务器
// ============================================
// 使用 Durable Objects 维护每个房间的 Y.Doc 状态
// 实现完整的 y-websocket 同步协议：
//   - sync step 1/2 握手
//   - 文档更新广播
//   - awareness 状态管理
// ============================================
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

// y-websocket 协议常量
const messageSync = 0;
const messageAwareness = 1;
const messageQueryAwareness = 2;

// ============================================
// Durable Object - 每个房间一个实例
// ============================================
export class WhiteboardRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    // 每个房间维护一个 Y.Doc
    this.doc = new Y.Doc();
    this.doc.gc = true;
    this.doc.awareness = new awarenessProtocol.Awareness(this.doc);

    // 连接管理：Map<WebSocket, { clientIDs: Set, updateHandler: Function }>
    this.sessions = new Map();

    // awareness 更新广播 - 统一处理
    this.doc.awareness.on('update', ({ added, updated, removed }, origin) => {
      const changedClients = added.concat(updated).concat(removed);
      if (changedClients.length === 0) return;

      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageAwareness);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(this.doc.awareness, changedClients)
      );
      const message = encoding.toUint8Array(encoder);

      for (const [ws] of this.sessions) {
        if (ws !== origin) {
          this._send(ws, message);
        }
      }
    });
  }

  // 发送消息到单个连接
  _send(ws, message) {
    try {
      ws.send(message);
    } catch (e) {
      this._closeConn(ws);
    }
  }

  // 关闭连接并清理
  _closeConn(ws) {
    const session = this.sessions.get(ws);
    if (session) {
      // 移除该连接关联的 awareness 状态
      if (session.clientIDs.size > 0) {
        awarenessProtocol.removeAwarenessStates(
          this.doc.awareness,
          Array.from(session.clientIDs),
          null
        );
      }
      // 移除文档更新监听器（防止内存泄漏）
      if (session.updateHandler) {
        this.doc.off('update', session.updateHandler);
      }
      this.sessions.delete(ws);
    }
    try { ws.close(); } catch (e) {}
  }

  // 处理客户端消息
  _messageListener(ws, data) {
    try {
      const encoder = encoding.createEncoder();
      const decoder = decoding.createDecoder(new Uint8Array(data));
      const messageType = decoding.readVarUint(decoder);

      switch (messageType) {
        case messageSync:
          encoding.writeVarUint(encoder, messageSync);
          syncProtocol.readSyncMessage(decoder, encoder, this.doc, ws);
          if (encoding.length(encoder) > 1) {
            this._send(ws, encoding.toUint8Array(encoder));
          }
          break;

        case messageAwareness:
          awarenessProtocol.applyAwarenessUpdate(
            this.doc.awareness,
            decoding.readVarUint8Array(decoder),
            ws
          );
          break;

        case messageQueryAwareness:
          encoding.writeVarUint(encoder, messageQueryAwareness);
          encoding.writeVarUint8Array(
            encoder,
            awarenessProtocol.encodeAwarenessUpdate(
              this.doc.awareness,
              Array.from(this.doc.awareness.getStates().keys())
            )
          );
          this._send(ws, encoding.toUint8Array(encoder));
          break;

        default:
          break;
      }
    } catch (err) {
      // 忽略消息处理错误
    }
  }

  // 设置新连接
  _setupConnection(ws) {
    const session = {
      clientIDs: new Set(),
      updateHandler: null,
    };
    this.sessions.set(ws, session);

    // 监听消息
    ws.addEventListener('message', (event) => {
      if (typeof event.data === 'string') return;
      this._messageListener(ws, event.data);
    });

    // 监听关闭
    ws.addEventListener('close', () => {
      this._closeConn(ws);
    });

    ws.addEventListener('error', () => {
      this._closeConn(ws);
    });

    // 发送 sync step 1（请求客户端的状态向量）
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    this._send(ws, encoding.toUint8Array(encoder));

    // 发送当前 awareness 状态
    const awarenessStates = Array.from(this.doc.awareness.getStates().keys());
    if (awarenessStates.length > 0) {
      const awarenessEncoder = encoding.createEncoder();
      encoding.writeVarUint(awarenessEncoder, messageAwareness);
      encoding.writeVarUint8Array(
        awarenessEncoder,
        awarenessProtocol.encodeAwarenessUpdate(this.doc.awareness, awarenessStates)
      );
      this._send(ws, encoding.toUint8Array(awarenessEncoder));
    }

    // 监听文档更新，发送给此连接（排除来自此连接的更新）
    session.updateHandler = (update, origin) => {
      if (origin !== ws) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, messageSync);
        syncProtocol.writeUpdate(enc, update);
        this._send(ws, encoding.toUint8Array(enc));
      }
    };
    this.doc.on('update', session.updateHandler);

    // 记录 awareness clientID 用于断开时清理
    session.clientIDs.add(this.doc.awareness.clientID);
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    server.accept();
    this._setupConnection(server);

    return new Response(null, { status: 101, webSocket: client });
  }
}

// ============================================
// Worker 入口
// ============================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 健康检查
    if (url.pathname === '/health') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          protocol: 'y-websocket',
          timestamp: Date.now(),
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 非 WebSocket 请求
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Public Whiteboard WebSocket Server (y-websocket protocol)', {
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // 获取房间名
    const roomName = url.pathname.slice(1) || 'public-board';

    // 获取或创建 Durable Object
    const id = env.WHITEBOARD_ROOM.idFromName(roomName);
    const stub = env.WHITEBOARD_ROOM.get(id);

    return stub.fetch(request);
  },
};
