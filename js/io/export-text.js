/**
 * Text exports: TXT, DOCX, text PDF and searchable PDF.
 * Each format is a descriptor that io/exporters.js lists in the Export menu.
 */
OVS.define('io/export-text', (require) => {
  'use strict';

  const index = require('model/page-index');
  const geometry = require('model/geometry');
  const vendor = require('util/vendor');
  const { xmlEscape } = require('util/format');

  /* ---------- shared: validated text per page ---------- */

  /** Lines of one page, honouring the line-break and paragraph options. */
  function pageLines(page, opts) {
    const lines = index.textLines(page, { indent: opts.lineBreaks, paragraphs: opts.paragraphs || !opts.lineBreaks });
    if (opts.lineBreaks) return lines;
    // Reflow: join each paragraph's lines with single spaces.
    const out = [];
    let buf = [], dir = 'ltr';
    const flush = () => { if (buf.length) out.push({ text: buf.join(' '), dir }); buf = []; };
    for (const l of lines) {
      if (l.blank) { flush(); if (opts.paragraphs) out.push({ text: '', dir: 'ltr', blank: true }); continue; }
      if (!buf.length) dir = l.dir;
      buf.push(l.text.trim());
    }
    flush();
    return out;
  }

  /** @returns {Array<{ title: string|null, lines }>} one block per page */
  function textBlocks(ctx) {
    const s = ctx.app.settings;
    const opts = { lineBreaks: s.get('exportLineBreaks'), paragraphs: s.get('exportParagraphs') };
    const pageCount = ctx.groups.reduce((n, g) => n + g.pages.length, 0);
    const headings = pageCount > 1 && s.get('exportPageHeaders');
    const blocks = [];
    for (const g of ctx.groups) {
      for (const p of g.pages) {
        const title = headings ? (g.doc.pageIds.length > 1 ? g.doc.name + ' · page ' + p.pageNo : g.doc.name) : null;
        blocks.push({ title, lines: pageLines(p, opts) });
      }
    }
    return blocks;
  }

  const lineCount = (blocks) => blocks.reduce((n, b) => n + b.lines.length, 0) + ' lines';

  function txt(blocks) {
    return blocks.map((b) => (b.title ? '=== ' + b.title + ' ===\n\n' : '') + b.lines.map((l) => l.text).join('\n')).join('\n\n') + '\n';
  }

  /* ---------- DOCX (Office Open XML, zipped with JSZip) ---------- */

  async function docx(blocks, monospace) {
    const JSZip = await vendor.jszip();
    const font = monospace ? 'Courier New' : 'Calibri';
    const run = (text, bold, rtl) => '<w:r><w:rPr><w:rFonts w:ascii="' + font + '" w:hAnsi="' + font + '" w:cs="' + font + '"/>' +
      (bold ? '<w:b/>' : '') + (rtl ? '<w:rtl/>' : '') + '<w:sz w:val="' + (monospace ? 20 : 22) + '"/></w:rPr><w:t xml:space="preserve">' + xmlEscape(text) + '</w:t></w:r>';
    const para = (text, o) => '<w:p><w:pPr>' + (o && o.rtl ? '<w:bidi/>' : '') + '<w:spacing w:after="0" w:line="' + (monospace ? 240 : 276) + '" w:lineRule="auto"/></w:pPr>' +
      (text ? run(text, o && o.bold, o && o.rtl) : '') + '</w:p>';
    let body = '';
    blocks.forEach((b, i) => {
      if (i > 0) body += '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
      if (b.title) body += para(b.title, { bold: true }) + para('');
      for (const l of b.lines) body += para(l.text, { rtl: l.dir === 'rtl' });
    });
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + body +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>');
    return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  }

  /* ---------- PDF (jsPDF) ---------- */

  /** Courier covers Latin-1; anything else embeds DejaVu Sans Mono. Returns the font name to use. */
  async function choosePdfFont(doc, sampleText) {
    if (!/[^\u0000-\u00FF]/.test(sampleText)) return 'courier';
    const f = await vendor.pdfFont();
    doc.addFileToVFS(f.file, f.data);
    doc.addFont(f.file, f.name, 'normal');
    return f.name;
  }

  async function textPdf(blocks) {
    const JsPDF = await vendor.jspdf();
    const doc = new JsPDF({ unit: 'pt', format: 'a4' });
    const font = await choosePdfFont(doc, blocks.map((b) => (b.title || '') + b.lines.map((l) => l.text).join('')).join(''));
    doc.setFont(font, 'normal');
    const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 48;
    blocks.forEach((b, bi) => {
      if (bi > 0) doc.addPage();
      const longest = Math.max(20, ...b.lines.map((l) => l.text.length));
      const size = Math.max(6, Math.min(11, (W - 2 * M) / (longest * 0.6)));
      let y = M + size;
      const write = (text, bold) => {
        if (y > H - M) { doc.addPage(); y = M + size; }
        doc.setFontSize(bold ? size + 1 : size);
        if (text) doc.text(text, M, y);
        y += size * 1.35;
      };
      if (b.title) { write(b.title, true); y += size * 0.7; }
      for (const l of b.lines) write(l.text);
    });
    return doc.output('blob');
  }

  /**
   * The invisible text of a searchable PDF: one text object per word, stretched
   * to the word's box on the scan, followed by a space within its line. Viewers
   * then read whole words and lines, so searching finds any word or part of a
   * word (like a normal text document), and the match is highlighted on the scan.
   * (One object per character would make every letter a separate fragment.)
   * Words of rotated text (stamps, seals) are written at their angle.
   */
  function writeTextLayer(doc, page, sx, sy) {
    for (const line of index.linesOf(page).values()) {
      const list = index.words(line);
      list.forEach((word, i) => {
        const text = word.map((c) => c.value).join('') + (i < list.length - 1 ? ' ' : '');
        const bare = text.trimEnd();
        if (word.some((c) => c.poly)) { writeRotatedWord(doc, word, text, bare, sx, sy); return; }
        const box = index.unionBox(word.map((c) => c.bbox));
        if (!box) return;
        doc.setFontSize(Math.max(2, (box[3] - box[1]) * sy));
        const natural = doc.getTextWidth(bare);
        const target = (box[2] - box[0]) * sx;
        doc.text(text, box[0] * sx, box[3] * sy, {
          renderingMode: 'invisible', baseline: 'bottom',
          horizontalScale: natural > 0 && target > 0 ? target / natural : 1
        });
      });
    }
  }

  /** A rotated word: from the first character's bottom-left corner to the last one's bottom-right, at that angle. */
  function writeRotatedWord(doc, word, text, bare, sx, sy) {
    const quads = word.map((c) => geometry.quadOf(c)).filter(Boolean).map((q) => q.map((p) => [p[0] * sx, p[1] * sy]));
    if (!quads.length) return;
    const start = quads[0][3], end = quads[quads.length - 1][2];
    const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
    const height = quads.reduce((n, q) => n + geometry.frameOf(q).h, 0) / quads.length;
    doc.setFontSize(Math.max(2, height));
    const natural = doc.getTextWidth(bare);
    doc.text(text, start[0], start[1], {
      renderingMode: 'invisible',
      angle: -Math.atan2(end[1] - start[1], end[0] - start[0]) * 180 / Math.PI, // jsPDF turns anticlockwise
      horizontalScale: natural > 0 && length > 0 ? length / natural : 1
    });
  }

  /** The original page images with the validated characters as an invisible, selectable text layer. */
  async function searchablePdf(ctx) {
    const JsPDF = await vendor.jspdf();
    const PT_PER_PX = 0.48; // page images treated as 150 dpi
    const allText = ctx.groups.map((g) => g.pages.map((p) => p.chars.map((c) => c.value).join('')).join('')).join('');
    const total = ctx.groups.reduce((n, g) => n + g.pages.length, 0);
    let doc = null, font = null, done = 0;
    for (const g of ctx.groups) {
      for (const page of g.pages) {
        if (ctx.progress) ctx.progress(++done, total);
        const canvas = await ctx.app.images.canvasFor(page, g.doc);
        const w = canvas.width * PT_PER_PX, h = canvas.height * PT_PER_PX;
        if (!doc) { doc = new JsPDF({ unit: 'pt', format: [w, h], orientation: w > h ? 'l' : 'p' }); font = await choosePdfFont(doc, allText); }
        else doc.addPage([w, h], w > h ? 'l' : 'p');
        doc.addImage(canvas.toDataURL('image/jpeg', 0.88), 'JPEG', 0, 0, w, h);
        doc.setFont(font, 'normal');
        writeTextLayer(doc, page, w / page.coord.w, h / page.coord.h);
      }
    }
    if (!doc) throw new Error('There are no pages to export.');
    return doc.output('blob');
  }

  /* ---------- descriptors ---------- */

  const FORMATS = [
    {
      id: 'txt', group: 'text', badge: 'TXT', label: 'Plain text', description: 'One line per source line',
      async build(ctx) { const b = textBlocks(ctx); return { blob: new Blob([txt(b)], { type: 'text/plain;charset=utf-8' }), filename: ctx.name + '.txt', detail: lineCount(b) }; }
    },
    {
      id: 'docx', group: 'text', badge: 'DOCX', tone: 'blue', label: 'Word document', description: 'Lines and paragraphs as in the scan',
      async build(ctx) { const b = textBlocks(ctx); return { blob: await docx(b, ctx.app.settings.get('exportLineBreaks')), filename: ctx.name + '.docx', detail: lineCount(b) }; }
    },
    {
      id: 'pdf', group: 'text', badge: 'PDF', tone: 'orange', label: 'Text PDF', description: 'Validated text, laid out line by line',
      async build(ctx) { const b = textBlocks(ctx); return { blob: await textPdf(b), filename: ctx.name + '.pdf', detail: lineCount(b) }; }
    },
    {
      id: 'searchable-pdf', group: 'text', badge: 'PDF', tone: 'orange', label: 'Searchable PDF', description: 'Original image with an invisible text layer',
      async build(ctx) { return { blob: await searchablePdf(ctx), filename: ctx.name + '_searchable.pdf' }; }
    }
  ];

  return { FORMATS, textBlocks };
});
