/**
 * Save all: one validated annotation file per document, in the format its
 * annotation came in (JSON, Parquet or SQLite). Original OCR values are kept in
 * separate ocr_* fields; source files are never overwritten.
 *
 * Chromium browsers write into a folder the user picks once per session
 * (File System Access API). Other browsers download the files (zipped when
 * there is more than one).
 */
OVS.define('io/save-all', (require) => {
  'use strict';

  const { stem, plural } = require('util/format');
  const { downloadBlob } = require('util/files');
  const vendor = require('util/vendor');
  const format = require('io/annotation-format');
  const { parquet } = require('io/export-data');
  const sqlite = require('io/annotation-sqlite');

  let folder = null;

  async function buildFiles(app) {
    const files = [];
    const threshold = app.store.threshold;
    for (const doc of app.store.documents) {
      const pages = doc.pageIds.map((id) => app.store.pages.get(id)).filter((p) => p && p.hasAnnotation);
      if (!pages.length) continue;
      const groups = [{ doc, pages }];
      const base = stem(doc.annotation ? doc.annotation.name : doc.name).replace(/\.validated$/i, '');
      const source = doc.annotation && doc.annotation.format;
      if (source === 'parquet') files.push({ name: base + '.validated.parquet', blob: await parquet(groups, threshold) });
      else if (source === 'sqlite') files.push({ name: base + '.validated.sqlite', blob: new Blob([await sqlite.write(groups, threshold)], { type: 'application/vnd.sqlite3' }) });
      else files.push({ name: base + '.validated.json', blob: new Blob(format.toJson(groups, threshold), { type: 'application/json' }) });
    }
    return files;
  }

  async function writeToFolder(files) {
    if (!folder) folder = await window.showDirectoryPicker({ id: 'ovs-save', mode: 'readwrite' });
    for (const f of files) {
      const handle = await folder.getFileHandle(f.name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(f.blob);
      await writable.close();
    }
    return folder.name;
  }

  async function download(files) {
    if (files.length === 1) { downloadBlob(files[0].name, files[0].blob); return; }
    const JSZip = await vendor.jszip();
    const zip = new JSZip();
    for (const f of files) zip.file(f.name, f.blob);
    downloadBlob('ocr-validation_' + new Date().toISOString().slice(0, 10) + '.zip', await zip.generateAsync({ type: 'blob' }));
  }

  /** @returns {Promise<boolean>} true once the files were written or downloaded */
  async function saveAll(app) {
    const files = await buildFiles(app);
    if (!files.length) { app.toast.show('Nothing to save yet: no document has annotations.'); return false; }
    let folderName = null;
    if (window.showDirectoryPicker && window.isSecureContext) {
      try { folderName = await writeToFolder(files); }
      catch (err) {
        if (err && err.name === 'AbortError') return false; // folder picker closed
        folder = null;
        console.warn('[OVS] Could not write to the folder; downloading instead', err);
      }
    }
    if (!folderName) await download(files);
    // Reset the counter first so the auto-saved copy records "nothing unsaved".
    app.store.markSaved();
    if (app.autosave) await app.autosave.flush().catch(() => {});
    app.toast.show('Saved ' + plural(files.length, 'validated annotation file') + (folderName ? ' to “' + folderName + '”.' : '.'));
    return true;
  }

  return { saveAll };
});
