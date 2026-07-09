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

// ===== 布局版本管理 =====

function initLayout() {
  const urlParams = new URLSearchParams(window.location.search);
  let mode = urlParams.get('layout');

  if (!mode) {
    mode = localStorage.getItem('wb_layout') || 'auto';
  }

  if (mode === 'legacy') {
    document.body.classList.add('layout-legacy');
  } else if (mode === 'v2') {
    document.body.classList.add('layout-mobile-v2');
  } else {
    // auto: 移动端使用 v2
    if (window.innerWidth < 768) {
      document.body.classList.add('layout-mobile-v2');
    }
  }

  const toggleBtn = document.getElementById('layout-toggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      const isV2 = document.body.classList.contains('layout-mobile-v2');
      if (isV2) {
        document.body.classList.remove('layout-mobile-v2');
        document.body.classList.add('layout-legacy');
        localStorage.setItem('wb_layout', 'legacy');
      } else {
        document.body.classList.remove('layout-legacy');
        document.body.classList.add('layout-mobile-v2');
        localStorage.setItem('wb_layout', 'v2');
      }
      setTimeout(() => {
        if (engine) engine.render();
        if (cursorLayer) cursorLayer.checkMobile();
      }, 100);
    });
  }
}

// ===== 账号认证入口 =====

const API_BASE = window.API_URL || '';
let authMode = 'login';

function initAuthEntry() {
  const overlay = document.getElementById('nickname-overlay');
  const usernameInput = document.getElementById('username-input');
  const passwordInput = document.getElementById('password-input');
  const submitBtn = document.getElementById('auth-submit');
  const errorDiv = document.getElementById('auth-error');
  const subtitle = document.getElementById('auth-subtitle');

  // 先尝试自动登录
  const savedToken = localStorage.getItem('wb_token');
  if (savedToken) {
    autoLogin(savedToken, overlay);
  }

  // 模式切换
  document.querySelectorAll('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      authMode = tab.dataset.mode;
      document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      submitBtn.textContent = authMode === 'login' ? '登录' : '注册';
      subtitle.textContent = authMode === 'login'
        ? '登录账号，开始一起涂鸦'
        : '注册新账号，开始一起涂鸦';
      errorDiv.classList.add('hidden');
    });
  });

  function showError(msg) {
    errorDiv.textContent = msg;
    errorDiv.classList.remove('hidden');
  }

  const handleSubmit = async () => {
    const username = usernameInput.value.trim();
    const password = passwordInput.value;

    if (!username || !password) {
      showError('请输入账号名和密码');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = '处理中...';

    try {
      const endpoint = authMode === 'login' ? '/api/login' : '/api/register';
      const resp = await fetch(API_BASE + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await resp.json();

      if (!resp.ok) {
        showError(data.error || '操作失败');
        submitBtn.disabled = false;
        submitBtn.textContent = authMode === 'login' ? '登录' : '注册';
        return;
      }

      localStorage.setItem('wb_token', data.token);
      localStorage.setItem('wb_username', data.username);

      overlay.style.opacity = '0';
      setTimeout(() => {
        overlay.classList.add('hidden');
        startApp(data.username);
      }, 400);
    } catch (err) {
      showError('网络错误，请检查连接');
      submitBtn.disabled = false;
      submitBtn.textContent = authMode === 'login' ? '登录' : '注册';
    }
  };

  submitBtn.addEventListener('click', handleSubmit);
  [usernameInput, passwordInput].forEach(input => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleSubmit();
    });
    input.addEventListener('input', () => errorDiv.classList.add('hidden'));
  });

  if (!savedToken) {
    setTimeout(() => usernameInput.focus(), 300);
  }
}

async function autoLogin(token, overlay) {
  try {
    const resp = await fetch(API_BASE + '/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (resp.ok) {
      const data = await resp.json();
      overlay.style.opacity = '0';
      setTimeout(() => {
        overlay.classList.add('hidden');
        startApp(data.username);
      }, 400);
    } else {
      localStorage.removeItem('wb_token');
      localStorage.removeItem('wb_username');
      const usernameInput = document.getElementById('username-input');
      if (usernameInput) setTimeout(() => usernameInput.focus(), 300);
    }
  } catch (e) {
    const usernameInput = document.getElementById('username-input');
    if (usernameInput) setTimeout(() => usernameInput.focus(), 300);
  }
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
    // 1. 先检测笔画（上层优先删除）
    const strokes = yjsSync.getAllStrokes();
    for (let i = strokes.length - 1; i >= 0; i--) {
      const s = strokes[i];
      if (pointToStrokeDistance(worldX, worldY, s) < s.width * 1.5 + 8) {
        yjsSync.removeStroke(s.index);
        return true;
      }
    }
    // 2. 未命中笔画，检测图片（下层）
    const images = yjsSync.getAllImages();
    for (let i = images.length - 1; i >= 0; i--) {
      const img = images[i];
      if (worldX >= img.x && worldX <= img.x + img.w &&
          worldY >= img.y && worldY <= img.y + img.h) {
        yjsSync.removeImageById(img.id);
        return true;
      }
    }
    return false;
  };

  // 图片放置
  engine.onImagePlace = (worldX, worldY) => {
    if (!pendingImageFile) return;
    const { dataUrl, naturalWidth, naturalHeight } = pendingImageFile;

    const maxDim = 400;
    let w = naturalWidth;
    let h = naturalHeight;
    if (w > maxDim || h > maxDim) {
      const ratio = Math.min(maxDim / w, maxDim / h);
      w = Math.round(w * ratio);
      h = Math.round(h * ratio);
    }

    yjsSync.addImage(worldX - w / 2, worldY - h / 2, w, h, dataUrl);

    pendingImageFile = null;
    engine.clearPendingImage();
    document.getElementById('image-placement').classList.add('hidden');
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

  setTimeout(() => {
    const users = yjsSync.getOnlineUsers();
    updateUserList(users);
    cursorLayer.update(yjsSync.getRemoteCursors());
  }, 500);

  setTimeout(() => {
    document.getElementById('minimap').classList.remove('hidden');
    updateMinimap();
  }, 500);

  setupToolbar();
  setupKeyboard();
  setupResponsive();
  setupUserListToggle();
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

// ===== 用户列表展开/收起 =====

function setupUserListToggle() {
  const userList = document.getElementById('user-list');
  const onlineCount = document.getElementById('online-count');
  const dropdown = document.getElementById('user-dropdown');

  const toggle = (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('hidden');
  };

  userList.addEventListener('click', toggle);
  onlineCount.addEventListener('click', toggle);

  document.addEventListener('click', (e) => {
    if (!dropdown.classList.contains('hidden') &&
        !userList.contains(e.target) &&
        !onlineCount.contains(e.target) &&
        !dropdown.contains(e.target)) {
      dropdown.classList.add('hidden');
    }
  });
}

// ===== 工具栏设置 =====

function setupToolbar() {
  const toolbar = document.getElementById('toolbar');

  // 工具切换
  document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tool = btn.dataset.tool;
      if (tool === 'image') {
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
    imageInput.value = '';
  });

  // 移动端工具栏折叠
  const moreBtn = document.getElementById('more-btn');
  if (moreBtn) {
    moreBtn.addEventListener('click', () => {
      toolbar.classList.toggle('options-collapsed');
    });
  }

  // 移动端默认折叠选项
  if (window.innerWidth < 768) {
    toolbar.classList.add('options-collapsed');
  }
}

// 设置当前工具
function setTool(tool) {
  currentTool = tool;
  engine.setTool(tool);

  document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });

  const toolbar = document.getElementById('toolbar');
  toolbar.className = 'toolbar tool-' + tool;

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
    if (e.code === 'Space' && !spacePressed) {
      spacePressed = true;
      engine.setSpacePressed(true);
      e.preventDefault();
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      e.preventDefault();
      yjsSync.undoLastStroke();
    }

    if (e.key === 'b' || e.key === 'B') {
      setTool('pen');
    }

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
  const dropdownList = document.getElementById('user-dropdown-list');

  // 过滤掉没有 name 的无效用户
  const validUsers = users.filter(u => u && u.name);

  onlineCount.textContent = `${validUsers.length} 人在线`;

  // 头像列表
  userList.innerHTML = '';
  const displayUsers = validUsers.slice(0, 8);
  for (const user of displayUsers) {
    const avatar = document.createElement('div');
    avatar.className = 'user-avatar';
    avatar.style.background = user.color || '#92400e';
    avatar.textContent = (user.name || '?').charAt(0).toUpperCase();
    avatar.title = user.name || '未知用户';
    userList.appendChild(avatar);
  }

  if (validUsers.length > 8) {
    const more = document.createElement('div');
    more.className = 'user-avatar';
    more.style.background = '#92400e';
    more.textContent = `+${validUsers.length - 8}`;
    userList.appendChild(more);
  }

  // 下拉面板完整列表
  if (dropdownList) {
    dropdownList.innerHTML = '';
    for (const user of validUsers) {
      const item = document.createElement('div');
      item.className = 'user-dropdown-item';

      const avatar = document.createElement('div');
      avatar.className = 'user-avatar';
      avatar.style.background = user.color || '#92400e';
      avatar.textContent = (user.name || '?').charAt(0).toUpperCase();

      const name = document.createElement('span');
      name.className = 'user-dropdown-name';
      name.textContent = user.name || '未知用户';

      item.appendChild(avatar);
      item.appendChild(name);
      dropdownList.appendChild(item);
    }
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

initLayout();
initAuthEntry();
