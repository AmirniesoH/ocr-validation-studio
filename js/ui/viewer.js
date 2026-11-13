/**
 * Original image viewer. The page image sits in a transformed stage (zooming
 * and panning never affect the rest of the layout); boxes are drawn by
 * ui/box-layer.js on a canvas above it.
 *
 * Pan: drag, wheel, arrow keys.  Zoom: buttons, Ctrl/Cmd + wheel, pinch, double-click,
 * or type a level into the zoom field ("150", "150%", "1.5x").
 * Hover a box to inspect its character; click it to edit; drag to draw the box
 * (or click four corners to draw the polygon)
 * of a manually added character.
 *
 * The Default zoom setting applies when a page opens and immediately when it changes.
 */
OVS.define('ui/viewer', (require) => {
  'use strict';

  const { h } = require('util/dom');
  const { clamp } = require('util/format');
  const { rafThrottle } = require('util/async');
  const { icon } = require('ui/icons');
  const { segmented } = require('ui/controls');
  const { pageLabel } = require('ui/labels');
  const boxLayer = require('ui/box-layer');
  const { Minimap, OUTER_WIDTH: MINIMAP_WIDTH } = require('ui/minimap');
  const review = require('model/review');
  const geometry = require('model/geometry');
  const index = require('model/page-index');

  const MIN_ZOOM = 0.05, MAX_ZOOM = 8;
  const MARGIN = 24;

  /**
   * A typed zoom level as a percentage: "150", "150%", "150 %", ".5x", "1.5x" or "×1.5".
   * Out-of-range numbers (0, negatives, huge values) are returned as typed, for the
   * caller to clamp; null only when the text is not a number.
   */
  function parseZoom(text) {
    const t = String(text).trim().replace(',', '.').toLowerCase();
    const NUM = '([-−]?(?:\\d+(?:\\.\\d*)?|\\.\\d+))';
    const toNumber = (v) => parseFloat(v.replace('−', '-'));
    let m = new RegExp('^' + NUM + '\\s*%?$').exec(t);
    if (m) return toNumber(m[1]);
    m = new RegExp('^[x×]?\\s*' + NUM + '\\s*[x×]?$').exec(t);
    if (m && /[x×]/.test(t)) return toNumber(m[1]) * 100;
    return null;
  }

  class Viewer {
    constructor(root, app) {
      this.root = root;
      this.app = app;
      this.view = { zoom: 1, panX: 0, panY: 0 };
      this.image = null;      // { url, img, width, height } of the current page
      this.drag = null;
      this.draft = null;      // box being drawn, in annotation coordinates
      this.corners = { id: null, points: [], cursor: null }; // polygon being drawn: corners clicked so far
      this.redraw = rafThrottle(() => this.draw());
      this.render();
      this.bindPointer();
      this.subscribe();
      new ResizeObserver(() => { this.resizeCanvas(); this.fitControls(); this.update(); }).observe(this.vp);
      this.loadPage();
    }

    /**
     * Narrowest width at which the floating controls fit: the zoom bar is centred
     * at the bottom and the page overview sits in the bottom-right corner, so the
     * pane needs room for the zoom bar plus an overview-sized margin on each side.
     * Used by the resizer between the panes (ui/shell.js) as the image pane's minimum.
     */
    minWidth() {
      const EDGE = 14, GAP = 10; // .mm right offset (viewer.css), space between overview and zoom bar
      const zoom = this.zoombar.offsetWidth || 300;
      return Math.ceil(zoom + 2 * (MINIMAP_WIDTH + EDGE + GAP));
    }

    /** Safety net for very small windows: hide the overview rather than let it cover the zoom bar. */
    fitControls() {
      const w = this.vp.clientWidth;
      this.vp.classList.toggle('narrow', w > 0 && w < this.minWidth());
    }

    get page() { return this.app.store.currentPage(); }
    get ui() { return this.app.store.ui; }

    subscribe() {
      const { bus, settings } = this.app;
      bus.on('page:changed', () => this.loadPage());
      bus.on('project:changed', () => { if (!this.page) this.loadPage(); });
      bus.on('chars:changed', (e) => { if (e.pageId === this.ui.pageId) { this.redraw(); this.updateDrawing(); } });
      bus.onAny(['ui:hover', 'ui:select'], () => { this.redraw(); this.updateLabel(); this.updateDrawing(); });
      bus.on('ui:view', () => { this.redraw(); this.updateDrawing(); });
      bus.on('ui:reveal', (e) => this.centerOn(this.app.store.getChar(e.id), false));
      settings.watch(['showBoxes', 'boxColor'], () => this.updateBoxButton());
      settings.watch(['showBoxes', 'boxColor', 'boxOpacity', 'boxThickness', 'lowColor', 'confHighlight', 'dimOthers', 'threshold'], () => this.redraw());
      settings.watch(['imageLabels'], () => this.updateLabel());
      settings.watch(['defaultZoom'], () => this.fit(settings.get('defaultZoom')));
    }

    /* ---------- DOM ---------- */

    render() {
      const app = this.app, cmd = app.commands;
      this.meta = h('span', { class: 'pane-meta' });
      this.tools = segmented('Viewer tool', [
        { value: 'pan', icon: 'hand', tip: 'Pan · drag the page' },
        { value: 'box', icon: 'boxDraw', tip: 'Draw a box for a manually added character' },
        { value: 'poly', icon: 'polyDraw', tip: 'Draw a polygon for a tilted or rotated character' }
      ], 'pan', (v) => { if (v === 'pan') cmd.cancelDraw(); else cmd.beginDraw(this.ui.drawFor || this.ui.selectedId, v); });
      this.boxButton = h('button', { class: 'ib sq', onClick: () => app.settings.set('showBoxes', !app.settings.get('showBoxes')) });
      this.swatch = h('span', { class: 'boxsw' });
      const styleButton = h('button', { class: 'ib sq', attrs: { 'aria-label': 'Bounding box style', 'data-tip': 'Bounding box style' }, onClick: () => app.store.setPanel('settings') }, this.swatch);

      this.img = h('img', { alt: 'Original scanned page', draggable: false });
      this.stage = h('div', { class: 'stage', hidden: true }, this.img);
      this.canvas = h('canvas', { class: 'overlay', attrs: { 'aria-hidden': 'true' } });
      this.label = h('div', { class: 'hlabel', hidden: true });
      this.message = h('div', { class: 'vp-msg' });
      this.drawText = h('span');
      this.shapes = segmented('Outline shape', [{ value: 'box', label: 'Box' }, { value: 'poly', label: 'Polygon' }], 'box', (v) => cmd.beginDraw(this.ui.drawFor, v));
      this.restartButton = h('button', { class: 'btn sm ghost', hidden: true, onClick: () => { this.corners.points = []; this.updateDrawing(); this.redraw(); } }, 'Start over');
      this.drawBanner = h('div', { class: 'float banner', hidden: true },
        this.shapes, this.drawText, this.restartButton,
        h('button', { class: 'btn sm ghost', onClick: () => cmd.cancelDraw() }, 'Skip'));
      this.noAnnotation = h('div', { class: 'float banner neutral', hidden: true },
        h('span', { class: 'bi' }, icon('braces', 15)),
        h('span', { text: 'This page has no annotation yet. Import a JSON, Parquet or SQLite file to validate it.' }),
        h('button', { class: 'btn sm', onClick: () => cmd.openImport('annotation') }, 'Import'));

      const zoomButton = (name, tip, fn) => h('button', { class: 'ib sq', attrs: { 'aria-label': tip, 'data-tip-up': tip }, onClick: fn }, icon(name, 16));
      this.zoomText = this.zoomField();
      this.centerButton = zoomButton('target', 'Center on selected character', () => this.centerOn(this.app.store.getChar(this.ui.selectedId), true));
      const zoombar = this.zoombar = h('div', { class: 'float zoombar', attrs: { role: 'group', 'aria-label': 'Zoom' } },
        zoomButton('zoomOut', 'Zoom out · −', () => this.zoomBy(1 / 1.25)), this.zoomText, zoomButton('zoomIn', 'Zoom in · +', () => this.zoomBy(1.25)),
        h('span', { class: 'vsep' }),
        zoomButton('fitWidth', 'Fit width · 0', () => this.fit('width')), zoomButton('fitPage', 'Fit page', () => this.fit('page')),
        h('button', { class: 'ib text', attrs: { 'aria-label': 'Actual size', 'data-tip-up': 'Actual size' }, onClick: () => this.fit('100') }, '1:1'),
        h('span', { class: 'vsep' }), this.centerButton);

      this.minimap = new Minimap((x, y) => this.centerImagePoint(x, y));
      this.vp = h('div', { class: 'vp', tabIndex: 0, attrs: { 'aria-label': 'Original image. Drag to pan, Ctrl and scroll to zoom.' } },
        this.stage, this.canvas, this.message, this.label, this.drawBanner, this.noAnnotation, zoombar, this.minimap.el);
      this.root.append(
        h('div', { class: 'pane-h' }, h('span', { class: 'pane-title', text: 'Original image' }), this.meta, h('div', { class: 'grow' }), this.tools, this.boxButton, styleButton),
        this.vp);
      this.updateBoxButton();
    }

    updateBoxButton() {
      const on = this.app.settings.get('showBoxes');
      const tip = (on ? 'Hide' : 'Show') + ' bounding boxes · B';
      this.boxButton.replaceChildren(icon(on ? 'eye' : 'eyeOff', 16));
      this.boxButton.classList.toggle('on', on);
      this.boxButton.setAttribute('aria-pressed', String(on));
      this.boxButton.setAttribute('aria-label', tip);
      this.boxButton.dataset.tip = tip;
      this.swatch.style.borderColor = this.app.settings.get('boxColor');
    }

    /* ---------- page ---------- */

    async loadPage() {
      const page = this.page;
      this.image = null;
      this.stage.hidden = true;
      this.label.hidden = true;
      this.noAnnotation.hidden = true;
      this.minimap.setImage(null);
      this.updateDrawing();
      this.redraw();
      if (!page) { this.message.replaceChildren(); this.meta.textContent = ''; return; }
      const doc = this.app.store.documentOf(page);
      this.meta.textContent = pageLabel(doc, page) + ' · ' + page.image.width + ' × ' + page.image.height + ' px';
      this.message.replaceChildren(h('div', { class: 'spinner' }), h('span', { text: doc.kind === 'pdf' ? 'Rendering page…' : 'Loading image…' }));
      try {
        this.app.images.pin(page.id);
        const res = await this.app.images.get(page, doc);
        if (this.ui.pageId !== page.id) return;
        this.image = res;
        this.img.src = res.url;
        this.img.width = res.width;
        this.img.height = res.height;
        this.stage.hidden = false;
        this.message.replaceChildren();
        this.noAnnotation.hidden = page.hasAnnotation;
        this.minimap.setImage(res);
        this.fit(this.app.settings.get('defaultZoom'));
      } catch (err) {
        console.error(err);
        if (this.ui.pageId === page.id) this.message.replaceChildren(icon('alert', 22), h('span', { text: 'The page image could not be displayed: ' + err.message }));
      }
    }

    /** Image pixels per annotation unit. */
    scale() {
      const page = this.page;
      return page && this.image ? { x: this.image.width / page.coord.w, y: this.image.height / page.coord.h } : { x: 1, y: 1 };
    }

    /* ---------- zoom and pan ---------- */

    /**
     * The zoom level, editable: click it, type a level and press Enter (or click away).
     * Escape cancels; ↑ / ↓ step by 10% (Shift: 50%). Out-of-range levels are clamped
     * to 5–800%; anything unreadable puts the current level back.
     */
    zoomField() {
      const input = h('input', {
        class: 'zval num', type: 'text', spellcheck: false, autocomplete: 'off',
        attrs: { inputmode: 'decimal', 'aria-label': 'Zoom level in percent', 'data-tip-up': 'Zoom level · click to type' }
      });
      const show = () => { input.value = Math.round(this.view.zoom * 100) + '%'; };
      const apply = () => {
        const typed = parseZoom(input.value);
        if (typed != null) {
          // Beyond the limits: use the nearest one and say so.
          const percent = clamp(typed, MIN_ZOOM * 100, MAX_ZOOM * 100);
          if (percent !== typed) {
            const which = percent === MAX_ZOOM * 100 ? 'maximum' : 'minimum';
            this.app.toast.show('Zoom set to ' + percent + '%, the ' + which + ' (allowed: ' + MIN_ZOOM * 100 + '–' + MAX_ZOOM * 100 + '%).');
          }
          // An unchanged level (e.g. after Escape) must not nudge the zoom by its rounding.
          if (percent !== Math.round(this.view.zoom * 100)) this.zoomToPercent(percent);
        }
        show();
      };
      input.addEventListener('focus', () => { input.value = String(Math.round(this.view.zoom * 100)); input.select(); });
      input.addEventListener('blur', apply);
      input.addEventListener('keydown', (e) => {
        e.stopPropagation(); // keep arrow keys and shortcuts out of the image's handlers
        if (e.key === 'Enter') { e.preventDefault(); apply(); input.value = String(Math.round(this.view.zoom * 100)); input.select(); }
        else if (e.key === 'Escape') { e.preventDefault(); show(); this.vp.focus({ preventScroll: true }); }
        else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const step = (e.shiftKey ? 50 : 10) * (e.key === 'ArrowUp' ? 1 : -1);
          const current = parseZoom(input.value);
          this.zoomToPercent((current != null ? current : this.view.zoom * 100) + step);
          input.value = String(Math.round(this.view.zoom * 100));
          input.select();
        }
      });
      return input;
    }

    /** Zoom to a percentage, around the centre of the view. */
    zoomToPercent(percent) {
      if (!this.image || !isFinite(percent)) return;
      this.zoomAt(percent / 100, this.vp.clientWidth / 2, this.vp.clientHeight / 2);
    }

    update() {
      const v = this.view;
      this.stage.style.transform = 'translate(' + v.panX + 'px,' + v.panY + 'px) scale(' + v.zoom + ')';
      // While the user is typing a level, leave the field alone.
      if (document.activeElement !== this.zoomText) this.zoomText.value = Math.round(v.zoom * 100) + '%';
      this.minimap.update(Object.assign({ viewW: this.vp.clientWidth, viewH: this.vp.clientHeight }, v));
      this.redraw();
      this.updateLabel();
    }

    /** mode: 'width' | 'page' | a percentage as a string ('100', '150', '200') */
    fit(mode) {
      if (!this.image) return;
      const vw = this.vp.clientWidth, vh = this.vp.clientHeight, W = this.image.width, H = this.image.height;
      let zoom;
      if (mode === 'page') zoom = Math.min((vw - MARGIN * 2) / W, (vh - MARGIN * 3) / H);
      else if (mode === 'width') zoom = (vw - MARGIN * 2) / W;
      else zoom = (parseFloat(mode) || 100) / 100;
      zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
      this.view = {
        zoom,
        panX: Math.round((vw - W * zoom) / 2),
        panY: mode === 'page' ? Math.round(Math.max(MARGIN, (vh - H * zoom) / 2 - MARGIN / 2)) : MARGIN
      };
      this.update();
    }

    zoomAt(zoom, x, y) {
      zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
      const v = this.view, k = zoom / v.zoom;
      this.view = { zoom, panX: x - (x - v.panX) * k, panY: y - (y - v.panY) * k };
      this.update();
    }

    zoomBy(factor) { this.zoomAt(this.view.zoom * factor, this.vp.clientWidth / 2, this.vp.clientHeight / 2); }

    panBy(dx, dy) { this.view.panX += dx; this.view.panY += dy; this.update(); }

    centerImagePoint(x, y) {
      this.view.panX = this.vp.clientWidth / 2 - x * this.view.zoom;
      this.view.panY = this.vp.clientHeight / 2 - y * this.view.zoom;
      this.update();
    }

    /** Annotation box → viewport rectangle [x, y, w, h]. */
    toScreen(b) {
      const s = this.scale(), v = this.view;
      return [v.panX + b[0] * s.x * v.zoom, v.panY + b[1] * s.y * v.zoom, (b[2] - b[0]) * s.x * v.zoom, (b[3] - b[1]) * s.y * v.zoom];
    }

    /** Annotation point [x, y] → viewport point. */
    toScreenPoint(p) {
      const s = this.scale(), v = this.view;
      return [v.panX + p[0] * s.x * v.zoom, v.panY + p[1] * s.y * v.zoom];
    }

    /** Viewport point → annotation coordinates. */
    toCoord(x, y) {
      const s = this.scale(), v = this.view;
      return [(x - v.panX) / v.zoom / s.x, (y - v.panY) / v.zoom / s.y];
    }

    /** Bring a character's box into view; with always, centre it even if visible. */
    centerOn(c, always) {
      if (!c || !c.bbox || !this.image) return;
      const r = this.toScreen(c.bbox);
      const vw = this.vp.clientWidth, vh = this.vp.clientHeight;
      const cx = r[0] + r[2] / 2, cy = r[1] + r[3] / 2;
      if (!always && cx > 70 && cx < vw - 70 && cy > 60 && cy < vh - 150) return;
      this.panBy(vw / 2 - cx, vh / 2 - cy);
    }

    /* ---------- drawing ---------- */

    resizeCanvas() {
      this.dpr = window.devicePixelRatio || 1;
      const w = this.vp.clientWidth, hgt = this.vp.clientHeight;
      this.canvas.width = Math.round(w * this.dpr);
      this.canvas.height = Math.round(hgt * this.dpr);
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = hgt + 'px';
    }

    draw() {
      const ctx = this.canvas.getContext('2d');
      const dpr = this.dpr || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!this.page || !this.image) { ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); return; }
      boxLayer.draw(ctx, {
        page: this.page, settings: this.app.settings, ui: this.ui, threshold: this.app.store.threshold,
        toScreen: (b) => this.toScreen(b), toScreenPoint: (pt) => this.toScreenPoint(pt),
        width: this.vp.clientWidth, height: this.vp.clientHeight, draft: this.draft,
        draftPoly: this.ui.tool === 'poly' && this.ui.drawFor ? this.corners : null
      });
    }

    /** Small label above the hovered or selected box (the "Labels on the image" setting). */
    updateLabel() {
      const c = this.app.store.getChar(this.ui.hoverId || this.ui.selectedId);
      if (!c || !c.bbox || !this.image || !this.app.settings.get('imageLabels')) { this.label.hidden = true; return; }
      const r = this.toScreen(c.bbox);
      const conf = review.conf(c);
      this.label.textContent = '“' + c.value + '”  ' + (conf == null ? 'manual' : conf.toFixed(2)) + '  · ' + review.REASON_LABEL[review.reason(c, this.app.store.threshold)];
      this.label.hidden = false;
      this.label.style.left = clamp(r[0] - 4, 6, Math.max(6, this.vp.clientWidth - 200)) + 'px';
      this.label.style.top = (r[1] > 34 ? r[1] - 28 : r[1] + r[3] + 8) + 'px';
    }

    /** Banner and tool state while a manually added character waits for its box. */
    updateDrawing() {
      const store = this.app.store;
      const target = store.getChar(this.ui.drawFor);
      const tool = this.ui.tool;
      const drawing = !!(target && tool !== 'pan');
      const polygon = drawing && tool === 'poly';
      // Corners belong to one character and one polygon: anything else starts afresh.
      if (!polygon || this.corners.id !== target.id) this.corners = { id: polygon ? target.id : null, points: [], cursor: null };
      this.drawBanner.hidden = !drawing;
      if (drawing) {
        const what = '“' + target.value + '” (line ' + index.lineNumber(this.page, target.lineId) + ')';
        const n = this.corners.points.length;
        this.drawText.textContent = !polygon ? 'Drag a box around ' + what + '.'
          : n ? 'Corner ' + n + ' of 4 placed.'
            : 'Click the four corners of ' + what + ', in any order.';
        this.shapes.setValue(tool);
        this.restartButton.hidden = !(polygon && n);
      }
      this.vp.classList.toggle('draw', drawing);
      this.tools.setValue(drawing ? tool : 'pan');
      const selected = store.getChar(this.ui.selectedId);
      const canDraw = drawing || !!(selected && review.isAdded(selected));
      for (const v of ['box', 'poly']) this.tools.querySelector('[data-value="' + v + '"]').disabled = !canDraw;
      this.centerButton.disabled = !(selected && selected.bbox);
    }

    /* ---------- pointer and keyboard ---------- */

    /** The smallest box under a viewport point. */
    hitTest(x, y) {
      if (!this.page || !this.image) return null;
      const [px, py] = this.toCoord(x, y);
      // Smallest character whose outline contains the point (rotated characters by their true shape).
      let best = null, bestArea = Infinity;
      for (const c of this.page.chars) {
        const b = c.bbox;
        if (c.space || !b || px < b[0] || px > b[2] || py < b[1] || py > b[3]) continue;
        if (c.poly && !geometry.contains(c.poly, px, py)) continue;
        const f = c.poly ? geometry.frameOf(c.poly) : { w: b[2] - b[0], h: b[3] - b[1] };
        if (f.w * f.h < bestArea) { best = c; bestArea = f.w * f.h; }
      }
      return best;
    }

    local(e) { const r = this.vp.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

    /** A click while drawing a polygon places a corner (dragging still pans); the fourth one saves it. */
    addCorner(point) {
      const points = this.corners.points;
      points.push(point);
      if (points.length === 4 && !this.app.commands.setPolygon(this.ui.drawFor, points)) this.corners.points = [];
      this.updateDrawing();
      this.redraw();
    }

    bindPointer() {
      const vp = this.vp, store = this.app.store, cmd = this.app.commands;

      vp.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target.closest('.float')) return;
        const [x, y] = this.local(e);
        vp.setPointerCapture(e.pointerId);
        if (this.ui.tool === 'box' && this.ui.drawFor) {
          const p = this.toCoord(x, y);
          this.drag = { mode: 'draw', x0: p[0], y0: p[1] };
          this.draft = [p[0], p[1], p[0], p[1]];
        } else {
          this.drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, panX: this.view.panX, panY: this.view.panY, moved: false, x, y };
        }
      });

      vp.addEventListener('pointermove', (e) => {
        const [x, y] = this.local(e);
        const d = this.drag;
        if (d && d.mode === 'pan') {
          const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
          if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
          d.moved = true;
          vp.classList.add('panning');
          this.view.panX = d.panX + dx;
          this.view.panY = d.panY + dy;
          this.update();
        } else if (d && d.mode === 'draw') {
          const p = this.toCoord(x, y);
          this.draft = [Math.min(d.x0, p[0]), Math.min(d.y0, p[1]), Math.max(d.x0, p[0]), Math.max(d.y0, p[1])];
          this.redraw();
        } else if (this.ui.tool === 'poly' && this.ui.drawFor) {
          this.corners.cursor = this.toCoord(x, y); // the outline follows the pointer to the next corner
          this.redraw();
        } else {
          const hit = this.hitTest(x, y);
          store.setHover(hit ? hit.id : null);
        }
      });

      const end = (e) => {
        const d = this.drag;
        this.drag = null;
        vp.classList.remove('panning');
        if (!d) return;
        if (d.mode === 'draw') {
          const r = this.draft, s = this.scale();
          this.draft = null;
          if (r && (r[2] - r[0]) * s.x * this.view.zoom > 3 && (r[3] - r[1]) * s.y * this.view.zoom > 3) cmd.setBox(this.ui.drawFor, r);
          this.redraw();
        } else if (!d.moved && e.type === 'pointerup') {
          if (this.ui.tool === 'poly' && this.ui.drawFor) { this.addCorner(this.toCoord(d.x, d.y)); return; }
          const hit = this.hitTest(d.x, d.y);
          if (hit) cmd.focusChar(hit.id, { edit: true });
        }
      };
      vp.addEventListener('pointerup', end);
      vp.addEventListener('pointercancel', end);
      vp.addEventListener('pointerleave', () => { if (!this.drag) store.setHover(null); });

      vp.addEventListener('wheel', (e) => {
        if (!this.image) return;
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          const [x, y] = this.local(e);
          this.zoomAt(this.view.zoom * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0022)), x, y);
        } else {
          const k = e.deltaMode === 1 ? 16 : 1;
          this.panBy(-(e.shiftKey ? e.deltaY : e.deltaX) * k, -(e.shiftKey ? 0 : e.deltaY) * k);
        }
      }, { passive: false });

      vp.addEventListener('dblclick', (e) => {
        if (this.ui.tool !== 'pan' || e.target.closest('.float')) return;
        const [x, y] = this.local(e);
        this.zoomAt(this.view.zoom * 1.6, x, y);
      });

      vp.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 120 : 40;
        const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
        if (moves[e.key]) { e.preventDefault(); this.panBy(moves[e.key][0], moves[e.key][1]); }
      });
    }
  }

  return { Viewer };
});
