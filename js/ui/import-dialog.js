/**
 * Import dialog: collects files, shows how documents and annotation files were
 * paired, lets the user fix the pairing and the detected annotation fields,
 * then imports everything in one step.
 */
OVS.define('ui/import-dialog', (require) => {
  'use strict';

  const { h } = require('util/dom');
  const { fmtInt, plural } = require('util/format');
  const { icon } = require('ui/icons');
  const { ImportSession, entriesFromInput, ACCEPT } = require('io/importer');
  const { dropTarget } = require('ui/file-drop');

  const BOX_FORMATS = [['auto', 'Detect'], ['xyxy', 'x0, y0, x1, y1'], ['xywh', 'x, y, width, height'], ['polygon', 'Polygon / points'], ['object', 'Object with named keys']];
  const COORDINATES = [['auto', 'Detect'], ['pixels', 'Image pixels'], ['normalized', 'Normalized 0–1'], ['points', 'PDF points']];

  class ImportDialog {
    constructor(root, app) {
      this.root = root;
      this.app = app;
      this.session = null;
      this.kind = 'documents';
      app.bus.on('import:open', (e) => this.open(e.kind, e.entries));
    }

    async open(kind, entries) {
      if (kind) this.kind = kind;
      if (!this.session) { this.session = new ImportSession(this.app); this.returnFocus = document.activeElement; }
      this.render();
      if (entries && entries.length) await this.add(entries);
    }

    close() {
      this.session = null;
      this.root.replaceChildren();
      if (this.returnFocus && this.returnFocus.focus) this.returnFocus.focus({ preventScroll: true });
    }

    async add(entries) {
      if (!entries.length) return;
      const s = this.session;
      const work = s.add(entries);
      this.render();
      await work;
      if (this.session === s) this.render();
    }

    async confirm(button) {
      button.disabled = true;
      button.textContent = 'Importing…';
      try {
        const result = await this.session.commit();
        this.close();
        this.app.toast.show(this.summaryMessage(result));
      } catch (err) {
        console.error(err);
        this.app.toast.show('Import failed: ' + err.message, { error: true });
        this.render();
      }
    }

    summaryMessage(r) {
      const parts = [];
      if (r.documents) parts.push(plural(r.documents, 'document') + ' (' + plural(r.pages, 'page') + ')');
      if (r.annotatedPages) parts.push('annotations for ' + plural(r.annotatedPages, 'page'));
      let msg = parts.length ? 'Imported ' + parts.join(' and ') + '.' : 'Nothing was imported.';
      if (r.unmatched) msg += ' ' + fmtInt(r.unmatched) + ' characters did not match a page and were skipped.';
      return msg;
    }

    /* ---------- rendering ---------- */

    render() {
      const s = this.session;
      if (!s) return;
      const rows = s.rows();
      const importable = rows.some((r) => (r.doc && !r.existing) || (r.existing && r.ann));
      const body = [this.dropZones()];
      if (s.busy) body.push(h('div', { class: 'qempty' }, h('div', { class: 'spinner centered' }), 'Reading files…'));
      if (s.errors.length) body.push(h('div', { class: 'errors', attrs: { role: 'alert' } }, h('b', { text: 'Some files were skipped' }), s.errors.map((e) => h('span', { text: e.name + ': ' + e.message }))));
      body.push(rows.length ? this.queue(rows) : h('div', { class: 'qempty', text: 'No files yet. Add scans and their annotation files; they pair up by file name.' }));
      for (const ann of s.anns) body.push(this.mapping(ann));

      const importButton = h('button', { class: 'btn primary', disabled: !importable || s.busy > 0 }, 'Import');
      importButton.addEventListener('click', () => this.confirm(importButton));
      const scrim = h('div', { class: 'scrim' },
        h('div', { class: 'dlg', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'import-title' } },
          h('div', { class: 'dlg-h' },
            h('div', { class: 'grow' },
              h('h2', { id: 'import-title', text: 'Import documents' }),
              h('p', { text: 'Files are read in this browser and never uploaded. Original OCR values stay unchanged; your corrections are stored next to them.' })),
            h('button', { class: 'ib sq', attrs: { 'aria-label': 'Close import' }, onClick: () => this.close() }, icon('x', 16, 1.9))),
          h('div', { class: 'dlg-b' }, body),
          h('div', { class: 'dlg-f' },
            h('span', { class: 'grow', text: this.summary(rows) }),
            h('button', { class: 'btn', onClick: () => this.close() }, 'Cancel'),
            importButton)));
      scrim.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.close(); } });
      const hadFocus = this.root.contains(document.activeElement);
      this.root.replaceChildren(scrim);
      if (!hadFocus) scrim.querySelector('.dlg-h .ib').focus({ preventScroll: true });
    }

    summary(rows) {
      const docs = rows.filter((r) => r.doc && !r.existing).length;
      const paired = rows.filter((r) => r.doc && r.ann).length;
      return plural(docs, 'document') + ' · ' + plural(this.session.anns.length, 'annotation file') + ' · ' + fmtInt(paired) + ' paired';
    }

    picker(label, accept, folder) {
      const input = h('input', { class: 'vh', type: 'file', accept: accept || '', multiple: true, attrs: { webkitdirectory: folder || null } });
      input.addEventListener('change', () => { const entries = entriesFromInput(input); input.value = ''; this.add(entries); });
      return h('label', { class: 'btn sm filebtn' }, label, input);
    }

    dropZones() {
      const zone = (highlight, children) => {
        return dropTarget(h('div', { class: 'drop' + (highlight ? ' hl' : '') }, children), (entries) => this.add(entries));
      };
      const annotations = this.kind === 'annotation';
      return h('div', { class: 'drops' },
        zone(!annotations, [
          h('h4', null, icon('image', 16), 'Scanned documents'),
          h('p', { text: 'Images, multi-page PDFs, or a whole folder. Drop them here.' }),
          h('div', { class: 'acts' }, this.picker('Images', ACCEPT.image), this.picker('PDF', ACCEPT.pdf), this.picker('Folder', '', true))
        ]),
        zone(annotations, [
          h('h4', null, icon('braces', 16), 'Annotation files'),
          h('p', { text: 'JSON, Parquet or SQLite, one record per character with its value, box and confidence.' }),
          h('div', { class: 'acts' }, this.picker('JSON, Parquet or SQLite', ACCEPT.annotation))
        ]));
    }

    queue(rows) {
      const s = this.session;
      const targets = s.targets();
      const body = rows.map((r) => {
        const docCell = r.doc
          ? h('td', null, h('span', { class: 'nm', text: r.doc.name }), h('span', { class: 'sub', text: r.existing ? 'Already open' : r.doc.meta }))
          : h('td', null, h('span', { class: 'sub', text: 'No matching document' }));

        const annCell = r.ann
          ? h('td', null, h('span', { class: 'nm mono', text: r.ann.name }), h('span', { class: 'sub', text: fmtInt(r.ann.charCount) + ' characters · ' + r.ann.format.toUpperCase() + (r.ann.source !== r.ann.name ? ' · from ' + r.ann.source : '') }))
          : h('td', null, h('span', { class: 'sub', text: 'None yet. You can import one later.' }));
        if (r.ann && !r.doc) {
          const choose = h('select', { class: 'sel', attrs: { 'aria-label': 'Choose a document for ' + r.ann.name } },
            h('option', { value: '', text: 'Choose a document…' }),
            targets.map((t) => h('option', { value: t.key, text: t.name + (t.existing ? ' (open)' : '') })));
          choose.addEventListener('change', () => { s.setTarget(r.ann.key, choose.value || undefined); this.render(); });
          annCell.appendChild(h('div', { class: 'spaced' }, choose));
        }

        const remove = [r.doc && !r.existing ? r.doc.key : null, r.ann ? r.ann.key : null].filter(Boolean);
        return h('tr', null, docCell, annCell, h('td', null, this.pairingStatus(r)),
          h('td', { class: 'narrow' }, h('button', { class: 'ib sq', attrs: { 'aria-label': 'Remove from the list' }, onClick: () => { remove.forEach((k) => s.remove(k)); this.render(); } }, icon('x', 14))));
      });
      return h('div', { class: 'tscroll' }, h('table', { class: 'qtable' },
        h('thead', null, h('tr', null, h('th', { text: 'Document' }), h('th', { text: 'Annotation' }), h('th', { text: 'Pairing' }), h('th'))),
        h('tbody', null, body)));
    }

    pairingStatus(r) {
      const pill = (cls, text) => h('span', { class: 'spill ' + cls }, h('span', { class: 'sdot' }), text);
      if (!r.doc) return pill('s-low', 'Not paired');
      if (!r.ann) return pill('s-none', 'Image only');
      const total = r.doc.pages.length;
      const status = r.pagesMatched === 0 ? pill('s-low', 'No pages matched') : pill('s-complete', r.pagesMatched === total ? 'Paired' : r.pagesMatched + ' of ' + total + ' pages');
      const note = r.existing && r.doc.pages.some((p) => p.hasAnnotation) ? 'Replaces the current annotation'
        : r.unmatched ? fmtInt(r.unmatched) + ' characters without a page' : null;
      return note ? h('div', null, status, h('span', { class: 'sub', text: note })) : status;
    }

    /** Field mapping for one annotation file, collapsed unless something needs attention. */
    mapping(ann) {
      const s = this.session, m = ann.mapping, cands = ann.cands;
      const fieldOptions = (none) => [h('option', { value: '', text: none })]
        .concat(cands.fields.map((f) => h('option', { value: f, text: f.startsWith('__') ? f.slice(2) + ' (from structure)' : f })));
      const field = (label, value, options, onChange) => {
        const el = h('select', { class: 'sel' }, options);
        el.value = value == null ? '' : value;
        el.addEventListener('change', () => { onChange(el.value); this.render(); });
        return h('label', null, label, el);
      };
      const listOptions = (pairs) => pairs.map(([v, l]) => h('option', { value: v, text: l }));
      const set = (patch) => s.setMapping(ann.key, patch);

      const boxValue = m.bbox ? 'f:' + m.bbox
        : m.cols ? 'c:' + cands.boxCols.findIndex((c) => c.fields.join() === m.cols.fields.map((f) => f.toLowerCase()).join()) : '';
      const boxOptions = [h('option', { value: '', text: 'No boxes' })]
        .concat(cands.boxFields.map((f) => h('option', { value: 'f:' + f, text: f })))
        .concat(cands.boxCols.map((c, i) => h('option', { value: 'c:' + i, text: c.fields.join(', ') + ' (' + (c.kind === 'xywh' ? 'x, y, w, h' : 'corners') + ')' })));
      const setBox = (v) => {
        if (!v) set({ bbox: null, cols: null });
        else if (v.startsWith('f:')) set({ bbox: v.slice(2), cols: null });
        else {
          const c = cands.boxCols[Number(v.slice(2))];
          set({ bbox: null, cols: { kind: c.kind, fields: c.fields.map((f) => cands.fields.find((x) => x.toLowerCase() === f)) } });
        }
      };

      const sample = ann.groups[0] && ann.groups[0].records.slice(0, 14).map((r) => r.value).join('');
      const details = h('details', { class: 'mapping', open: ann.open != null ? ann.open : !!ann.problem },
        h('summary', null, h('h4', null, icon('braces', 15), 'Fields in ' + ann.name,
          h('span', { class: 'spill ' + (ann.problem ? 's-low' : 's-complete') }, h('span', { class: 'sdot' }), ann.problem || 'Detected automatically'))),
        h('div', { class: 'mapgrid' },
          field('Character', m.value, fieldOptions('Choose…'), (v) => set({ value: v || null })),
          field('Confidence', m.conf, fieldOptions('None'), (v) => set({ conf: v || null })),
          field('Bounding box', boxValue, boxOptions, setBox),
          field('Box format', m.bboxFormat, listOptions(BOX_FORMATS), (v) => set({ bboxFormat: v })),
          field('Line', m.line, fieldOptions('Infer from positions'), (v) => set({ line: v || null })),
          field('Order in line', m.order, fieldOptions('By position'), (v) => set({ order: v || null })),
          field('Page', m.page, fieldOptions('Single page'), (v) => set({ page: v || null })),
          field('Coordinates', m.coords, listOptions(COORDINATES), (v) => set({ coords: v }))),
        sample ? h('div', { class: 'sample' }, 'First characters read: ', h('span', { class: 'mono', text: sample })) : null);
      details.addEventListener('toggle', () => { ann.open = details.open; });
      return details;
    }
  }

  return { ImportDialog };
});
