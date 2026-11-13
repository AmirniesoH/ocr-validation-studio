/**
 * Small shell components: status bar, start screen, the resizer between the
 * image and text panes. The start screen drop zone is a drop area (ui/file-drop.js).
 */
OVS.define('ui/shell', (require) => {
  'use strict';

  const { h } = require('util/dom');
  const { fmtInt, clamp } = require('util/format');
  const { debounce } = require('util/async');
  const { icon } = require('ui/icons');
  const { dropTarget } = require('ui/file-drop');
  const review = require('model/review');

  /* ---------- status bar ---------- */

  class StatusBar {
    constructor(root, app) {
      this.app = app;
      this.page = h('b');
      this.counts = h('span');
      this.progress = h('span');
      const key = (k) => h('kbd', { text: k });
      root.append(this.page, this.counts, this.progress, h('div', { class: 'grow' }),
        h('span', { class: 'keys hide-sm' }, key('Tab'), ' next pending · click or ', key('↵'), ' edit · ', key('Esc'), ' cancel · ',
          key('N'), '/', key('P'), ' navigate · ', key('A'), ' accept · ', key('I'), ' insert · ', key('Ctrl'), '+scroll zoom'));
      const update = debounce(() => this.update(), 80);
      app.bus.onAny(['page:changed', 'chars:changed', 'project:changed'], update);
      app.settings.watch(['threshold'], update);
      this.update();
    }

    update() {
      const store = this.app.store;
      const page = store.currentPage();
      if (!page) { this.page.textContent = 'No document open'; this.counts.textContent = ''; this.progress.textContent = ''; return; }
      const list = store.pageList();
      const k = review.counts(page.chars, store.threshold);
      this.page.textContent = 'Page ' + (list.indexOf(page) + 1) + ' of ' + list.length;
      this.counts.textContent = page.lines.length + ' lines · ' + fmtInt(k.total) + ' characters · ' + fmtInt(k.pending) + ' pending';
      this.progress.textContent = (k.total ? Math.round(k.accepted / k.total * 100) : 0) + '% accepted';
    }
  }

  /* ---------- start screen ---------- */

  class Welcome {
    constructor(root, app) {
      const cmd = app.commands;
      root.appendChild(h('div', { class: 'welcome-card' },
        h('div', null,
          h('h1', { text: 'Validate OCR text against the original scans' }),
          h('p', { text: 'Load scanned pages with their character annotations. Compare each character with the image, fix mistakes in place, add what the OCR missed, and export the validated text.' })),
        dropTarget(h('div', { class: 'dropzone' },
          icon('import', 26),
          h('div', { text: 'Drop images, PDFs, folders or annotation files here' }),
          h('div', { class: 'acts' },
            h('button', { class: 'btn primary', onClick: () => cmd.openImport('documents') }, icon('import', 15), 'Import documents'),
            h('button', { class: 'btn', onClick: () => cmd.loadSample() }, icon('sparkle', 15), 'Try with sample documents')),
          h('div', { class: 'muted small', text: 'Sample documents are for practice: they start fresh every time and are not kept. Your own documents are saved in this browser automatically.' })),
          (entries) => cmd.openImport(null, entries)),
        h('div', { class: 'formats' },
          h('div', null, h('b', { text: 'Documents' }), 'PNG, JPEG, WebP, GIF and BMP images; multi-page PDFs; whole folders.'),
          h('div', null, h('b', { text: 'Annotations' }), 'JSON, Parquet or SQLite with one record per character: value, bounding box, confidence, and optionally line and order.'))));
      const sync = () => { root.hidden = !app.store.isEmpty(); };
      app.bus.on('project:changed', sync);
      sync();
    }
  }

  /* ---------- resizer between the two panes ---------- */

  /**
   * Drag handle between the image and text panes. The split is stored as a
   * fraction (setting "split") and kept within each pane's minimum width in
   * pixels, so the limits hold at any window size:
   *   minWidths() → { left, right }   (px; left = what the image controls need)
   * The limits are re-applied whenever the workspace changes size.
   */
  function bindResizer(handle, left, right, app, minWidths) {
    const s = app.settings;
    const container = handle.parentElement;

    /** Allowed range of the split for the current width: [lo, hi]. */
    const range = () => {
      const width = container.clientWidth - handle.offsetWidth;
      if (width <= 0) return [0, 1];
      const min = minWidths();
      const lo = min.left / width, hi = 1 - min.right / width;
      return lo <= hi ? [lo, hi] : [min.left / (min.left + min.right), min.left / (min.left + min.right)];
    };
    const limit = (f) => { const [lo, hi] = range(); return clamp(f, lo, hi); };

    const apply = () => {
      const f = limit(s.get('split'));
      const [lo, hi] = range();
      left.style.flex = f + ' 1 0px';
      right.style.flex = (1 - f) + ' 1 0px';
      handle.setAttribute('aria-valuenow', String(Math.round(f * 100)));
      // Same rounding for all three, so the value always lies within the reported range.
      handle.setAttribute('aria-valuemin', String(Math.round(lo * 100)));
      handle.setAttribute('aria-valuemax', String(Math.round(hi * 100)));
    };

    Object.assign(handle, { tabIndex: 0 });
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', 'Resize the image and text panes');
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('on');
      document.body.classList.add('resizing');
      const box = container.getBoundingClientRect();
      const move = (ev) => s.set('split', limit((ev.clientX - box.left) / (box.width - handle.offsetWidth)));
      const up = () => {
        handle.classList.remove('on');
        document.body.classList.remove('resizing');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
    handle.addEventListener('keydown', (e) => {
      const step = { ArrowLeft: -0.03, ArrowRight: 0.03 }[e.key];
      if (step) { e.preventDefault(); s.set('split', limit(s.get('split') + step)); }
    });
    s.watch(['split'], apply);
    const ro = new ResizeObserver(apply);
    ro.observe(container);
    ro.observe(left); // also fires when the panes first appear
    apply();
  }

  return { StatusBar, Welcome, bindResizer };
});
