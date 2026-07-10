// ============================================
// main.js - 应用入口，协调各模块初始化
// ============================================

import { CanvasEngine } from './canvas-engine.js?v=20260710f';
import { CursorLayer } from './cursor-layer.js?v=20260710f';
import { ExportManager } from './export.js?v=20260710f';
import { yjsSync } from './yjs-sync.js?v=20260710f';

// MapLayer 按需加载（仅地图模式）

// ===== 全局状态 =====
let engine = null;
let cursorLayer = null;
let exportManager = null;
let mapLayer = null;
let currentMode = 'free'; // 'free' | 'map'
let currentTool = 'pen';
let currentColor = '#1e3a5f';
let currentWidth = 4;
let pendingImageFile = null;
let pendingImageProps = { scale: 1, rotation: 0, opacity: 1 };
let selectedImageId = null;
let selectedTextId = null;
let selectedType = null; // 'image' | 'text'
let pendingTextPos = null; // { worldX, worldY, screenX, screenY }
let editingTextId = null; // 正在编辑的文字 ID（null 表示新建）
let minimapTimer = null;
let savedViewport = null; // 跳转前保存的视口位置
let dragStartPos = null; // 拖拽起始位置缓存
let sessionToken = null; // 内存中的 token（不持久化，供 WebSocket 认证用）

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

// Cookie 工具函数
function setCookie(name, value, days) {
  const d = new Date();
  d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000);
  document.cookie = `${name}=${encodeURIComponent(value)};expires=${d.toUTCString()};path=/;SameSite=Lax`;
}

function getCookie(name) {
  const cname = name + '=';
  const decoded = decodeURIComponent(document.cookie);
  const ca = decoded.split(';');
  for (let c of ca) {
    c = c.trim();
    if (c.indexOf(cname) === 0) return c.substring(cname.length);
  }
  return '';
}

function deleteCookie(name) {
  document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
}

function initAuthEntry() {
  const overlay = document.getElementById('nickname-overlay');
  const usernameInput = document.getElementById('username-input');
  const passwordInput = document.getElementById('password-input');
  const submitBtn = document.getElementById('auth-submit');
  const errorDiv = document.getElementById('auth-error');
  const subtitle = document.getElementById('auth-subtitle');
  const togglePasswordBtn = document.getElementById('toggle-password');

  // 密码显示/隐藏切换
  if (togglePasswordBtn) {
    togglePasswordBtn.addEventListener('click', () => {
      const isPassword = passwordInput.type === 'password';
      passwordInput.type = isPassword ? 'text' : 'password';
      togglePasswordBtn.querySelector('.eye-open').classList.toggle('hidden', isPassword);
      togglePasswordBtn.querySelector('.eye-closed').classList.toggle('hidden', !isPassword);
    });
  }

  // 先尝试自动登录（HttpOnly Cookie 自动随请求发送）
  // 同时兼容旧版 localStorage 中存储的 token
  const savedToken = localStorage.getItem('wb_token');
  if (savedToken) {
    // 兼容旧版：将 localStorage token 传入 body
    autoLogin(savedToken, overlay);
  } else {
    // 尝试 Cookie 认证（无需传 token，浏览器自动携带 HttpOnly Cookie）
    autoLogin(null, overlay);
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

      // 检查是否为非 JSON 响应（如 GitHub Pages 返回 HTML 404 页面）
      const contentType = resp.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        showError('当前部署环境不支持账号服务，请使用 HTTP 部署地址访问');
        submitBtn.disabled = false;
        submitBtn.textContent = authMode === 'login' ? '登录' : '注册';
        return;
      }

      const data = await resp.json();

      if (!resp.ok) {
        showError(data.error || '操作失败');
        submitBtn.disabled = false;
        submitBtn.textContent = authMode === 'login' ? '登录' : '注册';
        return;
      }

      // 注册或登录成功：token 由服务器通过 HttpOnly Cookie 自动设置
      // 同时将 token 保存在内存中供 WebSocket 认证使用（不持久化到 localStorage）
      if (data.token) {
        sessionToken = data.token;
      }
      if (data.username) {
        setCookie('wb_username', data.username, 7);
      }

      overlay.style.opacity = '0';
      setTimeout(() => {
        overlay.classList.add('hidden');
        showModeSelect(data.username);
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
    // 如果有 token 参数（旧版兼容），放入 body；否则依赖 HttpOnly Cookie 自动认证
    const body = token ? JSON.stringify({ token }) : '{}';
    const resp = await fetch(API_BASE + '/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    // 检查是否为 JSON 响应（非 JSON 说明 API 不可用，如 GitHub Pages）
    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      // API 不可用，直接进入模式选择（以访客身份）
      overlay.style.opacity = '0';
      setTimeout(() => {
        overlay.classList.add('hidden');
        showModeSelect('访客');
      }, 400);
      return;
    }
    if (resp.ok) {
      const data = await resp.json();
      // 保存 token 到内存供 WebSocket 认证
      if (data.token) sessionToken = data.token;
      // 清理旧版 localStorage 中的 token（已迁移到 HttpOnly Cookie）
      localStorage.removeItem('wb_token');
      overlay.style.opacity = '0';
      setTimeout(() => {
        overlay.classList.add('hidden');
        showModeSelect(data.username);
      }, 400);
    } else {
      deleteCookie('wb_username');
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

// ===== 公告功能 =====

async function checkAnnouncement() {
  try {
    const resp = await fetch('https://cdn.jsdelivr.net/gh/april-and-aluo/public-whiteboard@main/announcement.json?t=' + Date.now());
    if (!resp.ok) return;
    const data = await resp.json();

    // 检查是否已经看过这个版本的公告
    const seenVersion = getCookie('wb_announcement') || localStorage.getItem('wb_announcement');
    if (seenVersion === data.version) return;

    // 显示公告
    const overlay = document.getElementById('announcement-overlay');
    const body = document.getElementById('announcement-body');
    if (!overlay || !body) return;

    body.textContent = data.content || '';
    overlay.classList.remove('hidden');

    // 关闭按钮
    const closeBtn = document.getElementById('announcement-close');
    const close = () => {
      overlay.classList.add('hidden');
      setCookie('wb_announcement', data.version, 365);
      localStorage.setItem('wb_announcement', data.version);
    };
    closeBtn.onclick = close;
  } catch (e) {
    // 公告加载失败不影响正常使用
  }
}

// ===== 模式选择 =====

let selectedUserName = null;

function showModeSelect(userName) {
  selectedUserName = userName;
  const overlay = document.getElementById('mode-select-overlay');
  if (!overlay) {
    // 如果没有模式选择 UI，直接进入自由涂鸦
    startApp(userName, 'free');
    return;
  }
  overlay.classList.remove('hidden');

  const freeCard = document.getElementById('mode-free');
  const mapCard = document.getElementById('mode-map');

  const selectMode = (mode) => {
    overlay.style.opacity = '0';
    setTimeout(() => {
      overlay.classList.add('hidden');
      overlay.style.opacity = '';
      startApp(selectedUserName, mode);
    }, 300);
  };

  freeCard.onclick = () => selectMode('free');
  mapCard.onclick = () => selectMode('map');
}

// ===== 地图模式初始化 =====

async function initMapLayer() {
  try {
    const { MapLayer } = await import('./map-layer.js?v=20260710f');
    const app = document.getElementById('app');
    mapLayer = new MapLayer(app, engine);
    await mapLayer.init();
    engine.mapMode = true;
    engine.mapLayer = mapLayer;
  } catch (err) {
    console.warn('[地图模式] 初始化失败，以无地图背景继续:', err);
  }
}

// ===== 启动应用 =====

function startApp(userName, mode = 'free') {
  currentMode = mode;
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
    () => yjsSync.getAllStrokes(),
    () => yjsSync.getAllTexts()
  );

  // 根据模式选择房间 ID
  const roomId = mode === 'map' ? 'map-board' : 'free-board';

  // 连接 Yjs 同步（传递 token 用于 WebSocket 认证，传入 roomId 区分房间）
  yjsSync.connect(userName, sessionToken || '', roomId);

  // 地图模式：初始化 MapLibre 地图背景层
  if (mode === 'map') {
    initMapLayer();
  }

  // ===== 设置回调 =====

  // 笔画完成 -> 同步到 Yjs
  engine.onStrokeEnd = (stroke) => {
    yjsSync.addStroke(stroke.points, stroke.color, stroke.width);
  };

  // 橡皮擦 -> 只擦除笔画，不擦除图片和文字（避免绘画时误删）
  engine.onErase = (worldX, worldY) => {
    const strokes = yjsSync.getAllStrokes();
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

    const maxDim = 400;
    let w = naturalWidth;
    let h = naturalHeight;
    if (w > maxDim || h > maxDim) {
      const ratio = Math.min(maxDim / w, maxDim / h);
      w = Math.round(w * ratio);
      h = Math.round(h * ratio);
    }

    yjsSync.addImage(
      worldX - w / 2, worldY - h / 2, w, h, dataUrl,
      pendingImageProps.rotation,
      pendingImageProps.opacity,
      pendingImageProps.scale
    );

    pendingImageFile = null;
    engine.clearPendingImage();
    document.getElementById('image-placement').classList.add('hidden');
    hideImagePropsPanel();
    setTool('pen');
  };

  // 文字放置：点击画布后立即创建文字元素并显示实时输入框
  engine.onTextPlace = (worldX, worldY) => {
    const screen = engine.worldToScreen(worldX, worldY);
    // 立即在 Yjs 中创建空文字元素，用户输入实时更新到画布
    const textId = yjsSync.addText(
      worldX, worldY, '', 24, '#422006', 0, 1, 1
    );
    pendingTextPos = { worldX, worldY, screenX: screen.x, screenY: screen.y };
    editingTextId = textId;
    showTextEditor(screen.x, screen.y, '');
  };

  // 选择模式：点击选中图片或文字
  engine.onSelectClick = (worldX, worldY) => {
    // 优先检测文字（在上层）
    const texts = yjsSync.getAllTexts();
    for (let i = texts.length - 1; i >= 0; i--) {
      const t = texts[i];
      if (hitTestText(worldX, worldY, t)) {
        selectedTextId = t.id;
        selectedImageId = null;
        selectedType = 'text';
        engine.selectedImage = null;
        engine.selectedText = t;
        engine.isEditMode = false;
        engine.requestRender();
        // 不自动打开属性面板，等待编辑按钮点击
        return;
      }
    }
    // 然后检测图片
    const images = yjsSync.getAllImages();
    for (let i = images.length - 1; i >= 0; i--) {
      const img = images[i];
      if (hitTestImage(worldX, worldY, img)) {
        selectedImageId = img.id;
        selectedTextId = null;
        selectedType = 'image';
        engine.selectedText = null;
        engine.selectedImage = img;
        engine.isEditMode = false;
        engine.requestRender();
        return;
      }
    }
    // 未命中
    deselectAll();
  };

  // 编辑按钮点击 -> 打开属性面板
  engine.onEditButtonClick = () => {
    engine.isEditMode = true;
    engine.requestRender();
    if (selectedType === 'image' && selectedImageId) {
      const imgs = yjsSync.getAllImages();
      const img = imgs.find(i => i.id === selectedImageId);
      if (img) showImagePropsPanel(img, null);
    } else if (selectedType === 'text' && selectedTextId) {
      const texts = yjsSync.getAllTexts();
      const t = texts.find(t => t.id === selectedTextId);
      if (t) showImagePropsPanel(null, t);
    }
  };

  // 删除按钮点击 -> 删除选中元素
  engine.onDeleteButtonClick = () => {
    if (selectedType === 'image' && selectedImageId) {
      yjsSync.removeImageById(selectedImageId);
      deselectAll();
    } else if (selectedType === 'text' && selectedTextId) {
      yjsSync.removeTextById(selectedTextId);
      deselectAll();
    }
  };

  // 拖拽移动 - 立即更新本地并同步渲染，保证拖拽连续
  engine.onDragMove = (itemType, deltaX, deltaY) => {
    if (itemType === 'image' && selectedImageId) {
      const imgs = yjsSync.getAllImages();
      const img = imgs.find(i => i.id === selectedImageId);
      if (img) {
        yjsSync.updateImageProps(selectedImageId, {
          x: img.x + deltaX,
          y: img.y + deltaY,
        });
        // 立即更新本地选中对象并同步渲染（不等待异步 onDataChange）
        engine.selectedImage = yjsSync.getAllImages().find(i => i.id === selectedImageId);
        engine.render();
      }
    } else if (itemType === 'text' && selectedTextId) {
      const texts = yjsSync.getAllTexts();
      const t = texts.find(t => t.id === selectedTextId);
      if (t) {
        yjsSync.updateTextProps(selectedTextId, {
          x: t.x + deltaX,
          y: t.y + deltaY,
        });
        // 立即更新本地选中对象并同步渲染
        engine.selectedText = yjsSync.getAllTexts().find(tt => tt.id === selectedTextId);
        engine.render();
      }
    }
  };

  // 拖拽结束
  engine.onDragEnd = () => {
    // 拖拽完成后重新获取选中对象
    if (selectedType === 'image' && selectedImageId) {
      const imgs = yjsSync.getAllImages();
      const img = imgs.find(i => i.id === selectedImageId);
      if (img) engine.selectedImage = img;
    } else if (selectedType === 'text' && selectedTextId) {
      const texts = yjsSync.getAllTexts();
      const t = texts.find(t => t.id === selectedTextId);
      if (t) engine.selectedText = t;
    }
    engine.requestRender();
  };

  // 光标移动 -> 广播
  engine.onCursorMove = (x, y) => {
    if (x === null) {
      yjsSync.clearCursor();
    } else {
      yjsSync.updateCursor(x, y);
    }
  };

  // 视口变化 -> 更新迷你地图 + 屏幕边缘标记 + 视口信息
  engine.onViewportChange = () => {
    updateMinimap();
    updateScreenEdgeMarkers();
    updateViewportInfo();
  };

  // 数据变化 -> 重新渲染 + 更新选中状态
  yjsSync.onDataChange = (type) => {
    // 如果选中的元素数据变化了，更新选中状态
    if (selectedType === 'image' && selectedImageId) {
      const imgs = yjsSync.getAllImages();
      const updated = imgs.find(i => i.id === selectedImageId);
      if (updated) {
        engine.selectedImage = updated;
      }
    } else if (selectedType === 'text' && selectedTextId) {
      const texts = yjsSync.getAllTexts();
      const updated = texts.find(t => t.id === selectedTextId);
      if (updated) {
        engine.selectedText = updated;
        // 同步文字内容到编辑框
        const textContent = document.getElementById('prop-text-content');
        if (textContent && document.activeElement !== textContent) {
          textContent.value = updated.content || '';
        }
        // 同步滑块值
        const scaleSlider = document.getElementById('prop-scale');
        const rotationSlider = document.getElementById('prop-rotation');
        const opacitySlider = document.getElementById('prop-opacity');
        if (document.activeElement !== scaleSlider) {
          const v = Math.round((updated.scale || 1) * 100);
          scaleSlider.value = v;
          document.getElementById('prop-scale-value').textContent = v + '%';
        }
        if (document.activeElement !== rotationSlider) {
          const v = Math.round(updated.rotation || 0);
          rotationSlider.value = v;
          document.getElementById('prop-rotation-value').textContent = v + '°';
        }
        if (document.activeElement !== opacitySlider) {
          const v = Math.round((updated.opacity !== undefined ? updated.opacity : 1) * 100);
          opacitySlider.value = v;
          document.getElementById('prop-opacity-value').textContent = v + '%';
        }
      }
    }
    engine.requestRender();
    updateMinimap();
  };

  // awareness 变化 -> 更新光标和用户列表
  yjsSync.onAwarenessChange = (users) => {
    updateUserList(users);
    cursorLayer.update(yjsSync.getRemoteCursors());
    updateScreenEdgeMarkers();
  };

  // 定期更新屏幕边缘标记（仅当有远程光标时才执行，减少不必要的计算）
  setInterval(() => {
    const remoteCursors = yjsSync.getRemoteCursors();
    if (remoteCursors.length > 0) {
      updateScreenEdgeMarkers();
      cursorLayer.update(remoteCursors);
    }
  }, 1000);

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
  setupImagePropsPanel();
  setupRewardButton();
  setupDragDropImage();

  // 页面关闭时断开连接，通知其他用户
  window.addEventListener('beforeunload', () => {
    // 清理未完成的空文字元素
    if (editingTextId) {
      const texts = yjsSync.getAllTexts();
      const t = texts.find(tt => tt.id === editingTextId);
      if (t && (!t.content || t.content.trim() === '')) {
        yjsSync.removeTextById(editingTextId);
      }
    }
    yjsSync.disconnect();
  });
  // 移动端 Safari 兼容
  window.addEventListener('pagehide', () => {
    if (editingTextId) {
      const texts = yjsSync.getAllTexts();
      const t = texts.find(tt => tt.id === editingTextId);
      if (t && (!t.content || t.content.trim() === '')) {
        yjsSync.removeTextById(editingTextId);
      }
    }
    yjsSync.disconnect();
  });

  // 进入画板后检查公告
  checkAnnouncement();
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
      } else if (tool === 'text') {
        setTool('text');
        document.getElementById('text-placement').classList.remove('hidden');
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
  // 切换工具时取消选择
  if (tool !== 'select' && (selectedImageId || selectedTextId)) {
    deselectAll();
  }
  // 切换工具时取消图片放置
  if (tool !== 'image' && pendingImageFile) {
    pendingImageFile = null;
    engine.clearPendingImage();
    document.getElementById('image-placement').classList.add('hidden');
    hideImagePropsPanel();
  }
  // 切换工具时取消文字放置（始终隐藏提示）
  if (tool !== 'text') {
    document.getElementById('text-placement').classList.add('hidden');
    document.getElementById('text-editor').classList.add('hidden');
    // 如果正在创建文字但切换了工具，删除已创建的空文字元素
    if (editingTextId && pendingTextPos) {
      const texts = yjsSync.getAllTexts();
      const t = texts.find(tt => tt.id === editingTextId);
      if (t && (!t.content || t.content.trim() === '')) {
        yjsSync.removeTextById(editingTextId);
      }
    }
    pendingTextPos = null;
    editingTextId = null;
  }

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
      // 重置属性并显示调节面板
      pendingImageProps = { scale: 1, rotation: 0, opacity: 1 };
      showImagePropsPanel(null);
    };
    img.onerror = () => {
      alert('图片加载失败，请检查文件是否损坏');
    };
    img.src = e.target.result;
  };
  reader.onerror = () => {
    alert('文件读取失败，请重试');
  };
  reader.readAsDataURL(file);
}

// ===== 图片命中检测（支持旋转和缩放）=====

function hitTestImage(worldX, worldY, img) {
  const scale = img.scale !== undefined ? img.scale : 1;
  const dw = img.w * scale;
  const dh = img.h * scale;
  const cx = img.x + img.w / 2;
  const cy = img.y + img.h / 2;
  const rotation = (img.rotation || 0) * Math.PI / 180;
  const dx = worldX - cx;
  const dy = worldY - cy;
  const cos = Math.cos(-rotation);
  const sin = Math.sin(-rotation);
  const lx = dx * cos - dy * sin;
  const ly = dx * sin + dy * cos;
  return lx >= -dw / 2 && lx <= dw / 2 && ly >= -dh / 2 && ly <= dh / 2;
}

// ===== 文字命中检测 =====

function hitTestText(worldX, worldY, t) {
  const bounds = engine._getTextBounds(t);
  if (!bounds) return false;
  return worldX >= bounds.minX && worldX <= bounds.maxX &&
         worldY >= bounds.minY && worldY <= bounds.maxY;
}

// ===== 格式化时间 =====

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ===== 属性面板（图片/文字通用）=====

function showImagePropsPanel(img, text) {
  const panel = document.getElementById('image-props-panel');
  const title = document.getElementById('props-panel-title');
  const scaleSlider = document.getElementById('prop-scale');
  const rotationSlider = document.getElementById('prop-rotation');
  const opacitySlider = document.getElementById('prop-opacity');
  const scaleValue = document.getElementById('prop-scale-value');
  const rotationValue = document.getElementById('prop-rotation-value');
  const opacityValue = document.getElementById('prop-opacity-value');
  const infoDiv = document.getElementById('props-info');
  const infoUser = document.getElementById('props-info-user');
  const infoTime = document.getElementById('props-info-time');
  const textEditDiv = document.getElementById('props-text-edit');
  const textContent = document.getElementById('prop-text-content');

  const item = img || text;

  if (item) {
    // 选中已放置的元素
    const scale = Math.round((item.scale || 1) * 100);
    const rotation = Math.round(item.rotation || 0);
    const opacity = Math.round((item.opacity !== undefined ? item.opacity : 1) * 100);
    scaleSlider.value = scale;
    rotationSlider.value = rotation;
    opacitySlider.value = opacity;
    scaleValue.textContent = scale + '%';
    rotationValue.textContent = rotation + '°';
    opacityValue.textContent = opacity + '%';

    // 显示放置信息
    title.textContent = img ? '图片属性' : '文字属性';
    infoDiv.classList.remove('hidden');
    infoUser.textContent = item.userName || '未知用户';
    infoTime.textContent = formatTime(item.createdAt);

    // 文字内容编辑
    if (text) {
      textEditDiv.classList.remove('hidden');
      textContent.value = text.content || '';
    } else {
      textEditDiv.classList.add('hidden');
    }
  } else {
    // 放置新图片时（无信息）
    title.textContent = '图片属性';
    scaleSlider.value = 100;
    rotationSlider.value = 0;
    opacitySlider.value = 100;
    scaleValue.textContent = '100%';
    rotationValue.textContent = '0°';
    opacityValue.textContent = '100%';
    infoDiv.classList.add('hidden');
    textEditDiv.classList.add('hidden');
  }

  panel.classList.remove('hidden');
}

function hideImagePropsPanel() {
  document.getElementById('image-props-panel').classList.add('hidden');
  engine.isEditMode = false;
  engine.requestRender();
}

function deselectAll() {
  selectedImageId = null;
  selectedTextId = null;
  selectedType = null;
  engine.selectedImage = null;
  engine.selectedText = null;
  engine.isEditMode = false;
  engine.requestRender();
  hideImagePropsPanel();
}

// ===== 文字编辑浮层 =====

function showTextEditor(screenX, screenY, initialText) {
  const editor = document.getElementById('text-editor');
  const input = document.getElementById('text-editor-input');
  editor.style.left = screenX + 'px';
  editor.style.top = screenY + 'px';
  input.value = initialText;
  editor.classList.remove('hidden');
  // 隐藏"点击画布添加文字"提示
  document.getElementById('text-placement').classList.add('hidden');
  setTimeout(() => input.focus(), 50);
}

function hideTextEditor() {
  document.getElementById('text-editor').classList.add('hidden');
  pendingTextPos = null;
  editingTextId = null;
  document.getElementById('text-placement').classList.add('hidden');
}

function confirmTextEditor() {
  const input = document.getElementById('text-editor-input');
  const content = input.value.trim();

  if (editingTextId) {
    if (content) {
      // 更新文字内容（已有元素，之前已实时创建）
      yjsSync.updateTextProps(editingTextId, { content });
    } else {
      // 内容为空，删除已创建的文字元素
      yjsSync.removeTextById(editingTextId);
    }
  } else if (pendingTextPos && content) {
    // 后备路径：如果因某种原因文字元素未提前创建
    yjsSync.addText(
      pendingTextPos.worldX,
      pendingTextPos.worldY,
      content,
      24,
      '#422006',
      0, 1, 1
    );
  }

  hideTextEditor();
  setTool('pen');
}

function setupImagePropsPanel() {
  const scaleSlider = document.getElementById('prop-scale');
  const rotationSlider = document.getElementById('prop-rotation');
  const opacitySlider = document.getElementById('prop-opacity');
  const scaleValue = document.getElementById('prop-scale-value');
  const rotationValue = document.getElementById('prop-rotation-value');
  const opacityValue = document.getElementById('prop-opacity-value');
  const closeBtn = document.getElementById('props-panel-close');
  const textContent = document.getElementById('prop-text-content');

  function updateProp(key, value) {
    if (selectedType === 'image' && selectedImageId) {
      yjsSync.updateImageProps(selectedImageId, { [key]: value });
      if (engine.selectedImage) {
        engine.selectedImage[key] = value;
        engine.requestRender();
      }
    } else if (selectedType === 'text' && selectedTextId) {
      yjsSync.updateTextProps(selectedTextId, { [key]: value });
      if (engine.selectedText) {
        engine.selectedText[key] = value;
        engine.requestRender();
      }
    } else if (pendingImageFile) {
      pendingImageProps[key] = value;
    }
  }

  scaleSlider.addEventListener('input', () => {
    const v = parseInt(scaleSlider.value);
    scaleValue.textContent = v + '%';
    updateProp('scale', v / 100);
  });

  rotationSlider.addEventListener('input', () => {
    const v = parseInt(rotationSlider.value);
    rotationValue.textContent = v + '°';
    updateProp('rotation', v);
  });

  opacitySlider.addEventListener('input', () => {
    const v = parseInt(opacitySlider.value);
    opacityValue.textContent = v + '%';
    updateProp('opacity', v / 100);
  });

  textContent.addEventListener('input', () => {
    if (selectedType === 'text' && selectedTextId) {
      const content = textContent.value.slice(0, 5000);
      if (content !== textContent.value) {
        textContent.value = content;
      }
      yjsSync.updateTextProps(selectedTextId, { content });
      if (engine.selectedText) {
        engine.selectedText.content = textContent.value;
        engine.requestRender();
      }
    }
  });

  closeBtn.addEventListener('click', () => {
    if (selectedImageId || selectedTextId) {
      deselectAll();
    } else if (pendingImageFile) {
      pendingImageFile = null;
      engine.clearPendingImage();
      document.getElementById('image-placement').classList.add('hidden');
      hideImagePropsPanel();
      setTool('pen');
    } else {
      hideImagePropsPanel();
    }
  });

  // 文字编辑器按钮
  document.getElementById('text-editor-confirm').addEventListener('click', confirmTextEditor);
  document.getElementById('text-editor-cancel').addEventListener('click', () => {
    // 取消时删除已创建的空文字元素
    if (editingTextId) {
      yjsSync.removeTextById(editingTextId);
    }
    hideTextEditor();
    setTool('pen');
  });
  document.getElementById('text-editor-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      confirmTextEditor();
    } else if (e.key === 'Escape') {
      // ESC 取消时删除已创建的空文字元素
      if (editingTextId) {
        yjsSync.removeTextById(editingTextId);
      }
      hideTextEditor();
      setTool('pen');
    }
  });
  // 实时输入同步：用户每输入一个字符，立即更新画布上的文字
  document.getElementById('text-editor-input').addEventListener('input', (e) => {
    if (editingTextId) {
      // 限制文字长度，防止超大文本导致性能问题
      const content = e.target.value.slice(0, 5000);
      if (content !== e.target.value) {
        e.target.value = content;
      }
      yjsSync.updateTextProps(editingTextId, { content });
    }
  });
}

// ===== 拖拽图片到网页 =====

function setupDragDropImage() {
  let dragOverlay = null;
  let dragCounter = 0;

  // 创建拖拽提示遮罩
  function createOverlay() {
    const div = document.createElement('div');
    div.id = 'drag-drop-overlay';
    div.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(30, 58, 95, 0.3); backdrop-filter: blur(4px);
      display: flex; align-items: center; justify-content: center;
      z-index: 9999; pointer-events: none; opacity: 0;
      transition: opacity 0.2s;
    `;
    div.innerHTML = `
      <div style="
        background: rgba(255,255,255,0.95); border-radius: 16px;
        padding: 40px 60px; text-align: center;
        border: 3px dashed #1e3a5f; box-shadow: 0 8px 32px rgba(0,0,0,0.15);
      ">
        <div style="font-size: 48px; margin-bottom: 12px;">🖼️</div>
        <div style="font-size: 20px; color: #1e3a5f; font-weight: 600;">松开以添加图片</div>
        <div style="font-size: 14px; color: #888; margin-top: 8px;">支持 JPG / PNG / GIF / WebP，最大 10MB</div>
      </div>
    `;
    return div;
  }

  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    // 仅处理包含文件的拖拽
    if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
    dragCounter++;
    if (!dragOverlay) {
      dragOverlay = createOverlay();
      document.body.appendChild(dragOverlay);
      requestAnimationFrame(() => { dragOverlay.style.opacity = '1'; });
    }
  });

  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    // 阻止默认行为以允许 drop
  });

  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      if (dragOverlay) {
        dragOverlay.style.opacity = '0';
        setTimeout(() => {
          if (dragOverlay) { dragOverlay.remove(); dragOverlay = null; }
        }, 200);
      }
    }
  });

  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    if (dragOverlay) {
      dragOverlay.style.opacity = '0';
      setTimeout(() => {
        if (dragOverlay) { dragOverlay.remove(); dragOverlay = null; }
      }, 200);
    }

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    // 取第一个图片文件
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        handleImageUpload(file);
        break;
      }
    }
  });
}

// ===== 赞赏按钮 =====

function setupRewardButton() {
  const btn = document.getElementById('reward-btn');
  const overlay = document.getElementById('reward-overlay');
  if (!btn || !overlay) return;

  const closeBtn = document.getElementById('reward-close');
  const confirmBtn = document.getElementById('reward-confirm');

  const open = () => overlay.classList.remove('hidden');
  const close = () => overlay.classList.add('hidden');

  btn.addEventListener('click', open);
  if (closeBtn) closeBtn.addEventListener('click', close);
  if (confirmBtn) confirmBtn.addEventListener('click', close);

  // 点击遮罩区域关闭
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
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

    // Delete/Backspace: 删除选中的图片或文字（不在输入框中时）
    if ((e.key === 'Delete' || e.key === 'Backspace') && (selectedImageId || selectedTextId)) {
      const activeTag = document.activeElement?.tagName;
      if (activeTag !== 'INPUT' && activeTag !== 'TEXTAREA' && !document.activeElement?.isContentEditable) {
        e.preventDefault();
        if (selectedType === 'image' && selectedImageId) {
          yjsSync.removeImageById(selectedImageId);
        } else if (selectedType === 'text' && selectedTextId) {
          yjsSync.removeTextById(selectedTextId);
        }
        deselectAll();
      }
    }

    // Escape: 取消选择或取消放置
    if (e.key === 'Escape') {
      if (selectedImageId || selectedTextId) {
        deselectAll();
      } else if (pendingImageFile) {
        pendingImageFile = null;
        engine.clearPendingImage();
        document.getElementById('image-placement').classList.add('hidden');
        hideImagePropsPanel();
        setTool('pen');
      } else if (pendingTextPos || editingTextId) {
        if (editingTextId) {
          const texts = yjsSync.getAllTexts();
          const t = texts.find(tt => tt.id === editingTextId);
          if (t && (!t.content || t.content.trim() === '')) {
            yjsSync.removeTextById(editingTextId);
          }
        }
        hideTextEditor();
        setTool('pen');
      }
    }

    // 快捷键: t -> 文字工具
    if (e.key === 't' || e.key === 'T') {
      setTool('text');
      document.getElementById('text-placement').classList.remove('hidden');
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
    // 点击头像跳转到该用户位置
    if (user.cursor && user.userId !== yjsSync.userId) {
      avatar.style.cursor = 'pointer';
      avatar.addEventListener('click', () => jumpToUser(user));
    }
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

      // 点击跳转到用户位置
      if (user.cursor && user.userId !== yjsSync.userId) {
        item.style.cursor = 'pointer';
        item.addEventListener('click', () => {
          jumpToUser(user);
          // 关闭下拉
          document.getElementById('user-dropdown').classList.add('hidden');
        });
      }

      item.appendChild(avatar);
      item.appendChild(name);
      dropdownList.appendChild(item);
    }
  }

  // 更新屏幕边缘标记
  updateScreenEdgeMarkers();
}

// ===== 视角跳转 =====

function jumpToUser(user) {
  if (!user.cursor) return;
  // 保存当前视口
  savedViewport = {
    offsetX: engine.offsetX,
    offsetY: engine.offsetY,
    scale: engine.scale,
  };
  // 跳转到用户位置（居中）
  const canvasW = engine.mainCanvas.width / engine.dpr;
  const canvasH = engine.mainCanvas.height / engine.dpr;
  engine.offsetX = canvasW / 2 - user.cursor.x * engine.scale;
  engine.offsetY = canvasH / 2 - user.cursor.y * engine.scale;
  engine.render();
  engine._notifyViewportChange();

  // 显示返回按钮
  const btn = document.getElementById('return-btn');
  btn.classList.remove('hidden');
  btn.onclick = returnToSavedViewport;
}

function returnToSavedViewport() {
  if (!savedViewport) return;
  engine.offsetX = savedViewport.offsetX;
  engine.offsetY = savedViewport.offsetY;
  engine.scale = savedViewport.scale;
  savedViewport = null;
  engine.render();
  engine._notifyViewportChange();
  document.getElementById('return-btn').classList.add('hidden');
}

// ===== 屏幕边缘标记其他用户 =====

function updateScreenEdgeMarkers() {
  const container = document.getElementById('edge-markers');
  if (!container) return;
  container.innerHTML = '';

  const remoteCursors = yjsSync.getRemoteCursors();
  const bounds = engine.getViewportBounds();
  const canvasW = engine.mainCanvas.width / engine.dpr;
  const canvasH = engine.mainCanvas.height / engine.dpr;
  const margin = 30;

  for (const rc of remoteCursors) {
    if (!rc.cursor) continue;
    const screen = engine.worldToScreen(rc.cursor.x, rc.cursor.y);
    // 如果在视口内，不显示标记
    if (screen.x >= 0 && screen.x <= canvasW && screen.y >= 0 && screen.y <= canvasH) continue;

    // 计算边缘位置（将屏幕坐标限制在边缘）
    const cx = canvasW / 2;
    const cy = canvasH / 2;
    const dx = screen.x - cx;
    const dy = screen.y - cy;
    const angle = Math.atan2(dy, dx);
    // 限制在画布边缘
    const halfW = canvasW / 2 - margin;
    const halfH = canvasH / 2 - margin;
    let ex, ey;
    const tanA = Math.abs(dy / dx);
    if (tanA < halfH / halfW) {
      // 左右边缘
      ex = dx > 0 ? cx + halfW : cx - halfW;
      ey = cy + (ex - cx) * (dy / dx);
    } else {
      // 上下边缘
      ey = dy > 0 ? cy + halfH : cy - halfH;
      ex = cx + (ey - cy) * (dx / dy);
    }

    const marker = document.createElement('div');
    marker.className = 'edge-marker';
    marker.style.left = (ex - 14) + 'px';
    marker.style.top = (ey - 14) + 'px';
    marker.style.background = rc.color || '#22c55e';
    marker.textContent = (rc.name || '?').charAt(0).toUpperCase();
    marker.title = `${rc.name} - 点击跳转`;
    marker.addEventListener('click', () => {
      jumpToUser({ cursor: rc.cursor, name: rc.name, color: rc.color });
    });
    container.appendChild(marker);
  }

  // 同时更新 minimap 上的远程光标
  engine._remoteCursorsForMinimap = remoteCursors.filter(rc => rc.cursor);
}

// ===== 视口信息显示 =====

function updateViewportInfo() {
  const info = document.getElementById('viewport-info');
  if (!info) return;
  const bounds = engine.getViewportBounds();
  info.textContent = `位置: ${Math.round(bounds.centerX)}, ${Math.round(bounds.centerY)} | 缩放: ${Math.round(engine.scale * 100)}%`;
}

// ===== 迷你地图更新 =====

function updateMinimap() {
  if (minimapTimer) clearTimeout(minimapTimer);
  minimapTimer = setTimeout(() => {
    const minimapCanvas = document.getElementById('minimap-canvas');
    if (!minimapCanvas) return;
    const strokes = yjsSync.getAllStrokes();
    const images = yjsSync.getAllImages();
    const texts = yjsSync.getAllTexts();
    engine._remoteCursorsForMinimap = yjsSync.getRemoteCursors().filter(rc => rc.cursor);
    engine.renderMinimap(minimapCanvas, strokes, images, texts);
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
