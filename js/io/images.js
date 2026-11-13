/**
 * Page images: probing image files, opening PDFs, rendering PDF pages, and a
 * cache of displayable images and thumbnails.
 */
OVS.define('io/images', (require) => {
  'use strict';

  const vendor = require('util/vendor');

  /** Long side, in pixels, used when rendering a PDF page for display. */
  const PDF_RENDER_LONG_SIDE = 2200;
  const THUMB_WIDTH = 224;
  /** Full-size page images kept ready; older ones are released (a rendered PDF page is ~1 MB). */
  const FULL_CACHE_SIZE = 12;

  /**
   * Release an object URL once the UI has dropped its <img> elements: revoking a URL an
   * image is about to load logs "Not allowed to load local resource" over file://.
   */
  const releaseUrl = (url) => setTimeout(() => URL.revokeObjectURL(url), 1000);

  function loadImg(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Image failed to load'));
      img.src = url;
    });
  }

  /** Decode a blob for drawing: an ImageBitmap where supported, else an <img> (its temporary URL is released). */
  /**
   * Decode an image; with `size`, straight to that size where the browser can (far less
   * memory and time than decoding a full scan to shrink it).
   */
  async function decode(blob, size) {
    if (window.createImageBitmap && size) {
      try { return await createImageBitmap(blob, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'high' }); }
      catch (e) { /* resize options unsupported: decode at full size below */ }
    }
    if (window.createImageBitmap) return createImageBitmap(blob);
    const url = URL.createObjectURL(blob);
    try { return await loadImg(url); } finally { URL.revokeObjectURL(url); }
  }

  /** Pixel size of an ImageBitmap or <img> from decode(). */
  const sizeOf = (bmp) => ({ width: bmp.width || bmp.naturalWidth, height: bmp.height || bmp.naturalHeight });

  /** Pixel size of an image file; throws a readable error when the browser cannot decode it. */
  async function probeImage(blob, name) {
    try {
      const bmp = await decode(blob);
      const size = sizeOf(bmp);
      if (bmp.close) bmp.close();
      return size;
    } catch (e) {
      throw new Error((name || 'This image') + ' cannot be displayed by this browser. Convert it to PNG or JPEG.');
    }
  }

  async function openPdf(blob) {
    const pdfjs = await vendor.pdf();
    const data = new Uint8Array(await blob.arrayBuffer());
    return pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  }

  /** Size of every page of a PDF, in points and in rendered pixels. */
  async function probePdf(blob) {
    const pdf = await openPdf(blob);
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const vp = (await pdf.getPage(i)).getViewport({ scale: 1 });
      const scale = PDF_RENDER_LONG_SIDE / Math.max(vp.width, vp.height);
      pages.push({ pdfPage: i, ptW: vp.width, ptH: vp.height, width: Math.round(vp.width * scale), height: Math.round(vp.height * scale) });
    }
    pdf.destroy();
    return pages;
  }

  /**
   * Hands out displayable page images, rendering PDF pages on demand.
   *   get(page, doc)   → Promise<{ url, img, width, height }>
   *   peek(pageId)     → the same, if already loaded, else null
   *   thumb(page, doc) → Promise<url>
   */
  class ImageService {
    constructor(bus) {
      this.bus = bus;
      this.full = new Map();
      this.ready = new Map();
      this.thumbs = new Map();
      this.pdfs = new Map();
      this.pinned = null; // the page on screen: never released
    }

    /** Keep this page's full image cached (the viewer pins the page it shows). */
    pin(pageId) { this.pinned = pageId; }

    peek(pageId) { return this.ready.get(pageId) || null; }

    /** The page's full image, loading it if needed. Recently used images stay cached (LRU). */
    get(page, doc) {
      let p = this.full.get(page.id);
      if (p) {
        this.full.delete(page.id); // move to the most recently used end
        this.full.set(page.id, p);
        return p;
      }
      p = this.load(page, doc).then((res) => {
        if (this.full.get(page.id) !== p) { releaseUrl(res.url); return res; } // released while loading
        this.ready.set(page.id, res);
        this.bus.emit('image:loaded', { pageId: page.id });
        return res;
      });
      p.catch(() => { if (this.full.get(page.id) === p) this.full.delete(page.id); });
      this.full.set(page.id, p);
      for (const id of this.full.keys()) { // least recently used first
        if (this.full.size <= FULL_CACHE_SIZE) break;
        if (id !== this.pinned && id !== page.id) this.release(id);
      }
      return p;
    }

    /** Drop a page's full image; it is loaded again when next needed. */
    release(pageId) {
      const r = this.ready.get(pageId);
      if (r) releaseUrl(r.url);
      this.ready.delete(pageId);
      this.full.delete(pageId);
    }

    async load(page, doc) {
      const blob = page.image.kind === 'pdf'
        ? await this.renderPdfPage(doc, page.image.pdfPage, page.image.width, page.image.height)
        : page.image.blob;
      const url = URL.createObjectURL(blob);
      const img = await loadImg(url);
      return { url, img, width: img.naturalWidth, height: img.naturalHeight };
    }

    pdfFor(doc) {
      if (!this.pdfs.has(doc.id)) this.pdfs.set(doc.id, openPdf(doc.file));
      return this.pdfs.get(doc.id);
    }

    async renderPdfPage(doc, pageNo, width, height, mime) {
      const pdf = await this.pdfFor(doc);
      const page = await pdf.getPage(pageNo);
      const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      page.cleanup();
      return new Promise((resolve) => canvas.toBlob(resolve, mime || 'image/jpeg', 0.92));
    }

    thumb(page, doc) {
      if (!this.thumbs.has(page.id)) this.thumbs.set(page.id, this.makeThumb(page, doc));
      return this.thumbs.get(page.id);
    }

    async makeThumb(page, doc) {
      const size = { width: THUMB_WIDTH, height: Math.round(THUMB_WIDTH * page.image.height / page.image.width) };
      const source = page.image.kind === 'pdf'
        ? await this.renderPdfPage(doc, page.image.pdfPage, size.width, size.height, 'image/png')
        : page.image.blob;
      const bmp = await decode(source, size);
      const { width: sw, height: sh } = sizeOf(bmp);
      const canvas = document.createElement('canvas');
      canvas.width = THUMB_WIDTH;
      canvas.height = Math.round(THUMB_WIDTH * sh / sw);
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      if (bmp.close) bmp.close();
      return URL.createObjectURL(await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85)));
    }

    /** The full page image drawn into a canvas (used by PDF export). */
    async canvasFor(page, doc) {
      const res = await this.get(page, doc);
      const canvas = document.createElement('canvas');
      canvas.width = res.width;
      canvas.height = res.height;
      canvas.getContext('2d').drawImage(res.img, 0, 0);
      return canvas;
    }

    forgetDocument(doc) {
      for (const id of doc.pageIds) {
        this.release(id);
        const t = this.thumbs.get(id);
        if (t) t.then(releaseUrl).catch(() => {});
        this.thumbs.delete(id);
      }
      const pdf = this.pdfs.get(doc.id);
      if (pdf) { pdf.then((p) => p.destroy()).catch(() => {}); this.pdfs.delete(doc.id); }
    }
  }

  return { ImageService, probeImage, probePdf };
});
