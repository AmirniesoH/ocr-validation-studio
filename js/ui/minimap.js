/**
 * Page overview in the corner of the image viewer: a thumbnail with the visible
 * area outlined. Click or drag on it to move the view.
 */
OVS.define('ui/minimap', (require) => {
  'use strict';

  const { h } = require('util/dom');

  const WIDTH = 92;
  /** Width of the whole box: thumbnail, 6px padding each side, 1px border each side (see .mm in viewer.css). */
  const OUTER_WIDTH = WIDTH + 2 * 6 + 2;

  class Minimap {
    /** @param {(imageX, imageY) => void} onMove  centre the view on an image point */
    constructor(onMove) {
      this.onMove = onMove;
      this.canvas = h('canvas', { attrs: { role: 'img', 'aria-label': 'Page overview. Click to move the view.' } });
      this.label = h('div', { class: 'mmlabel' });
      this.el = h('div', { class: 'float mm', hidden: true }, this.canvas, this.label);
      this.base = null;
      this.image = null;
      this.canvas.addEventListener('pointerdown', (e) => this.drag(e));
    }

    setImage(image) {
      this.image = image;
      this.el.hidden = !image;
      if (!image) return;
      const w = WIDTH * 2, hgt = Math.round(WIDTH * 2 * image.height / image.width);
      this.base = document.createElement('canvas');
      this.base.width = w;
      this.base.height = hgt;
      const ctx = this.base.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(image.img, 0, 0, w, hgt);
      this.canvas.width = w;
      this.canvas.height = hgt;
      this.canvas.style.width = WIDTH + 'px';
      this.canvas.style.height = hgt / 2 + 'px';
    }

    /** @param {{ zoom, panX, panY, viewW, viewH }} view */
    update(view) {
      if (!this.image) return;
      this.label.textContent = Math.round(view.zoom * 100) + '%';
      const ctx = this.canvas.getContext('2d');
      ctx.drawImage(this.base, 0, 0);
      const k = this.canvas.width / this.image.width / view.zoom;
      const x = -view.panX * k, y = -view.panY * k, w = view.viewW * k, hgt = view.viewH * k;
      ctx.fillStyle = 'rgba(43,89,195,.12)';
      ctx.strokeStyle = '#2B59C3';
      ctx.lineWidth = 3;
      ctx.fillRect(x, y, w, hgt);
      ctx.strokeRect(x, y, w, hgt);
    }

    drag(e) {
      if (!this.image) return;
      e.stopPropagation();
      const move = (ev) => {
        const r = this.canvas.getBoundingClientRect();
        this.onMove((ev.clientX - r.left) / r.width * this.image.width, (ev.clientY - r.top) / r.height * this.image.height);
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      move(e);
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    }
  }

  return { Minimap, OUTER_WIDTH };
});
