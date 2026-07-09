# 公共白板项目笔记 (Public Whiteboard)

## 1. 项目概述

本项目是一个协作式白板应用，支持多用户实时协同绘制。

- **协作框架**：使用 [Yjs](https://github.com/yjs/yjs) 作为 CRDT 数据同步核心，保证多端数据一致性
- **渲染层**：基于 HTML5 Canvas 进行图形绘制与渲染
- **通信方式**：
  - WebSocket（通过 y-websocket 服务端中转，生产环境主要方式）
  - BroadcastChannel（同浏览器跨标签页同步，辅助方式）

---

## 2. 部署方法

- **GitHub 仓库**：`april-and-aluo/public-whiteboard`
- **服务器地址**：`47.93.203.99:8080`
- **自动更新脚本**：`~/wb/auto-update.sh`
  - crontab 每 2 分钟检查 GitHub 最新 commit
  - 从 jsdelivr CDN 下载文件到 `~/wb/public/` 和 `~/wb/server.js`
  - 检测到更新后自动 `sudo systemctl restart whiteboard`
- **CDN 加速**：使用 jsdelivr CDN 拉取仓库文件，URL 格式：
  ```
  https://cdn.jsdelivr.net/gh/april-and-aluo/public-whiteboard@<commit-hash>/src/<文件>
  ```

---

## 3. 服务器更新方法

### 方法一（最高效）：等待自动更新

推送代码到 GitHub main 分支后，等待 2 分钟内的 cron 执行自动更新脚本。

### 方法二：阿里云工作台终端手动触发

1. 打开阿里云工作台，进入实例的「终端连接」
2. 执行：`bash ~/wb/auto-update.sh`

### 方法三：通过 jsdelivr CDN 绕过缓存（指定 commit hash）

```bash
curl -sL "https://cdn.jsdelivr.net/gh/april-and-aluo/public-whiteboard@<HASH>/src/<FILE>" -o <FILE>
```

---

## 4. 文件结构

| 文件 | 职责 |
| --- | --- |
| `src/main.js` | 应用入口，工具切换、选择/编辑/拖拽逻辑、用户跳转 |
| `src/canvas-engine.js` | Canvas 渲染、视口变换、手势处理、拖拽、编辑按钮 |
| `src/yjs-sync.js` | Yjs 数据同步逻辑、WebSocket/BroadcastChannel 连接 |
| `src/cursor-layer.js` | 远程用户光标层渲染 |
| `src/export.js` | PNG 导出功能 |
| `src/index.html` | 页面结构（含 WS_URL 配置） |
| `src/styles.css` | 样式定义（含移动端 v2 布局） |
| `server/combined.js` | Node.js 服务器（HTTP + WebSocket + 认证 + 持久化） |

---

## 5. 踩过的坑

### 5.1 BroadcastChannel awareness 状态永不过期
- **问题**：通过 BroadcastChannel 同步的 awareness 状态不会自动清除，已离开的用户光标会残留在画面上。
- **解决**：为每个 awareness 状态附带时间戳，并设置 5 秒超时的清理定时器。

### 5.2 用户离开事件
- **问题**：仅靠 `unload` 事件不可靠。
- **解决**：同时监听 `beforeunload` 和 `pagehide` 事件。

### 5.3 移动端工具栏 flex-wrap 导致空白行
- **问题**：移动端工具栏使用 `flex-wrap: wrap`，在折叠状态下会出现额外的空白行。
- **解决**：改为 `flex-wrap: nowrap`。

### 5.4 浏览器快照超时
- **问题**：当终端标签页内容过多时，浏览器快照会超时。
- **解决**：新开标签页操作，或等待页面加载完成后再截图。

### 5.5 CDN 缓存问题
- **问题**：jsdelivr CDN 会缓存文件。
- **解决**：在 URL 中使用 commit hash 绕过缓存。

### 5.6 【关键】客户端未连接 WebSocket 服务器
- **问题**：`window.WS_URL` 未配置，客户端默认使用 WebRTC P2P 模式，数据不经过服务器，导致服务器端持久化无效。
- **症状**：数据在页面刷新后丢失，跨设备同步不工作。
- **解决**：在 `index.html` 中添加 `<script>window.WS_URL = 'ws://${window.location.host}';</script>`
- **教训**：这是最关键的配置问题，必须确保客户端连接到 WebSocket 服务器才能实现数据同步和持久化。

### 5.7 Yjs 数据持久化
- **问题**：Yjs 文档数据默认仅存在于内存中，服务器重启后数据丢失。
- **解决**：在 `server/combined.js` 中实现文件持久化：
  - 房间创建时从 `data/ydocs/<roomname>.ydoc` 加载历史数据
  - 文档更新时防抖 2 秒保存到磁盘（原子写入：先写 .tmp 再 rename）
  - 房间空时不销毁文档，保留在内存中
  - SIGTERM/SIGINT 优雅关闭时保存所有房间数据

### 5.8 Pointer 事件拖拽追踪
- **问题**：拖拽过程中若指针移出元素，事件会丢失。
- **解决**：在 pointerdown 时调用 `setPointerCapture`。

### 5.9 Canvas DPR 缩放
- **问题**：高分屏上画面模糊。
- **解决**：按 `devicePixelRatio` 对 canvas 上下文进行缩放。

### 5.10 文字提示不消失
- **问题**：切换工具时"点击画布添加文字"提示仍显示。
- **解决**：在 `setTool()` 中，当工具不是 text 时，始终隐藏 `text-placement` 和 `text-editor` 元素。在 `showTextEditor()` 中也隐藏提示。

### 5.11 编辑按钮位置计算
- **问题**：canvas 上绘制的编辑按钮无法通过 DOM 事件点击，需要手动计算位置进行命中测试。
- **解决**：使用 `_getEditButtonWorldPos()` 计算世界坐标位置，`_hitTestEditButton()` 进行 18px 半径的命中测试。文字宽度通过 `ctx.measureText()` 计算。

---

## 6. 高效方法

- **定向编辑**：使用 SearchReplace 进行针对性修改
- **先读后改**：编辑前先 Read 文件，避免基于过期内容操作
- **批量调用**：对相互独立的工具调用进行批量处理
- **页面内调试**：使用 `browser_evaluate` 在实时页面中执行 JS 进行测试
- **更新流程**：先 commit & push 到 GitHub，等待自动更新脚本部署
- **CDN 验证**：推送后用 `curl -sL "https://cdn.jsdelivr.net/gh/...@<HASH>/..."` 验证 CDN 已更新
- **服务器验证**：`curl http://47.93.203.99:8080/health` 检查服务器状态
- **跨标签页测试**：新开标签页验证 WebSocket 同步是否正常
- **截图验证**：使用 `browser_take_screenshot` 截图后用 Read 工具查看图片内容

---

## 7. 架构说明

### 7.1 Yjs 文档结构

- `strokes`（Y.Array）：笔触数据 `{ points, color, width, userId }`
- `images`（Y.Array）：图片数据 `{ x, y, w, h, dataUrl, rotation, opacity, scale, userId, userName, createdAt }`
- `texts`（Y.Array）：文本数据 `{ id, x, y, text, size, rotation, opacity, color, userId, userName, createdAt }`
- `awareness`：用户在线状态与光标位置 `{ cursor: {x,y}, name, color }`

### 7.2 Canvas 坐标系统

- 世界坐标系 + 视口变换（offsetX, offsetY, scale）
- `screenToWorld(sx, sy)` / `worldToScreen(wx, wy)` 坐标转换

### 7.3 选择与编辑模式

- **选择模式**：点击元素显示蓝色虚线边框 + 圆形编辑按钮
- **编辑模式**：点击编辑按钮后打开属性面板，此时可平移视角
- **拖拽移动**：选中状态下直接拖拽元素可移动位置

### 7.4 缩略图（Minimap）

- 显示笔画（深色线条）、图片（蓝色矩形）、文字（橙色矩形）、远程光标（彩色圆点）
- 红色矩形表示当前视口范围
- 下方显示位置和缩放百分比

### 7.5 用户位置与跳转

- 屏幕边缘标记：不在视口内的用户显示为边缘小标志，点击跳转
- 用户列表头像点击：跳转到对应用户位置，显示返回按钮
- 返回按钮：点击回到跳转前的位置

### 7.6 数据持久化

- 服务器端文件持久化：`data/ydocs/<roomname>.ydoc`
- 防抖保存（2 秒延迟）
- 原子写入（.tmp + rename）
- 优雅关闭时全量保存
- 房间空时不销毁文档

---

## 8. 待办 / 改进

- [ ] 完善撤销/重做（undo/redo）栈
- [ ] 移动端双指平移手势应在所有工具模式下均可用
- [ ] 图片放置前的属性预览面板优化
- [ ] 考虑添加 y-leveldb 替代文件持久化以提升大文档性能
- [ ] 添加服务器端日志查看接口
- [ ] 压力测试：多用户同时编辑时的性能
