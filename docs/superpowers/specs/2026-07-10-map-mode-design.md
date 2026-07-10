# 世界地图模式 + 桌面端交互优化 设计文档

## 概述

在现有公共白板基础上新增"世界地图模式"，用户登录后可选择进入"自由涂鸦"或"世界地图"房间。地图模式下，背景为可缩放的世界地图（仅显示行政边界和陆海边界），用户可在地图上进行涂鸦、添加文字、放置图片等操作，与自由涂鸦模式功能一致。

同时优化桌面端画布交互逻辑，参考主流绘图软件（Figma/Photoshop/Krita）的操作习惯，并新增拖拽图片到网页的功能。

## 1. 整体架构

### 用户流程

```
用户打开页面 → 登录/注册 → 模式选择卡片 → 进入对应房间
                                    ├─ 自由涂鸦 → free-board 房间（现有逻辑）
                                    └─ 世界地图 → map-board 房间（新增）
```

### 模式选择界面

登录成功后显示全屏遮罩层（`mode-select-overlay`），包含两张大卡片：

- **左侧"自由涂鸦"** — 手绘风格插图 + 标题 + 描述"自由发挥，无限画布"
- **右侧"世界地图"** — 地图缩略图 + 标题 + 描述"在地图上标注创作"

点击卡片后遮罩淡出，进入对应房间。进入房间后不支持中途切换模式，需刷新页面重新选择。

### 房间隔离

- 自由涂鸦房间 ID：`free-board`
- 地图模式房间 ID：`map-board`
- 两个房间的 Yjs 数据完全独立，服务器已有的多房间支持无需改动

### 代码结构

```
src/
├── main.js              # 入口，增加模式选择逻辑 + 拖拽图片
├── canvas-engine.js     # 渲染引擎，增加地图模式适配 + 右键平移
├── map-layer.js          # 新增：MapLibre 地图背景层
├── yjs-sync.js           # 连接时传入不同 roomId
├── cursor-layer.js       # 不变
├── export.js             # 导出时包含地图背景（地图模式）
├── config.js             # 不变
├── index.html            # 增加模式选择遮罩 HTML
└── styles.css            # 增加模式选择样式
public/
└── map-data/
    ├── world.pmtiles     # 预生成的矢量瓦片（构建时准备）
    └── style.json        # MapLibre 样式配置
```

## 2. 地图模式渲染架构

### 分层结构

```
┌─────────────────────────────┐
│  涂鸦 Canvas (透明)          │ ← 笔画/图片/文字，坐标与经纬度对齐
├─────────────────────────────┤
│  MapLibre Canvas (背景)      │ ← 瓦片地图，仅边界线
├─────────────────────────────┤
│  光标 Canvas (透明)          │ ← 远程用户光标
└─────────────────────────────┘
```

### MapLayer（map-layer.js）

封装 MapLibre GL JS 实例，职责：

- 初始化 MapLibre 地图，加载 `public/map-data/world.pmtiles` 矢量瓦片
- 配置极简白底样式：陆地白色、海洋留白、边界深色细线，无地名标注
- 缩放级别分层：低缩放显示国界（ADM0），中缩放加省界（ADM1），高缩放加县/镇界（ADM2/ADM3）
- 暴露 `onViewportChange` 回调，通知 CanvasEngine 同步视口
- 提供 `lngLatToScreen(lng, lat)` 和 `screenToLngLat(x, y)` 坐标转换方法

### CanvasEngine 适配

- 增加 `mapMode` 标志，为 true 时坐标转换委托给 MapLayer
- `screenToWorld` / `worldToScreen` 在地图模式下调用 MapLayer 的经纬度转换
- 平移/缩放操作转发给 MapLibre，MapLibre 触发 `move` 事件后同步更新 CanvasEngine 的变换矩阵
- 地图模式下 `offsetX/offsetY/scale` 由 MapLibre 视口驱动

### PMTiles 数据准备（构建时一次性）

- 数据源：geoBoundaries ADM0-ADM3 + Natural Earth 海岸线
- 工具：`tippecanoe` 将 GeoJSON 转为 PMTiles
- 产物：`public/map-data/world.pmtiles`（预计 10-30MB）+ `public/map-data/style.json`
- 运行时静态提供，无服务器计算开销

### 视觉风格

极简白底：陆地纯白/极浅米色，海洋浅灰或留白，边界线深色细线。缩放到高级别时逐渐显示省/县/镇边界线，不填充颜色、不标注地名。与现有白板的"纸张"美学一致。

## 3. 桌面端交互优化

参考主流绘图软件的操作习惯，改进 `canvas-engine.js` 的事件处理：

| 操作 | 当前方式 | 优化后 | 参考软件 |
|------|---------|--------|---------|
| 平移画布 | 中键 或 空格+左键拖拽 | 右键拖拽（主要）+ 中键（保留） | Figma/PS |
| 缩放 | 滚轮 | 滚轮（保留）+ Ctrl+滚轮精确缩放 | Figma |
| 右键菜单 | 浏览器默认 | 阻止默认菜单，右键仅用于平移 | 所有绘图软件 |
| 绘画 | 左键拖拽 | 左键拖拽（不变） | - |
| 橡皮擦 | 左键拖拽 | 左键拖拽（不变） | - |
| 选择/拖动 | 选择工具+左键 | 选择工具+左键（不变） | - |
| 撤销 | Ctrl+Z | Ctrl+Z（不变） | - |

具体改动：

- `_onPointerDown`：`e.button === 2`（右键）触发平移，`e.preventDefault()` 阻止右键菜单
- `contextmenu` 事件监听：`e.preventDefault()` 全局阻止浏览器右键菜单
- 滚轮缩放：增加 `e.ctrlKey` 检测，Ctrl+滚轮时缩放步幅更小（精确缩放）
- 空格改为临时切换到平移工具（按下空格+左键拖拽平移，松开空格恢复原工具），与之前行为一致但表述更清晰

## 4. 拖拽图片到网页

新增桌面端拖拽上传功能：

- 监听 `window` 的 `dragover` 和 `drop` 事件
- `dragover` 时显示半透明遮罩提示"松开以添加图片"
- `drop` 时读取图片文件，复用现有 `handleImageUpload` 逻辑
- 仅接受图片类型文件，大小限制 10MB（与现有一致）
- 拖拽放置位置作为图片放置位置（转换为世界坐标/经纬度）

## 5. 数据层适配

### Yjs 数据结构

Yjs 数据结构不做模式标记，房间 ID 已隔离数据。`map-board` 房间里的坐标天然是经纬度，`free-board` 房间里的坐标是世界坐标。

地图模式下笔画/图片/文字的坐标从 `[worldX, worldY]` 变为 `[lng, lat]`：

```javascript
// 自由涂鸦模式（现有）
stroke.set('points', [[worldX, worldY], ...]);

// 地图模式（新增）
stroke.set('points', [[lng, lat], ...]);
```

### yjs-sync.js 改动

仅 `constructor` 默认 `roomId` 改为通过参数传入：

```javascript
const roomId = mode === 'map' ? 'map-board' : 'free-board';
yjsSync.connect(userName, sessionToken, roomId);
```

其余逻辑完全复用。

## 6. 导出功能适配

地图模式下导出 PNG 时需包含地图背景：

- `export.js` 的 `exportAll()` 增加地图模式分支
- 先将 MapLibre canvas 内容绘制到导出 canvas，再叠加涂鸦层
- 地图模式下使用 `map.getCanvas()` 获取底层渲染结果

## 7. 错误处理

- MapLibre 加载失败时回退到无地图背景的纯白画布，涂鸦功能不受影响
- PMTiles 文件缺失时显示友好提示，不阻塞应用
- 拖拽非图片文件时忽略并提示"请拖入图片文件"
