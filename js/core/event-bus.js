/**
 * Publish/subscribe. Components listen for changes and update only the DOM they own.
 *
 * Events (payload):
 *   project:changed    documents or pages added, replaced or removed
 *   page:changed       current page switched ({ pageId })
 *   chars:changed      a page's characters changed ({ pageId, ids, lineIds, structural, history })
 *   image:loaded       a page image finished loading ({ pageId })
 *   ui:hover           hovered character ({ id, prev })
 *   ui:select          selected character ({ id, prev })
 *   ui:edit            inline editing started/ended ({ id, prev })
 *   ui:insert          pending insertion changed ({ insert, prev })
 *   ui:view            filter, insert mode, drawing target or tool changed
 *   ui:panel           settings or statistics opened/closed ({ panel })
 *   ui:reveal          scroll both panes to a character ({ id })
 *   settings:changed   a setting changed ({ key, value }); key '*' after a reset
 *   history:changed    undo/redo availability changed
 *   save:status        unsaved count or auto-save state changed
 *   import:open        open the import dialog ({ kind, entries })
 */
OVS.define('core/event-bus', () => {
  'use strict';

  class EventBus {
    constructor() { this.handlers = new Map(); }

    /** Subscribe; returns a function that unsubscribes. */
    on(event, fn) {
      if (!this.handlers.has(event)) this.handlers.set(event, new Set());
      this.handlers.get(event).add(fn);
      return () => this.handlers.get(event).delete(fn);
    }

    /** Subscribe to several events with one handler. */
    onAny(events, fn) {
      const offs = events.map((e) => this.on(e, fn));
      return () => offs.forEach((off) => off());
    }

    emit(event, payload) {
      const set = this.handlers.get(event);
      if (!set) return;
      for (const fn of Array.from(set)) {
        try { fn(payload || {}); }
        catch (err) { console.error('[OVS] handler for "' + event + '" failed', err); }
      }
    }
  }

  return { EventBus };
});
