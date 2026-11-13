/**
 * Import pipeline.
 *
 *   const session = new ImportSession(app);
 *   await session.add([{ file, path }]);    read and classify files
 *   session.rows();                         pairing shown in the import dialog
 *   session.setMapping(annKey, patch);      user adjusts detected fields
 *   session.setTarget(annKey, targetKey);   user pairs an annotation by hand
 *   await session.commit();                 create documents and pages in the store
 *
 * Documents are images, PDFs, or folders of images (one document, one page per
 * image). Annotation files pair with documents by file name, by the image names
 * they contain, or by hand, and can also be added later for open documents.
 */
OVS.define('io/importer', (require) => {
  'use strict';

  const F = require('util/format');
  const { readText, readArrayBuffer } = require('util/files');
  const vendor = require('util/vendor');
  const { mapLimit } = require('util/async');
  const schema = require('io/annotation-schema');
  const sqlite = require('io/annotation-sqlite');
  const images = require('io/images');
  const layout = require('model/layout');

  /** Images decoded at once while importing: enough to keep the decoder busy, not to flood memory. */
  const PROBE_CONCURRENCY = 4;
  const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'avif']);
  /** Annotation file extensions per reader: the one list behind classify() and the file pickers. */
  const ANNOTATION_EXT = { json: ['json'], parquet: ['parquet', 'pq'], sqlite: sqlite.EXTENSIONS };
  /** `accept` strings for file pickers. */
  const ACCEPT = Object.freeze({
    image: 'image/*',
    pdf: 'application/pdf,.pdf',
    annotation: Object.values(ANNOTATION_EXT).flat().map((e) => '.' + e).concat('application/json').join(',')
  });
  const DPI_STEPS = [72, 96, 100, 150, 200, 240, 300, 400, 600, 1200];

  function classify(file) {
    const e = F.ext(file.name);
    for (const [kind, exts] of Object.entries(ANNOTATION_EXT)) if (exts.includes(e)) return kind;
    if (e === 'pdf' || file.type === 'application/pdf') return 'pdf';
    if (IMAGE_EXT.has(e) || /^image\//.test(file.type)) return 'image';
    return null;
  }

  /**
   * A document name not in `taken` ("scan.png", then "scan (2).png"), which it joins.
   * Exports identify documents by name, so names must not repeat.
   */
  function uniqueName(name, taken) {
    let out = name;
    const dot = name.lastIndexOf('.');
    const [base, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let n = 2; taken.has(out); n++) out = base + ' (' + n + ')' + extension;
    taken.add(out);
    return out;
  }

  /** Strip common suffixes so "letter.validated.json" pairs with "letter.png". */
  const annotationKey = (name) => F.stem(name)
    .replace(/[._-](validated|annotations?|ocr|chars?|characters|labels?|gt)$/i, '')
    .toLowerCase().replace(/[\s_-]+/g, '');

  class ImportSession {
    /**
     * @param {object} app
     * @param {{ sample?: boolean }} [options]  sample: the documents are generated samples (never auto-saved)
     */
    constructor(app, options) {
      this.app = app;
      this.sample = !!(options && options.sample);
      this.docs = [];     // pending documents: { key, name, kind, file?, pages: [...], meta }
      this.anns = [];     // annotation files: { key, name, format, rows, mapping, cands, groups, charCount, problem, target }
      this.errors = [];   // { name, message }
      this.busy = 0;
    }

    /* ---------- reading ---------- */

    /** @param {Array<{ file, path }>} entries  path is the folder-relative path when known */
    async add(entries) {
      this.busy++;
      try {
        const imageEntries = [];
        for (const entry of entries) {
          const file = entry.file || entry;
          const path = entry.path || file.webkitRelativePath || file.name;
          const type = classify(file);
          try {
            if (type === 'image') imageEntries.push({ file, path });
            else if (type === 'pdf') await this.addPdf(file);
            else if (type in ANNOTATION_EXT) await this.addAnnotation(file, type);
            else if (!file.name.startsWith('.')) this.errors.push({ name: file.name, message: 'Not a supported file type.' });
          } catch (err) {
            this.errors.push({ name: file.name, message: err.message || String(err) });
          }
        }
        await this.addImages(imageEntries);
        this.mergePageFiles();
      } finally {
        this.busy--;
      }
    }

    /** Images that share a folder become one multi-page document. */
    async addImages(entries) {
      // The browser decodes off the main thread, so a few images at a time load several
      // times faster than one by one (book scans are large).
      const probed = await mapLimit(entries, PROBE_CONCURRENCY, async (it) => {
        try { return { size: await images.probeImage(it.file, it.file.name) }; }
        catch (err) { return { error: err.message }; }
      });
      const byFolder = new Map();
      entries.forEach((it, i) => {
        const r = probed[i];
        if (r.error) { this.errors.push({ name: it.file.name, message: r.error }); return; }
        const folder = it.path.includes('/') ? it.path.slice(0, it.path.lastIndexOf('/')) : '';
        if (!byFolder.has(folder)) byFolder.set(folder, []);
        byFolder.get(folder).push({ name: it.file.name, blob: it.file, width: r.size.width, height: r.size.height });
      });
      for (const [folder, pages] of byFolder) {
        pages.sort((a, b) => F.naturalCompare(a.name, b.name));
        if (folder && pages.length > 1) {
          this.docs.push({ key: F.makeId('q'), name: folder.split('/').pop(), kind: 'folder', pages, meta: F.plural(pages.length, 'image') });
        } else {
          for (const p of pages) this.docs.push({ key: F.makeId('q'), name: p.name, kind: 'image', pages: [p], meta: p.width + ' × ' + p.height + ' px · ' + F.formatBytes(p.blob.size) });
        }
      }
    }

    async addPdf(file) {
      const pages = await images.probePdf(file);
      this.docs.push({
        key: F.makeId('q'), name: file.name, kind: 'pdf', file,
        pages: pages.map((p) => Object.assign({ name: file.name + ' · page ' + p.pdfPage }, p)),
        meta: F.plural(pages.length, 'page') + ' · ' + F.formatBytes(file.size)
      });
    }

    /**
     * Read an annotation file. Table formats (Parquet, SQLite) holding several
     * documents become one annotation per document, each named after its document.
     */
    async addAnnotation(file, format) {
      let parts;
      if (format === 'json') {
        let data;
        try { data = JSON.parse(await readText(file)); }
        catch (e) { throw new Error('This JSON file could not be parsed: ' + e.message); }
        parts = [{ name: null, rows: schema.flatten(data) }];
      } else if (format === 'parquet') {
        const pq = await vendor.parquet();
        const objects = await pq.parquetReadObjects({ file: await readArrayBuffer(file), compressors: pq.compressors });
        parts = schema.splitByDocument(schema.flatten(objects.map(schema.plain)));
      } else {
        parts = (await sqlite.read(await readArrayBuffer(file))).map((p) => ({ name: p.name, rows: schema.flatten(p.rows) }));
      }
      parts = parts.filter((p) => p.rows.length);
      if (!parts.length) throw new Error('No character records were found. Each record needs a character value and a box or confidence.');
      for (const part of parts) {
        const ann = {
          key: F.makeId('a'), name: part.name || file.name, source: file.name, format, rows: part.rows,
          mapping: schema.detectMapping(part.rows), cands: schema.candidates(part.rows), target: undefined
        };
        this.analyse(ann);
        this.anns.push(ann);
      }
    }

    /**
     * Annotation files written one per page, as for a book folder ("page_0001.json" beside
     * "page_0001.jpg"), are combined into one annotation for their document. A file belongs
     * to a page when it is named after the page, or names only images of that document.
     * Runs after every add(), so pages and their files can arrive in any order.
     */
    mergePageFiles() {
      const all = this.targets();
      const multi = all.filter((t) => t.pages.length > 1);
      if (!multi.length) return;
      const docKeys = new Set(all.map((t) => annotationKey(t.name)));
      const pageByKey = new Map();   // file-name key → { target, page }
      const targetByImage = new Map(); // image-name key → target
      for (const t of multi) {
        for (const page of t.pages) {
          if (!pageByKey.has(annotationKey(page.name))) pageByKey.set(annotationKey(page.name), { target: t, page });
          if (!targetByImage.has(F.normKey(page.name))) targetByImage.set(F.normKey(page.name), t);
        }
      }
      const found = new Map(); // target → [{ ann, rows }]
      const take = (target, ann, rows) => { if (!found.has(target)) found.set(target, []); found.get(target).push({ ann, rows }); };
      for (const ann of this.anns) {
        if (ann.target !== undefined || ann.pageFiles) continue;
        const key = annotationKey(ann.name);
        if (docKeys.has(key)) continue; // named after a whole document
        const hit = pageByKey.get(key);
        const untagged = ann.groups.length === 1 && !ann.groups[0].image && ann.groups[0].page == null;
        if (hit && untagged) { take(hit.target, ann, ann.rows.map((r) => Object.assign({ __image: hit.page.name }, r))); continue; }
        const owners = new Set(ann.groups.map((g) => (g.image ? targetByImage.get(F.normKey(g.image)) : null)));
        if (owners.size === 1 && !owners.has(null) && !owners.has(undefined)) take(owners.values().next().value, ann, ann.rows);
      }
      for (const [target, parts] of found) {
        let merged = this.anns.find((a) => a.pageFiles && a.target === target.key);
        if (!merged && parts.length === 1 && parts[0].rows === parts[0].ann.rows) continue; // one file that already pairs by image
        if (!merged) {
          merged = { key: F.makeId('a'), format: parts[0].ann.format, rows: [], pageFiles: 0, target: target.key };
          this.anns.push(merged);
        }
        for (const part of parts) for (const row of part.rows) merged.rows.push(row);
        merged.pageFiles += parts.length;
        merged.name = F.stem(target.name) + '.' + ANNOTATION_EXT[merged.format][0];
        merged.source = F.plural(merged.pageFiles, 'file') + ', one per page';
        merged.mapping = schema.detectMapping(merged.rows);
        if (merged.rows.some((r) => '__image' in r)) merged.mapping.image = '__image';
        merged.cands = schema.candidates(merged.rows);
        const used = new Set(parts.map((x) => x.ann));
        this.anns = this.anns.filter((a) => !used.has(a));
        this.analyse(merged);
      }
    }

    analyse(ann) {
      ann.groups = schema.normalize(ann.rows, ann.mapping);
      ann.charCount = ann.groups.reduce((n, g) => n + g.records.length, 0);
      ann.problem = !ann.mapping.value
        ? 'Choose the field that holds the character.'
        : !ann.mapping.bbox && !ann.mapping.cols ? 'No box field found; characters will have no boxes.' : null;
    }

    setMapping(annKey, patch) {
      const ann = this.anns.find((a) => a.key === annKey);
      if (ann) { Object.assign(ann.mapping, patch); this.analyse(ann); }
    }

    setTarget(annKey, targetKey) {
      const ann = this.anns.find((a) => a.key === annKey);
      if (ann) ann.target = targetKey;
    }

    remove(key) {
      this.docs = this.docs.filter((d) => d.key !== key);
      this.anns = this.anns.filter((a) => a.key !== key);
    }

    /* ---------- pairing ---------- */

    /** Pending documents plus documents already open in the app. */
    targets() {
      const store = this.app.store;
      const open = store.documents.map((d) => ({
        key: 'open:' + d.id, docId: d.id, name: d.name, kind: d.kind, existing: true,
        pages: d.pageIds.map((id) => store.pages.get(id)).filter(Boolean)
      }));
      return this.docs.concat(open);
    }

    resolveTarget(ann, targets) {
      if (ann.target !== undefined) return targets.find((t) => t.key === ann.target) || null;
      const key = annotationKey(ann.name);
      const byName = targets.find((t) => annotationKey(t.name) === key);
      if (byName) return byName;
      const imageGroups = ann.groups.filter((g) => g.image);
      if (imageGroups.length) {
        let best = null, bestN = 0;
        for (const t of targets) {
          const names = new Set(t.pages.map((p) => F.normKey(p.name)));
          const n = imageGroups.filter((g) => names.has(F.normKey(g.image))).length;
          if (n > bestN) { best = t; bestN = n; }
        }
        if (best) return best;
      }
      if (this.anns.length === 1 && this.docs.length === 1) return this.docs[0];
      return null;
    }

    /** Which page of the target each annotation group belongs to. */
    mapGroups(ann, target) {
      const assignments = [];
      let unmatched = 0;
      const numbered = ann.groups.filter((g) => !g.image && g.page != null);
      const base = numbered.length && Math.min(...numbered.map((g) => g.page)) === 0 ? 0 : 1;
      for (const g of ann.groups) {
        let idx = -1;
        if (g.image && !(target.kind === 'pdf' && g.page != null)) {
          const k = F.normKey(g.image);
          idx = target.pages.findIndex((p) => F.normKey(p.name) === k);
          if (idx < 0 && target.pages.length === 1 && (F.normKey(target.name) === k || ann.groups.length === 1)) idx = 0;
          if (idx < 0 && g.page != null) idx = g.page - base;
        } else if (g.page != null) idx = g.page - base;
        else idx = 0;
        if (idx >= 0 && idx < target.pages.length) assignments.push({ group: g, pageIndex: idx });
        else unmatched += g.records.length;
      }
      return { assignments, unmatched };
    }

    /** One row per pending document, plus annotations for open documents or with no document. */
    rows() {
      const targets = this.targets();
      const resolved = new Map(this.anns.map((a) => [a, this.resolveTarget(a, targets)]));
      const annFor = new Map();
      for (const [ann, t] of resolved) if (t) annFor.set(t.key, ann);
      const summary = (ann, target) => {
        const m = this.mapGroups(ann, target);
        return { pagesMatched: new Set(m.assignments.map((a) => a.pageIndex)).size, unmatched: m.unmatched };
      };
      const rows = this.docs.map((d) => {
        const ann = annFor.get(d.key) || null;
        return Object.assign({ doc: d, ann, existing: false }, ann ? summary(ann, d) : { pagesMatched: 0, unmatched: 0 });
      });
      for (const [ann, t] of resolved) {
        if (t && t.existing) rows.push(Object.assign({ doc: t, ann, existing: true }, summary(ann, t)));
        else if (!t) rows.push({ doc: null, ann, existing: false, pagesMatched: 0, unmatched: ann.charCount });
      }
      return rows;
    }

    /* ---------- committing ---------- */

    /** Size of the annotation's coordinate space for one page. */
    resolveCoord(group, page, mapping) {
      // A loop, not Math.max(...list): a group can hold hundreds of thousands of records.
      let maxX = 0, maxY = 0, boxed = 0;
      for (const r of group.records) {
        if (!r.bbox) continue;
        boxed++;
        if (r.bbox[2] > maxX) maxX = r.bbox[2];
        if (r.bbox[3] > maxY) maxY = r.bbox[3];
      }
      const mode = mapping.coords || 'auto';
      const img = page.image;
      if (mode === 'normalized' || (mode === 'auto' && boxed && maxX <= 1.0001 && maxY <= 1.0001)) return { w: 1, h: 1, unit: 'normalized' };
      if (mode === 'auto' && group.width && group.height) return { w: group.width, h: group.height, unit: 'px' };
      if (img.kind === 'pdf') {
        if (mode === 'points' || (mode === 'auto' && maxX <= img.ptW * 1.02 && maxY <= img.ptH * 1.02)) return { w: img.ptW, h: img.ptH, unit: 'pt' };
        const need = 72 * Math.max(maxX / img.ptW, maxY / img.ptH);
        const dpi = DPI_STEPS.find((d) => d >= need * 0.98) || Math.ceil(need);
        return { w: img.ptW * dpi / 72, h: img.ptH * dpi / 72, unit: 'px@' + dpi + 'dpi' };
      }
      return { w: img.width, h: img.height, unit: 'px' };
    }

    annotationData(group, page, mapping) {
      const built = layout.buildPage(group.records, { idPrefix: page.id });
      return { coord: this.resolveCoord(group, page, mapping), lines: built.lines, chars: built.chars, metrics: built.metrics, hasAnnotation: true };
    }

    newDocument(pending) {
      const doc = { id: F.makeId('doc'), name: pending.name, kind: pending.kind, file: pending.kind === 'pdf' ? pending.file : null, pageIds: [], annotation: null };
      if (this.sample) doc.sample = true;
      const pages = pending.pages.map((p, i) => {
        const page = {
          id: F.makeId('pg'), docId: doc.id, name: p.name, pageNo: i + 1,
          image: pending.kind === 'pdf'
            ? { kind: 'pdf', pdfPage: p.pdfPage, width: p.width, height: p.height, ptW: p.ptW, ptH: p.ptH }
            : { kind: 'blob', blob: p.blob, width: p.width, height: p.height },
          coord: { w: p.width, h: p.height, unit: 'px' },
          lines: [], chars: [], metrics: null, hasAnnotation: false
        };
        doc.pageIds.push(page.id);
        return page;
      });
      return { doc, pages };
    }

    /** Create documents and pages in the store. Returns a summary for the user. */
    async commit() {
      const store = this.app.store;
      const rows = this.rows();
      const taken = new Set(store.documents.map((d) => d.name));
      const created = new Map(this.docs.map((d) => {
        const made = this.newDocument(d);
        made.doc.name = uniqueName(made.doc.name, taken);
        return [d.key, made];
      }));
      const replaced = []; // annotations for documents that are already open
      let annotatedPages = 0, unmatched = 0;

      for (const row of rows) {
        if (!row.ann || !row.doc || !row.ann.mapping.value) continue;
        const target = row.doc;
        const m = this.mapGroups(row.ann, target);
        unmatched += m.unmatched;
        const doc = target.existing ? store.getDocument(target.docId) : created.get(target.key).doc;
        const pages = target.existing ? target.pages : created.get(target.key).pages;
        doc.annotation = { name: row.ann.name, format: row.ann.format, mapping: Object.assign({}, row.ann.mapping) };
        for (const a of m.assignments) {
          const page = pages[a.pageIndex];
          const data = this.annotationData(a.group, page, row.ann.mapping);
          if (target.existing) replaced.push({ pageId: page.id, data });
          else Object.assign(page, data);
          annotatedPages++;
        }
      }

      if (replaced.length) store.replaceAnnotations(replaced);
      const docs = Array.from(created.values());
      if (docs.length) store.addDocuments(docs.map((x) => x.doc), [].concat(...docs.map((x) => x.pages)));
      return {
        documents: docs.length,
        pages: docs.reduce((n, x) => n + x.pages.length, 0),
        annotatedPages, unmatched,
        errors: this.errors.slice()
      };
    }
  }

  /**
   * Files and folders from a drop: { entries: [{ file, path }], unreadable: [folder names] }.
   *
   * Everything is taken from the DataTransfer straight away (it is emptied once the
   * event ends). Dropped files are read with getAsFile(), which works everywhere.
   * Folders are walked with the entry API; Chrome refuses that when the page is
   * opened directly from disk (file://), and those folders are listed in `unreadable`.
   */
  async function entriesFromDataTransfer(dt) {
    const items = Array.from(dt.items || []).filter((it) => it.kind === 'file');
    const dropped = items.length
      ? items.map((it) => ({ entry: it.webkitGetAsEntry ? it.webkitGetAsEntry() : null, file: it.getAsFile() }))
      : Array.from(dt.files || []).map((file) => ({ entry: null, file }));

    const entries = [], unreadable = [];
    const fileOf = (entry) => new Promise((res, rej) => entry.file(res, rej));
    const readBatch = (reader) => new Promise((res, rej) => reader.readEntries(res, rej));
    async function walk(dir, prefix) {
      const reader = dir.createReader();
      for (let batch = await readBatch(reader); batch.length; batch = await readBatch(reader)) {
        for (const e of batch) {
          if (e.isFile) { const file = await fileOf(e); entries.push({ file, path: prefix + file.name }); }
          else if (e.isDirectory) await walk(e, prefix + e.name + '/');
        }
      }
    }

    for (const d of dropped) {
      if (d.entry && d.entry.isDirectory) {
        try { await walk(d.entry, d.entry.name + '/'); }
        catch (err) { unreadable.push(d.entry.name); }
      } else if (d.file) {
        entries.push({ file: d.file, path: d.file.name });
      }
    }
    return { entries, unreadable };
  }

  /** Files from an <input type=file> as [{ file, path }]. */
  const entriesFromInput = (input) => Array.from(input.files || []).map((file) => ({ file, path: file.webkitRelativePath || file.name }));

  return { ImportSession, entriesFromDataTransfer, entriesFromInput, ACCEPT };
});
