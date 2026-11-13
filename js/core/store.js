/**
 * Application state: loaded documents and pages, plus transient UI state.
 * Every mutation goes through a method here so the matching event is emitted.
 * UI code should call core/commands.js, which applies the review rules first.
 *
 * Document  { id, name, kind: 'image' | 'pdf' | 'folder', file: Blob | null, pageIds: [], annotation: { name, format, mapping } | null,
 *             sample?: true }      a generated sample document: never auto-saved
 * Page      { id, docId, name, pageNo,
 *             image: { kind: 'blob', blob, width, height } | { kind: 'pdf', pdfPage, width, height, ptW, ptH },
 *             coord: { w, h, unit },      size of the annotation's coordinate space (boxes stay in it)
 *             lines, chars, metrics, hasAnnotation }
 */
OVS.define('core/store', (require) => {
  'use strict';

  const { History } = require('core/history');
  const index = require('model/page-index');

  /** View state a project starts with (also restored when the project is cleared). */
  const INITIAL_VIEW = Object.freeze({
    filter: 'pending',   // see model/review.js FILTERS
    insertMode: false,
    drawFor: null,       // id of a manually added character waiting for its box
    tool: 'pan'          // 'pan' | 'box' (drag a rectangle) | 'poly' (click four corners)
  });

  class Store {
    constructor(bus, settings) {
      this.bus = bus;
      this.settings = settings;
      this.documents = [];
      this.pages = new Map();
      this.history = new History(bus);
      this.unsaved = 0;               // changes since the last Save all
      this.dirtyPages = new Set();    // pages auto-save still has to write
      this.ui = Object.assign({
        pageId: null,
        hoverId: null,
        selectedId: null,
        editId: null,
        insert: null,        // { lineId, order, id } while typing a new character
        panel: null          // 'settings' | 'stats' | null
      }, INITIAL_VIEW);
    }

    /* ---------- reading ---------- */

    get threshold() { return this.settings.get('threshold'); }
    isEmpty() { return this.documents.length === 0; }
    currentPage() { return (this.ui.pageId && this.pages.get(this.ui.pageId)) || null; }
    getDocument(id) { return this.documents.find((d) => d.id === id) || null; }
    documentOf(page) { return page ? this.getDocument(page.docId) : null; }

    /** True when documents are open and all of them are samples (nothing here is auto-saved). */
    isSampleProject() { return this.documents.length > 0 && this.documents.every((d) => d.sample); }

    getChar(id, page) {
      page = page || this.currentPage();
      return page && id ? index.byId(page).get(id) || null : null;
    }

    /** All pages in document order. */
    pageList() {
      const out = [];
      for (const d of this.documents) for (const id of d.pageIds) { const p = this.pages.get(id); if (p) out.push(p); }
      return out;
    }

    /* ---------- documents ---------- */

    addDocuments(docs, pages) {
      for (const p of pages) { this.pages.set(p.id, p); this.dirtyPages.add(p.id); }
      for (const d of docs) {
        const i = this.documents.findIndex((x) => x.id === d.id);
        if (i >= 0) this.documents[i] = d; else this.documents.push(d);
      }
      this.bus.emit('project:changed', { added: docs.map((d) => d.id) });
      if (!this.currentPage() && pages.length) this.setPage(pages[0].id);
    }

    /**
     * Replace the annotation of pages that are already open (an annotation file
     * imported for an open document). One update for any number of pages.
     * @param {Array<{ pageId, data }>} updates
     */
    replaceAnnotations(updates) {
      const ids = [];
      for (const { pageId, data } of updates) {
        const page = this.pages.get(pageId);
        if (!page) continue;
        Object.assign(page, data);
        this.dirtyPages.add(pageId);
        ids.push(pageId);
      }
      if (!ids.length) return;
      this.history.forget(ids);
      this.bus.emit('project:changed', {});
      if (ids.includes(this.ui.pageId)) this.setPage(this.ui.pageId, true);
    }

    removeDocument(docId) {
      const doc = this.getDocument(docId);
      if (!doc) return;
      this.documents = this.documents.filter((d) => d.id !== docId);
      for (const id of doc.pageIds) { this.pages.delete(id); this.dirtyPages.delete(id); }
      this.history.forget(doc.pageIds);
      if (doc.pageIds.includes(this.ui.pageId)) {
        const first = this.pageList()[0];
        this.setPage(first ? first.id : null, true);
      }
      this.bus.emit('project:changed', { removed: [docId] });
    }

    /** Close everything: documents, undo history, unsaved count and view state go back to a fresh start. */
    clear() {
      this.documents = [];
      this.pages.clear();
      this.dirtyPages.clear();
      this.history.forget();
      this.unsaved = 0;
      this.ui.insert = null;
      this.setView(INITIAL_VIEW);
      this.setPage(null, true);
      this.bus.emit('project:changed', { cleared: true });
      this.bus.emit('save:status');
    }

    /* ---------- characters ---------- */

    /**
     * Replace a page's characters and record the change for undo.
     * @param {object} info  { label, ids: changed ids, lineIds: lines whose layout changed, structural }
     * @param {Array} [nextLines]  the page's lines, when the change adds or removes a line
     */
    commit(pageId, nextChars, info, nextLines) {
      const page = this.pages.get(pageId);
      if (!page || nextChars === page.chars) return;
      const entry = { pageId, before: page.chars, after: nextChars, info: info || {} };
      // Lines only change when a line loses its last character; then undo restores them too.
      if (nextLines && nextLines !== page.lines) { entry.linesBefore = page.lines; entry.linesAfter = nextLines; page.lines = nextLines; }
      page.chars = nextChars;
      this.history.push(entry);
      this.markDirty(pageId);
      this.bus.emit('chars:changed', Object.assign({ pageId }, info));
    }

    /** Undo (dir -1) or redo (dir 1). Returns the history entry, or null. */
    travel(dir) {
      const entry = dir < 0 ? this.history.takeUndo() : this.history.takeRedo();
      if (!entry) return null;
      const page = this.pages.get(entry.pageId);
      if (!page) return entry;
      if (this.ui.pageId !== entry.pageId) this.setPage(entry.pageId);
      page.chars = dir < 0 ? entry.before : entry.after;
      if (entry.linesBefore) page.lines = dir < 0 ? entry.linesBefore : entry.linesAfter;
      this.markDirty(entry.pageId);
      this.bus.emit('chars:changed', Object.assign({ pageId: entry.pageId }, entry.info, { history: true }));
      return entry;
    }

    markDirty(pageId) {
      this.unsaved++;
      this.dirtyPages.add(pageId);
      this.bus.emit('save:status');
    }

    markSaved() {
      this.unsaved = 0;
      this.bus.emit('save:status');
    }

    /* ---------- transient UI ---------- */

    setPage(pageId, force) {
      if (!force && pageId === this.ui.pageId) return;
      Object.assign(this.ui, { pageId, hoverId: null, selectedId: null, editId: null, insert: null, drawFor: null, tool: 'pan' });
      this.bus.emit('page:changed', { pageId });
      this.bus.emit('ui:view', {});
    }

    setHover(id) { this.setField('hoverId', id, 'ui:hover'); }
    setSelected(id) { this.setField('selectedId', id, 'ui:select'); }
    setEdit(id) { this.setField('editId', id, 'ui:edit'); }

    setField(field, id, event) {
      if (this.ui[field] === id) return;
      const prev = this.ui[field];
      this.ui[field] = id;
      this.bus.emit(event, { id, prev });
    }

    setInsert(insert) {
      const prev = this.ui.insert;
      this.ui.insert = insert;
      this.bus.emit('ui:insert', { insert, prev });
    }

    setView(patch) {
      Object.assign(this.ui, patch);
      this.bus.emit('ui:view', patch);
    }

    setPanel(panel) {
      if (this.ui.panel === panel) return;
      this.ui.panel = panel;
      this.bus.emit('ui:panel', { panel });
    }
  }

  return { Store };
});
