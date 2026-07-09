# 公共白板项目笔记 (Public Whiteboard)

## 1. 项目概述

本项目是一个协作式白板应用，支持多用户实时协同绘制。

- **协作框架**：使用 [Yjs](https://github.com/yjs/yjs) 作为 CRDT 数据同步核心，保证多端数据一致性
- **渲染层**：基于 HTML5 Canvas 进行图形绘制与渲染
- **通信方式**：
  - WebRTC（点对点连接，适合少量用户低延迟场景）
  - WebSocket（通过 y-websocket 服务端中转，适合多用户、穿透 NAT 场景）

---

## 2. 部署方法

- **GitHub 仓库**：`april-and-aluo/public-whiteboard`
- **服务器地址**：`47.93.203.99:8080`
- **自动更新脚本**：`~/wb/auto-update.sh`
  - 该脚本从 GitHub 拉取最新代码并部署
- **CDN 加速**：使用 jsdelivr CDN 拉取仓库文件，URL 格式：
  ```
  https://cdn.jsdelivr.net/gh/april-and-aluo/public-whiteboard@<分支或commit>/src/<文件>
  ```

---

## 3. 服务器更新方法

### 方法一（最高效）：阿里云工作台终端

1. 打开阿里云工作台，进入实例的「终端连接」
2. 使用剪贴板粘贴命令到终端（实际写入 `xterm-helper-textarea` 触发 clipboard 事件）
3. 执行更新脚本：
   ```bash
   bash ~/wb/auto-update.sh
   ```

### 方法二：通过 jsdelivr CDN 绕过缓存（指定 commit hash）

当需要绕过 CDN 缓存拉取某个具体版本的文件时，使用带 commit hash 的 URL：

```bash
curl -sL "https://cdn.jsdelivr.net/gh/april-and-aluo/public-whiteboard@<HASH>/src/<FILE>" -o <FILE>
```

其中 `<HASH>` 为 GitHub 上某次提交的 commit hash，`<FILE>` 为目标文件路径。

---

## 4. 文件结构

| 文件 | 职责 |
| --- | --- |
| `src/main.js` | 应用入口，工具切换与业务逻辑 |
| `src/canvas-engine.js` | Canvas 渲染、视口变换、手势处理 |
| `src/yjs-sync.js` | Yjs 数据同步逻辑 |
| `src/cursor-layer.js` | 远程用户光标层渲染 |
| `src/export.js` | PNG 导出功能 |
| `src/index.html` | 页面结构 |
| `src/styles.css` | 样式定义 |

---

## 5. 踩过的坑

### 5.1 BroadcastChannel awareness 状态永不过期
- **问题**：通过 BroadcastChannel 同步的 awareness 状态不会自动清除，已离开的用户光标会残留在画面上。
- **解决**：为每个 awareness 状态附带时间戳，并设置 5 秒超时的清理定时器，超时未刷新即移除该状态。

### 5.2 用户离开事件
- **问题**：仅靠 `unload` 事件不可靠，无法稳定发送离开消息。
- **解决**：同时监听 `beforeunload` 和 `pagehide` 事件，在其中发送 leave 消息以清理 awareness。

### 5.3 移动端工具栏 flex-wrap 导致空白行
- **问题**：移动端工具栏使用 `flex-wrap: wrap`，在折叠状态下会出现额外的空白行。
- **解决**：改为 `flex-wrap: nowrap`，避免折行产生空白。

### 5.4 浏览器快照超时
- **问题**：当终端标签页内容过多过重时，浏览器快照（snapshot）会超时失败。
- **解决**：新开一个标签页进行操作，或等待页面加载完成后再截图。

### 5.5 CDN 缓存问题
- **问题**：jsdelivr CDN 会缓存文件，更新后无法立即看到效果。
- **解决**：在 URL 中使用 commit hash 来绕过缓存：
  ```
  https://cdn.jsdelivr.net/gh/.../public-whiteboard@<HASH>/src/<FILE>
  ```

### 5.6 Yjs 数据持久化
- **问题**：Yjs 文档数据默认仅存在于内存中，服务器重启后数据丢失。
- **解决**：需引入持久化层（如 LevelDB）才能实现真正的数据持久保存。

### 5.7 Pointer 事件拖拽追踪
- **问题**：拖拽过程中若指针移出元素，事件会丢失导致拖拽中断。
- **解决**：在 pointerdown 时调用 `setPointerCapture`，确保后续 pointermove/up 都能被捕获。

### 5.8 Canvas DPR 缩放
- **问题**：在高分屏（Retina）设备上画面模糊。
- **解决**：必须按 `devicePixelRatio` 对 canvas 上下文进行缩放（`ctx.scale(dpr, dpr)`），并设置 canvas 实际像素尺寸为 CSS 尺寸 × dpr。

---

## 6. 高效方法

- **定向编辑**：使用 SearchReplace 进行针对性修改，而非整文件重写
- **先读后改**：编辑前先 Read 文件，避免基于过期内容操作
- **批量调用**：对相互独立的工具调用进行批量处理（batch），减少往返延迟
- **页面内调试**：使用 `browser_evaluate` 在实时页面中执行 JS 进行测试
- **更新流程**：先 commit & push 到 GitHub，再通过终端触发服务器更新

---

## 7. 架构说明

### 7.1 Yjs 文档结构

Yjs 文档由以下共享数据组成：

- `strokes`（Y.Array）：笔触数据
- `images`（Y.Array）：图片数据
- `texts`（Y.Array）：文本数据
- `awareness`：用户在线状态与光标位置

### 7.2 Canvas 坐标系统

- Canvas 使用**世界坐标系**（world coordinate system）
- 通过视口变换（viewport transform）实现平移与缩放，参数包括：
  - `offsetX`：水平偏移
  - `offsetY`：垂直偏移
  - `scale`：缩放比例

### 7.3 坐标转换

提供两个核心转换函数：

- `screenToWorld(screenX, screenY)`：屏幕坐标 → 世界坐标
- `worldToScreen(worldX, worldY)`：世界坐标 → 屏幕坐标

### 7.4 选区高亮

- 选中元素的高亮直接绘制在 Canvas 上，使用世界坐标系绘制，保证缩放平移时位置正确。

### 7.5 缩略图（Minimap）

- Minimap 对所有内容进行等比例缩小渲染，呈现全局概览。

---

## 8. 待办 / 改进

- [ ] 为 y-websocket 服务端添加 LevelDB 持久化，实现真正的数据持久保存
- [ ] 完善撤销/重做（undo/redo）栈，目前仅支持撤销最后一笔，需扩展为完整历史栈
- [ ] 移动端双指平移手势应在所有工具模式下均可用（当前部分模式下被拦截）
