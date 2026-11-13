/**
 * Behaviour shared by the panels shown over the workspace while `store.ui.panel`
 * names them (Settings, Statistics): showing and hiding, Escape to close, and
 * moving focus into the panel when it opens.
 *
 *   sidePanel(root, app, { id: 'stats', label: 'Statistics', onOpen: () => render() })
 */
OVS.define('ui/side-panel', () => {
  'use strict';

  function sidePanel(root, app, { id, label, onOpen }) {
    root.setAttribute('aria-label', label);
    const sync = () => {
      const open = app.store.ui.panel === id;
      root.hidden = !open;
      if (!open) return;
      onOpen();
      const first = root.querySelector('button');
      if (first) first.focus({ preventScroll: true });
    };
    app.bus.on('ui:panel', sync);
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); app.store.setPanel(null); }
    });
    sync();
  }

  return { sidePanel };
});
