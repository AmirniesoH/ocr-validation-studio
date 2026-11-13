/**
 * Auto-save. The working session (source files, page structure, every review
 * decision) is written to IndexedDB in this browser shortly after each change
 * and restored when the app opens again. It is a safety net; Save all is what
 * writes the validated annotation files.
 *
 * Object stores
 *   docs    by document id, including PDF files     written when documents are added, replaced or removed
 *   pages   by page id: structure and characters     written when the page changes (no image inside)
 *   images  by page id: the page's image file        written once per page
 *   meta    'project': document order, current page, unsaved count
 *
 * Keeping images apart means an edit writes a few kilobytes of characters
 * instead of the whole scan again.
 *
 * Only the user's own documents are kept. Sample documents (doc.sample) are
 * never written, and any found in an older session are dropped on restore,
 * so "Try with sample documents" always starts fresh.
 */
OVS.define('io/autosave', (require) => {
  'use strict';

  const { isSampleDocument } = require('io/sample');

  const DB_NAME = 'ocr-validation-studio-v2';
  const DB_VERSION = 2; // 2: page images moved to their own store
  const STORES = ['docs', 'pages', 'images', 'meta'];
  const DELAY_MS = 700;

  const request = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const finished = (tx) => new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });

  /** The page as stored: everything but the image file, which lives in the images store. */
  const pageRecord = (p) => (p.image.blob ? Object.assign({}, p, { image: Object.assign({}, p.image, { blob: null }) }) : p);

  class AutoSave {
    constructor(app) {
      this.app = app;
      this.db = null;
      this.removedDocs = new Set();
      this.savedImages = new Set(); // page ids whose image is already stored
      this.docsDirty = false;       // documents added, replaced or removed since the last write
      this.timer = null;
      this.lastSaved = null;
      this.state = 'off'; // 'off' | 'idle' | 'saving' | 'saved' | 'error'
    }

    get available() { return !!this.db; }

    async open() {
      if (!window.indexedDB) return false;
      try {
        const open = indexedDB.open(DB_NAME, DB_VERSION);
        open.onupgradeneeded = () => { for (const name of STORES) if (!open.result.objectStoreNames.contains(name)) open.result.createObjectStore(name); };
        this.db = await request(open);
        this.setState('idle');
        return true;
      } catch (err) {
        console.warn('[OVS] IndexedDB unavailable; auto-save is off', err);
        return false;
      }
    }

    setState(state) {
      this.state = state;
      this.app.bus.emit('save:status');
    }

    /** Save soon (debounced). */
    schedule() {
      if (!this.available) return;
      clearTimeout(this.timer);
      if (this.state !== 'saving') this.setState('saving');
      this.timer = setTimeout(() => this.flush().catch((err) => { console.error(err); this.setState('error'); }), DELAY_MS);
    }

    async flush() {
      if (!this.available) return;
      clearTimeout(this.timer);
      const store = this.app.store;
      const dirty = Array.from(store.dirtyPages);
      store.dirtyPages.clear();
      const kept = store.documents.filter((d) => !d.sample);
      const isSamplePage = (p) => { const d = store.getDocument(p.docId); return !!(d && d.sample); };
      const current = store.currentPage();
      const tx = this.db.transaction(STORES, 'readwrite');
      const docs = tx.objectStore('docs'), pages = tx.objectStore('pages'), images = tx.objectStore('images');
      const newImages = [];
      if (this.docsDirty) for (const doc of kept) docs.put(doc, doc.id);
      for (const id of this.removedDocs) docs.delete(id);
      for (const id of dirty) {
        const p = store.pages.get(id);
        if (!p) { pages.delete(id); images.delete(id); this.savedImages.delete(id); continue; }
        if (isSamplePage(p)) continue;
        pages.put(pageRecord(p), id);
        if (p.image.blob && !this.savedImages.has(id)) { images.put(p.image.blob, id); this.savedImages.add(id); newImages.push(id); }
      }
      tx.objectStore('meta').put({
        docIds: kept.map((d) => d.id),
        pageId: current && !isSamplePage(current) ? current.id : null,
        unsaved: store.unsaved,
        savedAt: Date.now()
      }, 'project');
      try { await finished(tx); }
      catch (err) { // nothing was written: retry these pages and images on the next save
        dirty.forEach((id) => store.dirtyPages.add(id));
        newImages.forEach((id) => this.savedImages.delete(id));
        throw err;
      }
      this.docsDirty = false;
      this.removedDocs.clear();
      this.lastSaved = new Date();
      this.setState('saved');
    }

    /** Delete documents found in storage that must not be kept (old sample documents). */
    discard(docs) {
      if (!this.available || !docs.length) return;
      for (const doc of docs) {
        this.removedDocs.add(doc.id);
        for (const id of doc.pageIds) this.app.store.dirtyPages.add(id); // not in the store, so deleted on save
      }
      this.schedule();
    }

    removeDocument(doc) {
      if (!this.available) return;
      this.removedDocs.add(doc.id);
      for (const id of doc.pageIds) this.app.store.dirtyPages.add(id);
      this.schedule();
    }

    async clear() {
      if (!this.available) return;
      clearTimeout(this.timer);
      const tx = this.db.transaction(STORES, 'readwrite');
      for (const name of STORES) tx.objectStore(name).clear();
      await finished(tx);
      this.savedImages.clear();
      this.removedDocs.clear();
      this.docsDirty = false;
      this.setState('idle');
    }

    /** Load the previous session into the store; resolves to true when something was restored. */
    async restore() {
      if (!this.available) return false;
      const tx = this.db.transaction(STORES, 'readonly');
      const meta = await request(tx.objectStore('meta').get('project'));
      if (!meta || !meta.docIds || !meta.docIds.length) return false;
      const docs = [], pages = [];
      const migrate = []; // pages saved before version 2, with the image inside the page record
      const dropped = []; // sample documents saved by older versions
      for (const id of meta.docIds) {
        const doc = await request(tx.objectStore('docs').get(id));
        if (!doc) continue;
        if (isSampleDocument(doc)) { dropped.push(doc); continue; }
        docs.push(doc);
        for (const pid of doc.pageIds) {
          const p = await request(tx.objectStore('pages').get(pid));
          if (!p) continue;
          if (p.image.kind === 'blob' && p.image.blob) migrate.push(pid);
          else {
            if (p.image.kind === 'blob') p.image.blob = await request(tx.objectStore('images').get(pid));
            this.savedImages.add(pid);
          }
          pages.push(p);
        }
      }
      if (!docs.length) { this.discard(dropped); return false; }
      const store = this.app.store;
      store.addDocuments(docs, pages);
      store.dirtyPages.clear();
      if (migrate.length) {
        for (const id of migrate) store.dirtyPages.add(id); // rewritten in the new layout
        this.schedule();
      }
      this.discard(dropped); // after the store is set up, so its pages are deleted on the next save
      store.unsaved = meta.unsaved || 0;
      if (meta.pageId && store.pages.has(meta.pageId)) store.setPage(meta.pageId);
      this.lastSaved = new Date(meta.savedAt || Date.now());
      this.setState('saved');
      return true;
    }

    /** Save after every change from now on. */
    attach() {
      const kick = () => this.schedule();
      this.app.bus.on('project:changed', () => { this.docsDirty = true; kick(); });
      this.app.bus.onAny(['chars:changed', 'page:changed'], kick);
      window.addEventListener('pagehide', () => { if (this.docsDirty || this.app.store.dirtyPages.size) this.flush().catch(() => {}); });
    }
  }

  return { AutoSave };
});
