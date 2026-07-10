// ============================================
// map-layer.js - 地图背景层
// ============================================
// 在地图模式下作为画布底层的地图背景
// 优先使用 MapLibre GL JS（WebGL），回退到 Canvas 2D
// 显示国家边界 + 省/州行政区划边界
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
    this._maxZoom = 13;       // 最大缩放级别
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
    // 通过 <script> 标签加载 MapLibre GL JS
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
      maxZoom: this._maxZoom,
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
    // 并行加载国家边界和行政区划数据
    const [countryData, admin1Data] = await Promise.all([
      this._loadGeoJSON('/map-data/countries.geojson'),
      this._loadGeoJSON('/map-data/admin1.geojson'),
    ]);

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

    // 预处理 GeoJSON：将跨日期变更线的多边形切割
    const processedCountries = this._preprocessGeoJSON(countryData);
    const processedAdmin1 = this._preprocessGeoJSON(admin1Data);

    this.fallback = {
      canvas: mapCanvas,
      ctx: ctx,
      countries: processedCountries,
      admin1: processedAdmin1,
      centerLng: 0,
      centerLat: 20,
      zoom: 1,
    };

    // 设置 canvas 尺寸
    this._resizeFallbackCanvas();

    // 监听窗口大小变化
    this._resizeHandler = () => this._resizeFallbackCanvas();
    window.addEventListener('resize', this._resizeHandler);

    console.log('[MapLayer] Canvas 2D 地图初始化完成 (国家:' + processedCountries.features.length + ', 行政区:' + processedAdmin1.features.length + ')');
    this._initialized = true;
    this._mode = 'canvas2d';
    this._syncToEngine();
  }

  async _loadGeoJSON(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('加载失败: ' + url);
    return await resp.json();
  }

  // 预处理 GeoJSON：切割跨日期变更线的多边形
  _preprocessGeoJSON(geoData) {
    const result = {
      type: 'FeatureCollection',
      features: [],
    };

    for (const feature of geoData.features) {
      const processed = this._splitAntimeridianFeature(feature);
      result.features.push(...processed);
    }

    return result;
  }

  // 切割跨日期变更线的 feature
  _splitAntimeridianFeature(feature) {
    if (!feature.geometry) return [feature];

    const geom = feature.geometry;
    const results = [];

    if (geom.type === 'Polygon') {
      const split = this._splitAntimeridianPolygon(geom.coordinates);
      for (const poly of split) {
        results.push({
          ...feature,
          geometry: { type: 'Polygon', coordinates: poly },
        });
      }
    } else if (geom.type === 'MultiPolygon') {
      for (const polygon of geom.coordinates) {
        const split = this._splitAntimeridianPolygon(polygon);
        for (const poly of split) {
          results.push({
            ...feature,
            geometry: { type: 'Polygon', coordinates: poly },
          });
        }
      }
    } else {
      results.push(feature);
    }

    return results;
  }

  // 切割跨日期变更线的多边形
  // 返回一个数组，每个元素是一个 polygon（外环+内环的数组）
  _splitAntimeridianPolygon(polygon) {
    // polygon = [outerRing, hole1, hole2, ...]
    const splitRings = [];
    for (const ring of polygon) {
      const split = this._splitAntimeridianRing(ring);
      splitRings.push(split);
    }

    // 外环可能被拆分成多段，每段形成一个新多边形
    const outerParts = splitRings[0];
    const holes = splitRings.slice(1);

    const result = [];
    for (const outer of outerParts) {
      // 为每个外环找到包含的洞
      const myHoles = [];
      for (const holeParts of holes) {
        for (const hole of holeParts) {
          if (hole.length > 0) {
            const hcx = hole[0][0];
            const ocx = outer[0][0];
            // 简单地按经度范围判断
            if (Math.abs(hcx - ocx) < 180) {
              myHoles.push(hole);
            }
          }
        }
      }
      result.push([outer, ...myHoles]);
    }

    return result.length > 0 ? result : [polygon];
  }

  // 切割跨日期变更线的环
  _splitAntimeridianRing(ring) {
    const segments = [];
    let currentSegment = [];

    for (let i = 0; i < ring.length; i++) {
      const [lng, lat] = ring[i];

      if (currentSegment.length === 0) {
        currentSegment.push([lng, lat]);
        continue;
      }

      const prev = currentSegment[currentSegment.length - 1];
      const prevLng = prev[0];
      const delta = lng - prevLng;

      // 如果经度跳跃超过 180°，说明跨了日期变更线
      if (Math.abs(delta) > 180) {
        // 结束当前段
        if (currentSegment.length > 1) {
          segments.push(currentSegment);
        }
        // 开始新段
        currentSegment = [[lng, lat]];
      } else {
        currentSegment.push([lng, lat]);
      }
    }

    if (currentSegment.length > 1) {
      segments.push(currentSegment);
    }

    // 确保每个段是闭合的
    for (const seg of segments) {
      if (seg.length > 0) {
        const first = seg[0];
        const last = seg[seg.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) {
          seg.push([first[0], first[1]]);
        }
      }
    }

    return segments;
  }

  _resizeFallbackCanvas() {
    if (!this.fallback) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = this.fallback.canvas.getBoundingClientRect();
    this.fallback.canvas.width = rect.width * dpr;
    this.fallback.canvas.height = rect.height * dpr;
    this.fallback.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.fallback.ctx.scale(dpr, dpr);
    this._renderFallback();
  }

  // Canvas 2D 渲染地图
  _renderFallback() {
    if (!this.fallback) return;
    const { ctx, countries, admin1, centerLng, centerLat, zoom } = this.fallback;
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

    // 1. 绘制国家填充
    ctx.fillStyle = '#f5f5f0';
    for (const feature of countries.features) {
      this._drawFeature(ctx, feature, offsetX, offsetY, pixelScale, true);
    }

    // 2. 绘制省/州行政区划边界（较细、较浅）
    ctx.strokeStyle = '#d0d0c8';
    ctx.lineWidth = Math.max(0.3, pixelScale * 0.2);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const feature of admin1.features) {
      this._drawFeature(ctx, feature, offsetX, offsetY, pixelScale, false);
    }

    // 3. 绘制国家边界（较粗、较深）
    ctx.strokeStyle = '#999999';
    ctx.lineWidth = Math.max(0.5, pixelScale * 0.4);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const feature of countries.features) {
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

  // 屏幕坐标 -> 经纬度
  screenToLngLat(sx, sy) {
    if (this._mode === 'maplibre' && this.map) {
      return this.map.unproject([sx, sy]);
    }
    if (this._mode === 'canvas2d' && this.fallback) {
      const wx = (sx - this.engine.offsetX) / this.engine.scale;
      const wy = (sy - this.engine.offsetY) / this.engine.scale;
      return this._worldToLngLat(wx, wy);
    }
    return null;
  }

  // 经纬度 -> 屏幕坐标
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

  // Canvas 2D 模式：通过像素增量平移地图
  panByPixels(dx, dy) {
    if (this._mode !== 'canvas2d' || !this.fallback) return;
    const pixelScale = 256 * Math.pow(2, this.fallback.zoom) / 360;
    // 像素增量 -> 经纬度增量
    const dLng = -dx / pixelScale;
    // 纬度增量需要考虑墨卡托投影的非线性
    const centerWorld = this._lngLatToWorld(this.fallback.centerLng, this.fallback.centerLat);
    const newCenterWorldY = centerWorld.y - dy / pixelScale;
    const newCenter = this._worldToLngLat(centerWorld.x + dLng, newCenterWorldY);
    this.fallback.centerLng = newCenter.lng;
    this.fallback.centerLat = newCenter.lat;
    this._renderFallback();
  }

  // Canvas 2D 模式：以屏幕坐标为中心缩放
  zoomAt(screenX, screenY, newZoom) {
    if (this._mode !== 'canvas2d' || !this.fallback) return;
    const clampedZoom = Math.max(0, Math.min(this._maxZoom, newZoom));
    // 缩放前鼠标位置对应的经纬度
    const before = this.screenToLngLat(screenX, screenY);
    if (!before) return;
    this.fallback.zoom = clampedZoom;
    // 缩放后该经纬度对应的屏幕位置
    const after = this.lngLatToScreen(before.lng, before.lat);
    if (!after) return;
    // 调整中心使鼠标位置保持不变
    const dx = after.x - screenX;
    const dy = after.y - screenY;
    this.panByPixels(dx, dy);
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
