// ============================================
// map-layer.js - 地图背景层（分区块加载版）
// ============================================
// 高精度地图数据按 20°×20° 网格分块
// 只加载视口可见范围内的区块，降低服务器压力
// 国家边界一次性加载（低精度概览）
// 行政区划按需分块加载（高精度 GeoBoundaries）
// ============================================

export class MapLayer {
  constructor(container, canvasEngine) {
    this.container = container;
    this.engine = canvasEngine;
    this.map = null;
    this.fallback = null;
    this.onViewportChange = null;
    this._initialized = false;
    this._mode = 'none';
    this._maxZoom = 10;
    this._minZoom = 3;        // 大幅提高最小缩放：不允许看到大洲全貌
    this._tileSize = 20;      // 区块大小（度）
    this._loadedTiles = new Map();    // tileId -> features[]
    this._loadingTiles = new Set();   // 正在加载的区块
    this._tileUpdateTimer = null;     // 防抖计时器
    this._manifest = null;
    this._tileBaseURL = 'https://cdn.jsdelivr.net/gh/april-and-aluo/public-whiteboard@main/src/map-data/tiles';
    this._cdnBase = 'https://cdn.jsdelivr.net/gh/april-and-aluo/public-whiteboard@main/src/map-data';
  }

  async init() {
    const webglAvailable = this._checkWebGL();
    if (webglAvailable) {
      try {
        await this._initMapLibre();
        return;
      } catch (err) {
        console.warn('[MapLayer] MapLibre 失败，回退 Canvas 2D:', err.message);
      }
    } else {
      console.warn('[MapLayer] WebGL 不可用，使用 Canvas 2D');
    }
    try {
      await this._initCanvas2D();
    } catch (err) {
      console.warn('[MapLayer] Canvas 2D 也失败:', err);
      this.container.style.background = '#ffffff';
      this._mode = 'none';
    }
  }

  _checkWebGL() {
    try {
      const c = document.createElement('canvas');
      return !!(c.getContext('webgl') || c.getContext('experimental-webgl'));
    } catch (e) { return false; }
  }

  // ===== 区块加载核心逻辑 =====

  // 计算视口可见的区块 ID 列表（含一圈缓冲区）
  _getVisibleTileIds(lngMin, latMin, lngMax, latMax) {
    const ts = this._tileSize;
    const buf = ts; // 一圈缓冲
    const startLng = Math.floor((lngMin - buf) / ts) * ts;
    const endLng = Math.ceil((lngMax + buf) / ts) * ts;
    const startLat = Math.floor((latMin - buf) / ts) * ts;
    const endLat = Math.ceil((latMax + buf) / ts) * ts;
    const ids = [];
    for (let lat = startLat; lat < endLat; lat += ts) {
      for (let lng = startLng; lng < endLng; lng += ts) {
        ids.push(`${lng}_${lat}`);
      }
    }
    return ids;
  }

  // 防抖更新区块
  _scheduleTileUpdate() {
    if (this._tileUpdateTimer) clearTimeout(this._tileUpdateTimer);
    this._tileUpdateTimer = setTimeout(() => this._updateTiles(), 200);
  }

  // 加载新区块、卸载远离的区块
  async _updateTiles() {
    if (!this._initialized) return;

    let lngMin, latMin, lngMax, latMax;
    if (this._mode === 'maplibre' && this.map) {
      const b = this.map.getBounds();
      lngMin = b.getWest(); lngMax = b.getEast();
      latMin = b.getSouth(); latMax = b.getNorth();
    } else if (this._mode === 'canvas2d' && this.fallback) {
      const vp = this._getCanvasViewport();
      lngMin = vp.lngMin; lngMax = vp.lngMax;
      latMin = vp.latMin; latMax = vp.latMax;
    } else {
      return;
    }

    const visibleIds = new Set(this._getVisibleTileIds(lngMin, latMin, lngMax, latMax));

    // 卸载不可见的区块（保留两圈缓冲内的）
    const unloadBuffer = this._tileSize * 2;
    for (const [tileId] of this._loadedTiles) {
      if (!visibleIds.has(tileId)) {
        const [tlng, tlat] = tileId.split('_').map(Number);
        // 只卸载远离视口的区块
        if (tlng < lngMin - unloadBuffer || tlng > lngMax + unloadBuffer ||
            tlat < latMin - unloadBuffer || tlat > latMax + unloadBuffer) {
          this._loadedTiles.delete(tileId);
        }
      }
    }

    // 加载可见但未加载的区块
    const toLoad = [];
    for (const id of visibleIds) {
      if (!this._loadedTiles.has(id) && !this._loadingTiles.has(id)) {
        toLoad.push(id);
      }
    }

    // 限制并发加载数量
    const MAX_CONCURRENT = 4;
    const batch = toLoad.slice(0, MAX_CONCURRENT);
    for (const id of batch) {
      this._loadTile(id);
    }
    // 剩余的稍后加载
    if (toLoad.length > MAX_CONCURRENT) {
      setTimeout(() => {
        for (const id of toLoad.slice(MAX_CONCURRENT)) {
          if (!this._loadedTiles.has(id) && !this._loadingTiles.has(id)) {
            this._loadTile(id);
          }
        }
      }, 500);
    }

    this._refreshAdmin1Data();
  }

  async _loadTile(tileId) {
    if (this._loadedTiles.has(tileId) || this._loadingTiles.has(tileId)) return;
    this._loadingTiles.add(tileId);

    try {
      const resp = await fetch(`${this._tileBaseURL}/${tileId}/admin1.geojson`);
      if (!resp.ok) {
        console.warn('[MapLayer] Tile not found:', tileId, resp.status);
        this._loadingTiles.delete(tileId);
        return;
      }
      const data = await resp.json();
      const features = data.features || [];
      console.log('[MapLayer] Tile loaded:', tileId, features.length, 'features');
      if (features.length > 0) {
        const processed = this._preprocessGeoJSON({ features });
        this._loadedTiles.set(tileId, processed.features);
      } else {
        this._loadedTiles.set(tileId, []);
      }
      this._refreshAdmin1Data();
    } catch (e) {
      console.error('[MapLayer] Tile load error:', tileId, e.message);
    } finally {
      this._loadingTiles.delete(tileId);
    }
  }

  // 将所有已加载区块的数据合并，更新到地图/画布
  _refreshAdmin1Data() {
    const allFeatures = [];
    const seen = new Set();
    for (const [, feats] of this._loadedTiles) {
      for (const f of feats) {
        // 去重（同一要素可能出现在多个区块中）
        const key = (f.properties?.name || '') + '_' + (f.properties?.country || '') +
          '_' + (f.geometry?.coordinates?.[0]?.[0]?.[0] || '');
        if (!seen.has(key)) {
          seen.add(key);
          allFeatures.push(f);
        }
      }
    }

    if (this._mode === 'maplibre' && this.map) {
      const src = this.map.getSource('admin1');
      if (src) {
        src.setData({ type: 'FeatureCollection', features: allFeatures });
      }
    } else if (this._mode === 'canvas2d' && this.fallback) {
      this.fallback.admin1 = { type: 'FeatureCollection', features: allFeatures };
      this._renderFallback();
    }
  }

  // ===== MapLibre GL JS 模式 =====

  async _initMapLibre() {
    if (!window.maplibregl) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error('MapLibre 加载失败'));
        document.head.appendChild(s);
      });
    }
    if (!document.getElementById('maplibre-css')) {
      const link = document.createElement('link');
      link.id = 'maplibre-css'; link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css';
      document.head.appendChild(link);
    }

    const mapDiv = document.createElement('div');
    mapDiv.id = 'map-container';
    mapDiv.style.cssText = `position:absolute;top:0;left:0;width:100%;height:100%;z-index:0;background:#fff;`;
    const mainCanvas = document.getElementById('main-canvas');
    mainCanvas.parentElement.insertBefore(mapDiv, mainCanvas);
    mainCanvas.style.zIndex = '1';
    mainCanvas.style.background = 'transparent';

    // 从 CDN 加载国家边界（完整精度，3.5MB，146K顶点）
    const countryData = await this._loadGeoJSON(`${this._cdnBase}/countries.geojson`).catch(() => {
      // CDN 失败时回退到服务器
      return this._loadGeoJSON('/map-data/countries.geojson').catch(() => null);
    });
    const processedCountries = countryData ? this._preprocessGeoJSON(countryData) : null;
    console.log('[MapLayer] Countries loaded:', processedCountries?.features?.length || 0, 'features');

    const style = {
      version: 8, sources: {},
      layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#fff' } }]
    };

    this.map = new maplibregl.Map({
      container: mapDiv, style,
      center: [0, 30], zoom: 3.5,
      minZoom: this._minZoom, maxZoom: this._maxZoom,
      attributionControl: false,
      dragPan: false, scrollZoom: false, doubleClickZoom: false,
      touchZoomRotate: false, keyboard: false,
    });

    this.map.on('load', () => {
      // 国家填充和边界
      if (processedCountries) {
        this.map.addSource('countries', { type: 'geojson', data: processedCountries });
        this.map.addLayer({
          id: 'country-fill', type: 'fill', source: 'countries',
          paint: { 'fill-color': '#f5f5f0', 'fill-opacity': 1 },
        });
        this.map.addLayer({
          id: 'country-borders', type: 'line', source: 'countries',
          paint: {
            'line-color': '#999',
            'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.8, 5, 1.2, 7, 2.0, 10, 3.0],
            'line-opacity': 0.8,
          },
          layout: { 'line-join': 'round', 'line-cap': 'round' },
        });
      }

      // 行政区划（空数据源，按区块动态填充）
      this.map.addSource('admin1', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      this.map.addLayer({
        id: 'admin1-borders', type: 'line', source: 'admin1',
        paint: {
          'line-color': '#c8c8c0',
          'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.5, 5, 0.7, 7, 1.0, 10, 2.0],
          'line-opacity': 0.6,
        },
        layout: { 'line-join': 'round', 'line-cap': 'round' },
      });

      this._initialized = true;
      this._mode = 'maplibre';
      this._syncToEngine();
      this._updateTiles();
    });

    this.map.on('move', () => this._syncToEngine());
    this.map.on('moveend', () => { this._syncToEngine(); this._scheduleTileUpdate(); });
  }

  // ===== Canvas 2D 回退模式 =====

  async _initCanvas2D() {
    // 从 CDN 加载国家边界
    const countryData = await this._loadGeoJSON(`${this._cdnBase}/countries.geojson`).catch(() => {
      return this._loadGeoJSON('/map-data/countries.geojson').catch(() => null);
    });
    if (!countryData) throw new Error('无法加载国家数据');
    const processedCountries = this._preprocessGeoJSON(countryData);
    console.log('[MapLayer] Canvas2D countries:', processedCountries.features.length, 'features');

    const mapCanvas = document.createElement('canvas');
    mapCanvas.id = 'map-canvas-2d';
    mapCanvas.style.cssText = `position:absolute;top:0;left:0;width:100%;height:100%;z-index:0;background:#fff;pointer-events:none;`;
    const mainCanvas = document.getElementById('main-canvas');
    mainCanvas.parentElement.insertBefore(mapCanvas, mainCanvas);
    mainCanvas.style.zIndex = '1';
    mainCanvas.style.background = 'transparent';

    this.fallback = {
      canvas: mapCanvas, ctx: mapCanvas.getContext('2d'),
      countries: processedCountries,
      admin1: { type: 'FeatureCollection', features: [] },
      centerLng: 0, centerLat: 30, zoom: 3.5,
    };

    this._resizeFallbackCanvas();
    this._resizeHandler = () => this._resizeFallbackCanvas();
    window.addEventListener('resize', this._resizeHandler);

    this._initialized = true;
    this._mode = 'canvas2d';
    this._syncToEngine();
    this._updateTiles();
  }

  async _loadGeoJSON(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('加载失败: ' + url);
    return await resp.json();
  }

  // 预处理 GeoJSON：切割跨日期变更线的多边形
  _preprocessGeoJSON(geoData) {
    const result = { type: 'FeatureCollection', features: [] };
    for (const feature of geoData.features) {
      const processed = this._splitAntimeridianFeature(feature);
      result.features.push(...processed);
    }
    return result;
  }

  _splitAntimeridianFeature(feature) {
    if (!feature.geometry) return [feature];
    const geom = feature.geometry;
    const results = [];
    if (geom.type === 'Polygon') {
      const split = this._splitAntimeridianPolygon(geom.coordinates);
      for (const poly of split) {
        results.push({ ...feature, geometry: { type: 'Polygon', coordinates: poly } });
      }
    } else if (geom.type === 'MultiPolygon') {
      for (const polygon of geom.coordinates) {
        const split = this._splitAntimeridianPolygon(polygon);
        for (const poly of split) {
          results.push({ ...feature, geometry: { type: 'Polygon', coordinates: poly } });
        }
      }
    } else { results.push(feature); }
    return results;
  }

  _splitAntimeridianPolygon(polygon) {
    const splitRings = [];
    for (const ring of polygon) { splitRings.push(this._splitAntimeridianRing(ring)); }
    const outerParts = splitRings[0];
    const holes = splitRings.slice(1);
    const result = [];
    for (const outer of outerParts) {
      const myHoles = [];
      for (const holeParts of holes) {
        for (const hole of holeParts) {
          if (hole.length > 0 && Math.abs(hole[0][0] - outer[0][0]) < 180) {
            myHoles.push(hole);
          }
        }
      }
      result.push([outer, ...myHoles]);
    }
    return result.length > 0 ? result : [polygon];
  }

  _splitAntimeridianRing(ring) {
    const segments = [];
    let current = [];
    for (let i = 0; i < ring.length; i++) {
      const [lng, lat] = ring[i];
      if (current.length === 0) { current.push([lng, lat]); continue; }
      const prev = current[current.length - 1];
      if (Math.abs(lng - prev[0]) > 180) {
        if (current.length > 1) segments.push(current);
        current = [[lng, lat]];
      } else { current.push([lng, lat]); }
    }
    if (current.length > 1) segments.push(current);
    for (const seg of segments) {
      if (seg.length > 0) {
        const first = seg[0], last = seg[seg.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) seg.push([first[0], first[1]]);
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

  _getCanvasViewport() {
    const { centerLng, centerLat, zoom } = this.fallback;
    const rect = this.fallback.canvas.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    const pixelScale = 256 * Math.pow(2, zoom) / 360;
    const worldCenter = this._lngLatToWorld(centerLng, centerLat);
    const offsetX = w / 2 - worldCenter.x * pixelScale;
    const offsetY = h / 2 - worldCenter.y * pixelScale;
    const lngMin = this._worldToLngLat((0 - offsetX) / pixelScale, 0).lng;
    const lngMax = this._worldToLngLat((w - offsetX) / pixelScale, 0).lng;
    const latMax = this._worldToLngLat(0, (0 - offsetY) / pixelScale).lat;
    const latMin = this._worldToLngLat(0, (h - offsetY) / pixelScale).lat;
    return { lngMin, lngMax, latMin, latMax, offsetX, offsetY, pixelScale, w, h };
  }

  _renderFallback() {
    if (!this.fallback) return;
    const { ctx, countries, admin1 } = this.fallback;
    const vp = this._getCanvasViewport();
    const { offsetX, offsetY, pixelScale, w, h } = vp;
    const padLng = (vp.lngMax - vp.lngMin) * 0.1;
    const padLat = (vp.latMax - vp.latMin) * 0.1;
    const viewport = {
      lngMin: vp.lngMin - padLng, lngMax: vp.lngMax + padLng,
      latMin: vp.latMin - padLat, latMax: vp.latMax + padLat,
    };

    ctx.clearRect(0, 0, w, h);
    this.engine.offsetX = offsetX;
    this.engine.offsetY = offsetY;
    this.engine.scale = pixelScale;

    // 1. 国家填充
    ctx.fillStyle = '#f5f5f0';
    for (const f of countries.features) {
      if (this._featureInViewport(f, viewport)) this._drawFeature(ctx, f, offsetX, offsetY, pixelScale, true);
    }

    // 2. 行政区划边界
    if (admin1 && admin1.features) {
      ctx.strokeStyle = 'rgba(200, 200, 192, 0.6)';
      ctx.lineWidth = Math.max(0.3, pixelScale * 0.15);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      for (const f of admin1.features) {
        if (this._featureInViewport(f, viewport)) this._drawFeature(ctx, f, offsetX, offsetY, pixelScale, false);
      }
    }

    // 3. 国家边界
    ctx.strokeStyle = '#999';
    ctx.lineWidth = Math.max(0.5, pixelScale * 0.4);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const f of countries.features) {
      if (this._featureInViewport(f, viewport)) this._drawFeature(ctx, f, offsetX, offsetY, pixelScale, false);
    }

    this.engine.render();
    if (this.engine.onViewportChange) this.engine.onViewportChange();
  }

  _featureInViewport(feature, vp) {
    const bbox = feature._bbox || this._getFeatureBBox(feature);
    if (!bbox) return true;
    return !(bbox[0] > vp.lngMax || bbox[2] < vp.lngMin || bbox[1] > vp.latMax || bbox[3] < vp.latMin);
  }

  _getFeatureBBox(feature) {
    if (feature._bbox) return feature._bbox;
    let mn = Infinity, mn2 = Infinity, mx = -Infinity, mx2 = -Infinity;
    const coords = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    for (const poly of coords) {
      for (const ring of poly) {
        for (const [lng, lat] of ring) {
          if (lng < mn) mn = lng; if (lng > mx) mx = lng;
          if (lat < mn2) mn2 = lat; if (lat > mx2) mx2 = lat;
        }
      }
    }
    feature._bbox = [mn, mn2, mx, mx2];
    return feature._bbox;
  }

  _drawFeature(ctx, feature, offsetX, offsetY, scale, fill) {
    const g = feature.geometry;
    if (!g) return;
    const coords = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    for (const poly of coords) {
      for (const ring of poly) {
        ctx.beginPath();
        for (let i = 0; i < ring.length; i++) {
          const [lng, lat] = ring[i];
          const world = this._lngLatToWorld(lng, lat);
          const sx = world.x * scale + offsetX;
          const sy = world.y * scale + offsetY;
          if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
        }
        ctx.closePath();
        if (fill) ctx.fill(); else ctx.stroke();
      }
    }
  }

  _syncToEngine() {
    if (this._mode === 'maplibre' && this.map) this._syncMapLibreToEngine();
    else if (this._mode === 'canvas2d' && this.fallback) this._renderFallback();
  }

  _syncMapLibreToEngine() {
    if (!this.map || !this.engine) return;
    const c = this.map.getCenter();
    const zoom = this.map.getZoom();
    const worldCenter = this._lngLatToWorld(c.lng, c.lat);
    const pixelScale = 512 * Math.pow(2, zoom) / 360;
    const rect = this.map.getContainer().getBoundingClientRect();
    this.engine.offsetX = rect.width / 2 - worldCenter.x * pixelScale;
    this.engine.offsetY = rect.height / 2 - worldCenter.y * pixelScale;
    this.engine.scale = pixelScale;
    this.engine.render();
    if (this.engine.onViewportChange) this.engine.onViewportChange();
  }

  _lngLatToWorld(lng, lat) {
    const latRad = lat * Math.PI / 180;
    return { x: lng, y: -180 / Math.PI * Math.log(Math.tan(Math.PI / 4 + latRad / 2)) };
  }

  _worldToLngLat(x, y) {
    const yRad = -y * Math.PI / 180;
    return { lng: x, lat: 180 / Math.PI * (2 * Math.atan(Math.exp(yRad)) - Math.PI / 2) };
  }

  screenToLngLat(sx, sy) {
    if (this._mode === 'maplibre' && this.map) return this.map.unproject([sx, sy]);
    if (this._mode === 'canvas2d' && this.fallback) {
      return this._worldToLngLat((sx - this.engine.offsetX) / this.engine.scale, (sy - this.engine.offsetY) / this.engine.scale);
    }
    return null;
  }

  lngLatToScreen(lng, lat) {
    if (this._mode === 'maplibre' && this.map) return this.map.project([lng, lat]);
    if (this._mode === 'canvas2d' && this.fallback) {
      const w = this._lngLatToWorld(lng, lat);
      return { x: w.x * this.engine.scale + this.engine.offsetX, y: w.y * this.engine.scale + this.engine.offsetY };
    }
    return null;
  }

  setViewport(centerLng, centerLat, zoom) {
    if (this._mode === 'maplibre' && this.map) {
      this.map.jumpTo({ center: [centerLng, centerLat], zoom });
      this._scheduleTileUpdate();
    } else if (this._mode === 'canvas2d' && this.fallback) {
      this.fallback.centerLng = centerLng;
      this.fallback.centerLat = centerLat;
      this.fallback.zoom = zoom;
      this._renderFallback();
      this._scheduleTileUpdate();
    }
  }

  panByPixels(dx, dy) {
    if (this._mode !== 'canvas2d' || !this.fallback) return;
    const ps = 256 * Math.pow(2, this.fallback.zoom) / 360;
    const dLng = -dx / ps;
    const cw = this._lngLatToWorld(this.fallback.centerLng, this.fallback.centerLat);
    const nc = this._worldToLngLat(cw.x + dLng, cw.y - dy / ps);
    this.fallback.centerLng = nc.lng;
    this.fallback.centerLat = nc.lat;
    this._renderFallback();
    this._scheduleTileUpdate();
  }

  zoomAt(screenX, screenY, newZoom) {
    if (this._mode !== 'canvas2d' || !this.fallback) return;
    const cz = Math.max(this._minZoom, Math.min(this._maxZoom, newZoom));
    const before = this.screenToLngLat(screenX, screenY);
    if (!before) return;
    this.fallback.zoom = cz;
    const after = this.lngLatToScreen(before.lng, before.lat);
    if (!after) return;
    this.panByPixels(after.x - screenX, after.y - screenY);
  }

  getCanvas() {
    if (this._mode === 'maplibre' && this.map) return this.map.getCanvas();
    if (this._mode === 'canvas2d' && this.fallback) return this.fallback.canvas;
    return null;
  }

  getMode() { return this._mode; }

  destroy() {
    if (this.map) { this.map.remove(); this.map = null; }
    if (this._resizeHandler) window.removeEventListener('resize', this._resizeHandler);
    const d = document.getElementById('map-container'); if (d) d.remove();
    const c = document.getElementById('map-canvas-2d'); if (c) c.remove();
    this.fallback = null; this._mode = 'none';
  }
}
