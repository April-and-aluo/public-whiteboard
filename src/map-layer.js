// ============================================
// map-layer.js - 地图背景层
// ============================================
// 在地图模式下作为画布底层的地图背景
// 优先使用 MapLibre GL JS（WebGL），回退到 Canvas 2D
// 仅显示行政边界和陆海边界，极简白底风格
// 与上层 CanvasEngine 涂鸦层视口同步
// ============================================

export class MapLayer {
  constructor(container, canvasEngine) {
    this.container = container;
    this.engine = canvasEngine;
    this.map = null;          // MapLibre 实例
    this.fallback = null;     // Canvas2D 回退实例
    this.onViewportChange = null;
    this._initialized = false;
    this._mode = 'none';      // 'maplibre' | 'canvas2d' | 'none'
  }

  async init() {
    // 检查 WebGL 是否可用
    const webglAvailable = this._checkWebGL();

    if (webglAvailable) {
      try {
        await this._initMapLibre();
        return;
      } catch (err) {
        console.warn('[MapLayer] MapLibre 初始化失败，回退到 Canvas 2D:', err.message);
      }
    } else {
      console.warn('[MapLayer] WebGL 不可用，使用 Canvas 2D 回退方案');
    }

    // Canvas 2D 回退
    try {
      await this._initCanvas2D();
    } catch (err) {
      console.warn('[MapLayer] Canvas 2D 回退也失败，以纯白背景继续:', err);
      this.container.style.background = '#ffffff';
      this._mode = 'none';
    }
  }

  // 检查 WebGL 是否可用
  _checkWebGL() {
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      return !!gl;
    } catch (e) {
      return false;
    }
  }

  // ===== MapLibre GL JS 模式 =====
  async _initMapLibre() {
    // 通过 <script> 标签加载 MapLibre GL JS（UMD 模块，import() 不兼容）
    if (!window.maplibregl) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js';
        script.onload = resolve;
        script.onerror = () => reject(new Error('MapLibre GL JS 加载失败'));
        document.head.appendChild(script);
      });
    }
    const maplibregl = window.maplibregl;

    // 加载 CSS
    if (!document.getElementById('maplibre-css')) {
      const link = document.createElement('link');
      link.id = 'maplibre-css';
      link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css';
      document.head.appendChild(link);
    }

    // 创建地图容器
    const mapDiv = document.createElement('div');
    mapDiv.id = 'map-container';
    mapDiv.style.cssText = `
      position: absolute;
      top: 0; left: 0;
      width: 100%; height: 100%;
      z-index: 0;
      background: #ffffff;
    `;
    const mainCanvas = document.getElementById('main-canvas');
    mainCanvas.parentElement.insertBefore(mapDiv, mainCanvas);
    mainCanvas.style.zIndex = '1';
    mainCanvas.style.background = 'transparent';

    // 加载样式配置
    let style;
    try {
      const styleResp = await fetch('/map-data/style.json');
      if (styleResp.ok) {
        style = await styleResp.json();
      } else {
        throw new Error('Style not found');
      }
    } catch (styleErr) {
      console.warn('[MapLayer] 样式文件加载失败，使用内置样式:', styleErr.message);
      style = this._getFallbackStyle();
    }

    this.map = new maplibregl.Map({
      container: mapDiv,
      style: style,
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

    this.map.on('load', () => {
      console.log('[MapLayer] MapLibre 地图加载完成');
      this._initialized = true;
      this._mode = 'maplibre';
      this._syncToEngine();
    });

    this.map.on('move', () => this._syncToEngine());
    this.map.on('moveend', () => this._syncToEngine());
  }

  // ===== Canvas 2D 回退模式 =====
  async _initCanvas2D() {
    // 加载 GeoJSON 数据
    let geoData;
    try {
      const resp = await fetch('/map-data/countries.geojson');
      if (!resp.ok) throw new Error('GeoJSON 加载失败');
      geoData = await resp.json();
    } catch (err) {
      throw new Error('无法加载 GeoJSON: ' + err.message);
    }

    // 创建地图 canvas
    const mapCanvas = document.createElement('canvas');
    mapCanvas.id = 'map-canvas-2d';
    mapCanvas.style.cssText = `
      position: absolute;
      top: 0; left: 0;
      width: 100%; height: 100%;
      z-index: 0;
      background: #ffffff;
      pointer-events: none;
    `;
    const mainCanvas = document.getElementById('main-canvas');
    mainCanvas.parentElement.insertBefore(mapCanvas, mainCanvas);
    mainCanvas.style.zIndex = '1';
    mainCanvas.style.background = 'transparent';

    const ctx = mapCanvas.getContext('2d');
    this.fallback = {
      canvas: mapCanvas,
      ctx: ctx,
      geoData: geoData,
      centerLng: 0,
      centerLat: 20,
      zoom: 1,
    };

    // 设置 canvas 尺寸
    this._resizeFallbackCanvas();

    // 监听窗口大小变化
    this._resizeHandler = () => this._resizeFallbackCanvas();
    window.addEventListener('resize', this._resizeHandler);

    console.log('[MapLayer] Canvas 2D 地图初始化完成');
    this._initialized = true;
    this._mode = 'canvas2d';
    this._syncToEngine();
  }

  _resizeFallbackCanvas() {
    if (!this.fallback) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = this.fallback.canvas.getBoundingClientRect();
    this.fallback.canvas.width = rect.width * dpr;
    this.fallback.canvas.height = rect.height * dpr;
    this.fallback.ctx.scale(dpr, dpr);
    this._renderFallback();
  }

  // Canvas 2D 渲染地图
  _renderFallback() {
    if (!this.fallback) return;
    const { ctx, geoData, centerLng, centerLat, zoom } = this.fallback;
    const rect = this.fallback.canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    ctx.clearRect(0, 0, w, h);

    // 像素比例：zoom 0 时世界宽 360 度 = 256px
    const pixelScale = 256 * Math.pow(2, zoom) / 360;
    const worldCenter = this._lngLatToWorld(centerLng, centerLat);
    const offsetX = w / 2 - worldCenter.x * pixelScale;
    const offsetY = h / 2 - worldCenter.y * pixelScale;

    // 同步到 engine
    this.engine.offsetX = offsetX;
    this.engine.offsetY = offsetY;
    this.engine.scale = pixelScale;

    // 绘制国家填充
    ctx.fillStyle = '#f0f0f0';
    for (const feature of geoData.features) {
      this._drawFeature(ctx, feature, offsetX, offsetY, pixelScale, true);
    }

    // 绘制国家边界
    ctx.strokeStyle = '#b0b0b0';
    ctx.lineWidth = Math.max(0.5, pixelScale * 0.5);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const feature of geoData.features) {
      this._drawFeature(ctx, feature, offsetX, offsetY, pixelScale, false);
    }

    this.engine.render();
    if (this.engine.onViewportChange) this.engine.onViewportChange();
  }

  _drawFeature(ctx, feature, offsetX, offsetY, scale, fill) {
    const geometry = feature.geometry;
    if (!geometry) return;

    const coords = geometry.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry.coordinates;

    for (const polygon of coords) {
      for (const ring of polygon) {
        ctx.beginPath();
        for (let i = 0; i < ring.length; i++) {
          const [lng, lat] = ring[i];
          const world = this._lngLatToWorld(lng, lat);
          const sx = world.x * scale + offsetX;
          const sy = world.y * scale + offsetY;
          if (i === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        }
        ctx.closePath();
        if (fill) ctx.fill();
        else ctx.stroke();
      }
    }
  }

  // 将视口同步到 CanvasEngine
  _syncToEngine() {
    if (this._mode === 'maplibre' && this.map) {
      this._syncMapLibreToEngine();
    } else if (this._mode === 'canvas2d' && this.fallback) {
      this._renderFallback();
    }
  }

  _syncMapLibreToEngine() {
    if (!this.map || !this.engine) return;

    const transform = this.map.getCenter();
    const zoom = this.map.getZoom();
    const centerLng = transform.lng;
    const centerLat = transform.lat;

    const worldCenter = this._lngLatToWorld(centerLng, centerLat);
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
    if (this._mode === 'maplibre' && this.map) {
      return this.map.unproject([sx, sy]);
    }
    if (this._mode === 'canvas2d' && this.fallback) {
      // 反算：屏幕 -> 世界 -> 经纬度
      const wx = (sx - this.engine.offsetX) / this.engine.scale;
      const wy = (sy - this.engine.offsetY) / this.engine.scale;
      return this._worldToLngLat(wx, wy);
    }
    return null;
  }

  // 经纬度 -> 屏幕坐标（供 CanvasEngine 调用）
  lngLatToScreen(lng, lat) {
    if (this._mode === 'maplibre' && this.map) {
      return this.map.project([lng, lat]);
    }
    if (this._mode === 'canvas2d' && this.fallback) {
      const world = this._lngLatToWorld(lng, lat);
      return {
        x: world.x * this.engine.scale + this.engine.offsetX,
        y: world.y * this.engine.scale + this.engine.offsetY,
      };
    }
    return null;
  }

  // 设置视口（CanvasEngine 平移/缩放时调用）
  setViewport(centerLng, centerLat, zoom) {
    if (this._mode === 'maplibre' && this.map) {
      this.map.jumpTo({ center: [centerLng, centerLat], zoom });
    } else if (this._mode === 'canvas2d' && this.fallback) {
      this.fallback.centerLng = centerLng;
      this.fallback.centerLat = centerLat;
      this.fallback.zoom = zoom;
      this._renderFallback();
    }
  }

  // 获取导出用 canvas
  getCanvas() {
    if (this._mode === 'maplibre' && this.map) {
      return this.map.getCanvas();
    }
    if (this._mode === 'canvas2d' && this.fallback) {
      return this.fallback.canvas;
    }
    return null;
  }

  // 获取当前模式
  getMode() {
    return this._mode;
  }

  // 销毁
  destroy() {
    if (this.map) {
      this.map.remove();
      this.map = null;
    }
    if (this._resizeHandler) {
      window.removeEventListener('resize', this._resizeHandler);
    }
    const mapDiv = document.getElementById('map-container');
    if (mapDiv) mapDiv.remove();
    const mapCanvas = document.getElementById('map-canvas-2d');
    if (mapCanvas) mapCanvas.remove();
    this.fallback = null;
    this._mode = 'none';
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
