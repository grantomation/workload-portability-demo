;(function () {
  'use strict';
    const root = document.getElementById('app-root');
    const $ = (id) => root.querySelector('#' + id);

    // ---- Inline-style strings for dynamically created nodes ----
    const ST = {
      routeItem: 'display:flex;align-items:center;gap:11px;padding:9px;border-radius:11px;margin-bottom:2px;transition:background 0.12s',
      badge: 'width:30px;height:30px;flex:none;border-radius:50%;color:var(--badge-text);display:flex;align-items:center;justify-content:center;font-family:\'IBM Plex Mono\',monospace;font-size:13px;font-weight:600;box-shadow:0 1px 4px rgba(0,0,0,0.15)',
      text: 'flex:1;min-width:0',
      name: 'font-size:16px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text)',
      sub: 'font-family:\'IBM Plex Mono\',monospace;font-size:12px;color:var(--text-muted);margin-top:2px',
      vmTag: 'font-family:\'IBM Plex Mono\',monospace;font-size:9px;letter-spacing:0.5px;color:var(--text);background:var(--border);border-radius:5px;padding:3px 6px',
      del: 'width:24px;height:24px;flex:none;border:none;background:transparent;color:var(--text-sub);font-size:17px;line-height:1;cursor:pointer;border-radius:7px;display:flex;align-items:center;justify-content:center;transition:color 0.12s, background 0.12s',
      empty: 'padding:24px 14px;text-align:center;color:var(--text-sub);font-size:12.5px;line-height:1.6',
      pin: 'position:absolute;transform:translate(-50%,-50%);pointer-events:none;z-index:5',
      pinDisc: 'width:38px;height:38px;border-radius:50%;box-shadow:0 3px 10px rgba(0,0,0,0.30);border:2.5px solid rgba(180,180,180,0.45);display:flex;align-items:center;justify-content:center;color:var(--badge-text);font-family:\'IBM Plex Mono\',monospace;font-size:18px;font-weight:600;animation:dropin 0.45s cubic-bezier(0.2,0.9,0.3,1.25);pointer-events:auto;cursor:pointer',
      pinLabel: 'position:absolute;left:46px;top:50%;transform:translateY(-50%);white-space:nowrap;background:var(--pin-label-bg);border:1px solid var(--pin-label-border);border-radius:8px;padding:5px 10px;font-size:18px;font-weight:500;color:var(--text);box-shadow:0 1px 5px rgba(0,0,0,0.10)',
      pinRing: 'position:absolute;left:50%;top:50%;width:60px;height:60px;transform:translate(-50%,-50%);border-radius:50%;border:2.5px solid var(--text);box-shadow:0 0 0 4px rgba(128,128,128,0.3);pointer-events:none;display:none',
      urlRow: 'padding:8px 0;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:3px',
      urlPlat: 'font-family:\'IBM Plex Mono\',monospace;font-size:8.5px;letter-spacing:1.2px;text-transform:uppercase;display:flex;align-items:center;gap:6px',
      urlLink: 'font-family:\'IBM Plex Mono\',monospace;font-size:11px;color:#5b9df5;text-decoration:underline;word-break:break-all;line-height:1.4',
      urlDead: 'font-family:\'IBM Plex Mono\',monospace;font-size:11px;color:var(--text-sub);text-decoration:line-through;word-break:break-all;line-height:1.4',
    };

    const els = {
      ghost: $('ghost'),
      ghostDisc: $('ghost-disc'),
      namer: $('namer'),
      namerInput: $('namer-input'),
      namerBtn: $('namer-btn'),
      routeList: $('route-list'),
      map: $('map'),
      contour: $('contour-canvas'),
      trail: $('trail-canvas'),
      overlay: $('overlay'),
      pins: $('pins'),
      vm: $('vm'),
      emptyState: $('empty-state'),
      scaleMid: $('scale-mid'),
      scaleMax: $('scale-max'),
      regions: $('regions'),
      sidebar: $('sidebar'),
      divider: $('divider'),
      zoomIn: $('zoom-in'),
      zoomOut: $('zoom-out'),
      layersBtn: $('layers-btn'),
      urlPanel: $('url-panel'),
      urlList: $('url-list'),
      urlCount: $('url-count'),
      hud: $('hud-tl'),
    };

    const state = {
      stops: [],
      startedAt: null,
      now: Date.now(),
      pending: null, // { x, y } percent — provisional pin awaiting a name
      selectedId: null, // currently-selected pin
    };
    let fbm = null;
    let vmPos = null;   // {x,y} in map percent — current marker position
    let vmRaf = null;   // active travel animation frame

    // ---- View transform (zoom + pan), normalized 0..1 map space ----
    const MIN_SCALE = 0.45;
    const MAX_SCALE = 6;
    const view = { scale: 1, cx: 0.5, cy: 0.5 };
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    function clampView() {
      view.scale = clamp(view.scale, MIN_SCALE, MAX_SCALE);
      const half = 0.5 / view.scale;
      // Overscroll allowance so the map is always draggable, but not infinitely.
      const M = 0.35;
      const lo = half - M;
      const hi = 1 - half + M;
      if (lo > hi) {
        view.cx = 0.5;
        view.cy = 0.5;
      } else {
        view.cx = clamp(view.cx, lo, hi);
        view.cy = clamp(view.cy, lo, hi);
      }
    }
    // Scale bar reflects current zoom (full map width ≈ 24 km).
    function updateScale() {
      const r = els.map.getBoundingClientRect();
      if (r.width < 2) return;
      const kmFull = 24 * (90 / r.width) / view.scale;
      const fmt = (k) => (k >= 10 ? String(Math.round(k)) : k >= 1 ? k.toFixed(1) : k.toFixed(2));
      els.scaleMid.textContent = fmt(kmFull / 2);
      els.scaleMax.textContent = fmt(kmFull) + ' km';
    }
    // Normalized point (0..1) -> on-screen percentage of the map.
    function toScreen(nx, ny) {
      const half = 0.5 / view.scale;
      const u0 = view.cx - half;
      const v0 = view.cy - half;
      return { left: (nx - u0) * view.scale * 100, top: (ny - v0) * view.scale * 100 };
    }
    let contourRaf = null;
    function scheduleContour() {
      if (contourRaf) return;
      contourRaf = requestAnimationFrame(() => { contourRaf = null; drawContours(); });
    }
    function positionPins() {
      state.stops.forEach((s) => {
        const pin = els.pins.querySelector(`[data-id="${s.id}"]`);
        if (!pin) return;
        const p = toScreen(s.x / 100, s.y / 100);
        pin.style.left = p.left + '%';
        pin.style.top = p.top + '%';
      });
      positionLabels();
    }
    // Flip labels to the inner side near edges and de-collide them vertically.
    function positionLabels() {
      const r = els.overlay.getBoundingClientRect();
      if (r.width < 2) return;
      const GAP = 46; // px from pin centre to label edge (clears the disc)
      const items = [];
      state.stops.forEach((s) => {
        const pin = els.pins.querySelector(`[data-id="${s.id}"]`);
        if (!pin) return;
        const label = pin.querySelector('[data-role="label"]');
        if (!label) return;
        const p = toScreen(s.x / 100, s.y / 100);
        const cx = (p.left / 100) * r.width;
        const cy = (p.top / 100) * r.height;
        const lw = label.offsetWidth || 120;
        const lh = label.offsetHeight || 34;
        let side = 'right';
        if (cx + GAP + lw > r.width - 8) side = 'left';
        if (side === 'left' && cx - GAP - lw < 8) side = 'right';
        items.push({ label, cx, cy, lw, lh, side, y: cy });
      });
      ['left', 'right'].forEach((side) => {
        const group = items.filter((i) => i.side === side).sort((a, b) => a.cy - b.cy);
        let prevBottom = -Infinity;
        group.forEach((it) => {
          let top = it.cy - it.lh / 2;
          if (top < prevBottom + 4) top = prevBottom + 4;
          it.y = top + it.lh / 2;
          prevBottom = top + it.lh;
        });
      });
      items.forEach((it) => {
        const yc = Math.max(it.lh / 2 + 2, Math.min(r.height - it.lh / 2 - 2, it.y));
        const dy = yc - it.cy;
        if (it.side === 'right') {
          it.label.style.left = '46px';
          it.label.style.right = 'auto';
          it.label.style.textAlign = 'left';
        } else {
          it.label.style.left = 'auto';
          it.label.style.right = '46px';
          it.label.style.textAlign = 'right';
        }
        it.label.style.top = '50%';
        it.label.style.transform = `translateY(calc(-50% + ${dy.toFixed(1)}px))`;
      });
    }
    function positionRegions() {
      els.regions.querySelectorAll('[data-nx]').forEach((r) => {
        const p = toScreen(parseFloat(r.dataset.nx), parseFloat(r.dataset.ny));
        r.style.left = p.left + '%';
        r.style.top = p.top + '%';
      });
    }
    // ---- VM marker: lives at vmPos (map %); travels along the trail on new pins ----
    function placeVm() {
      if (!vmPos) { els.vm.hidden = true; return; }
      const p = toScreen(vmPos.x / 100, vmPos.y / 100);
      els.vm.style.left = p.left + '%';
      els.vm.style.top = p.top + '%';
      els.vm.hidden = false;
    }
    function setVmToLast() {
      if (vmRaf) { cancelAnimationFrame(vmRaf); vmRaf = null; }
      const last = state.stops[state.stops.length - 1];
      vmPos = last ? { x: last.x, y: last.y } : null;
      placeVm();
    }
    function animateVmToLast() {
      const last = state.stops[state.stops.length - 1];
      if (!last) { vmPos = null; placeVm(); return; }
      if (!vmPos) { setVmToLast(); return; }
      const from = { x: vmPos.x, y: vmPos.y };
      const to = { x: last.x, y: last.y };
      const dur = 1100;
      const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
      const t0 = performance.now();
      if (vmRaf) cancelAnimationFrame(vmRaf);
      const step = (now) => {
        const k = Math.min(1, (now - t0) / dur);
        const e = ease(k);
        vmPos = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
        placeVm();
        if (k < 1) vmRaf = requestAnimationFrame(step);
        else vmRaf = null;
      };
      vmRaf = requestAnimationFrame(step);
    }
    function layoutOverlay() {
      positionPins();
      positionRegions();
      placeVm();
      positionNamer();
      positionBanner();
    }
    function positionBanner() {}
    function applyView(redrawContour) {
      clampView();
      if (redrawContour) scheduleContour();
      layoutOverlay();
      drawTrail();
      updateScale();
    }

    // ---- Terrain: seeded fractal value-noise + marching squares ----
    function buildField() {
      const SX = 64;
      const SY = 42;
      let a = 1337 >>> 0;
      const rng = () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const grid = new Float32Array(SX * SY);
      for (let i = 0; i < grid.length; i++) grid[i] = rng();
      const idx = (x, y) => (((y % SY) + SY) % SY) * SX + (((x % SX) + SX) % SX);
      const sm = (t) => t * t * (3 - 2 * t);
      const vn = (fx, fy) => {
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const tx = sm(fx - x0);
        const ty = sm(fy - y0);
        const v00 = grid[idx(x0, y0)];
        const v10 = grid[idx(x0 + 1, y0)];
        const v01 = grid[idx(x0, y0 + 1)];
        const v11 = grid[idx(x0 + 1, y0 + 1)];
        const aa = v00 + (v10 - v00) * tx;
        const bb = v01 + (v11 - v01) * tx;
        return aa + (bb - aa) * ty;
      };
      fbm = (u, v) => {
        let amp = 0.5;
        let freq = 4;
        let sum = 0;
        let norm = 0;
        for (let o = 0; o < 5; o++) {
          sum += amp * vn(u * freq + o * 13.7, v * freq + o * 7.3);
          norm += amp;
          amp *= 0.5;
          freq *= 2;
        }
        const val = sum / norm;
        return Math.min(1, Math.max(0, (val - 0.5) * 1.35 + 0.5));
      };
    }

    function drawContours() {
      const el = els.contour;
      if (!el || !fbm) return;
      const r = el.getBoundingClientRect();
      if (r.width < 2) return;
      const dpr = window.devicePixelRatio || 1;
      el.width = r.width * dpr;
      el.height = r.height * dpr;
      const ctx = el.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, r.width, r.height);

      const W = r.width;
      const H = r.height;
      const RW = Math.max(60, Math.round(W / 6));
      const RH = Math.max(40, Math.round((RW * H) / W));
      const vals = new Float32Array((RW + 1) * (RH + 1));
      const half = 0.5 / view.scale;
      const u0 = view.cx - half;
      const v0 = view.cy - half;
      const inv = 1 / view.scale;
      for (let y = 0; y <= RH; y++) {
        for (let x = 0; x <= RW; x++) vals[y * (RW + 1) + x] = fbm(u0 + (x / RW) * inv, v0 + (y / RH) * inv);
      }
      const cw = W / RW;
      const ch = H / RH;
      const density = 13;
      const levels = [];
      for (let k = 1; k <= density; k++) levels.push(k / (density + 1));

      const cs = getComputedStyle(document.documentElement);
      const ink = cs.getPropertyValue('--contour-ink').trim() || '20,21,26';
      const contourMajor = parseFloat(cs.getPropertyValue('--contour-major')) || 0.6;
      const contourMinor = parseFloat(cs.getPropertyValue('--contour-minor')) || 0.23;
      const seg = {
        1: [['L', 'B']], 2: [['B', 'R']], 3: [['L', 'R']], 4: [['T', 'R']],
        5: [['T', 'L'], ['B', 'R']], 6: [['T', 'B']], 7: [['T', 'L']], 8: [['T', 'L']],
        9: [['T', 'B']], 10: [['T', 'R'], ['L', 'B']], 11: [['T', 'R']], 12: [['L', 'R']],
        13: [['B', 'R']], 14: [['L', 'B']],
      };

      levels.forEach((T, li) => {
        const major = li % 3 === 0;
        ctx.beginPath();
        for (let y = 0; y < RH; y++) {
          for (let x = 0; x < RW; x++) {
            const tl = vals[y * (RW + 1) + x];
            const tr = vals[y * (RW + 1) + x + 1];
            const br = vals[(y + 1) * (RW + 1) + x + 1];
            const bl = vals[(y + 1) * (RW + 1) + x];
            const c = (tl > T ? 8 : 0) | (tr > T ? 4 : 0) | (br > T ? 2 : 0) | (bl > T ? 1 : 0);
            if (c === 0 || c === 15) continue;
            const segs = seg[c];
            if (!segs) continue;
            const pt = (e) => {
              if (e === 'T') return [(x + (T - tl) / ((tr - tl) || 1e-6)) * cw, y * ch];
              if (e === 'R') return [(x + 1) * cw, (y + (T - tr) / ((br - tr) || 1e-6)) * ch];
              if (e === 'B') return [(x + (T - bl) / ((br - bl) || 1e-6)) * cw, (y + 1) * ch];
              return [x * cw, (y + (T - tl) / ((bl - tl) || 1e-6)) * ch];
            };
            for (const s of segs) {
              const aa = pt(s[0]);
              const bb = pt(s[1]);
              ctx.moveTo(aa[0], aa[1]);
              ctx.lineTo(bb[0], bb[1]);
            }
          }
        }
        ctx.strokeStyle = `rgba(${ink},${major ? contourMajor : contourMinor})`;
        ctx.lineWidth = major ? 1.1 : 0.65;
        ctx.stroke();
      });
    }

    function drawTrail() {
      const el = els.trail;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width < 2) return;
      const dpr = window.devicePixelRatio || 1;
      el.width = r.width * dpr;
      el.height = r.height * dpr;
      const ctx = el.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, r.width, r.height);

      const pts = state.stops.map((s) => {
        const p = toScreen(s.x / 100, s.y / 100);
        return { x: (p.left / 100) * r.width, y: (p.top / 100) * r.height };
      });
      if (pts.length < 2) return;

      const path = () => {
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      };
      const tcs = getComputedStyle(document.documentElement);
      const trailOuter = tcs.getPropertyValue('--trail-outer').trim() || '#f6f5f0';
      const trailDash = tcs.getPropertyValue('--trail-dash').trim() || '#14151a';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.setLineDash([]);
      path();
      ctx.strokeStyle = trailOuter;
      ctx.globalAlpha = 0.95;
      ctx.lineWidth = 5;
      ctx.stroke();
      ctx.globalAlpha = 0.82;
      ctx.setLineDash([7, 7]);
      path();
      ctx.strokeStyle = trailDash;
      ctx.lineWidth = 1.7;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
    }

    // ---- Derived presentation math ----
    function elevAt(x, y) {
      return Math.round(640 + (fbm ? fbm(x / 100, y / 100) : 0.5) * 2680);
    }
    function gridAt(x, y) {
      const col = String.fromCharCode(65 + Math.floor((x / 100) * 12));
      return col + '·' + (Math.floor((y / 100) * 9) + 1);
    }
    function totalDistance() {
      let dist = 0;
      for (let i = 1; i < state.stops.length; i++) {
        const dx = (state.stops[i].x - state.stops[i - 1].x) * 0.24;
        const dy = (state.stops[i].y - state.stops[i - 1].y) * 0.15;
        dist += Math.sqrt(dx * dx + dy * dy);
      }
      return dist;
    }
    function fmtTime(ms) {
      const s = Math.floor(ms / 1000);
      if (s < 60) return s + 's';
      const m = Math.floor(s / 60);
      if (m < 60) return m + 'm ' + (s % 60) + 's';
      const h = Math.floor(m / 60);
      if (h < 24) return h + 'h ' + (m % 60) + 'm';
      return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
    }
    function deriveStartedAt() {
      if (state.stops.length === 0) {
        state.startedAt = null;
        return;
      }
      state.startedAt = state.stops.reduce((min, s) => {
        const t = new Date(s.created_at).getTime();
        return t < min ? t : min;
      }, Infinity);
    }

    // ---- API (real backend) ----
    async function api(path, options = {}) {
      const res = await fetch(path, options);
      if (!res.ok) throw new Error(`Request failed: ${res.status}`);
      return res.status === 204 ? null : res.json();
    }

    async function loadStops() {
      state.stops = await api('/api/stops');
      deriveStartedAt();
    }

    // ---- Rendering ----
    function render() {
      renderRouteList();
      renderPins();
      renderStats();
      updateInspector();
      els.emptyState.hidden = state.stops.length !== 0;
    }

    function renderRouteList() {
      els.routeList.innerHTML = '';
      if (state.stops.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = ST.empty;
        empty.innerHTML = 'No waypoints yet.<br>Double-click the map to pin your first infrastructure.';
        els.routeList.appendChild(empty);
        return;
      }

      state.stops.forEach((s, i) => {
        const isLast = i === state.stops.length - 1;
        const selected = s.id === state.selectedId;
        const row = document.createElement('div');
        row.style.cssText = ST.routeItem;
        row.style.background = selected ? 'var(--bg-card-selected)' : 'transparent';
        row.style.cursor = 'pointer';
        row.addEventListener('mouseenter', () => { row.style.background = selected ? 'var(--bg-card-selected)' : 'var(--bg-card-hover)'; });
        row.addEventListener('mouseleave', () => { row.style.background = selected ? 'var(--bg-card-selected)' : 'transparent'; });
        row.addEventListener('click', () => selectStop(s.id));

        const badge = document.createElement('div');
        badge.style.cssText = ST.badge;
        badge.style.background = s.color;
        badge.textContent = i + 1;

        const text = document.createElement('div');
        text.style.cssText = ST.text;
        const name = document.createElement('div');
        name.style.cssText = ST.name;
        name.textContent = s.name;
        const sub = document.createElement('div');
        sub.style.cssText = ST.sub;
        sub.textContent = `ELEV ${elevAt(s.x, s.y).toLocaleString()}m · ${gridAt(s.x, s.y)}`;
        text.append(name, sub);

        row.append(badge, text);

        if (isLast) {
          const vmTag = document.createElement('span');
          vmTag.style.cssText = ST.vmTag;
          vmTag.textContent = 'VM';
          row.appendChild(vmTag);
        }

        const del = document.createElement('button');
        del.style.cssText = ST.del;
        del.type = 'button';
        del.setAttribute('aria-label', `Delete ${s.name}`);
        del.textContent = '×';
        del.addEventListener('mouseenter', () => { del.style.color = '#e5484d'; del.style.background = 'var(--delete-hover-bg)'; });
        del.addEventListener('mouseleave', () => { del.style.color = ''; del.style.background = 'transparent'; });
        del.addEventListener('click', (e) => { e.stopPropagation(); deleteStop(s.id); });
        row.appendChild(del);

        els.routeList.appendChild(row);
      });

      const hint = document.createElement('div');
      hint.style.cssText = 'margin:10px 4px;padding:9px 16px;background:var(--hint-bg);border:1px dashed var(--hint-border);color:var(--text-muted);border-radius:999px;font-size:13px;text-align:center;display:flex;align-items:center;justify-content:center;gap:10px';
      const dot = document.createElement('span');
      dot.style.cssText = 'width:7px;height:7px;border-radius:50%;background:var(--hint-dot);flex:none';
      const label = document.createElement('span');
      label.textContent = 'Double-click the map to pin an Infrastructure';
      hint.append(dot, label);
      els.routeList.appendChild(hint);
    }

    function renderPins() {
      const seen = new Set();
      state.stops.forEach((s, i) => {
        seen.add(String(s.id));
        let pin = els.pins.querySelector(`[data-id="${s.id}"]`);
        if (!pin) {
          pin = document.createElement('div');
          pin.dataset.id = s.id;
          pin.style.cssText = ST.pin;
          const disc = document.createElement('div');
          disc.dataset.role = 'disc';
          disc.style.cssText = ST.pinDisc;
          const label = document.createElement('div');
          label.dataset.role = 'label';
          label.style.cssText = ST.pinLabel;
          const ring = document.createElement('div');
          ring.dataset.role = 'ring';
          ring.style.cssText = ST.pinRing;
          disc.addEventListener('click', (e) => { e.stopPropagation(); selectStop(Number(pin.dataset.id)); });
          disc.addEventListener('dblclick', (e) => { e.stopPropagation(); });
          disc.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            draggingPin = { id: Number(pin.dataset.id), moved: false };
            els.overlay.style.cursor = 'grabbing';
          });
          pin.append(ring, disc, label);
          els.pins.appendChild(pin);
        }
        const p = toScreen(s.x / 100, s.y / 100);
        pin.style.left = p.left + '%';
        pin.style.top = p.top + '%';
        const disc = pin.querySelector('[data-role="disc"]');
        disc.style.background = s.color;
        disc.textContent = i + 1;
        pin.querySelector('[data-role="label"]').textContent = s.name;
        pin.querySelector('[data-role="ring"]').style.display = (s.id === state.selectedId) ? 'block' : 'none';
      });
      els.pins.querySelectorAll('[data-id]').forEach((pin) => {
        if (!seen.has(pin.dataset.id)) pin.remove();
      });
      positionLabels();
    }

    function renderStats() {}

    function escapeHtml(value) {
      return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    // ---- Interactions: click the map to drop a provisional pin, then name it ----
    function showBanner() {}

    // Pointer coords -> map percent, accounting for the current zoom/pan view.
    function clientToMap(clientX, clientY) {
      const r = els.overlay.getBoundingClientRect();
      const mx = (clientX - r.left) / r.width;
      const my = (clientY - r.top) / r.height;
      const half = 0.5 / view.scale;
      const nx = (view.cx - half) + mx / view.scale;
      const ny = (view.cy - half) + my / view.scale;
      return { x: Math.min(98, Math.max(2, nx * 100)), y: Math.min(95, Math.max(4, ny * 100)) };
    }

    function positionNamer() {
      if (!state.pending) return;
      const p = toScreen(state.pending.x / 100, state.pending.y / 100);
      els.ghost.style.left = p.left + '%';
      els.ghost.style.top = p.top + '%';
      els.namer.style.left = p.left + '%';
      els.namer.style.top = p.top + '%';
      // Default sits to the top-right; flip toward the interior near edges.
      const tx = p.left > 62 ? 'calc(-100% - 32px)' : '32px';
      const ty = p.top < 20 ? '32px' : 'calc(-100% - 10px)';
      els.namer.style.transform = `translate(${tx}, ${ty})`;
    }

    function openNamer(x, y) {
      state.pending = { x, y };
      els.ghost.style.display = 'block';
      els.namer.style.display = 'flex';
      positionNamer();
      // Re-trigger the drop-in each time the provisional pin lands.
      els.ghostDisc.style.animation = 'none';
      void els.ghostDisc.offsetWidth;
      els.ghostDisc.style.animation = 'dropin 0.4s cubic-bezier(0.2,0.9,0.3,1.25)';
      showBanner();
      els.namerInput.focus();
    }

    function cancelPending() {
      if (!state.pending) return;
      state.pending = null;
      els.ghost.style.display = 'none';
      els.namer.style.display = 'none';
      els.namerInput.value = '';
      showBanner();
    }

    async function commitPending() {
      if (!state.pending) return;
      const name = els.namerInput.value.trim();
      if (!name) { els.namerInput.focus(); return; }
      const { x, y } = state.pending;
      cancelPending();
      try {
        const stop = await api('/api/stops', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, x, y }),
        });
        state.stops.push(stop);
        deriveStartedAt();
        render();
        drawTrail();
        animateVmToLast(); // VM travels along the trail to the new pin
      } catch (err) {
        console.error(err);
      }
    }

    function selectStop(id) {
      cancelPending();
      state.selectedId = id;
      renderRouteList();
      renderPins();
      updateInspector();
    }

    async function deleteStop(id) {
      try {
        await api(`/api/stops/${id}`, { method: 'DELETE' });
        if (state.selectedId === id) state.selectedId = null;
        state.stops = state.stops.filter((s) => s.id !== id);
        deriveStartedAt();
        render();
        drawTrail();
        setVmToLast();
      } catch (err) {
        console.error(err);
      }
    }

    // ---- Inspector: per-pin infrastructure-route history (layers panel) ----
    let panelOpen = false;
    function setPanelOpen(open) {
      panelOpen = open;
      const p = els.urlPanel;
      if (open) {
        p.style.display = 'block';
        void p.offsetWidth;
        p.style.maxHeight = p.scrollHeight + 'px';
        p.style.opacity = '1';
      } else {
        p.style.maxHeight = '0';
        p.style.opacity = '0';
      }
    }
    let layersActive = false;
    function setLayersBtnVisible(visible) {
      layersActive = visible;
      const b = els.layersBtn;
      b.style.opacity = visible ? '1' : '0.3';
      b.style.cursor = visible ? 'pointer' : 'default';
    }
    function renderUrlList(stop) {
      const idx = state.stops.findIndex((s) => s.id === stop.id);
      const entries = state.stops.slice(0, idx + 1).reverse(); // selected pin first, earlier hops below
      // The workload lives at exactly one place — the most recent (last) stop —
      // so there is only ever one live route, regardless of which pin is selected.
      const liveId = state.stops.length ? state.stops[state.stops.length - 1].id : null;
      els.urlCount.textContent = entries.length + (entries.length === 1 ? ' HOP' : ' HOPS');
      els.urlList.innerHTML = '';
      entries.forEach((s, i) => {
        const live = s.id === liveId;
        const row = document.createElement('div');
        row.style.cssText = ST.urlRow;
        if (i === entries.length - 1) row.style.borderBottom = 'none';
        const plat = document.createElement('div');
        plat.style.cssText = ST.urlPlat;
        plat.style.color = live ? '#2fa45a' : 'var(--text-sub)';
        const dot = document.createElement('span');
        dot.style.cssText = `width:6px;height:6px;border-radius:50%;flex:none;background:${live ? '#2fa45a' : 'var(--text-sub)'}`;
        const plabel = document.createElement('span');
        plabel.textContent = live ? 'live' : 'retired';
        plat.append(dot, plabel);
        const urlEl = document.createElement('span');
        urlEl.style.cssText = live ? ST.urlLink : ST.urlDead;
        urlEl.textContent = s.url || 'unknown';
        row.append(plat, urlEl);
        els.urlList.appendChild(row);
      });
    }
    function updateInspector() {
      const stop = state.stops.find((s) => s.id === state.selectedId);
      if (!stop) {
        setLayersBtnVisible(false);
        setPanelOpen(false);
        return;
      }
      setLayersBtnVisible(true);
      renderUrlList(stop);
      setPanelOpen(panelOpen);
    }

    els.overlay.addEventListener('click', (e) => {
      if (panMoved) { panMoved = false; return; }
      // Single click only clears state; placing a pin requires a double-click.
      if (state.pending) { cancelPending(); return; }
      if (state.selectedId !== null) {
        state.selectedId = null;
        renderRouteList();
        renderPins();
        updateInspector();
      }
    });
    els.overlay.addEventListener('dblclick', (e) => {
      const p = clientToMap(e.clientX, e.clientY);
      openNamer(p.x, p.y);
    });
    // Clicks/drags inside the namer must not reach the map (else the pin moves / pans).
    ['mousedown', 'click'].forEach((ev) =>
      els.namer.addEventListener(ev, (e) => e.stopPropagation()));
    els.namerBtn.addEventListener('click', commitPending);
    els.layersBtn.addEventListener('click', (e) => { e.stopPropagation(); if (layersActive) setPanelOpen(!panelOpen); });
    els.namerInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitPending(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelPending(); }
    });

    // ---- Zoom (mouse wheel + buttons), capped at MIN/MAX scale ----
    function zoomAt(mx, my, factor) {
      const old = view.scale;
      const ns = clamp(old * factor, MIN_SCALE, MAX_SCALE);
      if (ns === old) return;
      const half0 = 0.5 / old;
      const nx = (view.cx - half0) + mx / old;
      const ny = (view.cy - half0) + my / old;
      view.scale = ns;
      const half1 = 0.5 / ns;
      view.cx = nx - mx / ns + half1;
      view.cy = ny - my / ns + half1;
      applyView(true);
    }
    els.map.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = els.overlay.getBoundingClientRect();
      zoomAt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });
    els.zoomIn.addEventListener('click', () => zoomAt(0.5, 0.5, 1.4));
    els.zoomOut.addEventListener('click', () => zoomAt(0.5, 0.5, 1 / 1.4));

    // ---- Drag-to-pan + sidebar resize (share window listeners) ----
    let panning = false, panStart = null, panMoved = false, resizingSb = false, draggingPin = null;
    els.overlay.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      panning = true;
      panMoved = false;
      panStart = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy };
      els.overlay.style.cursor = 'grabbing';
    });
    els.divider.addEventListener('mousedown', (e) => {
      e.preventDefault();
      resizingSb = true;
      document.body.style.userSelect = 'none';
    });
    const winMove = (e) => {
      if (draggingPin) {
        const p = clientToMap(e.clientX, e.clientY);
        const s = state.stops.find((st) => st.id === draggingPin.id);
        if (s) {
          s.x = p.x; s.y = p.y;
          draggingPin.moved = true;
          renderPins();
          setVmToLast();
          drawTrail();
          renderStats();
          if (state.pending) positionNamer();
        }
        return;
      }
      if (panning) {
        const r = els.overlay.getBoundingClientRect();
        if (Math.abs(e.clientX - panStart.x) + Math.abs(e.clientY - panStart.y) > 3) panMoved = true;
        view.cx = panStart.cx - ((e.clientX - panStart.x) / r.width) / view.scale;
        view.cy = panStart.cy - ((e.clientY - panStart.y) / r.height) / view.scale;
        applyView(true);
      } else if (resizingSb) {
        const rect = root.getBoundingClientRect();
        const w = clamp(e.clientX - rect.left, 400, Math.min(680, rect.width * (2 / 3)));
        els.sidebar.style.width = w + 'px';
        applyView(true);
      }
    };
    const winUp = () => {
      if (draggingPin) {
        const { id, moved } = draggingPin;
        draggingPin = null;
        els.overlay.style.cursor = 'grab';
        if (moved) { panMoved = true; selectStop(id); }
        return;
      }
      if (panning) { panning = false; els.overlay.style.cursor = 'grab'; }
      if (resizingSb) { resizingSb = false; document.body.style.userSelect = ''; }
    };
    window.addEventListener('mousemove', winMove);
    window.addEventListener('mouseup', winUp);

    // Keep terrain + overlay in sync with any map size change.
    const ro = new ResizeObserver(() => applyView(true));
    ro.observe(els.map);
    const onKey = (e) => { if (e.key === 'Escape') cancelPending(); };
    document.addEventListener('keydown', onKey);

    let resizeTimer = null;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        drawContours();
        drawTrail();
      }, 140);
    };
    window.addEventListener('resize', onResize);

    const tick = setInterval(() => {
      state.now = Date.now();
      renderStats();
    }, 1000);

    // hover / focus polish (was style-hover/style-focus in the design markup)
    const _hov = (el, prop, on, off) => { if (!el) return;
      el.addEventListener('mouseenter', () => { el.style[prop] = on; });
      el.addEventListener('mouseleave', () => { el.style[prop] = off; }); };
    _hov(els.layersBtn, 'background', 'var(--bg-card-hover)', 'var(--bg-card)');
    _hov(els.zoomIn, 'background', 'var(--bg-card-hover)', 'var(--bg-card)');
    _hov(els.zoomOut, 'background', 'var(--bg-card-hover)', 'var(--bg-card)');
    _hov(els.namerBtn, 'opacity', '0.88', '1');
    if (els.namerInput) {
      els.namerInput.addEventListener('focus', () => { els.namerInput.style.borderColor = 'var(--text)'; els.namerInput.style.background = 'var(--bg-sidebar)'; });
      els.namerInput.addEventListener('blur', () => { els.namerInput.style.borderColor = 'var(--border)'; els.namerInput.style.background = 'var(--bg-input)'; });
    }

    // ---- DB health: show/hide error overlay, poll for recovery ----
    const dbError = document.getElementById('db-error');
    let dbHealthTimer = null;

    function showDbError() {
      dbError.hidden = false;
      if (!dbHealthTimer) {
        dbHealthTimer = setInterval(pollDbHealth, 3000);
      }
    }

    function hideDbError() {
      dbError.hidden = true;
      if (dbHealthTimer) { clearInterval(dbHealthTimer); dbHealthTimer = null; }
    }

    async function pollDbHealth() {
      try {
        const res = await fetch('/health');
        if (!res.ok) return;
        const data = await res.json();
        if (data.database !== 'connected') return;
        hideDbError();
        await loadStops();
        render();
        applyView(false);
        setVmToLast();
        showBanner();
      } catch (_) { /* still down */ }
    }

    // ---- Theme toggle ----
    const SUN_SVG = '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>';
    const MOON_SVG = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
    const themeBtn = document.getElementById('theme-btn');
    const themeIcon = document.getElementById('theme-icon');
    function applyTheme(theme) {
      if (theme === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
        themeIcon.innerHTML = MOON_SVG;
      } else {
        document.documentElement.removeAttribute('data-theme');
        themeIcon.innerHTML = SUN_SVG;
      }
      localStorage.setItem('pw-theme', theme);
      scheduleContour();
      drawTrail();
    }
    themeBtn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      applyTheme(current === 'light' ? 'dark' : 'light');
    });
    _hov(themeBtn, 'background', 'var(--bg-card-hover)', 'var(--bg-card)');
    applyTheme(localStorage.getItem('pw-theme') || 'light');

    // ---- Infrastructure detection ----
    async function loadInfra() {
      try {
        const data = await api('/api/infra');
        const el = document.getElementById('infra-platform');
        if (el && data.platform) el.textContent = data.platform;
        if (data.source === 'pending') setTimeout(loadInfra, 3000);
      } catch (_) {
        setTimeout(loadInfra, 5000);
      }
    }

    // ---- Boot ----
    (async () => {
      buildField();
      drawContours();
      loadInfra();
      try {
        await loadStops();
      } catch (err) {
        console.error('Failed to load stops:', err);
        showDbError();
      }
      render();
      applyView(false);
      setVmToLast();
      els.overlay.style.cursor = 'grab';
      showBanner();
    })();
})();
