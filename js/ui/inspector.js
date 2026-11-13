/**
 * Character inspector under the text: a magnified crop of the scan around the
 * hovered (or selected) character, its OCR value and confidence, its review
 * state, position and box, and the actions that apply to it.
 */
OVS.define('ui/inspector', (require) => {
  'use strict';

  const { h } = require('util/dom');
  const { icon } = require('ui/icons');
  const { renderLoupe, LOUPE_SIZE } = require('ui/loupe');
  const review = require('model/review');
  const index = require('model/page-index');
  const geometry = require('model/geometry');
  const { round } = require('util/format');

  /** "7.0° anticlockwise" / "12.5° clockwise" (on screen; geometry angles are clockwise-positive). */
  const formatAngle = (deg) => Math.abs(deg).toFixed(1) + '° ' + (deg < 0 ? 'anticlockwise' : 'clockwise');


  class Inspector {
    constructor(root, app) {
      this.root = root;
      this.app = app;
      root.setAttribute('aria-live', 'polite');
      const r = () => this.render();
      app.bus.onAny(['ui:hover', 'ui:select', 'ui:edit', 'page:changed', 'image:loaded', 'ui:view', 'chars:changed'], r);
      app.settings.watch(['loupeZoom', 'threshold', 'lowColor'], r);
      this.render();
    }

    active() {
      const ui = this.app.store.ui;
      return this.app.store.getChar(ui.hoverId || ui.editId || ui.selectedId);
    }

    render() {
      const page = this.app.store.currentPage();
      this.root.hidden = !page || !page.hasAnnotation;
      if (this.root.hidden) return;
      const c = this.active();
      if (!c || c.space) { this.root.replaceChildren(this.emptyState()); return; }
      this.root.replaceChildren(this.loupe(page, c), this.glyph(c), this.details(page, c), this.actions(c));
    }

    emptyState() {
      const keys = [['Tab', 'Next pending character'], ['A', 'Accept selected'], ['I', 'Insert mode'], ['↵', 'Edit or confirm']];
      return h('div', { class: 'iempty' },
        h('div', { class: 'loupe empty' }, h('span', { text: 'Hover a character to see its source crop' })),
        h('div', { class: 'iempty-text' },
          h('h5', { text: 'Character inspector' }),
          h('div', { text: 'Hover any character, in the text or on the image, to compare it with the scan and read its OCR confidence. Click it to correct it in place.' })),
        h('div', { class: 'keys' }, keys.map(([k, label]) => [h('kbd', { text: k }), h('span', { text: label })])));
    }

    loupe(page, c) {
      if (!c.bbox) {
        return h('div', { class: 'loupe empty' }, h('span', { text: 'No bounding box yet' }),
          review.isAdded(c) ? h('button', { class: 'btn sm', onClick: () => this.app.commands.beginDraw(c.id, 'box') }, 'Draw box') : null,
          review.isAdded(c) ? h('button', { class: 'btn sm', onClick: () => this.app.commands.beginDraw(c.id, 'poly') }, 'Draw polygon') : null);
      }
      const image = this.app.images.peek(page.id);
      if (!image) return h('div', { class: 'loupe empty' }, h('div', { class: 'spinner' }));
      const zoom = this.app.settings.get('loupeZoom');
      const caption = c.poly ? zoom + '× · upright' : zoom + '× source crop';
      return h('div', { class: 'loupe' }, renderLoupe({ image, page, char: c, zoom, size: LOUPE_SIZE }), h('span', { class: 'loupe-cap', text: caption }));
    }

    /** The current value; for a corrected character, also the value the OCR detected. */
    glyph(c) {
      return h('div', { class: 'glyphcol' },
        h('div', { class: 'glyph', text: c.value }),
        review.isCorrected(c)
          ? h('div', { class: 'detected', title: 'Originally detected by the OCR' }, 'Detected', h('span', { class: 'was', text: c.ocr.value }))
          : null);
    }

    details(page, c) {
      const th = this.app.store.threshold;
      const conf = review.conf(c);
      const group = review.reason(c, th);
      const above = review.passes(conf, th);
      const lineChars = index.linesOf(page).get(c.lineId) || [];
      // Confidence and its relation to the threshold are shown whatever the group.
      const confColor = conf == null ? 'var(--line2)' : above ? 'var(--ok)' : 'var(--low-color)';
      const confText = conf == null ? 'n/a · added by hand' : conf.toFixed(3) + (above ? ' · above ' : ' · at or below ') + th.toFixed(2);
      return h('dl', { class: 'kv' },
        h('dt', { text: 'Confidence' }),
        h('dd', null,
          h('span', { class: 'meter' }, h('i', { style: { width: (conf == null ? 0 : conf * 100) + '%', background: confColor } }), h('b', { style: { left: th * 100 + '%' }, title: 'Threshold ' + th.toFixed(2) })),
          h('span', { class: 'mono num', text: confText })),
        h('dt', { text: 'Status' }),
        h('dd', null,
          group === 'pending'
            ? h('span', { class: 'spill s-pending' }, h('span', { class: 'sdot' }), 'Pending')
            : [h('span', { class: 'spill s-accepted' }, h('span', { class: 'sdot' }), 'Accepted'), h('span', { class: 'spill s-' + group, text: review.REASON_LABEL[group] })]),
        h('dt', { text: 'Position' }),
        h('dd', { text: 'Line ' + index.lineNumber(page, c.lineId) + ' · character ' + (lineChars.indexOf(c) + 1) }),
        h('dt', { text: 'Bounding box' }),
        h('dd', { class: 'mono small', text: c.bbox ? '[' + c.bbox.map((v) => round(v, 1)).join(', ') + ']' + (c.ocr ? '' : ' · drawn') : 'Not defined' }),
        c.poly ? [h('dt', { text: 'Rotation' }), h('dd', { class: 'mono small', text: formatAngle(geometry.angleOf(c.poly)) })] : null);
    }

    actions(c) {
      const cmd = this.app.commands;
      const th = this.app.store.threshold;
      const store = this.app.store;
      // One click must be enough while a character is being edited, so the action first ends the edit.
      const button = (name, label, fn, o) => h('button', { class: 'btn sm ' + ((o && o.cls) || ''), onClick: () => { if (store.ui.editId) store.setEdit(null); fn(); } },
        icon(name, 14, name === 'check' ? 2.2 : 1.8), label, o && o.key ? h('kbd', { text: o.key }) : null);
      const added = review.isAdded(c);
      const acts = h('div', { class: 'iacts' },
        review.isPending(c, th) ? button('check', 'Accept', () => cmd.acceptChar(c.id, true), { key: 'A' }) : null,
        button('pencil', 'Correct', () => cmd.focusChar(c.id, { edit: true }), { key: '↵' }),
        review.isCorrected(c) ? button('restore', 'Restore OCR value', () => cmd.restoreChar(c.id), { cls: 'ghost' }) : null,
        review.isConfirmed(c, th) ? button('restore', 'Undo acceptance', () => cmd.unacceptChar(c.id), { cls: 'ghost' }) : null,
        added ? button('boxDraw', 'Draw box', () => cmd.beginDraw(c.id, 'box'), { cls: 'ghost' }) : null,
        added ? button('polyDraw', 'Draw polygon', () => cmd.beginDraw(c.id, 'poly'), { cls: 'ghost' }) : null,
        button('insert', 'Insert before', () => cmd.insertNear(c.id, -1), { cls: 'ghost' }),
        button('insert', 'Insert after', () => cmd.insertNear(c.id, 1), { cls: 'ghost' }),
        button('trash', 'Remove', () => cmd.removeChar(c.id), { cls: 'ghost danger' }));
      // Pressing a button must not take the focus from the editor: it would blur, cancel the edit
      // and redraw these buttons before the click arrives (the first click was lost).
      acts.addEventListener('mousedown', (e) => e.preventDefault());
      return acts;
    }
  }

  return { Inspector };
});
