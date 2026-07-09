// ============================================
// cursor-layer.js - 实时光标层
// ============================================
// 在独立的 canvas 上绘制其他在线用户的光标和昵称
// 不重绘主画布，性能友好
// ============================================

export class CursorLayer {
  constructor(cursorCanvas, canvasEngine) {
    this.canvas = cursorCanvas;
    this.ctx = cursorCanvas.getContext('2d');
    this.engine = canvasEngine;
    this.cursors = []; // 远程用户光标列表
    this.renderQueued = false;
    this.isMobile = window.innerWidth < 768;
    this.lastUpdateTime = 0;
    this.updateInterval = this.isMobile ? 33 : 16; // 移动端 30fps，桌面端 60fps
  }

  // 更新光标数据并请求渲染
  update(cursors) {
    const now = performance.now();
    if (now - this.lastUpdateTime < this.updateInterval) return;
    this.lastUpdateTime = now;

    this.cursors = cursors;
    this.requestRender();
  }

  requestRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  render() {
    const ctx = this.ctx;
    const w = this.canvas.clientWidth || this.canvas.width;
    const h = this.canvas.clientHeight || this.canvas.height;
    ctx.clearRect(0, 0, w, h);

    for (const c of this.cursors) {
      if (!c.cursor) continue;

      // 世界坐标 -> 屏幕坐标
      const screen = this.engine.worldToScreen(c.cursor.x, c.cursor.y);

      // 视口裁剪
      if (screen.x < -100 || screen.x > w + 100 || screen.y < -50 || screen.y > h + 50) continue;

      // 画箭头光标
      ctx.save();
      ctx.translate(screen.x, screen.y);

      // 光标图标（手绘风格箭头）
      ctx.fillStyle = c.color;
      ctx.strokeStyle = '#422006';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, 16);
      ctx.lineTo(4, 12);
      ctx.lineTo(7, 18);
      ctx.lineTo(9, 17);
      ctx.lineTo(6, 11);
      ctx.lineTo(11, 11);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // 昵称标签
      ctx.font = "14px 'Patrick Hand', cursive";
      const textWidth = ctx.measureText(c.name).width;
      const labelX = 14;
      const labelY = 18;
      const padding = 6;

      // 标签背景
      ctx.fillStyle = c.color;
      ctx.strokeStyle = '#422006';
      ctx.lineWidth = 1.5;
      this._roundRect(ctx, labelX, labelY, textWidth + padding * 2, 22, 6);
      ctx.fill();
      ctx.stroke();

      // 标签文字
      ctx.fillStyle = '#ffffff';
      ctx.textBaseline = 'middle';
      ctx.fillText(c.name, labelX + padding, labelY + 11);

      ctx.restore();
    }
  }

  // 圆角矩形辅助
  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // 检测是否为移动端（响应式更新）
  checkMobile() {
    this.isMobile = window.innerWidth < 768;
    this.updateInterval = this.isMobile ? 33 : 16;
  }
}
