/**
 * Character geometry, including rotated text (stamps, seals, skewed lines).
 *
 * Every boxed character has an upright `bbox` [x0, y0, x1, y1]. A character
 * that is not horizontal also has a `poly`: its four corners in reading
 * orientation, [top-left, top-right, bottom-right, bottom-left] as [x, y]
 * pairs, in the same coordinate space as the bbox (which is the poly's bounds).
 * Code that only needs a rough position can keep using bbox; drawing, hit
 * testing, the magnifier and exports use the quad.
 *
 * Angles are in degrees, clockwise on screen (y grows downwards), so text
 * rising to the right has a negative angle.
 */
OVS.define('model/geometry', () => {
  'use strict';

  /** Below this angle (degrees) a polygon is treated as an ordinary upright box. */
  const MIN_ANGLE = 0.5;

  const rectQuad = (b) => [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];

  /** The character's corners: its poly if rotated, else its bbox as a quad; null without a box. */
  const quadOf = (c) => c.poly || (c.bbox ? rectQuad(c.bbox) : null);

  function boundsOf(quad) {
    const xs = quad.map((p) => p[0]), ys = quad.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }

  /** Angle of the quad's top edge, in degrees. */
  const angleOf = (q) => Math.atan2(q[1][1] - q[0][1], q[1][0] - q[0][0]) * 180 / Math.PI;

  /** Centre, width along the text, height across it, and angle (radians). */
  function frameOf(q) {
    return {
      cx: (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4,
      cy: (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4,
      w: Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]),
      h: Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]),
      angle: Math.atan2(q[1][1] - q[0][1], q[1][0] - q[0][0])
    };
  }

  /** Whether the point lies inside the (convex) quad. */
  function contains(q, x, y) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4];
      const cross = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
      if (cross !== 0) {
        if (sign && Math.sign(cross) !== sign) return false;
        sign = Math.sign(cross);
      }
    }
    return true;
  }

  /**
   * A rotated quad from polygon input ([[x, y] × 4] or [x, y, … × 8], or the same
   * as a JSON string). Null for anything else, and for upright rectangles, which
   * the bbox already describes.
   */
  function toQuad(raw) {
    let v = raw;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { return null; } }
    if (!Array.isArray(v)) return null;
    const n = (x) => (x == null || x === '' ? NaN : +x);   // a missing coordinate is not 0
    let q = null;
    if (v.length === 4 && v.every((p) => Array.isArray(p) && p.length >= 2)) q = v.map((p) => [n(p[0]), n(p[1])]);
    else if (v.length === 4 && v.every((p) => p && typeof p === 'object' && 'x' in p)) q = v.map((p) => [n(p.x), n(p.y)]);
    else if (v.length === 8 && v.every((x) => typeof x === 'number' || typeof x === 'string')) q = [0, 2, 4, 6].map((i) => [n(v[i]), n(v[i + 1])]);
    if (!q || q.some((p) => !isFinite(p[0]) || !isFinite(p[1]))) return null;
    return Math.abs(angleOf(q)) < MIN_ANGLE ? null : q.map((p) => p.map((n) => Math.round(n * 100) / 100));
  }

  /**
   * A character's quad from four corner points given in any order (clicked by the user).
   * The points are put in order around their centre, then the corner to start from is
   * chosen so the text direction is as close as possible to `refAngle` (degrees): the
   * angle of the neighbouring characters, or 0 for "as upright as possible".
   * @returns {Array|null}  [top-left, top-right, bottom-right, bottom-left], or null when
   *                        the points do not span an area (three in a line, repeated points)
   */
  function quadFromPoints(points, refAngle) {
    if (!points || points.length !== 4) return null;
    const cx = points.reduce((t, p) => t + p[0], 0) / 4, cy = points.reduce((t, p) => t + p[1], 0) / 4;
    // Ascending atan2 runs clockwise on screen (y grows downwards), the order of a quad's corners.
    const ring = points.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
    let area = 0;
    for (let i = 0; i < 4; i++) { const a = ring[i], b = ring[(i + 1) % 4]; area += a[0] * b[1] - b[0] * a[1]; }
    const size = boundsOf(ring);
    if (Math.abs(area) / 2 < 0.02 * (size[2] - size[0]) * (size[3] - size[1]) || Math.abs(area) < 1e-6) return null;
    const turn = (a) => Math.abs(((a - (refAngle || 0)) % 360 + 540) % 360 - 180);
    let best = null;
    for (let k = 0; k < 4; k++) {
      const q = [0, 1, 2, 3].map((i) => ring[(k + i) % 4]);
      if (!best || turn(angleOf(q)) < turn(angleOf(best))) best = q;
    }
    return best.map((p) => p.map((n) => Math.round(n * 100) / 100));
  }

  return { quadOf, boundsOf, angleOf, frameOf, contains, toQuad, quadFromPoints, MIN_ANGLE };
});
