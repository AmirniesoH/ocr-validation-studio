/**
 * Left panel: documents and their pages with thumbnails, review status and
 * the share of accepted characters. Collapses to a narrow rail of page numbers.
 * A page is Completed only when none of its characters are pending.
 * The area at the bottom is the place to drop more files (the only drop area
 * once a project is open); clicking it opens the import dialog.
 */
OVS.define('ui/nav-panel', (require) => {
  'use strict';

  const { h } = require('util/dom');
  const { plural } = require('util/format');
  const { debounce } = require('util/async');
  const { icon } = require('ui/icons');
  const { confirmButton } = require('ui/controls');
  const { docTag, STATUS_COLOR } = require('ui/labels');
  const { dropTarget } = require('ui/file-drop');
  const review = require('model/review');


  class NavPanel {
    constructor(root, app) {
      this.root = root;
      this.app = app;
      this.items = new Map(); // pageId → { el, update }
      this.thumbLoaders = new Map(); // thumbnail element → load(), until it comes into view
      // An edit changes only its own page's status; the threshold changes every page's.
      const changed = new Set();
      const refreshChanged = debounce(() => { for (const id of changed) { const it = this.items.get(id); if (it) it.update(); } changed.clear(); }, 100);
      app.bus.on('project:changed', () => this.render());
      app.bus.on('page:changed', () => this.markCurrent());
      app.bus.on('chars:changed', (e) => { changed.add(e.pageId); refreshChanged(); });
      app.settings.watch(['navCollapsed'], () => this.render());
      app.settings.watch(['threshold'], debounce(() => this.updateAll(), 100));
      this.render();
    }

    get collapsed() { return this.app.settings.get('navCollapsed'); }

    render() {
      const store = this.app.store;
      this.items.clear();
      this.thumbLoaders.clear();
      this.root.hidden = store.isEmpty();
      this.root.classList.toggle('collapsed', this.collapsed);
      const label = this.collapsed ? 'Show documents' : 'Hide documents';
      const toggle = h('button', { class: 'ib sq', attrs: { 'aria-label': label, 'data-tip': label }, onClick: () => this.app.settings.set('navCollapsed', !this.collapsed) }, icon('panel', 16));
      const head = h('div', { class: 'nav-h' },
        this.collapsed ? null : h('span', { class: 'pane-title', text: 'Documents' }),
        this.collapsed ? null : h('span', { class: 'pane-meta grow', text: plural(store.pageList().length, 'page') }),
        toggle);
      const body = this.collapsed
        ? h('div', { class: 'rail' }, store.pageList().map((p, i) => this.railItem(p, i)))
        : h('div', { class: 'nav-list' }, store.documents.map((d) => this.documentGroup(d)));
      this.root.replaceChildren(head, body, this.dropArea());
      this.observeThumbs(body);
      this.markCurrent();
    }

    /** Thumbnails load as their cards come near view: a book can have hundreds of pages. */
    observeThumbs(scroller) {
      if (this.thumbObserver) this.thumbObserver.disconnect();
      if (!this.thumbLoaders.size) return;
      this.thumbObserver = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          this.thumbObserver.unobserve(e.target);
          const load = this.thumbLoaders.get(e.target);
          this.thumbLoaders.delete(e.target);
          if (load) load();
        }
      }, { root: scroller, rootMargin: '600px 0px' });
      for (const el of this.thumbLoaders.keys()) this.thumbObserver.observe(el);
    }

    /** Drop area for adding more files; also a button that opens the import dialog. */
    dropArea() {
      const cmd = this.app.commands;
      const text = 'Drop images, PDFs, folders or annotation files here to add them';
      const el = this.collapsed
        ? h('div', { class: 'nav-drop mini', attrs: { role: 'button', tabindex: '0', 'aria-label': text + ', or press Enter to browse', 'data-tip': 'Drop files here to add them, or click to browse', 'data-tip-side': 'right' } },
          icon('import', 17))
        : h('div', { class: 'nav-drop', attrs: { role: 'button', tabindex: '0', 'aria-label': text + ', or press Enter to browse' } },
          icon('import', 18),
          h('span', { class: 'nav-drop-text' },
            h('b', { text: 'Add files' }),
            h('span', null, 'Drop images, PDFs, folders or annotation files here, or ', h('u', { text: 'browse' }))));
      el.addEventListener('click', () => cmd.openImport('documents'));
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cmd.openImport('documents'); } });
      return dropTarget(el, (entries) => cmd.openImport(null, entries));
    }

    status(page) {
      const k = review.counts(page.chars, this.app.store.threshold);
      return { k, status: review.pageStatus(k, page.hasAnnotation), pct: k.total ? Math.round(k.accepted / k.total * 100) : 0 };
    }

    documentGroup(doc) {
      const close = confirmButton({ className: 'ib sq close', label: 'Close ' + doc.name, confirmLabel: 'Click again to close', icon: 'x' }, () => this.app.commands.closeDocument(doc.id));
      return h('div', { class: 'docgrp' },
        h('div', { class: 'doch' }, h('span', { class: 'ftag', text: docTag(doc) }), h('span', { class: 'nm', title: doc.name, text: doc.name }), close),
        doc.pageIds.map((id) => this.app.store.pages.get(id)).filter(Boolean).map((p) => this.pageItem(doc, p)));
    }

    pageItem(doc, page) {
      const thumb = h('span', { class: 'thumb' }, h('span', { class: 'spinner small' }));
      this.thumbLoaders.set(thumb, () => this.app.images.thumb(page, doc)
        .then((url) => thumb.replaceChildren(h('img', { src: url, alt: '' })))
        .catch(() => thumb.replaceChildren(icon('image', 18))));
      const title = doc.kind === 'pdf' ? 'Page ' + page.pageNo : doc.pageIds.length > 1 ? page.name : 'Image';
      const pill = h('span', { class: 'spill' }, h('span', { class: 'sdot' }), h('span'));
      const bar = h('i');
      const lineCount = h('span');
      const pct = h('span', { class: 'pct' });
      const el = h('button', { class: 'pg', onClick: () => this.app.commands.openPage(page.id) }, thumb,
        h('span', { class: 'pgi' },
          h('span', { class: 'pgt' }, h('b', { text: title }), lineCount),
          pill,
          h('span', { class: 'progrow' }, h('span', { class: 'prog' }, bar), pct)));
      const update = () => {
        const s = this.status(page);
        lineCount.textContent = plural(page.lines.length, 'line');
        pill.className = 'spill s-' + s.status.key;
        pill.lastChild.textContent = s.status.label;
        bar.style.width = s.pct + '%';
        bar.style.background = STATUS_COLOR[s.status.key];
        pct.textContent = page.hasAnnotation ? s.pct + '%' : '—';
        el.title = page.hasAnnotation ? s.k.accepted + ' of ' + s.k.total + ' characters accepted, ' + s.k.pending + ' pending' : 'No annotation yet';
      };
      update();
      this.items.set(page.id, { el, update });
      return el;
    }

    railItem(page, i) {
      const dot = h('i');
      const el = h('button', { class: 'rp', attrs: { 'data-tip-side': 'right' }, onClick: () => this.app.commands.openPage(page.id) }, h('span', { text: String(i + 1) }), dot);
      const update = () => {
        const s = this.status(page);
        const doc = this.app.store.documentOf(page);
        const tip = doc.name + (doc.pageIds.length > 1 ? ' · page ' + page.pageNo : '') + ' · ' + s.status.label;
        el.dataset.tip = tip;
        el.setAttribute('aria-label', tip);
        dot.style.background = STATUS_COLOR[s.status.key];
      };
      update();
      this.items.set(page.id, { el, update });
      return el;
    }

    updateAll() { for (const item of this.items.values()) item.update(); }

    markCurrent() {
      const cur = this.app.store.ui.pageId;
      for (const [id, item] of this.items) {
        const on = id === cur;
        item.el.classList.toggle('cur', on);
        if (on) { item.el.setAttribute('aria-current', 'page'); item.el.scrollIntoView({ block: 'nearest' }); }
        else item.el.removeAttribute('aria-current');
      }
    }
  }

  return { NavPanel };
});
