/**
 * Sample documents. Renders typewritten scans on a canvas, takes exact
 * character boxes from the font metrics, adds typical OCR mistakes and missed
 * characters, then imports everything through the normal import pipeline in
 * three annotation shapes:
 *
 *   harrow-finch_correspondence/ (folder, 2 pages) + nested JSON in this app's format
 *   customs_entry_C105.png                         + flat JSON array, [x, y, w, h] boxes, confidence 0–100
 *   warehouse_ledger_p014.jpg                      + Parquet table with x0/y0/x1/y1 columns
 *
 * Every page is raw OCR output that nobody has reviewed yet, so the samples
 * always open exactly as on first use.
 *
 * Each page also has a word or two of faded type, as from a dry typewriter ribbon:
 * the whole word struck lightly, or the print fading out across the word. The OCR
 * misreads some of those characters with very low confidence (below 0.3) and reads
 * the rest correctly but unsure (0.3–0.6), so the low end of the confidence range
 * is represented too.
 *
 * Three pages also carry a stamp or seal whose text is not horizontal: a tilted
 * rubber stamp (page 1), a steeper one (page 2) and a round seal with curved text
 * (page 3). Their characters are annotated with four-corner polygons, as OCR
 * engines that read rotated text report them.
 */
OVS.define('io/sample', (require) => {
  'use strict';

  const vendor = require('util/vendor');
  const { round } = require('util/format');
  const { boundsOf } = require('model/geometry');
  const { nextFrame } = require('util/async');
  const { ImportSession } = require('io/importer');
  const { FORMAT } = require('io/annotation-format');

  const SCALE = 2;              // pages are laid out on an 850 × 1100 grid and rendered at 2×
  const W = 850, H = 1100;
  const FONT = '"Courier Prime", "Courier New", Courier, monospace';
  const INK = '#29251F';

  const ledgerRow = (a, b, c, d) => a.padEnd(9) + b.padEnd(9) + c.padEnd(22) + d.padStart(7);

  /**
   * Page definitions.
   *   lines:      [text, x, y, fontSize, bold?]
   *   errors:     [line, word, offset in word, OCR reading, confidence]
   *   missed:     [line, word, offset in word]       characters the OCR did not detect
   *   faded:      words in faded type, see FADED below
   *   stamps:     stamps and seals, see STAMP below
   */
  const PAGES = [
    {
      file: 'harrow-finch_p1.jpg', kind: 'letter', seed: 11,
      lines: [
        ['HARROW & FINCH SHIPPING CO.', 214, 64, 26, true],
        ['14 Wharf Street, Bristol 1.  Telephone: Bristol 22714', 234, 110, 12],
        ['12th March, 1958', 490, 176, 16],
        ['The Collector of Customs,', 96, 236, 16],
        ['H.M. Customs House,', 96, 260, 16],
        ['Queen Square, Bristol.', 96, 284, 16],
        ['Dear Sir,', 96, 332, 16],
        ['Re: Consignment No. 4471/B, ex S.S. "Calder Vale"', 144, 380, 16],
        ['We beg to advise that the above consignment of 312 bales', 144, 428, 16],
        ['of raw wool, landed at Avonmouth Dock on the 9th inst.,', 96, 452, 16],
        ['has been held pending examination of the accompanying', 96, 476, 16],
        ['certificates of origin. We enclose herewith copies of', 96, 500, 16],
        ['the invoices numbered 1187 to 1193 inclusive, together', 96, 524, 16],
        ['with the weight notes signed by the Dock Superintendent.', 96, 548, 16],
        ['We should be obliged if you would arrange for the goods', 144, 596, 16],
        ['to be released at your earliest convenience, as our', 96, 620, 16],
        ['clients in Bradford require delivery before the 20th.', 96, 644, 16],
        ['Yours faithfully,', 420, 692, 16],
        ['for HARROW & FINCH SHIPPING CO.', 420, 716, 16],
        ['J. W. Pemberton,', 420, 820, 16],
        ['Shipping Manager.', 420, 844, 16],
        ['Encl. 5', 96, 916, 16],
        ['JWP/MR', 96, 940, 16]
      ],
      errors: [[0, 'CO.', 1, '0', 0.48], [1, 'Bristol 1', 8, 'l', 0.52], [1, 'Telephone', 0, 'T', 0.69], [2, '1958', 2, 'S', 0.39],
        [7, '4471', 1, '4', 0.61], [7, 'Calder', 3, '1', 0.44], [8, 'bales', 0, 'h', 0.57], [9, 'inst.,', 4, '.', 0.58],
        [10, 'accompanying', 4, 'm', 0.66], [11, 'herewith', 5, 'w', 0.71], [12, '1187', 0, 'I', 0.46], [12, '1193', 3, '8', 0.53],
        [13, 'Superintendent', 9, 'u', 0.42], [14, 'obliged', 4, 'g', 0.66], [15, 'convenience', 9, 'e', 0.5], [16, 'Bradford', 0, '8', 0.37],
        [16, '20th', 1, 'O', 0.45], [17, 'faithfully', 0, 't', 0.55], [19, 'Pemberton', 1, 'c', 0.49], [20, 'Manager.', 7, ',', 0.47], [22, 'JWP', 1, 'V', 0.52]],
      missed: [[11, 'certificates', 6], [1, 'Wharf', 2]],
      faded: [
        { line: 14, word: 'arrange', misreads: [[1, 'n', 0.21], [3, 'o', 0.26], [5, 'q', 0.14]] },
        // The ribbon running dry at the end of the line: darker on the left, almost gone on the right.
        { line: 10, word: 'accompanying', fade: [0.1, 0.86], misreads: [[9, 'l', 0.24], [10, 'r', 0.12], [11, 'q', 0.09]] }
      ],
      stamps: [{
        kind: 'rect', x: 660, y: 276, angle: -0.12, w: 200, h: 76, color: 'rgba(170,32,52,0.72)',
        lines: [
          { text: 'H.M. CUSTOMS · BRISTOL', y: -18, size: 12, errors: [[17, '1', 0.48]] },
          { text: 'R E C E I V E D', y: 8, size: 22 },
          { text: '13 MAR 1958', y: 28, size: 13, errors: [[9, 'S', 0.55]] }
        ]
      }]
    },
    {
      file: 'harrow-finch_p2.jpg', kind: 'list', seed: 23,
      lines: [
        ['SCHEDULE OF ENCLOSURES', 320, 120, 16, true],
        ['Ref. Consignment No. 4471/B', 296, 150, 16],
        ['1.  Invoices Nos. 1187 - 1193 (seven copies)', 96, 222, 16],
        ['2.  Certificates of Origin, Nos. A 20416, A 20417', 96, 254, 16],
        ['3.  Weight Notes, Avonmouth Dock, 9th March, 1958', 96, 286, 16],
        ['4.  Bill of Lading No. 88/312, S.S. "Calder Vale"', 96, 318, 16],
        ["5.  Insurance Certificate, Lloyd's Policy 77104", 96, 350, 16],
        ['Total gross weight:     94 tons 6 cwt. 2 qrs.', 96, 422, 16],
        ['Total bales:            312', 96, 454, 16],
        ['J.W.P./M.R.', 96, 540, 16]
      ],
      errors: [[0, 'ENCLOSURES', 4, '0', 0.51], [3, '20416', 2, 'A', 0.44], [6, "Lloyd's", 5, '`', 0.58]],
      missed: [],
      faded: [
        { line: 4, word: 'Avonmouth', misreads: [[1, 'y', 0.24], [3, 'r', 0.17], [6, 'n', 0.28]] }
      ],
      stamps: [{
        kind: 'rect', x: 590, y: 650, angle: 0.3, w: 250, h: 68, color: 'rgba(48,66,148,0.78)',
        lines: [
          { text: 'CERTIFIED TRUE COPY', y: -2, size: 17, errors: [[16, '0', 0.5]] },
          { text: 'HARROW & FINCH · 12 MAR 1958', y: 20, size: 11, errors: [[7, '8', 0.46]] }
        ]
      }]
    },
    {
      file: 'customs_entry_C105.png', kind: 'form', seed: 37,
      lines: [
        ['H.M. CUSTOMS AND EXCISE', 287, 78, 20, true],
        ['ENTRY FOR GOODS ON IMPORT (C.105)', 286, 112, 14],
        ['Port: Bristol            Entry No. 2093', 80, 186, 15],
        ['Importer: Harrow & Finch Shipping Co., Bristol', 80, 228, 15],
        ['Vessel: S.S. Calder Vale     Arrived: 9.3.58', 80, 270, 15],
        ['Marks & Nos.   Description          Quantity', 80, 326, 15, true],
        ['H&F 1-312      Raw wool, greasy     312 bales', 80, 368, 15],
        ['Nett weight          94t 6c 2q', 215, 404, 15],
        ['Country of origin:  New Zealand', 80, 462, 15],
        ['Value declared:  £18,406  10s.  0d.', 80, 504, 15],
        ['Examined by: R. T. Hollis', 80, 562, 15],
        ['Date: 13.3.58', 80, 604, 15]
      ],
      // "Bristol" on line 4 is misread with high confidence: accepted by the threshold, but still wrong.
      errors: [[2, '2093', 0, 'Z', 0.43], [3, 'Bristol', 5, '1', 0.83], [6, 'greasy', 2, 'c', 0.54], [7, '94t', 0, '9', 0.62], [8, 'Zealand', 0, '2', 0.41],
        [9, '£', 0, 'E', 0.33], [9, '10s.', 2, '5', 0.48], [10, 'Hollis', 3, '1', 0.46]],
      missed: [[7, 'weight', 3]],
      faded: [
        { line: 9, word: '18,406', misreads: [[1, 'B', 0.18], [2, '.', 0.07], [3, 'A', 0.22]] }
      ],
      stamps: [{
        kind: 'seal', x: 640, y: 800, outer: 70, inner: 50, color: 'rgba(98,52,140,0.76)', size: 10.5,
        top: { text: 'H.M. CUSTOMS & EXCISE', errors: [[16, 'K', 0.45]] },
        bottom: { text: 'PORT OF BRISTOL', errors: [[11, '5', 0.5]] },
        lines: [
          { text: 'EXAMINED', y: -2, size: 13, angle: -0.1, errors: [[5, 'H', 0.53]] },
          { text: '13 MAR 1958', y: 16, size: 10, angle: -0.1 }
        ]
      }]
    },
    {
      file: 'warehouse_ledger_p014.jpg', kind: 'ledger', seed: 53,
      lines: [
        ['WAREHOUSE No. 3  -  RECEIVING LEDGER', 230, 84, 18, true],
        [ledgerRow('Date', 'Lot', 'Description', 'Bales'), 70, 160, 14, true],
        [ledgerRow('9 Mar', '4471/B', 'Raw wool (N.Z.)', '312'), 70, 204, 14],
        [ledgerRow('10 Mar', '4480/A', 'Jute bagging', '120'), 70, 240, 14],
        [ledgerRow('10 Mar', '4483/C', 'Tallow, casks', '48'), 70, 276, 14],
        [ledgerRow('11 Mar', '4491/A', 'Hides, salted', '206'), 70, 312, 14],
        [ledgerRow('11 Mar', '4502/B', 'Copra', '95'), 70, 348, 14],
        [ledgerRow('12 Mar', '4507/A', 'Raw wool (Aust.)', '188'), 70, 384, 14],
        [ledgerRow('12 Mar', '4511/D', 'Sisal fibre', '64'), 70, 420, 14],
        ['Carried forward:'.padEnd(40) + '1033'.padStart(7), 70, 480, 14]
      ],
      errors: [[2, '4471/B', 5, '8', 0.44], [3, 'Jute', 1, 'v', 0.51], [4, 'Tallow', 3, '1', 0.47], [5, 'salted', 4, 'c', 0.56],
        [6, 'Copra', 0, 'C', 0.64], [7, '(Aust.)', 5, ',', 0.49], [8, 'Sisal', 2, '5', 0.4], [9, '1033', 1, 'O', 0.45]],
      missed: [],
      faded: [
        { line: 3, word: 'bagging', fade: [0.15, 0.8], misreads: [[4, 'l', 0.27], [6, 'q', 0.16]] },
        { line: 8, word: '64', misreads: [[0, 'G', 0.19], [1, 'A', 0.08]] }
      ]
    }
  ];

  function rng(seed) { let s = seed >>> 0 || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

  /* ---------- drawing the scans ---------- */

  function paper(ctx, rand) {
    ctx.fillStyle = '#F2EDE1';
    ctx.fillRect(0, 0, W, H);
    const glow = ctx.createRadialGradient(150, 90, 10, 150, 90, 700);
    glow.addColorStop(0, 'rgba(255,255,255,0.5)'); glow.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
    const age = ctx.createRadialGradient(760, 1060, 20, 760, 1060, 650);
    age.addColorStop(0, 'rgba(140,108,58,0.18)'); age.addColorStop(1, 'rgba(140,108,58,0)');
    ctx.fillStyle = age; ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 6; i++) {
      const x = rand() * W, y = rand() * H, r = 6 + rand() * 18;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(150,110,60,0.09)'); g.addColorStop(1, 'rgba(150,110,60,0)');
      ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }

  const rule = (ctx, x, y, w, h, color) => { ctx.fillStyle = color; ctx.fillRect(x, y, w, h); };

  const DECORATIONS = {
    letter(ctx) {
      rule(ctx, 96, 146, 658, 1.4, 'rgba(40,36,30,0.78)');
      for (const y of [366, 732]) {
        const g = ctx.createLinearGradient(0, y - 5, 0, y + 5);
        g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.45, 'rgba(90,70,40,0.08)'); g.addColorStop(0.6, 'rgba(255,255,255,0.45)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g; ctx.fillRect(0, y - 5, W, 10);
      }
      ctx.fillStyle = '#47443F';
      for (const y of [278, 822]) { ctx.beginPath(); ctx.arc(36, y, 10, 0, Math.PI * 2); ctx.fill(); }
      ctx.save();
      ctx.translate(418, 748);
      ctx.strokeStyle = 'rgba(31,42,68,0.85)'; ctx.lineWidth = 1.7; ctx.lineCap = 'round';
      ctx.stroke(new Path2D('M8 46 C 20 10, 34 6, 31 30 S 24 58, 42 41 S 64 12, 69 29 S 76 48, 89 35 S 104 17, 113 30 S 122 46, 136 31 C 145 22, 154 24, 160 33 S 175 42, 193 22 M 44 54 C 86 49, 140 47, 214 42'));
      ctx.restore();
    },
    list(ctx) { rule(ctx, 320, 142, 211, 1.2, 'rgba(40,36,30,0.6)'); },
    form(ctx) {
      const ink = 'rgba(40,36,30,0.78)', thin = 'rgba(40,36,30,0.5)';
      rule(ctx, 56, 140, 738, 2.2, ink);
      rule(ctx, 56, 168, 738, 1.6, ink); rule(ctx, 56, 646, 738, 1.6, ink); rule(ctx, 56, 168, 1.6, 480, ink); rule(ctx, 792, 168, 1.6, 480, ink);
      for (const y of [218, 260, 304, 446, 492, 550, 592]) rule(ctx, 56, y, 738, 1, thin);
      rule(ctx, 207, 304, 1, 142, thin); rule(ctx, 396, 304, 1, 142, thin);
    },
    ledger(ctx) {
      rule(ctx, 58, 0, 1.2, H, 'rgba(196,72,72,0.55)'); rule(ctx, 62, 0, 1.2, H, 'rgba(196,72,72,0.4)');
      rule(ctx, 60, 190, 740, 1.6, 'rgba(40,36,30,0.7)');
      for (const y of [232, 268, 304, 340, 376, 412, 448]) rule(ctx, 60, y, 740, 1, 'rgba(70,110,170,0.45)');
      rule(ctx, 60, 468, 740, 1.2, 'rgba(40,36,30,0.6)'); rule(ctx, 60, 471, 740, 1.2, 'rgba(40,36,30,0.6)');
      for (const x of [141, 216, 401]) rule(ctx, x, 150, 1, 318, 'rgba(70,110,170,0.4)');
    }
  };

  /* ---------- faded type ---------- */

  /**
   * FADED  { line, word, from?, to?, fade?, misreads: [[offset in word, OCR reading, confidence]] }
   *   Type struck with a dry ribbon: light, with broken strokes. `fade` is how much ink is
   *   lost, [at the word's start, at its end]: [0.68, 0.68] (the default) fades the whole
   *   word evenly, [0.1, 0.86] fades it out from left to right. `from` / `to` (offsets in
   *   the word, inclusive) limit it to part of the word.
   */
  const DEFAULT_FADE = [0.68, 0.68];

  /** Glyph keys ("line:index") a faded spec covers. */
  function fadedKeys(def, f) {
    const start = def.lines[f.line][0].indexOf(f.word);
    const from = f.from || 0, to = f.to != null ? f.to : f.word.length - 1;
    const keys = [];
    for (let o = from; o <= to; o++) if (f.word[o] !== ' ') keys.push(f.line + ':' + (start + o));
    return keys;
  }

  /** The faded area in page units (the union of its glyph boxes), or null. */
  function fadedBox(def, f, glyphs) {
    const keys = new Set(fadedKeys(def, f));
    const boxes = glyphs.filter((g) => keys.has(g.line + ':' + g.ci)).map((g) => g.bbox.map((v) => v / SCALE));
    if (!boxes.length) return null;
    return [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
  }

  /** Lift ink off the faded words, before the ink layer is laid on the paper. */
  function fadeInk(ictx, def, glyphs, rand) {
    for (const f of def.faded || []) {
      const b = fadedBox(def, f, glyphs);
      if (!b) continue;
      const [a0, a1] = f.fade || DEFAULT_FADE;
      const w = b[2] - b[0], h = b[3] - b[1];
      ictx.save();
      ictx.globalCompositeOperation = 'destination-out';
      const g = ictx.createLinearGradient(b[0], 0, b[2], 0);
      g.addColorStop(0, 'rgba(0,0,0,' + a0 + ')'); g.addColorStop(1, 'rgba(0,0,0,' + a1 + ')');
      ictx.fillStyle = g;
      ictx.fillRect(b[0] - 1, b[1] - 1, w + 2, h + 2);
      // Broken strokes, more of them where the ribbon is drier.
      ictx.fillStyle = '#000';
      for (let i = 0; i < w * 0.9; i++) {
        const t = rand();
        if (rand() > 0.25 + (a0 + (a1 - a0) * t)) continue;
        ictx.fillRect(b[0] + t * w, b[1] + rand() * h, 0.8 + rand() * 1.6, 0.6 + rand() * 1.2);
      }
      ictx.restore();
    }
  }

  /* ---------- stamps and seals: text at an angle or along a curve ---------- */

  /**
   * STAMP
   *   rect  { kind: 'rect', x, y, angle, w, h, color, lines: [{ text, y, size, errors? }] }
   *         a framed rubber stamp centred on (x, y), turned by angle (radians, clockwise)
   *   seal  { kind: 'seal', x, y, outer, inner, color, size, top: { text, errors? }, bottom: { text, errors? },
   *           lines: [{ text, y, size, angle?, errors? }] }
   *         a round seal: `top` follows the upper arc, `bottom` the lower arc (both read
   *         left to right), `lines` sit in the middle
   *   errors: [index in text, OCR reading, confidence]
   */


  /** Draw one character with its baseline-left at (x, y) in the current transform; returns its four corners in image px. */
  function stampGlyph(ctx, ch, x, y) {
    ctx.fillText(ch, x, y);
    const m = ctx.measureText(ch), pad = 0.8, t = ctx.getTransform();
    const l = x - m.actualBoundingBoxLeft - pad, r = x + m.actualBoundingBoxRight + pad;
    const top = y - m.actualBoundingBoxAscent - pad, bottom = y + m.actualBoundingBoxDescent + pad;
    return [[l, top], [r, top], [r, bottom], [l, bottom]].map(([px, py]) => { const q = t.transformPoint({ x: px, y: py }); return [round(q.x, 1), round(q.y, 1)]; });
  }

  /** Draw a stamp; returns its glyphs { line, ci, ch, bbox, poly, err } with line numbers from `firstLine`. */
  function drawStamp(ctx, st, firstLine) {
    const glyphs = [];
    const add = (line, ci, ch, poly, errors) => {
      const err = (errors || []).find((e) => e[0] === ci);
      glyphs.push({ line, ci, ch, poly, bbox: boundsOf(poly), err: err ? { ocr: err[1], conf: err[2] } : null });
    };
    const straight = (spec, line) => {          // a line centred on the current origin
      ctx.font = '700 ' + spec.size + 'px ' + FONT;
      const adv = ctx.measureText('M').width;
      ctx.save();
      if (spec.angle) ctx.rotate(spec.angle);
      Array.from(spec.text).forEach((ch, ci) => {
        if (ch !== ' ') add(line, ci, ch, stampGlyph(ctx, ch, -spec.text.length * adv / 2 + ci * adv, spec.y), spec.errors);
      });
      ctx.restore();
    };
    const arc = (spec, line, radius, upper, size) => {
      ctx.font = '700 ' + size + 'px ' + FONT;
      const adv = ctx.measureText('M').width, step = adv / radius, chars = Array.from(spec.text);
      chars.forEach((ch, ci) => {
        const phi = (ci - (chars.length - 1) / 2) * step;
        if (ch === ' ') return;
        ctx.save();
        // Upper arc: letters stand on the circle, tops outwards. Lower arc: tops towards the centre.
        if (upper) { ctx.rotate(phi); ctx.translate(0, -radius); } else { ctx.rotate(-phi); ctx.translate(0, radius); }
        add(line, ci, ch, stampGlyph(ctx, ch, -adv / 2, 0), spec.errors);
        ctx.restore();
      });
    };

    ctx.save();
    ctx.translate(st.x, st.y);
    ctx.strokeStyle = ctx.fillStyle = st.color;
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    let line = firstLine;
    if (st.kind === 'rect') {
      ctx.rotate(st.angle);
      ctx.lineWidth = 2.5;
      ctx.strokeRect(-st.w / 2, -st.h / 2, st.w, st.h);
      for (const spec of st.lines) straight(spec, line++);
    } else {
      ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.arc(0, 0, st.outer, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(0, 0, st.inner, 0, Math.PI * 2); ctx.stroke();
      arc(st.top, line++, st.inner + 5, true, st.size);
      arc(st.bottom, line++, st.outer - 5, false, st.size);
      for (const spec of st.lines) straight(spec, line++);
    }
    ctx.restore();
    return glyphs;
  }

  /** Type the lines; returns each glyph's ink box in image pixels. */
  function typeLines(ctx, def, rand) {
    const glyphs = [];
    def.lines.forEach(([text, x, y, size, bold], li) => {
      ctx.font = (bold ? '700 ' : '400 ') + size + 'px ' + FONT;
      const advance = ctx.measureText('M').width;
      const baseline = y + size * 1.05;
      for (let ci = 0; ci < text.length; ci++) {
        const ch = text[ci];
        if (ch === ' ') continue;
        const gx = x + ci * advance + (rand() - 0.5) * 0.5;
        const gy = baseline + (rand() - 0.5) * 0.6;
        ctx.globalAlpha = 0.8 + rand() * 0.18;
        ctx.fillText(ch, gx, gy);
        const m = ctx.measureText(ch);
        const pad = 0.8;
        const box = [gx - m.actualBoundingBoxLeft - pad, gy - m.actualBoundingBoxAscent - pad, gx + m.actualBoundingBoxRight + pad, gy + m.actualBoundingBoxDescent + pad];
        glyphs.push({ line: li, ci, ch, bbox: box.map((v) => round(v * SCALE, 1)) });
      }
    });
    ctx.globalAlpha = 1;
    return glyphs;
  }

  async function renderPage(def) {
    const rand = rng(def.seed);
    const canvas = document.createElement('canvas');
    canvas.width = W * SCALE; canvas.height = H * SCALE;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
    paper(ctx, rand);
    DECORATIONS[def.kind](ctx);

    // Ink on its own layer, softened like a scan.
    const ink = document.createElement('canvas');
    ink.width = canvas.width; ink.height = canvas.height;
    const ictx = ink.getContext('2d');
    ictx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
    ictx.fillStyle = INK;
    const glyphs = typeLines(ictx, def, rand);
    fadeInk(ictx, def, glyphs, rand);
    // Stamps on the paper layer, scaled like the page; their lines follow the typed ones.
    ctx.save();
    ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
    let next = def.lines.length;
    for (const st of def.stamps || []) {
      const g = drawStamp(ctx, st, next);
      glyphs.push(...g);
      next = g.reduce((n, x) => Math.max(n, x.line + 1), next);
    }
    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = 'blur(0.45px)';
    ctx.drawImage(ink, 0, 0);
    ctx.filter = 'none';

    // Scanner grain.
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (rand() - 0.5) * 18;
      img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n * 0.9;
    }
    ctx.putImageData(img, 0, 0);

    const type = def.file.endsWith('.png') ? 'image/png' : 'image/jpeg';
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.9));
    return { blob, glyphs, width: canvas.width, height: canvas.height };
  }

  /* ---------- simulated OCR output ---------- */

  /** One record per glyph the OCR "found": its reading and confidence, nothing reviewed. */
  function ocrRecords(def, glyphs) {
    const rand = rng(def.seed * 7919);
    const at = (li, word, off) => li + ':' + (def.lines[li][0].indexOf(word) + off);
    const errors = new Map(def.errors.map(([li, word, off, ocr, conf]) => [at(li, word, off), { ocr, conf }]));
    // Faded type: misreads with very low confidence; the rest of the word read right, but unsure.
    const faded = new Set();
    for (const f of def.faded || []) {
      fadedKeys(def, f).forEach((k) => faded.add(k));
      for (const [off, ocr, conf] of f.misreads) errors.set(at(f.line, f.word, off), { ocr, conf });
    }
    const missed = new Set(def.missed.map(([li, word, off]) => at(li, word, off)));
    const out = [];
    for (const g of glyphs) {
      const key = g.line + ':' + g.ci;
      if (missed.has(key)) continue; // left for the user to add
      const err = g.err || errors.get(key);
      const text = err ? err.ocr : g.ch;
      // Stamp ink at an angle is harder to read, so it gets lower confidence more often.
      const conf = err ? err.conf : faded.has(key) ? 0.3 + rand() * 0.3 : g.poly
        ? (rand() < 0.35 ? 0.5 + rand() * 0.25 : 0.78 + rand() * 0.16)
        : (rand() < 0.06 ? 0.6 + rand() * 0.26 : 0.885 + rand() * 0.114);
      out.push({ g, text, conf: Math.round(conf * 1000) / 1000 });
    }
    return out;
  }

  /** Line numbers present in the records, in order (typed lines, then stamp lines). */
  const lineNumbers = (recs) => Array.from(new Set(recs.map((x) => x.g.line))).sort((a, b) => a - b);

  /** This app's nested format, as an OCR engine would deliver it (no review fields). */
  function nestedJson(defs, rendered) {
    return {
      format: FORMAT,
      document: 'harrow-finch_correspondence',
      pages: defs.map((def, pi) => {
        const recs = ocrRecords(def, rendered[pi].glyphs);
        return {
          page: pi + 1, image: def.file, width: rendered[pi].width, height: rendered[pi].height,
          lines: lineNumbers(recs).map((li) => ({
            id: li + 1,
            characters: recs.filter((x) => x.g.line === li).map((x, i) => Object.assign(
              { index: i, text: x.text, bbox: x.g.bbox, conf: x.conf },
              x.g.poly ? { polygon: x.g.poly } : null))
          }))
        };
      })
    };
  }

  /** A generic flat OCR dump: [x, y, w, h] boxes, confidence in percent, a polygon for rotated text. */
  function flatJson(def, rendered) {
    return ocrRecords(def, rendered.glyphs).map((x, i) => Object.assign({
      char: x.text,
      box: [x.g.bbox[0], x.g.bbox[1], round(x.g.bbox[2] - x.g.bbox[0], 1), round(x.g.bbox[3] - x.g.bbox[1], 1)],
      confidence: Math.round(x.conf * 1000) / 10,
      line_id: x.g.line,
      idx: i
    }, x.g.poly ? { polygon: x.g.poly } : null));
  }

  async function parquetTable(def, rendered) {
    const pq = await vendor.parquet();
    const recs = ocrRecords(def, rendered.glyphs);
    const col = (name, type, fn) => ({ name, type, data: recs.map(fn) });
    return new Blob([pq.parquetWriteBuffer({
      columnData: [
        col('page', 'INT32', () => 1), col('line', 'INT32', (x) => x.g.line), col('char_index', 'INT32', (x) => x.g.ci),
        col('text', 'STRING', (x) => x.text), col('conf', 'DOUBLE', (x) => x.conf),
        col('x0', 'DOUBLE', (x) => x.g.bbox[0]), col('y0', 'DOUBLE', (x) => x.g.bbox[1]), col('x1', 'DOUBLE', (x) => x.g.bbox[2]), col('y1', 'DOUBLE', (x) => x.g.bbox[3])
      ]
    })]);
  }

  /** Names of the sample documents; sessions saved before samples were marked can be recognised by them. */
  const DOCUMENT_NAMES = new Set(['harrow-finch_correspondence', ...PAGES.slice(2).map((p) => p.file)]);

  /** A generated sample document (marked as such, or from an older saved session). */
  const isSampleDocument = (doc) => !!doc.sample || DOCUMENT_NAMES.has(doc.name);

  /**
   * Generate the sample files: [{ file, path? }], the page images with their raw OCR
   * annotations in three formats (nested JSON, flat JSON, Parquet).
   */
  async function files() {
    try { await Promise.all([document.fonts.load('400 16px "Courier Prime"'), document.fonts.load('700 16px "Courier Prime"')]); } catch (e) { /* falls back to Courier New */ }
    const rendered = [];
    for (const def of PAGES) { rendered.push(await renderPage(def)); await nextFrame(); }
    const file = (parts, name, type) => new File(parts, name, { type: type || '' });
    const folder = 'harrow-finch_correspondence/';
    return [
      { file: file([rendered[0].blob], PAGES[0].file, 'image/jpeg'), path: folder + PAGES[0].file },
      { file: file([rendered[1].blob], PAGES[1].file, 'image/jpeg'), path: folder + PAGES[1].file },
      { file: file([JSON.stringify(nestedJson(PAGES.slice(0, 2), rendered.slice(0, 2)))], 'harrow-finch_correspondence.json', 'application/json') },
      { file: file([rendered[2].blob], PAGES[2].file, 'image/png') },
      { file: file([JSON.stringify(flatJson(PAGES[2], rendered[2]))], 'customs_entry_C105.json', 'application/json') },
      { file: file([rendered[3].blob], PAGES[3].file, 'image/jpeg') },
      { file: file([await parquetTable(PAGES[3], rendered[3])], 'warehouse_ledger_p014.parquet') }
    ];
  }

  /**
   * Import the sample files as sample documents, which are never auto-saved:
   * every visit starts from the same fresh pages.
   */
  async function load(app) {
    const session = new ImportSession(app, { sample: true });
    await session.add(await files());
    const result = await session.commit();
    if (result.errors.length) throw new Error(result.errors.map((e) => e.name + ': ' + e.message).join('; '));
    return result;
  }

  return { files, load, isSampleDocument };
});
