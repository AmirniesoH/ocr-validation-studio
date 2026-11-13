/**
 * SQLite annotation files (.sqlite, .sqlite3, .db): one database holding any
 * number of documents, with indexes, so even a whole book opens and queries fast.
 *
 *   await write(groups, threshold)  → Uint8Array   a database file (export)
 *   await read(arrayBuffer)         → [{ name, rows }]   character rows to import
 *
 * Schema written by this app (format ocr-validation-studio/2):
 *
 *   meta        key, value                         format, threshold, exported_at, application
 *   documents   id, name, kind, annotation_source
 *   pages       id, document_id, page, image, width, height, coordinate_unit
 *   characters  id, page_id, line, char_index, text, ocr_text, conf, status, review,
 *               corrected, manually_added, verified, x0, y0, x1, y1, rotated_box, bbox_source, joined
 *   annotations (view) one flat row per character with its document, page and image,
 *               the same columns as the CSV and Parquet exports
 *
 * Reading: the table or view whose columns best describe characters (value,
 * box, confidence, line), preferring this app's `annotations` view on a tie,
 * so databases from other tools work too. Rows are split by their `document`
 * column when it holds several documents, so each pairs with its own document.
 */
OVS.define('io/annotation-sqlite', (require) => {
  'use strict';

  const vendor = require('util/vendor');
  const schema = require('io/annotation-schema');
  const { FORMAT, flatRows } = require('io/annotation-format');
  const { splitByDocument } = schema;

  const EXTENSIONS = ['sqlite', 'sqlite3', 'db', 'db3'];

  const SCHEMA = `
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT, annotation_source TEXT);
    CREATE TABLE pages (
      id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES documents(id),
      page INTEGER NOT NULL, image TEXT, width REAL, height REAL, coordinate_unit TEXT);
    CREATE TABLE characters (
      id INTEGER PRIMARY KEY, page_id INTEGER NOT NULL REFERENCES pages(id),
      line INTEGER NOT NULL, char_index INTEGER NOT NULL,
      text TEXT NOT NULL, ocr_text TEXT, conf REAL,
      status TEXT, review TEXT, corrected INTEGER, manually_added INTEGER, verified INTEGER,
      x0 REAL, y0 REAL, x1 REAL, y1 REAL, rotated_box TEXT, bbox_source TEXT, joined INTEGER);
    CREATE INDEX characters_by_page ON characters (page_id, line, char_index);
    CREATE INDEX characters_by_review ON characters (review);
    CREATE INDEX pages_by_document ON pages (document_id, page);
    CREATE VIEW annotations AS
      SELECT d.name AS document, p.page, p.image, p.width AS page_width, p.height AS page_height,
             c.line, c.char_index, c.text, c.ocr_text, c.conf, c.status, c.review,
             c.corrected, c.manually_added, c.verified, c.x0, c.y0, c.x1, c.y1, c.rotated_box,
             c.bbox_source, p.coordinate_unit, c.joined
      FROM characters c JOIN pages p ON p.id = c.page_id JOIN documents d ON d.id = p.document_id
      ORDER BY d.id, p.page, c.line, c.char_index;`;

  const CHARACTER_COLUMNS = ['line', 'char_index', 'text', 'ocr_text', 'conf', 'status', 'review', 'corrected',
    'manually_added', 'verified', 'x0', 'y0', 'x1', 'y1', 'rotated_box', 'bbox_source', 'joined'];

  /** SQLite has no booleans or "empty": true/false become 1/0, empty strings NULL. */
  const sqlValue = (v) => (v === true ? 1 : v === false ? 0 : v === '' || v === undefined ? null : v);

  /* ---------- writing ---------- */

  async function write(groups, threshold) {
    const SQL = await vendor.sqlite();
    const db = new SQL.Database();
    try {
      db.exec(SCHEMA);
      db.exec('BEGIN');
      const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
      for (const [k, v] of [['format', FORMAT], ['threshold', String(threshold)], ['exported_at', new Date().toISOString()], ['application', 'OCR Validation Studio']]) meta.run([k, v]);
      meta.free();

      const insDoc = db.prepare('INSERT INTO documents (id, name, kind, annotation_source) VALUES (?, ?, ?, ?)');
      const insPage = db.prepare('INSERT INTO pages (id, document_id, page, image, width, height, coordinate_unit) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const insChar = db.prepare('INSERT INTO characters (page_id, ' + CHARACTER_COLUMNS.join(', ') + ') VALUES (?' + ', ?'.repeat(CHARACTER_COLUMNS.length) + ')');
      let pageId = 0;
      groups.forEach((g, gi) => {
        insDoc.run([gi + 1, g.doc.name, g.doc.kind, g.doc.annotation ? g.doc.annotation.name : null]);
        for (const p of g.pages) {
          pageId++;
          insPage.run([pageId, gi + 1, p.pageNo, g.doc.kind === 'pdf' ? null : p.name, p.coord.w, p.coord.h, p.coord.unit || 'px']);
          for (const r of flatRows([{ doc: g.doc, pages: [p] }], threshold)) insChar.run([pageId].concat(CHARACTER_COLUMNS.map((k) => sqlValue(r[k]))));
        }
      });
      insDoc.free(); insPage.free(); insChar.free();
      db.exec('COMMIT');
      return db.export();
    } finally {
      db.close();
    }
  }

  /* ---------- reading ---------- */

  const quote = (name) => '"' + String(name).replace(/"/g, '""') + '"';

  /** Rows of a table or view as plain objects. */
  function selectAll(db, name, limit) {
    const res = db.exec('SELECT * FROM ' + quote(name) + (limit ? ' LIMIT ' + limit : ''));
    if (!res.length) return [];
    const { columns, values } = res[0];
    return values.map((v) => { const o = {}; columns.forEach((c, i) => { o[c] = v[i]; }); return o; });
  }

  /** How well a table describes characters, from the fields detected in a sample of its rows. */
  function score(rows) {
    if (!rows.length) return 0;
    const m = schema.detectMapping(rows);
    if (!m.value) return 0;
    return 3 + (m.bbox || m.cols ? 2 : 0) + (m.conf ? 1 : 0) + (m.line ? 1 : 0) + Math.min(1, rows.length / 50);
  }

  const unreadable = (e) => new Error('This file is not a readable SQLite database (' + e.message + ').');

  /** Tables and views to consider; the app's own `annotations` view first. */
  function listObjects(db) {
    let res;
    // sql.js opens any bytes lazily; the first query is where a non-database fails.
    try { res = db.exec("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'"); }
    catch (e) { throw unreadable(e); }
    const names = (res[0] || { values: [] }).values.map((v) => v[0]);
    return names.sort((a, b) => (b.toLowerCase() === 'annotations') - (a.toLowerCase() === 'annotations'));
  }

  async function read(buffer) {
    const SQL = await vendor.sqlite();
    let db;
    try { db = new SQL.Database(new Uint8Array(buffer)); }
    catch (e) { throw unreadable(e); }
    try {
      const objects = listObjects(db);
      if (!objects.length) throw new Error('The database has no tables.');
      // Score every table, even one called "annotations": another tool's table of that
      // name may hold something else. The app's own view wins ties by coming first.
      let source = null, best = 0;
      for (const name of objects) {
        let s = 0;
        try { s = score(selectAll(db, name, 200)); } catch (e) { /* a broken view: skip it */ }
        if (s > best) { best = s; source = name; }
      }
      if (!source) throw new Error('No table with character records was found (a character value plus a box or confidence).');
      return splitByDocument(selectAll(db, source));
    } finally {
      db.close();
    }
  }

  return { write, read, EXTENSIONS };
});
