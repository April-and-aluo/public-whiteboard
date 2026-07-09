# 公共展示板 - 部署指南

## 架构概览

```
前端（GitHub Pages，免费）  ←→  WebSocket 服务器（Render/Fly.io，免费）
```

- 前端：纯静态文件，托管在 GitHub Pages
- 后端：y-websocket 服务器，负责实时数据中继

---

## 第一步：部署前端到 GitHub Pages

### 1.1 创建 GitHub 仓库

1. 登录 GitHub，点击 **New repository**
2. 仓库名随意（如 `public-whiteboard`）
3. 选择 **Public**
4. 点击 **Create repository**

### 1.2 推送代码

```bash
# 在项目目录下
git init
git add .
git commit -m "公共展示板初始版本"
git branch -M main
git remote add origin https://github.com/你的用户名/public-whiteboard.git
git push -u origin main
```

### 1.3 启用 GitHub Pages

1. 进入仓库 **Settings** → **Pages**
2. **Source** 选择 **GitHub Actions**
3. 推送代码后会自动触发部署（Actions 标签页可查看进度）
4. 部署完成后，访问 `https://你的用户名.github.io/public-whiteboard/`

> 此时前端已上线，但实时同步使用的是 y-webrtc 公共信令服务器（P2P 模式）。
> 要获得更稳定的体验，请继续部署后端服务器。

---

## 第二步：部署后端 WebSocket 服务器

### 方案 A：Render（推荐，最简单，免费）

Render 免费层每月 750 小时，15分钟无活动会休眠。
配合 UptimeRobot 可防止休眠。

1. **注册 Render**：https://render.com（可用 GitHub 登录）

2. **创建 Web Service**：
   - 点击 **New** → **Web Service**
   - 连接你的 GitHub 仓库
   - 配置：
     ```
     Name:        whiteboard-server
     Runtime:     Node
     Build Command:  npm install && cd server && npm install
     Start Command:  node server/server.js
     Plan:        Free
     ```
   - 环境变量：
     ```
     PORT=8080
     NODE_ENV=production
     ```
   - 点击 **Create Web Service**

3. **等待部署完成**，获取地址：`https://whiteboard-server.onrender.com`

4. **配置 UptimeRobot 防止休眠**：
   - 注册 https://uptimerobot.com（免费）
   - 添加监控：
     - 监控类型：HTTP(s)
     - URL：`https://whiteboard-server.onrender.com/health`
     - 监控间隔：5分钟
   - 这样服务器不会因 15 分钟无活动而休眠

### 方案 B：Fly.io（更稳定，不休眠，需信用卡验证）

Fly.io 免费层包含 3 个 VM（256MB RAM），不休眠。

1. **注册 Fly.io**：https://fly.io
2. **安装 flyctl**：
   ```bash
   # macOS
   brew install flyctl
   # Linux
   curl -L https://fly.io/install.sh | sh
   ```
3. **部署**：
   ```bash
   fly launch        # 使用已有的 fly.toml 配置
   fly deploy
   ```
4. 获取地址：`wss://whiteboard-server.fly.dev`

---

## 第三步：连接前端和后端

1. 打开 `src/config.js`
2. 填入你的 WebSocket 服务器地址：
   ```javascript
   // Render
   window.WS_URL = 'wss://whiteboard-server.onrender.com';

   // 或 Fly.io
   window.WS_URL = 'wss://whiteboard-server.fly.dev';
   ```
3. 提交并推送：
   ```bash
   git add src/config.js
   git commit -m "配置 WebSocket 服务器地址"
   git push
   ```
4. GitHub Actions 会自动重新部署前端

---

## 验证

1. 打开前端地址 `https://你的用户名.github.io/public-whiteboard/`
2. 输入昵称进入画板
3. 顶部应显示"1 人在线"
4. 在另一个浏览器/设备打开同一地址，输入不同昵称
5. 两人应能实时看到对方的绘画和光标

---

## 本地开发

```bash
# 启动前端
python3 -m http.server 3000 --directory src

# 启动后端（另一个终端）
cd server && npm install && npm start
```

本地开发时，`src/config.js` 留空即可使用 y-webrtc P2P 模式，
或设置为 `ws://localhost:8080` 连接本地服务器。

---

## 项目文件说明

```
├── src/                    # 前端（部署到 GitHub Pages）
│   ├── index.html
│   ├── config.js           # ← 修改此处配置后端地址
│   ├── styles.css
│   ├── main.js
│   ├── canvas-engine.js
│   ├── yjs-sync.js
│   ├── cursor-layer.js
│   ├── export.js
│   └── yjs-bundle.js       # 自动生成的打包文件
├── server/                 # 后端（部署到 Render/Fly.io）
│   ├── server.js
│   └── package.json
├── .github/workflows/
│   └── deploy-pages.yml    # GitHub Pages 自动部署
├── Dockerfile              # Docker 部署（Fly.io）
├── render.yaml             # Render 部署配置
├── fly.toml                # Fly.io 部署配置
└── package.json            # 依赖和构建脚本
```

---

## 常见问题

**Q: 实时同步不工作？**
A: 检查 `src/config.js` 中的 WS_URL 是否正确，服务器是否在线。
访问 `https://你的服务器地址/health` 检查服务器状态。

**Q: GitHub Pages 部署失败？**
A: 在仓库 Actions 标签页查看构建日志。确保 `package.json` 和 `build.mjs` 都在仓库中。

**Q: Render 服务器休眠？**
A: 配置 UptimeRobot 每 5 分钟 ping `/health` 端点。

**Q: 想要数据持久化？**
A: 当前服务器是内存模式，重启后数据会丢失。
可后续添加 Yjs 文档定期保存到存储（如 Redis、文件系统）。
```
