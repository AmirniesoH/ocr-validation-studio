/**
 * Magnified crop of the scan around one character, drawn into a canvas.
 * Used by the character inspector and by the live preview in Settings.
 *
 * Zoom is relative to the page's typical character height: at 1× a typical
 * character would be BASE_CHAR_PX tall, so 4× shows it 48 px tall, whatever
 * the scan's resolution.
 *
 * A rotated character (stamp, seal) is turned upright in the crop, so it can be
 * compared with the text directly.
 */
OVS.define('ui/loupe', (require) => {
  'use strict';

  const { h } = require('util/dom');
  const geometry = require('model/geometry');

  const BASE_CHAR_PX = 12;
  const ZOOM_LEVELS = [2, 3, 4, 6, 8];
  /** Side of the square crop in CSS px (character inspector and Settings preview). */
  const LOUPE_SIZE = 132;

  /**
   * @param {{ image, page, char, zoom, size }} o
   *   image  { img, width, height } from the image service
   *   size   side of the square in CSS px
   * @returns {HTMLCanvasElement}
   */
  function renderLoupe(o) {
    const { image, page, char: c, zoom, size } = o;
    const dpr = window.devicePixelRatio || 1;
    const canvas = h('canvas', { width: Math.round(size * dpr), height: Math.round(size * dpr), attrs: { role: 'img', 'aria-label': 'Magnified crop of the scan around “' + c.value + '”, ' + zoom + '×' } });
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#E8E2D4';
    ctx.fillRect(0, 0, size, size);

    const sx = image.width / page.coord.w, sy = image.height / page.coord.h;
    const f = geometry.frameOf(geometry.quadOf(c).map((p) => [p[0] * sx, p[1] * sy])); // in image px
    const typicalHeight = (page.metrics && page.metrics.charH ? page.metrics.charH * sy : f.h);
    const scale = (BASE_CHAR_PX * zoom) / Math.max(4, typicalHeight); // CSS px per image px
    const reach = size / scale * Math.SQRT2;                         // source square that covers the turned crop
    ctx.imageSmoothingQuality = 'high';
    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.rotate(-f.angle);                                            // upright: undo the character's rotation
    ctx.scale(scale, scale);
    ctx.drawImage(image.img, f.cx - reach / 2, f.cy - reach / 2, reach, reach, -reach / 2, -reach / 2, reach, reach);
    ctx.restore();

    // Darken around the box and outline it.
    const bw = f.w * scale, bh = f.h * scale;
    const bx = (size - bw) / 2, by = (size - bh) / 2;
    ctx.fillStyle = 'rgba(30,28,24,.14)';
    ctx.beginPath();
    ctx.rect(0, 0, size, size);
    ctx.rect(bx, by, bw, bh);
    ctx.fill('evenodd');
    ctx.strokeStyle = '#2B59C3';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(bx, by, bw, bh);
    return canvas;
  }

  return { renderLoupe, ZOOM_LEVELS, LOUPE_SIZE };
});
