/**
 * Everything the user can do, as one method each. UI components call these
 * instead of changing the store, so behaviour (review rules, undo, navigation,
 * messages) lives in one place.
 */
OVS.define('core/commands', (require) => {
  'use strict';

  const review = require('model/review');
  const index = require('model/page-index');
  const layout = require('model/layout');
  const geometry = require('model/geometry');
  const { makeId, plural, round } = require('util/format');

  class Commands {
    /** @param {object} app  { bus, settings, store, images, autosave, toast } */
    constructor(app) {
      this.app = app;
    }

    get store() { return this.app.store; }
    get page() { return this.store.currentPage(); }
    get threshold() { return this.store.threshold; }

    toast(message, opts) { if (this.app.toast) this.app.toast.show(message, opts); }

    /** Replace one character in the current page and record it for undo. */
    replace(next, label) {
      const page = this.page;
      this.store.commit(page.id, page.chars.map((c) => (c.id === next.id ? next : c)), { label, ids: [next.id] });
    }

    /* ---------- pages and view ---------- */

    /** Open a page. Leaving the statistics view is part of navigating to a page. */
    openPage(pageId) {
      this.endTransient();
      if (this.store.ui.panel === 'stats') this.store.setPanel(null);
      this.store.setPage(pageId);
    }

    stepPage(dir) {
      const list = this.store.pageList();
      const next = list[list.findIndex((p) => p.id === this.store.ui.pageId) + dir];
      if (next) this.openPage(next.id);
    }

    endTransient() {
      if (this.store.ui.editId) this.store.setEdit(null);
      if (this.store.ui.insert) this.store.setInsert(null);
    }

    setFilter(filter) { if (review.FILTERS.some((f) => f.id === filter)) this.store.setView({ filter }); }

    /** Rounded to the slider's step (0.01); the settings keep it within 0–1. */
    setThreshold(value) { this.app.settings.set('threshold', round(value, 2)); }

    toggleInsertMode(force) {
      const on = typeof force === 'boolean' ? force : !this.store.ui.insertMode;
      if (!on && this.store.ui.insert) this.store.setInsert(null);
      this.store.setView({ insertMode: on });
    }

    togglePanel(panel) { this.store.setPanel(this.store.ui.panel === panel ? null : panel); }

    /* ---------- moving between characters ---------- */

    /**
     * Select the next (dir 1) or previous (dir -1) character that matches a filter,
     * counting from the current character and wrapping around the page.
     * @param {{ filter?, edit?, quiet?, from? }} opts  filter defaults to the active one
     * @returns {boolean} whether a character was found
     */
    step(dir, opts) {
      const o = opts || {};
      const page = this.page;
      if (!page || !page.hasAnnotation) return false;
      const filter = o.filter || this.store.ui.filter;
      const order = index.readingOrder(page);
      const list = order.filter((c) => review.matches(c, filter, this.threshold));
      if (!list.length) {
        if (!o.quiet) this.toast(filter === 'pending' ? 'Every character on this page is accepted.' : 'No characters match this filter on this page.');
        return false;
      }
      const pos = new Map(order.map((c, i) => [c.id, i]));
      const start = o.from || this.store.ui.editId || this.store.ui.selectedId;
      const cur = pos.has(start) ? pos.get(start) : -1;
      const target = dir > 0
        ? list.find((c) => pos.get(c.id) > cur) || list[0]
        : list.slice().reverse().find((c) => cur < 0 || pos.get(c.id) < cur) || list[list.length - 1];
      this.focusChar(target.id, { edit: o.edit });
      return true;
    }

    /** Next/previous pending character: what Tab does. */
    nextPending(dir, opts) { return this.step(dir, Object.assign({}, opts, { filter: 'pending' })); }

    /**
     * Select a character, bring it into view in both panes (the text panel and the
     * image), optionally open its editor. Every way of picking a character goes
     * through here, so the two panes always follow each other.
     */
    focusChar(id, opts) {
      this.store.setSelected(id);
      this.app.bus.emit('ui:reveal', { id });
      if (opts && opts.edit) this.startEdit(id);
    }

    /* ---------- inline editing ---------- */

    startEdit(id) {
      const c = this.store.getChar(id);
      if (!c || c.space) return;
      if (this.store.ui.insert) this.store.setInsert(null);
      this.store.setSelected(id);
      this.store.setEdit(id);
    }

    cancelEdit() { this.store.setEdit(null); }

    /**
     * Confirm an inline edit.
     *   new value        corrects the character (typing the OCR value back ends the correction)
     *   same value       Enter accepts it if it is pending; otherwise nothing changes.
     *                    Tab just moves on, so tabbing never accepts by accident.
     *   empty value      removes a manually added character; cancels otherwise
     * @param {number} advance  1 / -1 to continue with the next / previous pending character
     */
    commitEdit(id, value, advance) {
      const c = this.store.getChar(id);
      this.store.setEdit(null);
      if (c) {
        if (!value) {
          if (review.isAdded(c)) this.removeChar(id);
        } else if (value !== c.value) {
          const next = review.edit(c, value);
          const was = review.isCorrected(c), now = review.isCorrected(next);
          this.replace(next, now && !was ? 'Correct' : was && !now ? 'Restore' : 'Edit');
        } else if (!advance) {
          this.acceptChar(id);
        }
      }
      if (advance) this.nextPending(advance, { edit: true, from: id });
    }

    /* ---------- inserting missing characters ---------- */

    insertAt(lineId, order) {
      if (!this.page) return;
      if (this.store.ui.editId) this.store.setEdit(null);
      this.store.setSelected(null);
      this.store.setInsert({ lineId, order, id: makeId('ins') });
    }

    /** Insert before (side -1) or after (side 1) a character. */
    insertNear(id, side) {
      const c = this.store.getChar(id);
      if (!c) return;
      const line = index.linesOf(this.page).get(c.lineId) || [];
      const neighbour = line[line.indexOf(c) + side];
      this.insertAt(c.lineId, neighbour ? (c.order + neighbour.order) / 2 : c.order + side);
    }

    insertAtLineEnd(lineId) {
      const line = (this.page && index.linesOf(this.page).get(lineId)) || [];
      this.insertAt(lineId, line.length ? line[line.length - 1].order + 1 : 0);
    }

    commitInsert(value) {
      const ins = this.store.ui.insert;
      const page = this.page;
      this.store.setInsert(null);
      if (!ins || !page || !value) return;
      const c = review.createAdded(makeId('add'), ins.lineId, ins.order, value);
      this.store.commit(page.id, page.chars.concat([c]), { label: 'Insert', ids: [c.id], lineIds: [ins.lineId], structural: true });
      this.store.setSelected(c.id);
      this.beginDraw(c.id);
      this.toast('Added “' + value + '”. Drag across it on the image to give it a bounding box, or press Esc to skip.');
    }

    cancelInsert() { this.store.setInsert(null); }

    /* ---------- accepting ---------- */

    /** Accept a pending character as it is (others are left alone); with advance, continue to the next pending one. */
    acceptChar(id, advance) {
      const c = this.store.getChar(id);
      const next = c && review.accept(c, this.threshold);
      if (next) this.replace(next, 'Accept');
      if (advance) this.nextPending(1, { from: id });
    }

    /** Accept every pending character on a line. */
    acceptLine(lineId) {
      const page = this.page;
      const n = this.acceptWhere((c) => c.lineId === lineId);
      if (n) this.toast('Accepted ' + plural(n, 'pending character') + ' on line ' + index.lineNumber(page, lineId) + '.');
    }

    /** Accept every pending character on the current page. */
    acceptPage() {
      const n = this.acceptWhere(() => true);
      this.toast(n ? 'Accepted ' + plural(n, 'pending character') + ' on this page.' : 'Nothing is pending on this page.');
    }

    /** Accept the pending characters of the current page that match `test`, as one undo step. @returns {number} */
    acceptWhere(test) {
      const page = this.page;
      if (!page) return 0;
      const ids = [];
      const next = page.chars.map((c) => {
        const accepted = test(c) && review.accept(c, this.threshold);
        if (!accepted) return c;
        ids.push(c.id);
        return accepted;
      });
      if (ids.length) this.store.commit(page.id, next, { label: 'Accept', ids });
      return ids.length;
    }

    unacceptChar(id) {
      const c = this.store.getChar(id);
      const next = c && review.unaccept(c, this.threshold);
      if (next) this.replace(next, 'Unaccept');
    }

    restoreChar(id) {
      const c = this.store.getChar(id);
      const next = c && review.restore(c);
      if (!next) return;
      this.replace(next, 'Restore');
      this.toast('Restored the original OCR value.');
    }

    /**
     * Remove a character from the page: one the OCR detected by mistake, or one added
     * by hand. Its box goes with it, its neighbours close up, the rest of the line is
     * renumbered, and a line left empty disappears (model/layout.js withoutChar). Everything derived from the page's
     * characters (counts, statistics, exports) follows; undo brings it all back.
     */
    removeChar(id) {
      const page = this.page;
      const c = this.store.getChar(id);
      const next = c && layout.withoutChar(page, id);
      if (!next) return;
      const ui = this.store.ui;
      if (ui.editId === id) this.store.setEdit(null);
      if (ui.selectedId === id) this.store.setSelected(null);
      if (ui.hoverId === id) this.store.setHover(null);
      if (ui.drawFor === id) this.store.setView({ drawFor: null, tool: 'pan' });
      // Without lineIds the text panel redraws the page: a removed line renumbers the ones below it.
      const info = { label: 'Remove', ids: [id], structural: true };
      if (!next.lineRemoved) info.lineIds = [c.lineId];
      this.store.commit(page.id, next.chars, info, next.lines);
      this.toast('Removed “' + c.value + '”' + (next.lineRemoved ? ' and its empty line' : '') + '. Undo brings it back.');
    }

    /* ---------- boxes for manually added characters ---------- */

    /**
     * Start drawing the outline of a manually added character on the image.
     * @param {'box'|'poly'} [shape]  a dragged rectangle, or four clicked corners for tilted
     *                                characters; defaults to the shape used last time
     */
    beginDraw(id, shape) {
      const c = this.store.getChar(id);
      if (!c || !review.isAdded(c)) return;
      const settings = this.app.settings;
      if (shape === 'box' || shape === 'poly') settings.set('drawShape', shape);
      this.store.setView({ drawFor: id, tool: settings.get('drawShape') === 'poly' ? 'poly' : 'box' });
    }

    cancelDraw() { this.store.setView({ drawFor: null, tool: 'pan' }); }

    setBox(id, bbox) {
      const c = this.store.getChar(id);
      if (!c) return;
      this.replace(review.withBox(c, bbox.map((v) => round(v, 2))), 'Box');
      this.store.setView({ drawFor: null, tool: 'pan' });
      this.toast('Saved the bounding box for “' + c.value + '”.');
    }

    /**
     * Give a character a four-corner outline from points clicked in any order. The text
     * direction follows the nearest rotated character on its line, else the reading closest
     * to upright. Corners that turn out level are stored as an ordinary box.
     * @returns {boolean}  false when the points do not span an area
     */
    setPolygon(id, points) {
      const c = this.store.getChar(id);
      if (!c) return false;
      const line = (index.linesOf(this.page).get(c.lineId) || []).filter((x) => x.poly && x.id !== id);
      const near = line.sort((a, b) => Math.abs(a.order - c.order) - Math.abs(b.order - c.order))[0];
      const quad = geometry.quadFromPoints(points, near ? geometry.angleOf(near.poly) : 0);
      if (!quad) { this.toast('Those four points do not enclose an area. Click the four corners of the character.'); return false; }
      const level = Math.abs(geometry.angleOf(quad)) < geometry.MIN_ANGLE;
      this.replace(review.withBox(c, geometry.boundsOf(quad).map((v) => round(v, 2)), level ? null : quad), 'Box');
      this.store.setView({ drawFor: null, tool: 'pan' });
      this.toast('Saved the polygon for “' + c.value + '”.');
      return true;
    }

    /* ---------- history ---------- */

    undo() { this.endTransient(); if (!this.store.travel(-1)) this.toast('Nothing to undo.'); }
    redo() { this.endTransient(); if (!this.store.travel(1)) this.toast('Nothing to redo.'); }

    /* ---------- files ---------- */

    openImport(kind, entries) { this.app.bus.emit('import:open', { kind: kind || 'documents', entries: entries || [] }); }

    /**
     * Open the sample documents in a project of their own, exactly as on first
     * use: generated fresh, nothing reviewed, default view, never auto-saved.
     * With a project open, this goes through New project first (which asks about
     * unsaved changes); otherwise the empty project is reset anyway.
     */
    async loadSample() {
      if (!this.store.isEmpty()) { if (!(await this.newProject({ quiet: true }))) return; }
      else this.resetProject();
      try {
        this.toast('Generating sample documents…', { sticky: true });
        const result = await require('io/sample').load(this.app);
        this.toast('Loaded ' + plural(result.pages, 'sample page') + '. Press Tab to jump to the first pending character.');
      } catch (err) {
        this.fail('The sample could not be generated', err);
      }
    }

    /** @returns {Promise<boolean>} whether the files were saved */
    async saveAll() {
      try { return await require('io/save-all').saveAll(this.app); }
      catch (err) { this.fail('Save failed', err); return false; }
    }

    async exportAs(formatId) {
      try { await require('io/exporters').run(this.app, formatId, this.app.settings.get('exportScope')); }
      catch (err) { this.fail('Export failed', err); }
    }

    closeDocument(docId) {
      const doc = this.store.getDocument(docId);
      if (!doc) return;
      this.store.removeDocument(docId);
      this.app.images.forgetDocument(doc);
      if (this.app.autosave) this.app.autosave.removeDocument(doc);
      this.toast('Closed ' + doc.name + '.');
    }

    /* ---------- project ---------- */

    /**
     * Start a new, empty project. With no unsaved changes this happens at once;
     * otherwise the user chooses to save first, discard the changes, or cancel.
     * "Changes" are edits made since the last Save all (store.unsaved).
     * @param {{ quiet?: boolean }} [opts]  quiet: no "Started a new project" message
     * @returns {Promise<boolean>} whether the new project was started
     */
    async newProject(opts) {
      const store = this.store;
      if (store.isEmpty()) return true;
      this.endTransient();
      if (store.unsaved > 0) {
        const choice = await this.app.dialogs.choose({
          title: 'Save changes before starting a new project?',
          message: 'This project has ' + plural(store.unsaved, 'unsaved change') + '. A new project closes ' +
            (store.documents.length === 1 ? 'the open document' : 'all ' + plural(store.documents.length, 'open document')) + '.',
          options: [
            { id: 'save', icon: 'save', tone: 'primary', label: 'Save', description: 'Save all changes to the validated annotation files, then start a new project.' },
            { id: 'discard', icon: 'trash', tone: 'danger', label: 'Discard', description: 'Start a new project without saving. Your unsaved changes will be lost.' },
            { id: 'cancel', icon: 'x', label: 'Cancel', description: 'Go back to the current project. Nothing is changed.' }
          ],
          cancel: 'cancel'
        });
        if (choice === 'cancel') return false;
        if (choice === 'save' && !(await this.saveAll())) {
          this.toast('The changes were not saved, so the current project is still open.');
          return false;
        }
      }
      this.resetProject();
      if (!(opts && opts.quiet)) this.toast('Started a new project.');
      return true;
    }

    /** Close every document and clear undo history and the auto-saved draft. */
    resetProject() {
      for (const doc of this.store.documents) this.app.images.forgetDocument(doc);
      if (this.store.ui.panel) this.store.setPanel(null);
      this.store.clear();
      if (this.app.autosave) this.app.autosave.clear();
    }

    fail(what, err) {
      console.error(err);
      this.toast(what + ': ' + (err && err.message ? err.message : err), { error: true });
    }
  }

  return { Commands };
});
