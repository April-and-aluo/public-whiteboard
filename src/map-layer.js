// ============================================
// map-layer.js - 地图背景层（分区块加载版 v2）
// ============================================
// 国家边界和行政区划都按 20°×20° 区块从 CDN 加载
// 初始加载低精度国家填充（快速显示）
// 区块加载后替换为高精度边界（tol=0.005, ~500m）
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
    this._minZoom = 3;
    this._tileSize = 20;
    this._loadedTiles = new Map();    // tileId -> {admin1: [], countries: []}
    this._loadingTiles = new Set();
    this._tileUpdateTimer = null;
    this._cdnVersion = '20260711f';   // 缓存破坏版本号
    this._cdnBase = `https://cdn.jsdelivr.net/gh/april-and-aluo/public-whiteboard@main/src/map-data`;
  }

  async init() {
    const webglAvailable = this._checkWebGL();
    if (webglAvailable) {
      try { await this._initMapLibre(); return; }
      catch (err) { console.warn('[MapLayer] MapLibre 失败:', err.message); }
    } else {
      console.warn('[MapLayer] WebGL 不可用，使用 Canvas 2D');
    }
    try { await this._initCanvas2D(); }
    catch (err) {
      console.warn('[MapLayer] Canvas 2D 失败:', err);
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

  _tileURL(tileId, layer) {
    return `${this._cdnBase}/tiles/${tileId}/${layer}.geojson?v=${this._cdnVersion}`;
  }

  _getVisibleTileIds(lngMin, latMin, lngMax, latMax) {
    const ts = this._tileSize;
    const buf = ts;
    const startLng = Math.floor((lngMin - buf + 180) / ts) * ts - 180;
    const endLng = Math.ceil((lngMax + buf + 180) / ts) * ts - 180;
    const startLat = Math.floor((latMin - buf + 90) / ts) * ts - 90;
    const endLat = Math.ceil((latMax + buf + 90) / ts) * ts - 90;
    const ids = [];
    for (let lat = startLat; lat < endLat; lat += ts) {
      for (let lng = startLng; lng < endLng; lng += ts) {
        ids.push(`${lng}_${lat}`);
      }
    }
    return ids;
  }

  _scheduleTileUpdate() {
    if (this._tileUpdateTimer) clearTimeout(this._tileUpdateTimer);
    this._tileUpdateTimer = setTimeout(() => this._updateTiles(), 200);
  }

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
    } else return;

    const visibleIds = new Set(this._getVisibleTileIds(lngMin, latMin, lngMax, latMax));

    // 卸载远离的区块
    const unloadBuffer = this._tileSize * 2;
    for (const [tileId] of this._loadedTiles) {
      if (!visibleIds.has(tileId)) {
        const [tlng, tlat] = tileId.split('_').map(Number);
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

    const MAX_CONCURRENT = 6;
    for (const id of toLoad.slice(0, MAX_CONCURRENT)) {
      this._loadTile(id);
    }
    if (toLoad.length > MAX_CONCURRENT) {
      setTimeout(() => {
        for (const id of toLoad.slice(MAX_CONCURRENT)) {
          if (!this._loadedTiles.has(id) && !this._loadingTiles.has(id)) {
            this._loadTile(id);
          }
        }
      }, 500);
    }
  }

  async _loadTile(tileId) {
    if (this._loadedTiles.has(tileId) || this._loadingTiles.has(tileId)) return;
    this._loadingTiles.add(tileId);

    try {
      // 同时加载 admin1 和 countries
      const [admin1Resp, countriesResp] = await Promise.allSettled([
        fetch(this._tileURL(tileId, 'admin1')),
        fetch(this._tileURL(tileId, 'countries')),
      ]);

      const tileData = { admin1: [], countries: [] };

      if (admin1Resp.status === 'fulfilled' && admin1Resp.value.ok) {
        const data = await admin1Resp.value.json();
        if (data.features?.length) {
          tileData.admin1 = this._preprocessGeoJSON(data).features;
        }
      }

      if (countriesResp.status === 'fulfilled' && countriesResp.value.ok) {
        const data = await countriesResp.value.json();
        if (data.features?.length) {
          tileData.countries = this._preprocessGeoJSON(data).features;
        }
      }

      this._loadedTiles.set(tileId, tileData);
      console.log(`[MapLayer] Tile ${tileId}: ${tileData.admin1.length} admin1, ${tileData.countries.length} countries`);
      this._refreshTileData();
    } catch (e) {
      console.error('[MapLayer] Tile error:', tileId, e.message);
      this._loadedTiles.set(tileId, { admin1: [], countries: [] });
    } finally {
      this._loadingTiles.delete(tileId);
    }
  }

  // 合并所有已加载区块的数据，更新地图
  _refreshTileData() {
    const allAdmin1 = [];
    const allCountries = [];
    const seenA = new Set();
    const seenC = new Set();

    for (const [, td] of this._loadedTiles) {
      for (const f of td.admin1) {
        const key = (f.properties?.name || '') + JSON.stringify(f.geometry?.coordinates?.[0]?.[0]?.[0] || '');
        if (!seenA.has(key)) { seenA.add(key); allAdmin1.push(f); }
      }
      for (const f of td.countries) {
        const key = (f.properties?.name || '') + JSON.stringify(f.geometry?.coordinates?.[0]?.[0]?.[0] || '');
        if (!seenC.has(key)) { seenC.add(key); allCountries.push(f); }
      }
    }

    if (this._mode === 'maplibre' && this.map) {
      const aSrc = this.map.getSource('admin1');
      const cSrc = this.map.getSource('countries-tile');
      if (aSrc) aSrc.setData({ type: 'FeatureCollection', features: allAdmin1 });
      if (cSrc) cSrc.setData({ type: 'FeatureCollection', features: allCountries });
    } else if (this._mode === 'canvas2d' && this.fallback) {
      this.fallback.admin1 = { type: 'FeatureCollection', features: allAdmin1 };
      this.fallback.countriesTile = { type: 'FeatureCollection', features: allCountries };
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

    // 初始低精度国家数据（仅用于快速填充显示）
    const countryData = await this._loadGeoJSON(`${this._cdnBase}/countries.geojson?v=${this._cdnVersion}`).catch(() => null);
    const processedCountries = countryData ? this._preprocessGeoJSON(countryData) : null;

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
      // 初始低精度国家填充（快速显示）
      if (processedCountries) {
        this.map.addSource('countries', { type: 'geojson', data: processedCountries });
        this.map.addLayer({
          id: 'country-fill', type: 'fill', source: 'countries',
          paint: { 'fill-color': '#f5f5f0', 'fill-opacity': 1 },
        });
      }

      // 高精度国家边界（从区块加载，初始为空）
      this.map.addSource('countries-tile', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      this.map.addLayer({
        id: 'country-borders-hp', type: 'line', source: 'countries-tile',
        paint: {
          'line-color': '#888',
          'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.8, 5, 1.2, 7, 2.0, 10, 3.0],
          'line-opacity': 0.85,
        },
        layout: { 'line-join': 'round', 'line-cap': 'round' },
      });

      // 行政区划边界
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
    // 初始低精度国家数据（快速显示填充）
    const countryData = await this._loadGeoJSON(`${this._cdnBase}/countries.geojson?v=${this._cdnVersion}`).catch(() => null);
    const processedCountries = countryData ? this._preprocessGeoJSON(countryData) : { type: 'FeatureCollection', features: [] };
    console.log('[MapLayer] Initial countries:', processedCountries.features.length, 'features');

    const mapCanvas = document.createElement('canvas');
    mapCanvas.id = 'map-canvas-2d';
    mapCanvas.style.cssText = `position:absolute;top:0;left:0;width:100%;height:100%;z-index:0;background:#fff;pointer-events:none;`;
    const mainCanvas = document.getElementById('main-canvas');
    mainCanvas.parentElement.insertBefore(mapCanvas, mainCanvas);
    mainCanvas.style.zIndex = '1';
    mainCanvas.style.background = 'transparent';

    this.fallback = {
      canvas: mapCanvas, ctx: mapCanvas.getContext('2d'),
      countries: processedCountries,        // 低精度初始数据（仅填充）
      countriesTile: { type: 'FeatureCollection', features: [] }, // 高精度区块数据
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
    const { ctx, countries, countriesTile, admin1 } = this.fallback;
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

    // 1. 国家填充（用初始低精度数据）
    ctx.fillStyle = '#f5f5f0';
    for (const f of countries.features) {
      if (this._featureInViewport(f, viewport)) this._drawFeature(ctx, f, offsetX, offsetY, pixelScale, true);
    }

    // 2. 行政区划边界（从区块加载）
    if (admin1?.features) {
      ctx.strokeStyle = 'rgba(200, 200, 192, 0.6)';
      ctx.lineWidth = Math.max(0.3, pixelScale * 0.15);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      for (const f of admin1.features) {
        if (this._featureInViewport(f, viewport)) this._drawFeature(ctx, f, offsetX, offsetY, pixelScale, false);
      }
    }

    // 3. 国家边界（优先用高精度区块数据，回退到初始数据）
    const borderSource = (countriesTile?.features?.length > 0) ? countriesTile : countries;
    ctx.strokeStyle = '#888';
    ctx.lineWidth = Math.max(0.5, pixelScale * 0.4);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const f of borderSource.features) {
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
    const coords = feature.geometry?.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry?.coordinates || [];
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
