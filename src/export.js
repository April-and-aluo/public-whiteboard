// ============================================
// export.js - 导出功能
// ============================================
// 将整块展示板内容导出为 PNG 图片
// ============================================

export class ExportManager {
  constructor(canvasEngine, yjsSync) {
    this.engine = canvasEngine;
    this.yjs = yjsSync;
  }

  // 导出全部内容为 PNG
  exportAll() {
    const strokes = this.yjs.getAllStrokes();
    const images = this.yjs.getAllImages();

    if (strokes.length === 0 && images.length === 0) {
      alert('画板是空的，先画点什么吧！');
      return;
    }

    // 计算内容边界
    const bounds = this.engine.getContentBounds(strokes, images);
    const contentW = bounds.maxX - bounds.minX;
    const contentH = bounds.maxY - bounds.minY;

    // 限制最大导出尺寸
    const maxDimension = 4096;
    let exportScale = 1;
    if (contentW > maxDimension || contentH > maxDimension) {
      exportScale = Math.min(maxDimension / contentW, maxDimension / contentH);
    }

    const exportW = Math.ceil(contentW * exportScale);
    const exportH = Math.ceil(contentH * exportScale);

    // 创建离屏 canvas
    const offscreen = document.createElement('canvas');
    const dpr = window.devicePixelRatio || 1;
    offscreen.width = exportW * dpr;
    offscreen.height = exportH * dpr;
    const ctx = offscreen.getContext('2d');
    ctx.scale(dpr, dpr);

    // 纸张背景
    ctx.fillStyle = '#fefce8';
    ctx.fillRect(0, 0, exportW, exportH);

    // 应用变换：将世界坐标的内容偏移到 (0,0) 起点
    ctx.translate(-bounds.minX * exportScale, -bounds.minY * exportScale);
    ctx.scale(exportScale, exportScale);

    // 绘制图片
    for (const img of images) {
      let imageObj = this.engine.imageCache.get(img.id);
      if (!imageObj) {
        imageObj = new Image();
        imageObj.src = img.dataUrl;
        this.engine.imageCache.set(img.id, imageObj);
      }
      if (imageObj.complete && imageObj.naturalWidth > 0) {
        this.engine._drawImage(ctx, img);
      }
    }

    // 绘制笔画
    for (const s of strokes) {
      this._drawStroke(ctx, s);
    }

    // 下载
    offscreen.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `whiteboard-${new Date().toISOString().slice(0, 10)}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 'image/png');
  }

  // 导出当前视口
  exportViewport() {
    const mainCanvas = this.engine.mainCanvas;
    const dpr = this.engine.dpr;

    // 创建离屏 canvas，复制当前画布
    const offscreen = document.createElement('canvas');
    offscreen.width = mainCanvas.width;
    offscreen.height = mainCanvas.height;
    const ctx = offscreen.getContext('2d');

    // 填充纸张背景
    ctx.fillStyle = '#fefce8';
    ctx.fillRect(0, 0, offscreen.width, offscreen.height);

    // 复制当前画布内容
    ctx.drawImage(mainCanvas, 0, 0);

    // 下载
    offscreen.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `whiteboard-viewport-${new Date().toISOString().slice(0, 10)}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 'image/png');
  }

  // 绘制笔画（与 canvas-engine 保持一致的纸感风格）
  _drawStroke(ctx, stroke) {
    const points = stroke.points;
    if (points.length < 1) return;

    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();

    if (points.length === 1) {
      ctx.arc(points[0][0], points[0][1], stroke.width / 2, 0, Math.PI * 2);
      ctx.fillStyle = stroke.color;
      ctx.fill();
    } else {
      ctx.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length - 1; i++) {
        const xc = (points[i][0] + points[i + 1][0]) / 2;
        const yc = (points[i][1] + points[i + 1][1]) / 2;
        ctx.quadraticCurveTo(points[i][0], points[i][1], xc, yc);
      }
      const last = points[points.length - 1];
      ctx.lineTo(last[0], last[1]);
      ctx.stroke();
    }
  }
}
