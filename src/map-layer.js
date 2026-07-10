// ============================================
// map-layer.js - MapLibre GL JS 地图背景层
// ============================================
// 在地图模式下作为画布底层的地图背景
// 仅显示行政边界和陆海边界，极简白底风格
// 与上层 CanvasEngine 涂鸦层视口同步
// ============================================

export class MapLayer {
  constructor(container, canvasEngine) {
    this.container = container;
    this.engine = canvasEngine;
    this.map = null;
    this.onViewportChange = null;
    this._initialized = false;
  }

  async init() {
    try {
      // 动态导入 MapLibre GL JS
      const maplibregl = await import('https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js');

      // 等待 CSS 加载
      if (!document.getElementById('maplibre-css')) {
        const link = document.createElement('link');
        link.id = 'maplibre-css';
        link.rel = 'stylesheet';
        link.href = 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css';
        document.head.appendChild(link);
      }

      // 创建地图容器（位于 main-canvas 下方）
      const mapDiv = document.createElement('div');
      mapDiv.id = 'map-container';
      mapDiv.style.cssText = `
        position: absolute;
        top: 0; left: 0;
        width: 100%; height: 100%;
        z-index: 0;
        background: #ffffff;
      `;
      // 插入到 main-canvas 之前（z-index 更低）
      const mainCanvas = document.getElementById('main-canvas');
      mainCanvas.parentElement.insertBefore(mapDiv, mainCanvas);
      mainCanvas.style.zIndex = '1';
      mainCanvas.style.background = 'transparent';

      // 加载样式配置
      let styleUrl = '/map-data/style.json';
      try {
        const styleResp = await fetch(styleUrl);
        if (styleResp.ok) {
          const style = await styleResp.json();
          this.map = new maplibregl.Map({
            container: mapDiv,
            style: style,
            center: [0, 20],
            zoom: 1,
            minZoom: 0,
            maxZoom: 8,
            attributionControl: false,
            dragPan: false,      // 禁用 MapLibre 自带拖拽，由 CanvasEngine 控制
            scrollZoom: false,    // 禁用 MapLibre 自带滚轮缩放
            doubleClickZoom: false,
            touchZoomRotate: false,
            keyboard: false,
          });
        } else {
          throw new Error('Style not found');
        }
      } catch (styleErr) {
        console.warn('[MapLayer] 样式文件加载失败，使用内置样式:', styleErr.message);
        // 回退：使用简单的内置样式
        this.map = new maplibregl.Map({
          container: mapDiv,
          style: this._getFallbackStyle(),
          center: [0, 20],
          zoom: 1,
          minZoom: 0,
          maxZoom: 8,
          attributionControl: false,
          dragPan: false,
          scrollZoom: false,
          doubleClickZoom: false,
          touchZoomRotate: false,
          keyboard: false,
        });
      }

      // 地图加载完成
      this.map.on('load', () => {
        console.log('[MapLayer] 地图加载完成');
        this._initialized = true;
        // 初始同步视口
        this._syncToEngine();
      });

      // 地图移动时同步到 CanvasEngine
      this.map.on('move', () => {
        this._syncToEngine();
      });

      this.map.on('moveend', () => {
        this._syncToEngine();
      });

    } catch (err) {
      console.warn('[MapLayer] MapLibre 加载失败，回退到无地图背景:', err);
      // 回退：纯白背景，涂鸦功能不受影响
      this.container.style.background = '#ffffff';
    }
  }

  // 将 MapLibre 视口同步到 CanvasEngine
  _syncToEngine() {
    if (!this.map || !this.engine) return;

    const transform = this.map.getCenter();
    const zoom = this.map.getZoom();
    const centerLng = transform.lng;
    const centerLat = transform.lat;

    const worldCenter = this._lngLatToWorld(centerLng, centerLat);
    // 统一像素比例：zoom 0 时世界宽 360 度 = 256px
    const pixelScale = 256 * Math.pow(2, zoom) / 360;

    const rect = this.map.getContainer().getBoundingClientRect();
    this.engine.offsetX = rect.width / 2 - worldCenter.x * pixelScale;
    this.engine.offsetY = rect.height / 2 - worldCenter.y * pixelScale;
    this.engine.scale = pixelScale;

    this.engine.render();
    if (this.engine.onViewportChange) this.engine.onViewportChange();
  }

  // 经纬度 -> 世界坐标（墨卡托投影，Y 轴向下与屏幕一致）
  _lngLatToWorld(lng, lat) {
    const x = lng;
    const latRad = lat * Math.PI / 180;
    // Y 轴翻转：纬度越高 Y 越小（向上），与屏幕坐标一致
    const y = -180 / Math.PI * Math.log(Math.tan(Math.PI / 4 + latRad / 2));
    return { x, y };
  }

  // 世界坐标 -> 经纬度
  _worldToLngLat(x, y) {
    const lng = x;
    const yRad = -y * Math.PI / 180;
    const lat = 180 / Math.PI * (2 * Math.atan(Math.exp(yRad)) - Math.PI / 2);
    return { lng, lat };
  }

  // 屏幕坐标 -> 经纬度（供 CanvasEngine 调用）
  screenToLngLat(sx, sy) {
    if (!this.map) return null;
    return this.map.unproject([sx, sy]);
  }

  // 经纬度 -> 屏幕坐标（供 CanvasEngine 调用）
  lngLatToScreen(lng, lat) {
    if (!this.map) return null;
    return this.map.project([lng, lat]);
  }

  // 设置视口（CanvasEngine 平移/缩放时调用）
  setViewport(centerLng, centerLat, zoom) {
    if (!this.map) return;
    this.map.jumpTo({
      center: [centerLng, centerLat],
      zoom: zoom,
    });
  }

  // 获取导出用 canvas
  getCanvas() {
    if (!this.map) return null;
    return this.map.getCanvas();
  }

  // 销毁
  destroy() {
    if (this.map) {
      this.map.remove();
      this.map = null;
    }
    const mapDiv = document.getElementById('map-container');
    if (mapDiv) mapDiv.remove();
  }

  // 回退样式（当 style.json 加载失败时使用）
  _getFallbackStyle() {
    return {
      version: 8,
      sources: {},
      layers: [
        {
          id: 'background',
          type: 'background',
          paint: { 'background-color': '#ffffff' }
        }
      ]
    };
  }
}
