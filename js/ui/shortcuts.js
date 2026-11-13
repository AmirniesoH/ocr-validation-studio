/**
 * Keyboard shortcuts. Letter keys are ignored while typing in a field or while
 * the import dialog is open.
 *
 *   Tab / Shift+Tab   next / previous pending character, with its editor open
 *   N / P             next / previous character in the active filter
 *   A                 accept the selected character and move on
 *   Enter             edit the selected character
 *   I                 insert mode           B   show/hide boxes
 *   + / − / 0         zoom in / out / fit width
 *   PageDown / Up     next / previous page
 *   Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z or Ctrl+Y   undo, redo
 *   Ctrl/Cmd+S        save all              Ctrl/Cmd+O   import
 *   Esc               stop drawing, leave insert mode, close a panel, clear the selection
 */
OVS.define('ui/shortcuts', () => {
  'use strict';

  const isTyping = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

  function bindShortcuts(app) {
    const { commands: cmd, store, settings } = app;

    document.addEventListener('keydown', (e) => {
      const target = e.target;
      const dialogOpen = !!document.querySelector('.scrim');
      const mod = e.ctrlKey || e.metaKey;

      if (mod && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 's') { e.preventDefault(); cmd.saveAll(); return; }
        if (k === 'o') { e.preventDefault(); cmd.openImport('documents'); return; }
        if (isTyping(target) || dialogOpen) return;
        if (k === 'z' && !e.shiftKey) { e.preventDefault(); cmd.undo(); }
        else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); cmd.redo(); }
        return;
      }
      if (e.altKey || isTyping(target) || dialogOpen) return;
      if (!store.currentPage() && e.key !== 'Escape') return;

      // Tab from nowhere in particular (or from the image) starts the pending walk.
      // The text panel handles Tab itself; other controls keep normal Tab order.
      if (e.key === 'Tab') {
        const fromNowhere = target === document.body || (target.closest && target.closest('.vp'));
        if (fromNowhere && cmd.nextPending(e.shiftKey ? -1 : 1, { edit: true, quiet: true })) e.preventDefault();
        return;
      }

      switch (e.key) {
        case 'n': case 'N': e.preventDefault(); cmd.step(1); break;
        case 'p': case 'P': e.preventDefault(); cmd.step(-1); break;
        case 'a': case 'A': if (store.ui.selectedId) { e.preventDefault(); cmd.acceptChar(store.ui.selectedId, true); } break;
        case 'Enter':
          if (store.ui.selectedId && !(target.closest && target.closest('button:not(.ch), a'))) { e.preventDefault(); cmd.focusChar(store.ui.selectedId, { edit: true }); }
          break;
        case 'i': case 'I': e.preventDefault(); cmd.toggleInsertMode(); break;
        case 'b': case 'B': e.preventDefault(); settings.set('showBoxes', !settings.get('showBoxes')); break;
        case '+': case '=': e.preventDefault(); app.viewer.zoomBy(1.25); break;
        case '-': case '_': e.preventDefault(); app.viewer.zoomBy(0.8); break;
        case '0': e.preventDefault(); app.viewer.fit('width'); break;
        case 'PageDown': e.preventDefault(); cmd.stepPage(1); break;
        case 'PageUp': e.preventDefault(); cmd.stepPage(-1); break;
        case 'Escape':
          if (store.ui.drawFor) cmd.cancelDraw();
          else if (store.ui.insertMode) cmd.toggleInsertMode(false);
          else if (store.ui.panel) store.setPanel(null);
          else if (store.ui.selectedId) store.setSelected(null);
          break;
        default: break;
      }
    });
  }

  return { bindShortcuts };
});
