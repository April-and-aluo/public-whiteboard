// ============================================
// canvas-engine.js - Canvas 渲染引擎 + 视口变换 + 触摸手势
// ============================================
// 负责所有画布渲染、坐标变换、平移缩放、手势识别
// 不处理工具切换和业务逻辑，只负责画
// ============================================

export class CanvasEngine {
  constructor(mainCanvas, cursorCanvas) {
    this.mainCanvas = mainCanvas;
    this.cursorCanvas = cursorCanvas;
    this.ctx = mainCanvas.getContext('2d');
    this.cursorCtx = cursorCanvas.getContext('2d');

    // 视口状态：世界坐标 -> 屏幕坐标的变换
    this.offsetX = 0;
    this.offsetY = 0;
    this.scale = 1;

    // 设备像素比（高分辨率屏幕）
    this.dpr = window.devicePixelRatio || 1;

    // 画布尺寸
    this.width = 0;
    this.height = 0;

    // 手势状态
    this.pointers = new Map(); // 活跃的指针
    this.isPanning = false;
    this.panStartX = 0;
    this.panStartY = 0;
    this.panStartOffsetX = 0;
    this.panStartOffsetY = 0;

    // 双指缩放状态
    this.pinchStartDist = 0;
    this.pinchStartScale = 1;
    this.pinchCenter = null;

    // 当前正在绘制的笔画（本地预览）
    this.currentStroke = null;
    this.isDrawing = false;

    // 图片缓存（避免重复解码）
    this.imageCache = new Map();

    // 渲染节流
    this.renderQueued = false;

    // 拖拽状态（选择模式下拖动图片/文字）
    this.isDragging = false;
    this.dragStartWorld = null;
    this.draggedType = null; // 'image' | 'text'
    this.dragMoved = false;

    // 回调函数
    this.onStrokeStart = null;
    this.onStrokeMove = null;
    this.onStrokeEnd = null;
    this.onErase = null; // (worldX, worldY) => boolean(是否命中删除)
    this.onImagePlace = null; // (worldX, worldY) => void
    this.onSelectClick = null; // (worldX, worldY) => void
    this.onTextPlace = null; // (worldX, worldY) => void
    this.onCursorMove = null; // (worldX, worldY) => void
    this.onViewportChange = null;
    this.onEditButtonClick = null; // () => void 编辑按钮被点击
    this.onDragMove = null; // (itemType, deltaX, deltaY) => void 拖拽移动
    this.onDragEnd = null; // () => void 拖拽结束
    this.selectedImage = null; // 当前选中的图片对象（用于高亮显示）
    this.selectedText = null; // 当前选中的文字对象（用于高亮显示）
    this.isEditMode = false; // 是否在编辑模式（属性面板打开时）

    this._setupCanvas();
    this._setupEventListeners();
  }

  // 初始化画布尺寸
  _setupCanvas() {
    const resize = () => {
      const rect = this.mainCanvas.getBoundingClientRect();
      this.width = rect.width;
      this.height = rect.height;

      [this.mainCanvas, this.cursorCanvas].forEach(canvas => {
        canvas.width = this.width * this.dpr;
        canvas.height = this.height * this.dpr;
        canvas.style.width = this.width + 'px';
        canvas.style.height = this.height + 'px';
      });

      this.ctx.scale(this.dpr, this.dpr);
      this.cursorCtx.scale(this.dpr, this.dpr);

      this.render();
    };

    resize();
    window.addEventListener('resize', resize);
  }

  // 设置事件监听（统一使用 Pointer Events）
  _setupEventListeners() {
    this.mainCanvas.addEventListener('pointerdown', this._onPointerDown.bind(this));
    this.mainCanvas.addEventListener('pointermove', this._onPointerMove.bind(this));
    this.mainCanvas.addEventListener('pointerup', this._onPointerUp.bind(this));
    this.mainCanvas.addEventListener('pointercancel', this._onPointerUp.bind(this));
    this.mainCanvas.addEventListener('pointerleave', this._onPointerLeave.bind(this));
    this.mainCanvas.addEventListener('wheel', this._onWheel.bind(this), { passive: false });

    // 阻止触摸默认行为
    this.mainCanvas.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    this.mainCanvas.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  }

  // ===== 坐标变换 =====

  // 屏幕坐标 -> 世界坐标
  screenToWorld(sx, sy) {
    return {
      x: (sx - this.offsetX) / this.scale,
      y: (sy - this.offsetY) / this.scale,
    };
  }

  // 世界坐标 -> 屏幕坐标
  worldToScreen(wx, wy) {
    return {
      x: wx * this.scale + this.offsetX,
      y: wy * this.scale + this.offsetY,
    };
  }

  // 获取相对于画布的坐标
  _getCanvasPoint(e) {
    const rect = this.mainCanvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }

  // ===== 指针事件处理 =====

  _onPointerDown(e) {
    e.preventDefault();
    try { this.mainCanvas.setPointerCapture(e.pointerId); } catch (_) {}

    const point = this._getCanvasPoint(e);
    this.pointers.set(e.pointerId, {
      x: point.x,
      y: point.y,
      type: e.pointerType,
    });

    // 双指手势处理
    if (this.pointers.size === 2) {
      this._startPinchGesture();
      return;
    }

    // 三指或更多 - 不处理绘画
    if (this.pointers.size > 2) return;

    const world = this.screenToWorld(point.x, point.y);

    // 中键或空格+拖拽 -> 平移
    if (e.button === 1 || this._isSpacePressed) {
      this._startPan(point.x, point.y);
      return;
    }

    // 根据当前工具处理
    const tool = this.currentTool || 'pen';

    if (tool === 'pen') {
      this._startDrawing(world.x, world.y, point);
    } else if (tool === 'eraser') {
      this._eraseAt(world.x, world.y);
    } else if (tool === 'image' && this.pendingImage) {
      this._placeImage(world.x, world.y);
    } else if (tool === 'text') {
      if (this.onTextPlace) this.onTextPlace(world.x, world.y);
    } else if (tool === 'select') {
      // 1. 检查是否点击了编辑按钮
      if (this._hitTestEditButton(point.x, point.y)) {
        if (this.onEditButtonClick) this.onEditButtonClick();
        return;
      }
      // 2. 检查是否点击了已有选中项（开始拖拽）
      if (this.selectedImage && this._hitTestSelected(point.x, point.y, 'image')) {
        this.isDragging = true;
        this.dragStartWorld = { x: world.x, y: world.y };
        this.draggedType = 'image';
        this.dragMoved = false;
        return;
      }
      if (this.selectedText && this._hitTestSelected(point.x, point.y, 'text')) {
        this.isDragging = true;
        this.dragStartWorld = { x: world.x, y: world.y };
        this.draggedType = 'text';
        this.dragMoved = false;
        return;
      }
      // 3. 记住之前是否有选中
      const hadSelection = !!(this.selectedImage || this.selectedText);
      // 4. 检查是否点击了某个元素（选中它）
      if (this.onSelectClick) this.onSelectClick(world.x, world.y);
      // 5. 如果之前没有选中、点击后也没有选中 -> 开始平移
      //    如果之前有选中但现在取消选中 -> 仅取消选中，不平移
      if (!hadSelection && !this.selectedImage && !this.selectedText) {
        this._startPan(point.x, point.y);
      }
    }
  }

  _onPointerMove(e) {
    const point = this._getCanvasPoint(e);

    // 更新指针位置
    if (this.pointers.has(e.pointerId)) {
      this.pointers.set(e.pointerId, {
        x: point.x,
        y: point.y,
        type: e.pointerType,
      });
    }

    // 双指手势处理
    if (this.pointers.size === 2) {
      this._updatePinchGesture();
      return;
    }

    // 平移
    if (this.isPanning) {
      const dx = point.x - this.panStartX;
      const dy = point.y - this.panStartY;
      this.offsetX = this.panStartOffsetX + dx;
      this.offsetY = this.panStartOffsetY + dy;
      this.render();
      this._notifyViewportChange();
      return;
    }

    const world = this.screenToWorld(point.x, point.y);

    // 光标位置广播
    if (this.onCursorMove) {
      this.onCursorMove(world.x, world.y);
    }

    // 绘画中
    if (this.isDrawing && this.currentStroke) {
      this._continueDrawing(world.x, world.y);
    }

    // 橡皮擦移动擦除
    if (this.currentTool === 'eraser' && (e.buttons & 1)) {
      this._eraseAt(world.x, world.y);
    }

    // 选择模式拖拽
    if (this.currentTool === 'select' && this.isDragging && this.dragStartWorld) {
      const dx = world.x - this.dragStartWorld.x;
      const dy = world.y - this.dragStartWorld.y;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
        this.dragMoved = true;
      }
      if (this.dragMoved && this.onDragMove) {
        this.onDragMove(this.draggedType, dx, dy);
        this.dragStartWorld = { x: world.x, y: world.y };
      }
    }
  }

  _onPointerUp(e) {
    this.pointers.delete(e.pointerId);

    // 双指手势结束
    if (this.pointers.size < 2) {
      this._endPinchGesture();
    }

    // 平移结束
    if (this.isPanning) {
      this._endPan();
    }

    // 绘画结束
    if (this.isDrawing && this.currentStroke) {
      this._endDrawing();
    }

    // 拖拽结束
    if (this.isDragging) {
      if (this.dragMoved && this.onDragEnd) {
        this.onDragEnd();
      }
      this.isDragging = false;
      this.dragStartWorld = null;
      this.draggedType = null;
      this.dragMoved = false;
    }
  }

  _onPointerLeave(e) {
    // 光标离开画布时清除
    if (this.onCursorMove) {
      this.onCursorMove(null, null);
    }
  }

  // ===== 滚轮缩放 =====

  _onWheel(e) {
    e.preventDefault();
    const point = this._getCanvasPoint(e);
    const worldBefore = this.screenToWorld(point.x, point.y);

    // 缩放因子
    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.max(0.1, Math.min(10, this.scale * zoomFactor));

    // 以光标为中心缩放
    this.scale = newScale;
    this.offsetX = point.x - worldBefore.x * this.scale;
    this.offsetY = point.y - worldBefore.y * this.scale;

    this.render();
    this._notifyViewportChange();
  }

  // ===== 平移 =====

  _startPan(x, y) {
    this.isPanning = true;
    this.panStartX = x;
    this.panStartY = y;
    this.panStartOffsetX = this.offsetX;
    this.panStartOffsetY = this.offsetY;
    this.mainCanvas.classList.add('panning');
  }

  _endPan() {
    this.isPanning = false;
    this.mainCanvas.classList.remove('panning');
  }

  // ===== 双指缩放手势 =====

  _startPinchGesture() {
    const pointers = Array.from(this.pointers.values());
    if (pointers.length < 2) return;

    const dx = pointers[1].x - pointers[0].x;
    const dy = pointers[1].y - pointers[0].y;
    this.pinchStartDist = Math.sqrt(dx * dx + dy * dy);
    this.pinchStartScale = this.scale;

    this.pinchCenter = {
      x: (pointers[0].x + pointers[1].x) / 2,
      y: (pointers[0].y + pointers[1].y) / 2,
    };

    // 记录初始中心对应的世界坐标，用于计算平移增量
    this.pinchStartWorld = this.screenToWorld(this.pinchCenter.x, this.pinchCenter.y);

    // 停止当前绘画
    if (this.isDrawing && this.currentStroke) {
      this._endDrawing();
    }
  }

  _updatePinchGesture() {
    const pointers = Array.from(this.pointers.values());
    if (pointers.length < 2 || this.pinchStartDist === 0) return;

    const dx = pointers[1].x - pointers[0].x;
    const dy = pointers[1].y - pointers[0].y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // 当前双指中心
    const currentCenter = {
      x: (pointers[0].x + pointers[1].x) / 2,
      y: (pointers[0].y + pointers[1].y) / 2,
    };

    const newScale = Math.max(0.1, Math.min(10, this.pinchStartScale * (dist / this.pinchStartDist)));

    // 缩放围绕初始世界点 + 平移跟随手指中心移动
    this.scale = newScale;
    this.offsetX = currentCenter.x - this.pinchStartWorld.x * this.scale;
    this.offsetY = currentCenter.y - this.pinchStartWorld.y * this.scale;

    this.render();
    this._notifyViewportChange();
  }

  _endPinchGesture() {
    this.pinchStartDist = 0;
    this.pinchCenter = null;
    this.pinchStartWorld = null;
  }

  // ===== 绘画逻辑 =====

  _startDrawing(worldX, worldY, screenPoint) {
    this.isDrawing = true;
    this.currentStroke = {
      points: [[worldX, worldY]],
      color: this.currentColor || '#1e3a5f',
      width: this.currentWidth || 4,
    };
    // 本地预览渲染
    this.render();
  }

  _continueDrawing(worldX, worldY) {
    if (!this.currentStroke) return;
    const points = this.currentStroke.points;
    const last = points[points.length - 1];

    // 最小距离过滤（减少抖动）
    const dx = worldX - last[0];
    const dy = worldY - last[1];
    if (dx * dx + dy * dy < 1) return;

    points.push([worldX, worldY]);
    this.render();
  }

  _endDrawing() {
    this.isDrawing = false;
    if (this.currentStroke && this.currentStroke.points.length > 1) {
      if (this.onStrokeEnd) {
        this.onStrokeEnd(this.currentStroke);
      }
    }
    this.currentStroke = null;
    this.render();
  }

  // ===== 橡皮擦 =====

  _eraseAt(worldX, worldY) {
    if (this.onErase) {
      const erased = this.onErase(worldX, worldY);
      if (erased) this.render();
    }
  }

  // ===== 图片放置 =====

  _placeImage(worldX, worldY) {
    if (this.onImagePlace) {
      this.onImagePlace(worldX, worldY);
    }
  }

  // ===== 渲染 =====

  // 请求渲染（节流）
  requestRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  // 主渲染函数
  render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);

    // 应用视口变换
    ctx.save();
    ctx.translate(this.offsetX, this.offsetY);
    ctx.scale(this.scale, this.scale);

    // 绘制所有图片（先画图片，在底层）
    if (this.renderImages) {
      this.renderImages(ctx);
    }

    // 绘制所有文字
    if (this.renderTexts) {
      this.renderTexts(ctx);
    }

    // 绘制所有笔画
    if (this.renderStrokes) {
      this.renderStrokes(ctx);
    }

    // 绘制当前正在画的笔画（本地预览）
    if (this.currentStroke && this.currentStroke.points.length > 0) {
      this._drawStroke(ctx, this.currentStroke);
    }

    // 绘制选中图片的高亮边框
    if (this.selectedImage) {
      const img = this.selectedImage;
      const scale = img.scale !== undefined ? img.scale : 1;
      const dw = img.w * scale;
      const dh = img.h * scale;
      const cx = img.x + img.w / 2;
      const cy = img.y + img.h / 2;
      const rotation = (img.rotation || 0) * Math.PI / 180;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rotation);
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 2 / this.scale;
      ctx.setLineDash([8 / this.scale, 4 / this.scale]);
      ctx.strokeRect(-dw / 2 - 4, -dh / 2 - 4, dw + 8, dh + 8);
      ctx.setLineDash([]);
      // 四角标记
      const corners = [[-dw/2-4, -dh/2-4], [dw/2+4, -dh/2-4], [dw/2+4, dh/2+4], [-dw/2-4, dh/2+4]];
      ctx.fillStyle = '#3b82f6';
      for (const [x, y] of corners) {
        ctx.fillRect(x - 3, y - 3, 6, 6);
      }
      ctx.restore();
    }

    // 绘制选中文字的高亮边框
    if (this.selectedText) {
      const t = this.selectedText;
      const bounds = this._getTextBounds(t);
      if (bounds) {
        const cx = (bounds.minX + bounds.maxX) / 2;
        const cy = (bounds.minY + bounds.maxY) / 2;
        const rotation = (t.rotation || 0) * Math.PI / 180;

        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(rotation);
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 2 / this.scale;
        ctx.setLineDash([8 / this.scale, 4 / this.scale]);
        ctx.strokeRect(-(bounds.maxX - bounds.minX) / 2 - 4, -(bounds.maxY - bounds.minY) / 2 - 4, (bounds.maxX - bounds.minX) + 8, (bounds.maxY - bounds.minY) + 8);
        ctx.setLineDash([]);
        const dw = bounds.maxX - bounds.minX;
        const dh = bounds.maxY - bounds.minY;
        const corners = [[-dw/2-4, -dh/2-4], [dw/2+4, -dh/2-4], [dw/2+4, dh/2+4], [-dw/2-4, dh/2+4]];
        ctx.fillStyle = '#3b82f6';
        for (const [x, y] of corners) {
          ctx.fillRect(x - 3, y - 3, 6, 6);
        }
        ctx.restore();
      }
    }

    // 绘制编辑按钮（圆形，位于选中边框右上角）
    if ((this.selectedImage || this.selectedText) && !this.isEditMode) {
      this._drawEditButton(ctx);
    }

    ctx.restore();
  }

  // 绘制圆形编辑按钮
  _drawEditButton(ctx) {
    const pos = this._getEditButtonWorldPos();
    if (!pos) return;
    const r = 14 / this.scale; // 固定屏幕大小

    ctx.save();
    ctx.translate(pos.x, pos.y);
    // 圆形背景
    ctx.fillStyle = '#3b82f6';
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    // 铅笔图标（简化为白色线条）
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5 / this.scale;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const s = 6 / this.scale;
    ctx.beginPath();
    ctx.moveTo(-s * 0.6, s * 0.6);
    ctx.lineTo(s * 0.6, -s * 0.6);
    ctx.moveTo(s * 0.2, -s * 0.8);
    ctx.lineTo(s * 0.8, -s * 0.2);
    ctx.stroke();
    ctx.restore();
  }

  // 获取编辑按钮在世界坐标中的位置
  _getEditButtonWorldPos() {
    if (this.selectedImage) {
      const img = this.selectedImage;
      const scale = img.scale !== undefined ? img.scale : 1;
      const dw = img.w * scale;
      const dh = img.h * scale;
      const cx = img.x + img.w / 2;
      const cy = img.y + img.h / 2;
      const rotation = (img.rotation || 0) * Math.PI / 180;
      // 右上角（旋转前）
      const lx = dw / 2 + 10 / this.scale;
      const ly = -dh / 2 - 10 / this.scale;
      const wx = cx + lx * Math.cos(rotation) - ly * Math.sin(rotation);
      const wy = cy + lx * Math.sin(rotation) + ly * Math.cos(rotation);
      return { x: wx, y: wy };
    }
    if (this.selectedText) {
      const t = this.selectedText;
      const bounds = this._getTextBounds(t);
      if (!bounds) return null;
      const cx = (bounds.minX + bounds.maxX) / 2;
      const cy = (bounds.minY + bounds.maxY) / 2;
      const rotation = (t.rotation || 0) * Math.PI / 180;
      const dw = bounds.maxX - bounds.minX;
      const dh = bounds.maxY - bounds.minY;
      const lx = dw / 2 + 10 / this.scale;
      const ly = -dh / 2 - 10 / this.scale;
      const wx = cx + lx * Math.cos(rotation) - ly * Math.sin(rotation);
      const wy = cy + lx * Math.sin(rotation) + ly * Math.cos(rotation);
      return { x: wx, y: wy };
    }
    return null;
  }

  // 检查屏幕坐标是否点击了编辑按钮
  _hitTestEditButton(screenX, screenY) {
    if (!this.selectedImage && !this.selectedText) return false;
    if (this.isEditMode) return false;
    const pos = this._getEditButtonWorldPos();
    if (!pos) return false;
    const screen = this.worldToScreen(pos.x, pos.y);
    const r = 18; // 点击半径稍大
    const dx = screenX - screen.x;
    const dy = screenY - screen.y;
    return dx * dx + dy * dy <= r * r;
  }

  // 检查屏幕坐标是否点击了选中元素
  _hitTestSelected(screenX, screenY, type) {
    const world = this.screenToWorld(screenX, screenY);
    if (type === 'image' && this.selectedImage) {
      // 使用缓存的世界坐标进行命中检测
      const img = this.selectedImage;
      const scale = img.scale !== undefined ? img.scale : 1;
      const dw = img.w * scale;
      const dh = img.h * scale;
      const cx = img.x + img.w / 2;
      const cy = img.y + img.h / 2;
      const rotation = (img.rotation || 0) * Math.PI / 180;
      const ddx = world.x - cx;
      const ddy = world.y - cy;
      const lx = ddx * Math.cos(-rotation) - ddy * Math.sin(-rotation);
      const ly = ddx * Math.sin(-rotation) + ddy * Math.cos(-rotation);
      return lx >= -dw/2 && lx <= dw/2 && ly >= -dh/2 && ly <= dh/2;
    }
    if (type === 'text' && this.selectedText) {
      const bounds = this._getTextBounds(this.selectedText);
      if (!bounds) return false;
      return world.x >= bounds.minX && world.x <= bounds.maxX &&
             world.y >= bounds.minY && world.y <= bounds.maxY;
    }
    return false;
  }

  // 获取当前视口在世界坐标中的边界
  getViewportBounds() {
    const w = this.mainCanvas.width / this.dpr;
    const h = this.mainCanvas.height / this.dpr;
    const topLeft = this.screenToWorld(0, 0);
    const bottomRight = this.screenToWorld(w, h);
    return {
      minX: topLeft.x,
      minY: topLeft.y,
      maxX: bottomRight.x,
      maxY: bottomRight.y,
      centerX: (topLeft.x + bottomRight.x) / 2,
      centerY: (topLeft.y + bottomRight.y) / 2,
      width: bottomRight.x - topLeft.x,
      height: bottomRight.y - topLeft.y,
    };
  }

  // 绘制单条笔画（手绘纸感风格）
  _drawStroke(ctx, stroke) {
    const points = stroke.points;
    if (points.length < 1) return;

    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // 添加轻微的粗糙感（纸感效果）
    ctx.beginPath();

    if (points.length === 1) {
      // 单点 -> 画圆点
      ctx.arc(points[0][0], points[0][1], stroke.width / 2, 0, Math.PI * 2);
      ctx.fillStyle = stroke.color;
      ctx.fill();
    } else {
      // 多点 -> 画平滑曲线
      ctx.moveTo(points[0][0], points[0][1]);

      for (let i = 1; i < points.length - 1; i++) {
        const xc = (points[i][0] + points[i + 1][0]) / 2;
        const yc = (points[i][1] + points[i + 1][1]) / 2;
        ctx.quadraticCurveTo(points[i][0], points[i][1], xc, yc);
      }

      // 最后一段
      const last = points[points.length - 1];
      ctx.lineTo(last[0], last[1]);
      ctx.stroke();
    }
  }

  // 设置渲染数据源
  setRenderSources(imagesGetter, strokesGetter, textsGetter) {
    this.renderImages = (ctx) => {
      const images = imagesGetter();
      for (const img of images) {
        this._drawImage(ctx, img);
      }
    };
    this.renderStrokes = (ctx) => {
      const strokes = strokesGetter();
      for (const s of strokes) {
        this._drawStroke(ctx, s);
      }
    };
    if (textsGetter) {
      this.renderTexts = (ctx) => {
        const texts = textsGetter();
        for (const t of texts) {
          this._drawText(ctx, t);
        }
      };
    }
  }

  // 绘制图片（支持旋转、透明度、缩放）
  _drawImage(ctx, img) {
    const rotation = img.rotation || 0;
    const opacity = img.opacity !== undefined ? img.opacity : 1;
    const scale = img.scale !== undefined ? img.scale : 1;
    const dw = img.w * scale;
    const dh = img.h * scale;
    const cx = img.x + img.w / 2;
    const cy = img.y + img.h / 2;

    let imageObj = this.imageCache.get(img.id);
    if (!imageObj) {
      imageObj = new Image();
      imageObj.onload = () => this.requestRender();
      imageObj.src = img.dataUrl;
      this.imageCache.set(img.id, imageObj);
      // 图片还在加载，先画占位框
      ctx.save();
      ctx.globalAlpha = opacity;
      ctx.translate(cx, cy);
      ctx.rotate(rotation * Math.PI / 180);
      ctx.fillStyle = 'rgba(254, 243, 199, 0.5)';
      ctx.fillRect(-dw / 2, -dh / 2, dw, dh);
      ctx.strokeStyle = '#422006';
      ctx.lineWidth = 2 / this.scale;
      ctx.setLineDash([6 / this.scale, 4 / this.scale]);
      ctx.strokeRect(-dw / 2, -dh / 2, dw, dh);
      ctx.setLineDash([]);
      ctx.restore();
      return;
    }

    if (imageObj.complete && imageObj.naturalWidth > 0) {
      ctx.save();
      ctx.globalAlpha = opacity;
      ctx.translate(cx, cy);
      ctx.rotate(rotation * Math.PI / 180);
      ctx.drawImage(imageObj, -dw / 2, -dh / 2, dw, dh);
      ctx.restore();
    }
  }

  // 绘制文字（支持旋转、透明度、缩放）
  _drawText(ctx, t) {
    const rotation = t.rotation || 0;
    const opacity = t.opacity !== undefined ? t.opacity : 1;
    const scale = t.scale !== undefined ? t.scale : 1;
    const fontSize = (t.fontSize || 24) * scale;
    const color = t.color || '#422006';
    const content = t.content || '';

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.font = `${fontSize}px 'Patrick Hand', 'Caveat', cursive`;
    ctx.fillStyle = color;
    ctx.textBaseline = 'top';
    ctx.translate(t.x, t.y);
    ctx.rotate(rotation * Math.PI / 180);

    // 支持多行文字
    const lines = content.split('\n');
    const lineHeight = fontSize * 1.3;
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], 0, i * lineHeight);
    }
    ctx.restore();
  }

  // 获取文字的边界框（世界坐标）
  _getTextBounds(t) {
    const content = t.content || '';
    if (!content) return null;
    const scale = t.scale !== undefined ? t.scale : 1;
    const fontSize = (t.fontSize || 24) * scale;
    const lines = content.split('\n');
    const lineHeight = fontSize * 1.3;

    // 使用 canvas measureText 获取文字宽度
    const ctx = this.ctx;
    ctx.save();
    ctx.font = `${fontSize}px 'Patrick Hand', 'Caveat', cursive`;
    let maxW = 0;
    for (const line of lines) {
      const m = ctx.measureText(line);
      if (m.width > maxW) maxW = m.width;
    }
    ctx.restore();

    const w = maxW;
    const h = lines.length * lineHeight;
    const rotation = (t.rotation || 0) * Math.PI / 180;
    const cx = t.x + w / 2;
    const cy = t.y + h / 2;
    // 旋转后的边界框
    const bw = Math.abs(w * Math.cos(rotation)) + Math.abs(h * Math.sin(rotation));
    const bh = Math.abs(w * Math.sin(rotation)) + Math.abs(h * Math.cos(rotation));
    return {
      minX: cx - bw / 2,
      minY: cy - bh / 2,
      maxX: cx + bw / 2,
      maxY: cy + bh / 2,
    };
  }

  // ===== 工具状态设置 =====

  setTool(tool) {
    this.currentTool = tool;
  }

  setColor(color) {
    this.currentColor = color;
  }

  setWidth(width) {
    this.currentWidth = width;
  }

  setSpacePressed(isPressed) {
    this._isSpacePressed = isPressed;
  }

  setPendingImage(dataUrl, naturalWidth, naturalHeight) {
    this.pendingImage = { dataUrl, naturalWidth, naturalHeight };
  }

  clearPendingImage() {
    this.pendingImage = null;
  }

  // ===== 视口控制 =====

  // 居中到指定世界坐标
  centerOn(worldX, worldY) {
    this.offsetX = this.width / 2 - worldX * this.scale;
    this.offsetY = this.height / 2 - worldY * this.scale;
    this.render();
    this._notifyViewportChange();
  }

  // 重置视口
  resetView() {
    this.offsetX = 0;
    this.offsetY = 0;
    this.scale = 1;
    this.render();
    this._notifyViewportChange();
  }

  // 缩放到指定级别，以屏幕中心为锚点
  zoomTo(newScale) {
    const cx = this.width / 2;
    const cy = this.height / 2;
    const world = this.screenToWorld(cx, cy);
    this.scale = Math.max(0.1, Math.min(10, newScale));
    this.offsetX = cx - world.x * this.scale;
    this.offsetY = cy - world.y * this.scale;
    this.render();
    this._notifyViewportChange();
  }

  _notifyViewportChange() {
    if (this.onViewportChange) {
      this.onViewportChange({
        offsetX: this.offsetX,
        offsetY: this.offsetY,
        scale: this.scale,
      });
    }
  }

  // ===== 导出辅助 =====

  // 计算所有内容的边界范围
  getContentBounds(strokes, images, texts) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (const s of strokes) {
      for (const [x, y] of s.points) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }

    for (const img of images) {
      const scale = img.scale !== undefined ? img.scale : 1;
      const dw = img.w * scale;
      const dh = img.h * scale;
      const rotation = (img.rotation || 0) * Math.PI / 180;
      const cx = img.x + img.w / 2;
      const cy = img.y + img.h / 2;
      // 旋转后的边界框
      const bw = Math.abs(dw * Math.cos(rotation)) + Math.abs(dh * Math.sin(rotation));
      const bh = Math.abs(dw * Math.sin(rotation)) + Math.abs(dh * Math.cos(rotation));
      minX = Math.min(minX, cx - bw / 2);
      minY = Math.min(minY, cy - bh / 2);
      maxX = Math.max(maxX, cx + bw / 2);
      maxY = Math.max(maxY, cy + bh / 2);
    }

    if (texts) {
      for (const t of texts) {
        const bounds = this._getTextBounds(t);
        if (bounds) {
          minX = Math.min(minX, bounds.minX);
          minY = Math.min(minY, bounds.minY);
          maxX = Math.max(maxX, bounds.maxX);
          maxY = Math.max(maxY, bounds.maxY);
        }
      }
    }

    // 如果没有内容，返回默认范围
    if (minX === Infinity) {
      return { minX: 0, minY: 0, maxX: this.width, maxY: this.height };
    }

    // 加边距
    const padding = 50;
    return {
      minX: minX - padding,
      minY: minY - padding,
      maxX: maxX + padding,
      maxY: maxY + padding,
    };
  }

  // 获取用于导出的离屏 canvas
  renderToOffscreen(strokes, images, width, height) {
    const offscreen = document.createElement('canvas');
    offscreen.width = width * this.dpr;
    offscreen.height = height * this.dpr;
    const ctx = offscreen.getContext('2d');
    ctx.scale(this.dpr, this.dpr);

    // 纸张背景
    ctx.fillStyle = '#fefce8';
    ctx.fillRect(0, 0, width, height);

    // 绘制图片
    for (const img of images) {
      let imageObj = this.imageCache.get(img.id);
      if (!imageObj) {
        imageObj = new Image();
        imageObj.src = img.dataUrl;
        this.imageCache.set(img.id, imageObj);
      }
      if (imageObj.complete && imageObj.naturalWidth > 0) {
        this._drawImage(ctx, img);
      }
    }

    // 绘制笔画
    for (const s of strokes) {
      this._drawStroke(ctx, s);
    }

    return offscreen;
  }

  // ===== 迷你地图 =====

  renderMinimap(minimapCanvas, strokes, images, texts) {
    const mctx = minimapCanvas.getContext('2d');
    const mw = minimapCanvas.width;
    const mh = minimapCanvas.height;

    mctx.clearRect(0, 0, mw, mh);
    mctx.fillStyle = '#fffbeb';
    mctx.fillRect(0, 0, mw, mh);

    const hasTexts = texts && texts.length > 0;
    if (strokes.length === 0 && images.length === 0 && !hasTexts) return;

    const bounds = this.getContentBounds(strokes, images, texts);
    const contentW = bounds.maxX - bounds.minX;
    const contentH = bounds.maxY - bounds.minY;
    if (contentW <= 0 || contentH <= 0) return;

    const padding = 10;
    const ratio = Math.min((mw - padding * 2) / contentW, (mh - padding * 2) / contentH);
    const offsetX = (mw - contentW * ratio) / 2 - bounds.minX * ratio;
    const offsetY = (mh - contentH * ratio) / 2 - bounds.minY * ratio;

    // 画笔画缩略
    mctx.strokeStyle = '#422006';
    mctx.lineWidth = 0.5;
    for (const s of strokes) {
      mctx.beginPath();
      const pts = s.points;
      if (pts.length > 0) {
        mctx.moveTo(pts[0][0] * ratio + offsetX, pts[0][1] * ratio + offsetY);
        for (let i = 1; i < pts.length; i++) {
          mctx.lineTo(pts[i][0] * ratio + offsetX, pts[i][1] * ratio + offsetY);
        }
        mctx.stroke();
      }
    }

    // 画图片缩略（色块）
    if (images) {
      for (const img of images) {
        const scale = img.scale !== undefined ? img.scale : 1;
        const ix = img.x * ratio + offsetX;
        const iy = img.y * ratio + offsetY;
        const iw = img.w * scale * ratio;
        const ih = img.h * scale * ratio;
        mctx.fillStyle = 'rgba(59, 130, 246, 0.25)';
        mctx.fillRect(ix, iy, iw, ih);
        mctx.strokeStyle = 'rgba(59, 130, 246, 0.6)';
        mctx.lineWidth = 0.5;
        mctx.strokeRect(ix, iy, iw, ih);
      }
    }

    // 画文字缩略（色块）
    if (texts) {
      for (const t of texts) {
        const bounds = this._getTextBounds(t);
        if (!bounds) continue;
        const tx = bounds.minX * ratio + offsetX;
        const ty = bounds.minY * ratio + offsetY;
        const tw = (bounds.maxX - bounds.minX) * ratio;
        const th = (bounds.maxY - bounds.minY) * ratio;
        mctx.fillStyle = 'rgba(234, 88, 12, 0.25)';
        mctx.fillRect(tx, ty, tw, th);
        mctx.strokeStyle = 'rgba(234, 88, 12, 0.6)';
        mctx.lineWidth = 0.5;
        mctx.strokeRect(tx, ty, tw, th);
      }
    }

    // 画其他用户光标位置
    if (this._remoteCursorsForMinimap) {
      for (const rc of this._remoteCursorsForMinimap) {
        const cx = rc.cursor.x * ratio + offsetX;
        const cy = rc.cursor.y * ratio + offsetY;
        mctx.fillStyle = rc.color || '#22c55e';
        mctx.beginPath();
        mctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
        mctx.fill();
      }
    }

    // 画当前视口矩形
    const viewWorld = this.screenToWorld(0, 0);
    const viewEnd = this.screenToWorld(this.width, this.height);
    mctx.strokeStyle = '#ef4444';
    mctx.lineWidth = 1.5;
    mctx.strokeRect(
      viewWorld.x * ratio + offsetX,
      viewWorld.y * ratio + offsetY,
      (viewEnd.x - viewWorld.x) * ratio,
      (viewEnd.y - viewWorld.y) * ratio
    );
  }
}
