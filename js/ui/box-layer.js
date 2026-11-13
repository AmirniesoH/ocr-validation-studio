/**
 * Draws bounding boxes over the page image on a screen-space canvas, so lines
 * stay crisp at every zoom. Boxes are batched by style into one path each.
 *
 *   pending (at or below threshold)  low-confidence color, stronger, light fill
 *   accepted by you            green
 *   corrected                  teal
 *   manually added             purple
 *   accepted by confidence     box color
 *   hovered / selected         blue with a halo, drawn last
 */
OVS.define('ui/box-layer', (require) => {
  'use strict';

  const review = require('model/review');

  // Same hues as --ok, --fix and --add in tokens.css (light theme).
  const COLORS = { active: '#2B59C3', confirmed: '#2E8B57', corrected: '#0E8A95', added: '#8A3FD1' };

  /**
   * @param {CanvasRenderingContext2D} ctx  already scaled for devicePixelRatio
   * @param {object} p  { page, settings, ui, threshold, toScreen(bbox) → [x, y, w, h], toScreenPoint([x, y]) → [x, y], width, height, draft: bbox | null,
   *                    draftPoly: { points: [[x, y]], cursor: [x, y] | null } | null }
   */
  function draw(ctx, p) {
    ctx.clearRect(0, 0, p.width, p.height);
    const s = p.settings, ui = p.ui, th = p.threshold;
    const activeIds = new Set([ui.hoverId, ui.selectedId].filter(Boolean));
    const dimOthers = s.get('dimOthers') && ui.filter !== 'all';
    const highlightLow = s.get('confHighlight');
    const base = s.get('boxOpacity');
    const showBoxes = s.get('showBoxes'), boxColor = s.get('boxColor'), lowColor = s.get('lowColor');
    const styles = new Map();
    const active = [];

    for (const c of p.page.chars) {
      if (c.space || !c.bbox) continue;
      if (activeIds.has(c.id)) { active.push(c); continue; }
      if (!showBoxes) continue;
      const r = p.toScreen(c.bbox);
      if (r[0] > p.width || r[1] > p.height || r[0] + r[2] < 0 || r[1] + r[3] < 0) continue;

      let color = boxColor, alpha = base, fill = null;
      const group = review.reason(c, th);
      if (COLORS[group]) color = COLORS[group];
      else if (highlightLow && group === 'pending') { color = lowColor; alpha = Math.min(1, base + 0.3); fill = color; }
      if (dimOthers && !review.matches(c, ui.filter, th)) alpha *= 0.35;

      const key = color + '|' + alpha.toFixed(2) + '|' + (fill || '');
      if (!styles.has(key)) styles.set(key, { color, alpha, fill, path: new Path2D() });
      const path = styles.get(key).path;
      if (c.poly) addQuad(path, c.poly, p);
      else path.rect(Math.round(r[0]) + 0.5, Math.round(r[1]) + 0.5, Math.max(1, Math.round(r[2])), Math.max(1, Math.round(r[3])));
    }

    ctx.lineWidth = s.get('boxThickness');
    for (const st of styles.values()) {
      if (st.fill) { ctx.globalAlpha = 0.09; ctx.fillStyle = st.fill; ctx.fill(st.path); }
      ctx.globalAlpha = st.alpha;
      ctx.strokeStyle = st.color;
      ctx.stroke(st.path);
    }

    for (const c of active) {
      const outline = new Path2D();
      if (c.poly) addQuad(outline, c.poly, p);
      else { const r = p.toScreen(c.bbox); outline.rect(r[0], r[1], r[2], r[3]); }
      ctx.globalAlpha = 0.28; ctx.strokeStyle = COLORS.active; ctx.lineWidth = 6;
      ctx.stroke(outline);
      ctx.globalAlpha = c.id === ui.hoverId ? 0.18 : 0.1; ctx.fillStyle = COLORS.active;
      ctx.fill(outline);
      ctx.globalAlpha = 1; ctx.lineWidth = 2;
      ctx.stroke(outline);
    }

    if (p.draft) {
      const r = p.toScreen(p.draft);
      ctx.globalAlpha = 0.14; ctx.fillStyle = COLORS.added; ctx.fillRect(r[0], r[1], r[2], r[3]);
      ctx.globalAlpha = 1; ctx.strokeStyle = COLORS.added; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
      ctx.strokeRect(r[0], r[1], r[2], r[3]);
      ctx.setLineDash([]);
    }
    if (p.draftPoly && p.draftPoly.points.length) drawDraftPolygon(ctx, p);
    ctx.globalAlpha = 1;
  }

  /** Corners clicked so far for a polygon, joined in click order, with a line on to the pointer. */
  function drawDraftPolygon(ctx, p) {
    const pts = p.draftPoly.points.map(p.toScreenPoint);
    const path = pts.concat(p.draftPoly.cursor ? [p.toScreenPoint(p.draftPoly.cursor)] : []);
    ctx.globalAlpha = 1; ctx.strokeStyle = COLORS.added; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
    ctx.beginPath();
    path.forEach((s, i) => { if (i) ctx.lineTo(s[0], s[1]); else ctx.moveTo(s[0], s[1]); });
    if (path.length > 2) ctx.closePath();
    ctx.globalAlpha = 0.14; ctx.fillStyle = COLORS.added; if (path.length > 2) ctx.fill();
    ctx.globalAlpha = 1; ctx.stroke();
    ctx.setLineDash([]);
    for (const s of pts) {
      ctx.beginPath(); ctx.arc(s[0], s[1], 4, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 2; ctx.stroke();
    }
  }

  /** Add a rotated character's outline to a path, in screen coordinates. */
  function addQuad(path, quad, p) {
    quad.forEach((pt, i) => { const s = p.toScreenPoint(pt); if (i) path.lineTo(s[0], s[1]); else path.moveTo(s[0], s[1]); });
    path.closePath();
  }

  return { draw };
});
