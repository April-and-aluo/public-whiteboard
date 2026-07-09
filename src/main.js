// ============================================
// main.js - 应用入口，协调各模块初始化
// ============================================

import { CanvasEngine } from './canvas-engine.js';
import { CursorLayer } from './cursor-layer.js';
import { ExportManager } from './export.js';
import { yjsSync } from './yjs-sync.js';

// ===== 全局状态 =====
let engine = null;
let cursorLayer = null;
let exportManager = null;
let currentTool = 'pen';
let currentColor = '#1e3a5f';
let currentWidth = 4;
let pendingImageFile = null;
let minimapTimer = null;

// ===== 昵称入口 =====

function initNicknameEntry() {
  const overlay = document.getElementById('nickname-overlay');
  const input = document.getElementById('nickname-input');
  const submitBtn = document.getElementById('nickname-submit');

  // 自动聚焦
  setTimeout(() => input.focus(), 300);

  const handleSubmit = () => {
    const name = input.value.trim();
    if (!name) {
      input.classList.add('error');
      input.placeholder = '请输入昵称...';
      input.focus();
      return;
    }
    overlay.style.opacity = '0';
    setTimeout(() => {
      overlay.classList.add('hidden');
      startApp(name);
    }, 400);
  };

  submitBtn.addEventListener('click', handleSubmit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSubmit();
  });
  input.addEventListener('input', () => {
    input.classList.remove('error');
  });
}

// ===== 启动应用 =====

function startApp(userName) {
  const app = document.getElementById('app');
  app.classList.remove('hidden');

  // 初始化各模块
  const mainCanvas = document.getElementById('main-canvas');
  const cursorCanvas = document.getElementById('cursor-canvas');

  engine = new CanvasEngine(mainCanvas, cursorCanvas);
  cursorLayer = new CursorLayer(cursorCanvas, engine);
  exportManager = new ExportManager(engine, yjsSync);

  // 设置初始工具状态
  engine.setTool(currentTool);
  engine.setColor(currentColor);
  engine.setWidth(currentWidth);

  // 设置渲染数据源
  engine.setRenderSources(
    () => yjsSync.getAllImages(),
    () => yjsSync.getAllStrokes()
  );

  // 连接 Yjs 同步
  yjsSync.connect(userName);

  // ===== 设置回调 =====

  // 笔画完成 -> 同步到 Yjs
  engine.onStrokeEnd = (stroke) => {
    yjsSync.addStroke(stroke.points, stroke.color, stroke.width);
  };

  // 橡皮擦 -> 命中检测并删除
  engine.onErase = (worldX, worldY) => {
    const strokes = yjsSync.getAllStrokes();
    // 从后往前检测（上层优先删除）
    for (let i = strokes.length - 1; i >= 0; i--) {
      const s = strokes[i];
      if (pointToStrokeDistance(worldX, worldY, s) < s.width * 1.5 + 8) {
        yjsSync.removeStroke(s.index);
        return true;
      }
    }
    return false;
  };

  // 图片放置
  engine.onImagePlace = (worldX, worldY) => {
    if (!pendingImageFile) return;
    const { dataUrl, naturalWidth, naturalHeight } = pendingImageFile;

    // 计算缩放后的尺寸（适应画布）
    const maxDim = 400;
    let w = naturalWidth;
    let h = naturalHeight;
    if (w > maxDim || h > maxDim) {
      const ratio = Math.min(maxDim / w, maxDim / h);
      w = Math.round(w * ratio);
      h = Math.round(h * ratio);
    }

    // 以点击位置为中心放置
    yjsSync.addImage(worldX - w / 2, worldY - h / 2, w, h, dataUrl);

    // 清理
    pendingImageFile = null;
    engine.clearPendingImage();
    document.getElementById('image-placement').classList.add('hidden');

    // 切回画笔工具
    setTool('pen');
  };

  // 光标移动 -> 广播
  engine.onCursorMove = (x, y) => {
    if (x === null) {
      yjsSync.clearCursor();
    } else {
      yjsSync.updateCursor(x, y);
    }
  };

  // 视口变化 -> 更新迷你地图
  engine.onViewportChange = () => {
    updateMinimap();
  };

  // 数据变化 -> 重新渲染
  yjsSync.onDataChange = () => {
    engine.requestRender();
    updateMinimap();
  };

  // awareness 变化 -> 更新光标和用户列表
  yjsSync.onAwarenessChange = (users) => {
    updateUserList(users);
    cursorLayer.update(yjsSync.getRemoteCursors());
  };

  // 连接状态变化
  yjsSync.onConnectionChange = (state) => {
    const banner = document.getElementById('connection-banner');
    if (state === 'connected' || state === 'local') {
      banner.classList.add('hidden');
    } else {
      banner.classList.remove('hidden');
    }
  };

  // 初始渲染
  engine.render();

  // 手动触发初始用户列表更新
  setTimeout(() => {
    const users = yjsSync.getOnlineUsers();
    updateUserList(users);
    cursorLayer.update(yjsSync.getRemoteCursors());
  }, 500);

  // 显示迷你地图
  setTimeout(() => {
    document.getElementById('minimap').classList.remove('hidden');
    updateMinimap();
  }, 500);

  // 设置工具栏
  setupToolbar();

  // 键盘快捷键
  setupKeyboard();

  // 响应式
  setupResponsive();
}

// ===== 点到笔画距离计算 =====

function pointToStrokeDistance(px, py, stroke) {
  const points = stroke.points;
  if (points.length === 0) return Infinity;
  if (points.length === 1) {
    const dx = px - points[0][0];
    const dy = py - points[0][1];
    return Math.sqrt(dx * dx + dy * dy);
  }

  let minDist = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const dist = pointToSegmentDistance(px, py, points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]);
    minDist = Math.min(minDist, dist);
  }
  return minDist;
}

function pointToSegmentDistance(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ddx = px - x1;
    const ddy = py - y1;
    return Math.sqrt(ddx * ddx + ddy * ddy);
  }
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  const ddx = px - cx;
  const ddy = py - cy;
  return Math.sqrt(ddx * ddx + ddy * ddy);
}

// ===== 工具栏设置 =====

function setupToolbar() {
  const toolbar = document.getElementById('toolbar');
  const canvasArea = document.querySelector('.canvas-area');

  // 工具切换
  document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tool = btn.dataset.tool;
      if (tool === 'image') {
        // 图片工具 -> 触发文件选择
        document.getElementById('image-input').click();
      } else {
        setTool(tool);
      }
    });
  });

  // 颜色选择器
  const colorPicker = document.getElementById('color-picker');
  const colorDisplay = document.getElementById('color-display');
  colorDisplay.style.background = currentColor;

  colorPicker.addEventListener('input', (e) => {
    currentColor = e.target.value;
    colorDisplay.style.background = currentColor;
    engine.setColor(currentColor);
  });

  // 画笔粗细
  document.querySelectorAll('.brush-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.brush-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentWidth = parseInt(btn.dataset.size);
      engine.setWidth(currentWidth);
    });
  });

  // 撤销
  document.getElementById('undo-btn').addEventListener('click', () => {
    yjsSync.undoLastStroke();
  });

  // 导出
  document.getElementById('export-btn').addEventListener('click', () => {
    exportManager.exportAll();
  });

  // 图片上传
  const imageInput = document.getElementById('image-input');
  imageInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    handleImageUpload(file);
    imageInput.value = ''; // 重置以便重复选择
  });
}

// 设置当前工具
function setTool(tool) {
  currentTool = tool;
  engine.setTool(tool);

  // 更新工具栏 UI
  document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });

  // 更新工具栏 class（控制 pen-options 显隐）
  const toolbar = document.getElementById('toolbar');
  toolbar.className = 'toolbar tool-' + tool;

  // 更新画布区域 class（控制光标样式）
  const canvasArea = document.querySelector('.canvas-area');
  canvasArea.className = 'canvas-area tool-' + tool;
}

// ===== 图片上传处理 =====

function handleImageUpload(file) {
  if (!file.type.startsWith('image/')) {
    alert('请选择图片文件');
    return;
  }

  if (file.size > 10 * 1024 * 1024) {
    alert('图片不能超过 10MB');
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      // 压缩大图
      const maxDim = 1080;
      let w = img.naturalWidth;
      let h = img.naturalHeight;
      let canvas = null;

      if (w > maxDim || h > maxDim) {
        const ratio = Math.min(maxDim / w, maxDim / h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
        canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
      }

      const dataUrl = canvas ? canvas.toDataURL('image/jpeg', 0.8) : e.target.result;

      // 检查最终大小
      if (dataUrl.length > 5 * 1024 * 1024) {
        alert('图片过大，请选择较小的图片');
        return;
      }

      pendingImageFile = {
        dataUrl,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
      };

      engine.setPendingImage(dataUrl, img.naturalWidth, img.naturalHeight);
      setTool('image');
      document.getElementById('image-placement').classList.remove('hidden');
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

// ===== 键盘快捷键 =====

function setupKeyboard() {
  let spacePressed = false;

  window.addEventListener('keydown', (e) => {
    // 空格 -> 平移模式
    if (e.code === 'Space' && !spacePressed) {
      spacePressed = true;
      engine.setSpacePressed(true);
      e.preventDefault();
    }

    // Ctrl/Cmd + Z -> 撤销
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      e.preventDefault();
      yjsSync.undoLastStroke();
    }

    // B -> 画笔
    if (e.key === 'b' || e.key === 'B') {
      setTool('pen');
    }

    // E -> 橡皮
    if (e.key === 'e' || e.key === 'E') {
      setTool('eraser');
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      spacePressed = false;
      engine.setSpacePressed(false);
    }
  });
}

// ===== 用户列表更新 =====

function updateUserList(users) {
  const userList = document.getElementById('user-list');
  const onlineCount = document.getElementById('online-count');

  // 更新在线人数
  onlineCount.textContent = `${users.length} 人在线`;

  // 更新头像列表（最多显示 8 个）
  userList.innerHTML = '';
  const displayUsers = users.slice(0, 8);
  for (const user of displayUsers) {
    const avatar = document.createElement('div');
    avatar.className = 'user-avatar';
    avatar.style.background = user.color;
    avatar.textContent = user.name.charAt(0).toUpperCase();
    avatar.title = user.name;
    userList.appendChild(avatar);
  }

  // 如果超过 8 人，显示 +N
  if (users.length > 8) {
    const more = document.createElement('div');
    more.className = 'user-avatar';
    more.style.background = '#92400e';
    more.textContent = `+${users.length - 8}`;
    userList.appendChild(more);
  }
}

// ===== 迷你地图更新 =====

function updateMinimap() {
  if (minimapTimer) clearTimeout(minimapTimer);
  minimapTimer = setTimeout(() => {
    const minimapCanvas = document.getElementById('minimap-canvas');
    if (!minimapCanvas) return;
    const strokes = yjsSync.getAllStrokes();
    const images = yjsSync.getAllImages();
    engine.renderMinimap(minimapCanvas, strokes, images);
  }, 200);
}

// ===== 响应式 =====

function setupResponsive() {
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      cursorLayer.checkMobile();
      engine.render();
      updateMinimap();
    }, 200);
  });
}

// ===== 启动 =====

initNicknameEntry();
