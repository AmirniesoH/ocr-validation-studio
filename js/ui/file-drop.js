/**
 * Drag and drop of files, limited to dedicated drop areas.
 *
 *   guardWindow(app)              once at start-up: dropping a file anywhere
 *                                 else does nothing (instead of the browser
 *                                 opening it in the tab and losing the work)
 *   dropTarget(el, onEntries)     make an element a drop area; onEntries gets
 *                                 [{ file, path }] (folders are expanded)
 *
 * While files are dragged over the window, body.dragging is set so every drop
 * area can show itself; the area under the pointer gets .over.
 *
 * Problems are reported as messages, never silently: a folder the browser will
 * not let the page read (Chrome, page opened from disk) or a failed read.
 */
OVS.define('ui/file-drop', (require) => {
  'use strict';

  const { entriesFromDataTransfer } = require('io/importer');

  const hasFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

  let report = (message) => console.warn('[OVS] ' + message);

  function guardWindow(app) {
    if (app && app.toast) report = (message) => app.toast.show(message, { error: true });
    let depth = 0;
    const stop = () => { depth = 0; document.body.classList.remove('dragging'); };
    window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; document.body.classList.add('dragging'); } });
    window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --depth <= 0) stop(); });
    // Drop areas call preventDefault first; anywhere else, refuse the drop.
    window.addEventListener('dragover', (e) => {
      if (!hasFiles(e) || e.defaultPrevented) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'none';
    });
    window.addEventListener('drop', (e) => { if (hasFiles(e)) e.preventDefault(); stop(); });
    window.addEventListener('dragend', stop);
  }

  function dropTarget(el, onEntries) {
    el.classList.add('drop-target');
    // preventDefault is all a drop area needs. The drop effect is left to the
    // browser: forcing "copy" makes drags that only allow "move" or "link"
    // (some file managers and apps) silently refuse to drop.
    el.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      el.classList.add('over');
    });
    el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('over'); });
    el.addEventListener('drop', async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      el.classList.remove('over');
      try {
        const { entries, unreadable } = await entriesFromDataTransfer(e.dataTransfer);
        if (unreadable.length) {
          report('The browser did not allow reading the dropped folder ' + unreadable.map((n) => '“' + n + '”').join(', ') +
            '. Use Import → Import folder instead, or drop the files from inside the folder.');
        }
        if (entries.length) onEntries(entries);
      } catch (err) {
        console.error(err);
        report('The dropped files could not be read: ' + (err && err.message ? err.message : err));
      }
    });
    return el;
  }

  return { guardWindow, dropTarget };
});
