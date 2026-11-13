/**
 * Third-party libraries in /vendor, loaded on first use so the app starts fast.
 * Each loader resolves to the library's API.
 */
OVS.define('util/vendor', () => {
  'use strict';

  const pending = new Map();

  function loadScript(src) {
    if (!pending.has(src)) {
      pending.set(src, new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => resolve();
        s.onerror = () => {
          pending.delete(src);
          reject(new Error('Could not load ' + src + '. Check that the vendor folder sits next to index.html.'));
        };
        document.head.appendChild(s);
      }));
    }
    return pending.get(src);
  }

  let sqlitePromise = null; // sql.js is initialised once

  return {
    /** PDF.js. The worker is also loaded as a plain script: when Web Workers are
     *  unavailable (opening the app from file://), PDF.js runs it on the page instead. */
    async pdf() {
      await loadScript('vendor/pdf.min.js');
      await loadScript('vendor/pdf.worker.min.js');
      const lib = window.pdfjsLib;
      if (!lib) throw new Error('PDF.js did not initialise.');
      if (!lib.GlobalWorkerOptions.workerSrc) lib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
      return lib;
    },
    async jszip() { await loadScript('vendor/jszip.min.js'); return window.JSZip; },
    async jspdf() { await loadScript('vendor/jspdf.umd.min.js'); return window.jspdf.jsPDF; },
    /** { parquetReadObjects, parquetMetadata, compressors, parquetWriteBuffer } */
    async parquet() { await loadScript('vendor/parquet.bundle.js'); return window.OVSParquet; },
    /** sql.js (SQLite). The WebAssembly binary comes embedded in a script, so nothing is fetched (works over file://). */
    async sqlite() {
      if (!sqlitePromise) {
        sqlitePromise = (async () => {
          await loadScript('vendor/sql-wasm.js');
          await loadScript('vendor/sql-wasm-binary.js');
          const bytes = Uint8Array.from(atob(window.OVS_SQLITE_WASM), (ch) => ch.charCodeAt(0));
          return window.initSqlJs({ wasmBinary: bytes });
        })();
        sqlitePromise.catch(() => { sqlitePromise = null; });
      }
      return sqlitePromise;
    },
    /** A Unicode monospace font for PDF export: { name, file, data (base64) } */
    async pdfFont() { await loadScript('vendor/fonts/dejavu-sans-mono.js'); return window.OVS_PDF_FONT; }
  };
});
