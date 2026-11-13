/**
 * Undo/redo. Each entry holds a page's character array before and after one
 * change. Arrays are immutable and share unchanged characters, so entries are cheap.
 */
OVS.define('core/history', () => {
  'use strict';

  const LIMIT = 300;

  class History {
    constructor(bus) {
      this.bus = bus;
      this.undoStack = [];
      this.redoStack = [];
    }

    /** @param {{ pageId, before, after, info }} entry */
    push(entry) {
      this.undoStack.push(entry);
      if (this.undoStack.length > LIMIT) this.undoStack.shift();
      this.redoStack.length = 0;
      this.bus.emit('history:changed');
    }

    canUndo() { return this.undoStack.length > 0; }
    canRedo() { return this.redoStack.length > 0; }

    /** Move the newest entry from one stack to the other and return it. */
    takeUndo() { return this.move(this.undoStack, this.redoStack); }
    takeRedo() { return this.move(this.redoStack, this.undoStack); }

    move(from, to) {
      const entry = from.pop();
      if (!entry) return null;
      to.push(entry);
      this.bus.emit('history:changed');
      return entry;
    }

    /** Drop entries for the given pages, or everything when called without arguments. */
    forget(pageIds) {
      if (!pageIds) { this.undoStack = []; this.redoStack = []; }
      else {
        const gone = new Set(pageIds);
        this.undoStack = this.undoStack.filter((e) => !gone.has(e.pageId));
        this.redoStack = this.redoStack.filter((e) => !gone.has(e.pageId));
      }
      this.bus.emit('history:changed');
    }
  }

  return { History };
});
