/**
 * Export registry. Formats come from io/export-text.js and io/export-data.js;
 * the Export menu is built from this list.
 *
 * To add a format, add a descriptor to one of those files:
 *   { id, group: 'text' | 'data', badge, tone?, label, description,
 *     build: async (ctx) => ({ blob, filename, detail? }) }
 * ctx = { app, scope, groups: [{ doc, pages }], name (base file name), threshold,
 *         progress(done, total) }   long builds call progress per page, for the "page X of Y" message
 */
OVS.define('io/exporters', (require) => {
  'use strict';

  const { stem } = require('util/format');
  const { downloadBlob } = require('util/files');
  const { nextFrame } = require('util/async');

  /** From this many pages on, an export shows a "Preparing…" message while it is built. */
  const SLOW_PAGES = 20;
  const textFormats = require('io/export-text');
  const dataFormats = require('io/export-data');

  const FORMATS = textFormats.FORMATS.concat(dataFormats.FORMATS);

  const SCOPES = [
    { id: 'page', label: 'This page' },
    { id: 'doc', label: 'Document' },
    { id: 'all', label: 'All documents' }
  ];

  /** Pages covered by a scope, grouped by document. */
  function collect(app, scope) {
    const store = app.store;
    const cur = store.currentPage();
    const docs = scope === 'all' ? store.documents : cur ? [store.documentOf(cur)] : [];
    return docs.filter(Boolean)
      .map((doc) => ({ doc, pages: scope === 'page' ? [cur] : doc.pageIds.map((id) => store.pages.get(id)).filter(Boolean) }))
      .filter((g) => g.pages.length);
  }

  function baseName(app, scope) {
    const cur = app.store.currentPage();
    if (scope === 'all' || !cur) return 'ocr-validation_all-documents';
    const doc = app.store.documentOf(cur);
    return scope === 'page' && doc.pageIds.length > 1 ? stem(doc.name) + '_p' + cur.pageNo : stem(doc.name);
  }

  function context(app, scope) {
    return { app, scope, groups: collect(app, scope), name: baseName(app, scope), threshold: app.store.threshold, progress: () => {} };
  }

  /** Build a format and download it. */
  async function run(app, formatId, scope) {
    const format = FORMATS.find((f) => f.id === formatId);
    if (!format) throw new Error('Unknown export format: ' + formatId);
    const ctx = context(app, scope);
    if (!ctx.groups.length) throw new Error('Open a document first.');
    const pages = ctx.groups.reduce((n, g) => n + g.pages.length, 0);
    // Large exports take a while: say so, and let the browser paint the message first.
    if (pages >= SLOW_PAGES) {
      ctx.progress = (done, total) => app.toast.show(format.label + ': page ' + done + ' of ' + total + '…', { sticky: true });
      app.toast.show('Preparing ' + format.label + '…', { sticky: true });
      await nextFrame();
    }
    let out;
    try { out = await format.build(ctx); }
    finally { app.toast.hide(); }
    downloadBlob(out.filename, out.blob);
    app.toast.show('Exported ' + out.filename + (out.detail ? ' · ' + out.detail : '') + '.');
    return out;
  }

  /** The first lines of the text export, for the Export menu. */
  function preview(app, scope, maxLines) {
    const ctx = context(app, scope);
    const lines = [];
    for (const b of textFormats.textBlocks(ctx)) {
      if (b.title) lines.push('=== ' + b.title + ' ===', '');
      for (const l of b.lines) lines.push(l.text);
      lines.push('');
      if (lines.length > maxLines) break;
    }
    return { text: lines.slice(0, maxLines).join('\n') + (lines.length > maxLines ? '\n…' : ''), filename: ctx.name + '.txt' };
  }

  return { FORMATS, SCOPES, run, preview };
});
