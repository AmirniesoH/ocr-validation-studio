/**
 * Settings side panel. It opens over the right edge of the workspace, so the
 * image stays visible. The magnifier section shows a live preview, because the
 * inspector it affects is under the panel.
 */
OVS.define('ui/settings-panel', (require) => {
  'use strict';

  const { h } = require('util/dom');
  const { icon } = require('ui/icons');
  const { switchButton, slider, segmented, select } = require('ui/controls');
  const { sidePanel } = require('ui/side-panel');
  const { renderLoupe, ZOOM_LEVELS, LOUPE_SIZE } = require('ui/loupe');
  const { RANGES } = require('core/settings');
  const review = require('model/review');
  const index = require('model/page-index');

  const BOX_COLORS = [['#2B59C3', 'Blue'], ['#0E9AA7', 'Teal'], ['#2E9E5B', 'Green'], ['#C2185B', 'Magenta'], ['#3A3A3A', 'Graphite']];
  const LOW_COLORS = [['#D2691E', 'Orange'], ['#D1435B', 'Red'], ['#9B51E0', 'Violet'], ['#B7950B', 'Amber']];
  const ZOOM_OPTIONS = [['width', 'Fit width'], ['page', 'Fit page'], ['100', '100%'], ['150', '150%'], ['200', '200%']];
  const TEXT_SIZES = [[14, 'Small · 14 px'], [16, 'Medium · 16 px'], [18, 'Large · 18 px'], [20, 'Extra large · 20 px']];

  class SettingsPanel {
    constructor(root, app) {
      this.root = root;
      this.app = app;
      this.live = {};   // controls updated when their setting changes elsewhere
      app.settings.watch(['threshold'], () => this.syncThreshold());
      app.settings.watch(['loupeZoom'], () => this.renderPreview());
      app.bus.onAny(['ui:select', 'page:changed', 'image:loaded'], () => this.renderPreview());
      app.bus.on('settings:changed', (e) => { if (e.key === '*' && !root.hidden) this.render(); });
      sidePanel(root, app, { id: 'settings', label: 'Settings', onOpen: () => this.render() });
    }

    get settings() { return this.app.settings; }

    /* ---------- control builders ---------- */

    row(label, control, description, forId) {
      return h('div', { class: 'set' },
        h('div', null,
          forId ? h('label', { class: 'sl', htmlFor: forId, text: label }) : h('div', { class: 'sl', text: label }),
          description ? h('div', { class: 'sd', text: description }) : null),
        control);
    }

    toggleRow(key, label, description) {
      return this.row(label, switchButton('set-' + key, label, this.settings.get(key), (v) => this.settings.set(key, v)), description);
    }

    /** Slider for a numeric setting; its range comes from RANGES in core/settings.js. */
    rangeRow(key, label, format) {
      const value = h('span', { class: 'val num', text: format(this.settings.get(key)) });
      const input = slider('set-' + key, Object.assign({ value: this.settings.get(key), width: '120px' }, RANGES[key]), (v) => { value.textContent = format(v); this.settings.set(key, v); });
      this.live[key] = { input, value, format };
      return this.row(label, h('div', { class: 'setc' }, input, value), null, 'set-' + key);
    }

    swatchRow(key, label, colors) {
      const s = this.settings;
      const custom = h('input', { class: 'colorin', type: 'color', value: s.get(key), attrs: { 'aria-label': 'Custom ' + label.toLowerCase() } });
      const swatches = colors.map(([c, name]) => h('button', { class: 'swc', style: { background: c }, dataset: { color: c }, attrs: { 'aria-label': name }, onClick: () => { s.set(key, c); custom.value = c; paint(); } }));
      const paint = () => swatches.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.color.toLowerCase() === String(s.get(key)).toLowerCase())));
      custom.addEventListener('input', () => { s.set(key, custom.value); paint(); });
      paint();
      return this.row(label, h('div', { class: 'swatches' }, swatches, custom));
    }

    selectRow(key, label, options, parse, description) {
      return this.row(label, select('set-' + key, options, this.settings.get(key), (v) => this.settings.set(key, v), parse), description, 'set-' + key);
    }

    /* ---------- content ---------- */

    render() {
      const s = this.settings;
      const pct = (v) => Math.round(v * 100) + '%';
      this.live = {};
      this.previewMount = h('div', { class: 'loupe-preview' });
      this.thresholdNote = h('small');
      const preview = h('div', { class: 'prevrow', attrs: { 'aria-label': 'Preview of pending character styling' } },
        'Shipp1ng'.split('').map((ch, i) => h('span', { class: i === 2 || i === 5 ? 'low' : '', text: ch })), this.thresholdNote);

      this.root.replaceChildren(
        h('div', { class: 'dr-h' }, h('h2', { text: 'Settings' }), h('div', { class: 'grow' }),
          h('button', { class: 'ib sq', attrs: { 'aria-label': 'Close settings', 'data-tip': 'Close · Esc' }, onClick: () => this.app.store.setPanel(null) }, icon('x', 16, 1.9))),
        h('div', { class: 'dr-b' },
          h('section', { class: 'sec' }, h('h3', { text: 'Bounding boxes' }),
            this.toggleRow('showBoxes', 'Show bounding boxes', 'Toggle quickly with B'),
            this.toggleRow('imageLabels', 'Labels on the image', 'The character, confidence and status above the hovered or selected box'),
            this.swatchRow('boxColor', 'Box color', BOX_COLORS),
            this.rangeRow('boxOpacity', 'Box opacity', pct),
            this.rangeRow('boxThickness', 'Border thickness', (v) => v.toFixed(1) + ' px')),
          h('section', { class: 'sec' }, h('h3', { text: 'Confidence' }),
            this.rangeRow('threshold', 'Confidence threshold', (v) => v.toFixed(2)),
            h('p', { class: 'sd note', text: 'Characters with a confidence above the threshold are accepted; those at or below it are pending until you correct or accept them.' }),
            this.toggleRow('confHighlight', 'Highlight pending characters'),
            this.swatchRow('lowColor', 'Low-confidence color', LOW_COLORS),
            this.rangeRow('lowOpacity', 'Low-confidence opacity', pct),
            preview),
          h('section', { class: 'sec' }, h('h3', { text: 'General' }),
            this.row('Theme', segmented('Theme', [{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'auto', label: 'Auto' }], s.get('theme'), (v) => s.set('theme', v))),
            this.selectRow('defaultZoom', 'Default zoom', ZOOM_OPTIONS, null, 'Applied now and whenever a page opens'),
            this.selectRow('textSize', 'Text size', TEXT_SIZES, Number)),
          h('section', { class: 'sec' }, h('h3', { text: 'Magnifier' }),
            this.selectRow('loupeZoom', 'Magnifier zoom', ZOOM_LEVELS.map((z) => [z, z + '×']), Number, 'Size of the source crop in the character inspector'),
            this.previewMount),
          h('section', { class: 'sec' }, h('h3', { text: 'Display' }),
            this.toggleRow('lineNumbers', 'Line numbers'),
            this.toggleRow('indent', 'Preserve indentation', 'Offsets each line by its position on the page'),
            this.toggleRow('statusMarks', 'Status marks', 'Tints characters accepted by you, corrected or manually added'),
            this.toggleRow('hoverConfidence', 'Confidence on hover', 'Shows the confidence above the character under the pointer'),
            this.toggleRow('dimOthers', 'Dim characters outside the filter'),
            this.toggleRow('showSpaces', 'Show spaces as dots'))),
        h('div', { class: 'dr-f' }, h('span', { text: 'Settings are kept in this browser.' }),
          h('button', { class: 'btn sm ghost', onClick: () => { s.reset(); this.app.toast.show('Settings reset to defaults.'); } }, 'Reset to defaults')));
      this.syncThreshold();
      this.renderPreview();
    }

    syncThreshold() {
      if (this.root.hidden || !this.live.threshold) return;
      const v = this.settings.get('threshold');
      this.live.threshold.input.setValue(v);
      this.live.threshold.value.textContent = v.toFixed(2);
      // The preview is a fixed example word, "Shipp1ng", with two low-confidence letters.
      this.thresholdNote.textContent = '2 pending at or below ' + v.toFixed(2);
    }

    /** Magnifier preview: the selected character, or the first one with a box on this page. */
    renderPreview() {
      if (this.root.hidden || !this.previewMount) return;
      const store = this.app.store;
      const page = store.currentPage();
      const image = page && this.app.images.peek(page.id);
      const selected = store.getChar(store.ui.selectedId);
      const c = selected && selected.bbox ? selected : page && index.readingOrder(page).find((x) => x.bbox && review.isPending(x, store.threshold)) || (page && index.readingOrder(page).find((x) => x.bbox));
      if (!image || !c) {
        this.previewMount.replaceChildren(h('div', { class: 'loupe empty' }, h('span', { text: 'Open an annotated page to preview' })));
        return;
      }
      const zoom = this.settings.get('loupeZoom');
      this.previewMount.replaceChildren(
        h('div', { class: 'loupe' }, renderLoupe({ image, page, char: c, zoom, size: LOUPE_SIZE }), h('span', { class: 'loupe-cap', text: zoom + '×' })),
        h('div', { class: 'sd', text: 'Preview of “' + c.value + '” on line ' + index.lineNumber(page, c.lineId) + '.' }));
    }
  }

  return { SettingsPanel };
});
