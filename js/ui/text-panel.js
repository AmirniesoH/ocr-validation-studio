/**
 * Digital text panel. One row per source line; every character is its own
 * button, linked to its box on the image.
 *
 *   hover        highlight + confidence + box on the image + crop in the inspector
 *   click        replace the character in place with an input
 *   Tab          next pending character (opens its editor); Shift+Tab previous
 *   N / P        next / previous character in the active filter
 *   arrows       move the selection
 *   insert mode  insertion points between characters and at line ends
 *
 * Rendering is incremental: hover, selection and single edits touch only the
 * affected cells; insertions and removals re-render one line.
 */
OVS.define('ui/text-panel', (require) => {
  'use strict';

  const { h, setPressed } = require('util/dom');
  const { fmtInt, plural } = require('util/format');
  const { debounce } = require('util/async');
  const { icon } = require('ui/icons');
  const { slider, confirmButton } = require('ui/controls');
  const { createCharEditor } = require('ui/inline-editor');
  const { RANGES } = require('core/settings');
  const review = require('model/review');
  const index = require('model/page-index');

  /**
   * Dimming for the active filter, as CSS: the text body carries data-filter and each
   * character its group class (is-<group>), so switching filters restyles no cells.
   * Built from review.FILTERS, the one definition of which groups each filter shows.
   */
  function installFilterStyles() {
    if (document.getElementById('ovs-filter-dimming')) return;
    const rules = review.FILTERS.filter((f) => f.id !== 'all').map((f) =>
      '.dim-on[data-filter="' + f.id + '"] .ch' + f.groups.map((g) => ':not(.is-' + g + ')').join('') + ' { opacity: .4; }');
    document.head.appendChild(h('style', { id: 'ovs-filter-dimming', text: rules.join('\n') }));
  }

  const FILTER_DOTS = { all: 'var(--text3)', pending: 'var(--low-color)', accepted: 'var(--ok-auto)', confirmed: 'var(--ok)', corrected: 'var(--fix)', added: 'var(--add)' };

  class TextPanel {
    constructor(root, app) {
      installFilterStyles();
      this.root = root;
      this.app = app;
      this.cells = new Map();   // charId → { cell, button }
      this.rows = new Map();    // lineId → row element
      this.editor = null;       // { id, handle } of the open character editor
      this.pill = null;
      this.insertPoints = false; // whether cells carry their insert targets (insert mode)
      this.activeRow = null;    // row of the hovered, edited or selected character
      this.lifted = new Set();  // rows that render normally although out-of-view rows are skipped (see liftRows)
      this.render();
      this.bindEvents();
      this.subscribe();
      this.renderPage();
    }

    get store() { return this.app.store; }
    get page() { return this.store.currentPage(); }
    get ui() { return this.store.ui; }
    get threshold() { return this.store.threshold; }

    subscribe() {
      const { bus, settings } = this.app;
      const counts = debounce(() => this.updateCounts(), 60);
      bus.on('page:changed', () => this.renderPage());
      bus.on('project:changed', () => { if (!this.page) this.renderPage(); });
      bus.on('chars:changed', (e) => { if (e.pageId === this.ui.pageId) { this.onCharsChanged(e); counts(); } });
      bus.on('ui:hover', (e) => this.onHover(e));
      bus.on('ui:select', (e) => this.onSelect(e));
      bus.on('ui:edit', (e) => this.onEdit(e));
      bus.on('ui:insert', (e) => this.onInsert(e));
      bus.on('ui:view', () => this.refreshView());
      bus.on('ui:reveal', (e) => this.reveal(e.id));
      settings.watch(['indent', 'showSpaces'], () => this.renderPage(true));
      settings.watch(['hoverConfidence'], () => { this.hidePill(); this.showPill(this.store.getChar(this.ui.hoverId)); });
      settings.watch(['threshold', 'confHighlight', 'statusMarks', 'dimOthers', 'lineNumbers'], () => this.refreshView());
    }

    /** Filter, insert mode, threshold or display settings changed: restyle without rebuilding. */
    refreshView() {
      this.applyViewState();
      this.refreshClasses();
      this.updateCounts();
    }

    /* ---------- static parts ---------- */

    render() {
      const cmd = this.app.commands;
      this.meta = h('span', { class: 'pane-meta' });
      this.insertButton = h('button', { class: 'ib', attrs: { 'data-tip': 'Insert missing characters · I' }, onClick: () => cmd.toggleInsertMode() }, icon('insert', 16), h('span', { text: 'Insert' }));
      this.acceptPageButton = confirmButton({
        className: 'ib accept-page', label: 'Accept page', icon: 'check', showText: true,
        confirmLabel: () => 'Click again to accept ' + plural(this.pendingCount, 'pending character')
      }, () => cmd.acceptPage());
      this.acceptPageButton.dataset.tip = 'Accept every pending character on this page';
      this.pendingCount = 0;

      this.thresholdValue = h('span', { class: 'val num' });
      this.thresholdSlider = slider('ovs-threshold', Object.assign({ value: this.threshold }, RANGES.threshold), (v) => cmd.setThreshold(v));
      this.chips = new Map();
      const chips = h('div', { class: 'chips', attrs: { role: 'group', 'aria-label': 'Show characters' } }, review.FILTERS.map((f) => {
        const count = h('span', { class: 'n' });
        const b = h('button', { class: 'chip', onClick: () => cmd.setFilter(f.id) }, h('span', { class: 'dot', style: { background: FILTER_DOTS[f.id] } }), f.label, count);
        this.chips.set(f.id, { button: b, count });
        return b;
      }));
      this.position = h('span', { class: 'navtxt num' });
      const nav = h('div', { class: 'navm' },
        h('button', { class: 'ib sq', attrs: { 'aria-label': 'Previous character in this filter', 'data-tip': 'Previous · P' }, onClick: () => cmd.step(-1) }, icon('chevronLeft', 15, 2)),
        this.position,
        h('button', { class: 'ib sq', attrs: { 'aria-label': 'Next character in this filter', 'data-tip': 'Next · N' }, onClick: () => cmd.step(1) }, icon('chevronRight', 15, 2)));

      this.insertBar = h('div', { class: 'insbar', hidden: true }, icon('insert', 15),
        h('span', { text: 'Click between two characters, or on + at the end of a line, to add a character the OCR missed.' }),
        h('button', { class: 'lnk', onClick: () => cmd.toggleInsertMode(false) }, 'Done'));
      this.body = h('div', { class: 'tbody', tabIndex: 0, attrs: { 'aria-label': 'Digital text, one row per source line. Tab moves to the next pending character.' } });
      this.inspectorMount = h('div', { class: 'insp' });

      this.root.append(
        h('div', { class: 'pane-h' }, h('span', { class: 'pane-title', text: 'Digital text' }), this.meta, h('div', { class: 'grow' }), this.acceptPageButton, this.insertButton),
        h('div', { class: 'tp-tools' },
          h('div', { class: 'tp-row' },
            h('div', { class: 'thr' }, h('label', { class: 'lbl', htmlFor: 'ovs-threshold', text: 'Confidence threshold' }), this.thresholdSlider, this.thresholdValue),
            h('div', { class: 'grow' }), nav),
          chips),
        this.body,
        this.inspectorMount);
      this.applyViewState();
    }

    /** Classes and controls that follow settings and view state. */
    applyViewState() {
      const s = this.app.settings, ui = this.ui;
      const th = this.threshold;
      this.body.classList.toggle('marks', s.get('statusMarks'));
      this.body.classList.toggle('hl-low', s.get('confHighlight'));
      this.body.classList.toggle('dim-on', s.get('dimOthers') && ui.filter !== 'all');
      this.body.classList.toggle('no-gutter', !s.get('lineNumbers'));
      this.body.classList.toggle('inserting', ui.insertMode);
      this.body.dataset.filter = ui.filter;
      if (ui.insertMode !== this.insertPoints) this.setInsertPoints(ui.insertMode);
      this.insertBar.hidden = !ui.insertMode;
      setPressed(this.insertButton, ui.insertMode);
      this.thresholdValue.textContent = th.toFixed(2);
      this.thresholdSlider.setValue(th);
      for (const [id, chip] of this.chips) setPressed(chip.button, ui.filter === id);
    }

    /* ---------- rendering ---------- */

    renderPage(keepScroll) {
      const page = this.page;
      this.insertPoints = this.ui.insertMode; // renderCell adds insert targets in insert mode
      const top = this.body.scrollTop;
      this.cells.clear();
      this.rows.clear();
      this.editor = null;
      this.pill = null;
      this.activeRow = null;
      this.lifted.clear();
      this.body.replaceChildren(this.insertBar);
      if (page && !page.hasAnnotation) this.body.appendChild(this.emptyState());
      else if (page) {
        const lines = index.linesOf(page);
        const frag = document.createDocumentFragment();
        page.lines.forEach((line, i) => frag.appendChild(this.renderLine(line, i, lines.get(line.id) || [])));
        this.body.appendChild(frag);
        this.markActiveRow();
      }
      this.updateCounts();
      this.body.scrollTop = keepScroll ? top : 0;
    }

    emptyState() {
      return h('div', { class: 'tempty' }, icon('braces', 26),
        h('div', { text: 'No annotation for this page yet.' }),
        h('div', { class: 'muted', text: 'Import a JSON, Parquet or SQLite file with the characters, their boxes and confidence scores. It pairs with the document by file name.' }),
        h('button', { class: 'btn', onClick: () => this.app.commands.openImport('annotation') }, icon('braces', 15), 'Import annotation file'));
    }

    renderLine(line, i, chars) {
      const dot = h('span', { class: 'lnst' });
      const accept = h('button', { class: 'row-act', dataset: { action: 'accept-line' }, attrs: { 'aria-label': 'Accept the pending characters on line ' + (i + 1), 'data-tip-up': 'Accept line' } }, icon('check', 14, 2.2));
      const charsEl = h('div', { class: 'line-chars' });
      const insert = this.ui.insert && this.ui.insert.lineId === line.id ? this.ui.insert : null;
      let placed = false;
      for (const c of chars) {
        if (insert && !placed && insert.order < c.order) { charsEl.appendChild(this.renderInsertCell()); placed = true; }
        charsEl.appendChild(this.renderCell(c));
      }
      if (insert && !placed) charsEl.appendChild(this.renderInsertCell());

      const row = h('div', { class: 'row' + (line.paraBefore ? ' para' : ''), dataset: { line: line.id }, attrs: { dir: line.dir } },
        h('span', { class: 'gut' }, dot, h('span', { text: String(i + 1) })),
        this.app.settings.get('indent') && line.indent && line.dir === 'ltr' ? h('span', { class: 'indent', style: { width: 'calc(var(--cell-w) * ' + line.indent + ')' } }) : null,
        charsEl,
        h('button', { class: 'ins-end', dataset: { action: 'insert-end' }, attrs: { 'aria-label': 'Insert a character at the end of line ' + (i + 1) } }, '+'),
        accept);
      row.parts = { dot, accept };
      this.updateRowState(row, chars);
      this.rows.set(line.id, row);
      return row;
    }

    updateRowState(row, chars) {
      let pending = 0, total = 0;
      for (const c of chars) { if (c.space) continue; total++; if (review.isPending(c, this.threshold)) pending++; }
      if (row.parts.pending === pending && row.parts.total === total) return;
      row.parts.pending = pending; row.parts.total = total;
      row.parts.dot.className = 'lnst ' + (pending === 0 ? 'done' : pending < total ? 'partial' : '');
      row.parts.dot.title = pending === 0 ? 'All characters accepted' : fmtInt(pending) + ' pending';
      row.parts.accept.hidden = pending === 0;
    }

    /** "Insert here" target before a character; present only in insert mode. */
    insertPoint(id) {
      return h('button', { class: 'ins', tabIndex: -1, dataset: { action: 'insert', id }, attrs: { 'aria-label': 'Insert a character here' } });
    }

    /** Add or remove the insert targets of every cell when insert mode changes. */
    setInsertPoints(on) {
      this.insertPoints = on;
      for (const cell of this.body.querySelectorAll('.cell[data-cid]')) {
        const first = cell.firstElementChild;
        const has = first && first.classList.contains('ins');
        if (on && !has) cell.prepend(this.insertPoint(cell.dataset.cid));
        else if (!on && has) first.remove();
      }
    }

    renderCell(c) {
      const insertButton = this.ui.insertMode ? this.insertPoint(c.id) : null;
      if (c.space) return h('span', { class: 'cell space', dataset: { cid: c.id } }, insertButton, h('span', { class: 'spc', text: this.app.settings.get('showSpaces') ? '·' : '' }));
      const button = h('button', { class: this.charClass(c), tabIndex: -1, dataset: { id: c.id }, attrs: { 'aria-label': this.describe(c) } }, c.value);
      const cell = h('span', { class: 'cell', dataset: { cid: c.id } }, insertButton, button);
      this.cells.set(c.id, { cell, button });
      if (this.ui.editId === c.id) this.openEditor(c);
      return cell;
    }

    charClass(c) {
      const ui = this.ui, th = this.threshold;
      const r = review.reason(c, th);
      let cls = 'ch is-' + r;
      if (r === 'added' && !c.bbox) cls += ' no-box';
      if (ui.hoverId === c.id) cls += ' is-hover';
      if (ui.selectedId === c.id) cls += ' is-selected';
      return cls;
    }

    describe(c) {
      const conf = review.conf(c);
      return 'Character “' + c.value + '”, ' + (conf == null ? 'no OCR confidence' : 'confidence ' + conf.toFixed(2)) + ', ' + review.REASON_LABEL[review.reason(c, this.threshold)].toLowerCase();
    }

    refreshClasses() {
      const page = this.page;
      if (!page) return;
      const byId = index.byId(page);
      // Write only what changed: a threshold step usually moves a handful of characters.
      for (const [id, ref] of this.cells) {
        const c = byId.get(id);
        if (!c) continue;
        const cls = this.charClass(c);
        if (ref.button.className !== cls) ref.button.className = cls;
      }
      const lines = index.linesOf(page);
      for (const [lineId, row] of this.rows) this.updateRowState(row, lines.get(lineId) || []);
    }

    rerenderLine(lineId) {
      const page = this.page;
      const old = this.rows.get(lineId);
      if (!page || !old) return;
      const i = page.lines.findIndex((l) => l.id === lineId);
      for (const [id, ref] of this.cells) if (old.contains(ref.cell)) this.cells.delete(id);
      const row = this.renderLine(page.lines[i], i, index.linesOf(page).get(lineId) || []);
      old.replaceWith(row);
      this.markActiveRow(); // the new row takes over the old one's highlight and lift
    }

    /* ---------- store events ---------- */

    onCharsChanged(e) {
      const page = this.page;
      if (!page) return;
      // Every commit names the characters it changed (and, when characters were added or
      // removed, their lines); undo and redo carry the same info, so all of them update in place.
      if (e.structural || !(e.ids && e.ids.length)) {
        if (e.lineIds && e.lineIds.length) e.lineIds.forEach((id) => this.rerenderLine(id));
        else this.renderPage(true);
        return;
      }
      const byId = index.byId(page);
      const lines = new Set();
      for (const id of e.ids) {
        const ref = this.cells.get(id), c = byId.get(id);
        if (!ref || !c) continue;
        if (ref.button.textContent !== c.value) ref.button.textContent = c.value;
        const cls = this.charClass(c);
        if (ref.button.className !== cls) ref.button.className = cls;
        ref.button.setAttribute('aria-label', this.describe(c));
        lines.add(c.lineId);
      }
      // Filter dimming follows the group class just set (pure CSS), so nothing else needs restyling.
      for (const lineId of lines) { const row = this.rows.get(lineId); if (row) this.updateRowState(row, index.linesOf(page).get(lineId) || []); }
    }

    onHover(e) {
      const prev = this.cells.get(e.prev);
      if (prev) prev.button.classList.remove('is-hover');
      this.hidePill();
      const cur = this.cells.get(e.id);
      if (cur) { cur.button.classList.add('is-hover'); this.showPill(this.store.getChar(e.id)); }
      this.markActiveRow();
    }

    onSelect(e) {
      const prev = this.cells.get(e.prev);
      if (prev) prev.button.classList.remove('is-selected');
      const cur = this.cells.get(e.id);
      if (cur) cur.button.classList.add('is-selected');
      this.markActiveRow();
      this.updateCounts();
    }

    markActiveRow() {
      const c = this.store.getChar(this.ui.hoverId || this.ui.editId || this.ui.selectedId);
      const row = c ? this.rows.get(c.lineId) : null;
      if (this.activeRow && this.activeRow !== row) this.activeRow.classList.remove('act');
      this.activeRow = row;
      if (row) row.classList.add('act');
      this.liftRows();
    }

    /**
     * Rows out of view skip rendering (content-visibility in text.css), which also clips
     * each row to its own box. Rows holding the hovered, selected or edited character, or
     * an insertion, render normally, so its highlight, shadow, confidence label and editor
     * can overlap the neighbouring lines as before.
     */
    liftRows() {
      const ui = this.ui;
      const lineIds = [ui.hoverId, ui.editId, ui.selectedId].map((id) => this.store.getChar(id)).filter(Boolean).map((c) => c.lineId);
      if (ui.insert) lineIds.push(ui.insert.lineId);
      const next = new Set(lineIds.map((id) => this.rows.get(id)).filter(Boolean));
      for (const row of this.lifted) if (!next.has(row)) row.classList.remove('lift');
      for (const row of next) row.classList.add('lift');
      this.lifted = next;
    }

    showPill(c) {
      if (!c || this.ui.editId === c.id || !this.app.settings.get('hoverConfidence')) return;
      const ref = this.cells.get(c.id);
      if (!ref) return;
      const conf = review.conf(c);
      const kind = conf == null ? ' na' : review.isPending(c, this.threshold) ? ' low' : '';
      this.pill = h('span', { class: 'pill' + kind, text: conf == null ? 'manual' : conf.toFixed(2), attrs: { 'aria-hidden': 'true' } });
      ref.cell.appendChild(this.pill);
    }

    hidePill() { if (this.pill) { this.pill.remove(); this.pill = null; } }

    /** Bring a character into view: left alone if it is already comfortably visible, else centred (like the image). */
    reveal(id) {
      const ref = this.cells.get(id);
      if (!ref) return;
      const margin = 24;
      const box = this.body.getBoundingClientRect(), r = ref.cell.getBoundingClientRect();
      const visible = r.top >= box.top + margin && r.bottom <= box.bottom - margin && r.left >= box.left && r.right <= box.right;
      if (!visible) ref.cell.scrollIntoView({ block: 'center', inline: 'nearest' });
      if (!this.editor && this.root.contains(document.activeElement)) ref.button.focus({ preventScroll: true });
    }

    updateCounts() {
      const page = this.page;
      const k = review.counts(page ? page.chars : [], this.threshold);
      const values = { all: k.total, pending: k.pending, accepted: k.accepted, confirmed: k.confirmed, corrected: k.corrected, added: k.added };
      for (const [id, chip] of this.chips) chip.count.textContent = fmtInt(values[id]);
      this.pendingCount = k.pending;
      this.acceptPageButton.disabled = !k.pending;
      this.meta.textContent = page ? page.lines.length + ' lines · ' + fmtInt(k.total) + ' characters' : '';
      if (!page) { this.position.textContent = ''; return; }
      const list = index.readingOrder(page).filter((c) => review.matches(c, this.ui.filter, this.threshold));
      const i = list.findIndex((c) => c.id === this.ui.selectedId);
      this.position.textContent = !list.length ? 'none' : i >= 0 ? (i + 1) + ' / ' + list.length : list.length + ' left';
    }

    /* ---------- editing ---------- */

    onEdit(e) {
      if (e.prev) this.closeEditor(e.prev);
      const c = this.store.getChar(e.id);
      if (c) this.openEditor(c);
      this.markActiveRow();
    }

    openEditor(c) {
      const ref = this.cells.get(c.id);
      if (!ref) return;
      this.hidePill();
      const cmd = this.app.commands;
      const handle = createCharEditor({
        value: c.value,
        label: 'Replace ' + this.describe(c),
        onCommit: (value, advance) => cmd.commitEdit(c.id, value, advance),
        onCancel: () => cmd.cancelEdit()
      });
      ref.button.hidden = true;
      ref.cell.classList.add('editing');
      ref.cell.append(handle.node);
      this.editor = { id: c.id, handle };
      const focus = () => { handle.focus(); ref.cell.scrollIntoView({ block: 'nearest', inline: 'nearest' }); };
      if (ref.cell.isConnected) focus(); else Promise.resolve().then(focus);
    }

    closeEditor(id) {
      if (!this.editor || this.editor.id !== id) return;
      const hadFocus = this.editor.handle.hasFocus();
      this.editor.handle.close();
      this.editor = null;
      const ref = this.cells.get(id);
      if (!ref) return;
      ref.cell.classList.remove('editing');
      ref.button.hidden = false;
      if (hadFocus) ref.button.focus({ preventScroll: true });
    }

    /* ---------- inserting ---------- */

    renderInsertCell() {
      const cmd = this.app.commands;
      const cell = h('span', { class: 'cell editing' });
      const handle = createCharEditor({
        value: '', isNew: true, label: 'New character',
        onCommit: (value) => (value ? cmd.commitInsert(value) : cmd.cancelInsert()),
        onCancel: () => cmd.cancelInsert()
      });
      cell.append(handle.node);
      cell.insertHandle = handle;
      Promise.resolve().then(() => { if (cell.isConnected) { handle.focus(); cell.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } });
      return cell;
    }

    onInsert(e) {
      const lines = new Set([e.prev && e.prev.lineId, e.insert && e.insert.lineId].filter(Boolean));
      for (const lineId of lines) {
        const row = this.rows.get(lineId);
        if (!row) continue;
        row.querySelectorAll('.cell.editing').forEach((cell) => { if (cell.insertHandle) cell.insertHandle.close(); });
        this.rerenderLine(lineId);
      }
    }

    /* ---------- DOM events ---------- */

    bindEvents() {
      const body = this.body, store = this.store, cmd = this.app.commands;
      body.addEventListener('mouseover', (e) => { const b = e.target.closest('.ch'); if (b) store.setHover(b.dataset.id); });
      body.addEventListener('mouseout', (e) => {
        const b = e.target.closest('.ch');
        if (b && !(e.relatedTarget && b.contains(e.relatedTarget))) store.setHover(null);
      });
      body.addEventListener('click', (e) => {
        const action = e.target.closest('[data-action]');
        if (action) {
          const row = action.closest('.row');
          if (action.dataset.action === 'insert') cmd.insertNear(action.dataset.id, -1);
          else if (action.dataset.action === 'insert-end') cmd.insertAtLineEnd(row.dataset.line);
          else if (action.dataset.action === 'accept-line') cmd.acceptLine(row.dataset.line);
          return;
        }
        const b = e.target.closest('.ch');
        if (b) cmd.focusChar(b.dataset.id, { edit: true }); // also brings it into view on the image
      });
      body.addEventListener('keydown', (e) => this.onKeyDown(e));
    }

    onKeyDown(e) {
      if (e.target.tagName === 'INPUT') return; // editors handle their own keys
      const cmd = this.app.commands;
      if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        // Tab walks the pending characters. With none left, focus leaves the panel as usual.
        if (cmd.nextPending(e.shiftKey ? -1 : 1, { edit: true, quiet: true })) e.preventDefault();
        else this.app.toast.show('Every character on this page is accepted.');
        return;
      }
      const moves = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
      if (!moves.includes(e.key) || !this.page) return;
      e.preventDefault();
      const target = this.neighbour(e.key);
      if (target) cmd.focusChar(target.id);
    }

    /** The character an arrow/Home/End key moves the selection to. */
    neighbour(key) {
      const page = this.page;
      const order = index.readingOrder(page);
      const cur = this.store.getChar(this.ui.selectedId);
      if (!cur) return order[0] || null;
      const lines = index.linesOf(page);
      const line = page.lines.find((l) => l.id === cur.lineId);
      const chars = (lines.get(cur.lineId) || []).filter((c) => !c.space);
      if (key === 'Home') return chars[0];
      if (key === 'End') return chars[chars.length - 1];
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        const forward = (key === 'ArrowRight') !== (line && line.dir === 'rtl');
        const i = order.indexOf(cur) + (forward ? 1 : -1);
        return order[Math.max(0, Math.min(order.length - 1, i))];
      }
      const next = page.lines[page.lines.indexOf(line) + (key === 'ArrowDown' ? 1 : -1)];
      if (!next) return null;
      const col = (lines.get(cur.lineId) || []).indexOf(cur);
      const target = lines.get(next.id) || [];
      for (let k = Math.min(col, target.length - 1); k >= 0; k--) if (!target[k].space) return target[k];
      return target.find((c) => !c.space) || null;
    }
  }

  return { TextPanel };
});
