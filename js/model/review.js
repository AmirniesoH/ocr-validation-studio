/**
 * Review rules: the single source of truth for what "accepted", "pending",
 * "corrected" and "manually added" mean. Every counter, filter, color and
 * export in the app goes through this module.
 *
 * CHARACTER SHAPE (characters are immutable; every change makes a new object)
 *
 *   {
 *     id, lineId, order,          identity and position (order may be fractional)
 *     value,                      current text
 *     bbox,                       current box [x0, y0, x1, y1] or null
 *     poly,                       four corners when the character is rotated (model/geometry.js), else null
 *     ocr: { value, conf, bbox }  original OCR prediction, frozen; null for manually added characters
 *     verified,                   true once the user has edited or explicitly accepted it
 *     space, virtual,             a space token (never reviewed); virtual = inferred from a gap
 *     src                         extra fields from the source file, kept for export
 *   }
 *
 * RULES (threshold t)
 *
 *   Every non-space character is in exactly one GROUP, checked in this order:
 *     added       manually added by the user (no OCR prediction, no confidence)
 *     corrected   its value differs from the OCR value (changed by the user)
 *     threshold   accepted by confidence: OCR confidence > t
 *     confirmed   accepted by the user unchanged while its confidence is ≤ t
 *                 ("Accepted by you"); if t is lowered below its confidence it
 *                 is simply accepted by confidence, and returns here if t rises again
 *     pending     confidence ≤ t (or none) and not reviewed by the user
 *
 *   ACCEPTED is every group except pending, so:
 *     total    = accepted + pending
 *     accepted = threshold + confirmed + corrected + added
 *
 *   What the user can do:
 *     accept    only a pending character: it becomes "Accepted by you", unchanged
 *     edit      any character; a new value makes it corrected (total unchanged);
 *               typing the original OCR value back makes it accepted again
 *               (by confidence if > t, otherwise by you)
 *     add       a new character: +1 total, accepted and added
 *
 *   The confidence and its relation to t are never changed by the user: the
 *   inspector and charts always show them, whatever the group.
 *
 *   A page is complete when it has no pending characters.
 */
OVS.define('model/review', () => {
  'use strict';

  /* ---------- predicates ---------- */

  /** Original OCR confidence, or null (manually added or not provided). */
  const conf = (c) => (c.ocr && c.ocr.conf != null ? c.ocr.conf : null);
  const isAdded = (c) => !c.space && !c.ocr;
  const isCorrected = (c) => !c.space && !!c.ocr && c.value !== c.ocr.value;

  /**
   * The threshold rule, in one place: a confidence passes only when it is
   * strictly greater than the threshold (equal to it stays pending).
   */
  const passes = (confidence, threshold) => confidence != null && confidence > threshold;
  /** Short text for the rule, used in labels: "> 0.75". */
  const ruleText = (threshold) => '> ' + threshold.toFixed(2);

  /**
   * The group of a non-space character (see RULES above):
   *   'added' | 'corrected' | 'threshold' | 'confirmed' | 'pending'
   */
  function reason(c, threshold) {
    if (isAdded(c)) return 'added';
    if (isCorrected(c)) return 'corrected';
    if (passes(conf(c), threshold)) return 'threshold';
    return c.verified ? 'confirmed' : 'pending';
  }

  const isPending = (c, threshold) => !c.space && reason(c, threshold) === 'pending';
  const isAccepted = (c, threshold) => !c.space && reason(c, threshold) !== 'pending';
  /** Accepted by the user unchanged (and not already accepted by confidence). */
  const isConfirmed = (c, threshold) => !c.space && reason(c, threshold) === 'confirmed';

  const REASON_LABEL = {
    added: 'Manually added',
    corrected: 'Corrected',
    threshold: 'Accepted by confidence',
    confirmed: 'Accepted by you',
    pending: 'Pending'
  };

  /* ---------- filters ---------- */

  /** Every group reason() can return. */
  const GROUPS = ['added', 'corrected', 'threshold', 'confirmed', 'pending'];
  const ACCEPTED_GROUPS = GROUPS.filter((g) => g !== 'pending');

  /**
   * Filters for the text panel, each with the groups it shows: 'accepted' covers every
   * accepted group, the others one group each. The single source for matches() and
   * for the text panel's dimming styles.
   */
  const FILTERS = [
    { id: 'all', label: 'All', groups: GROUPS },
    { id: 'pending', label: 'Pending', groups: ['pending'] },
    { id: 'accepted', label: 'Accepted', groups: ACCEPTED_GROUPS },
    { id: 'confirmed', label: 'Accepted by you', groups: ['confirmed'] },
    { id: 'corrected', label: 'Corrected', groups: ['corrected'] },
    { id: 'added', label: 'Manually added', groups: ['added'] }
  ];
  const FILTER_GROUPS = new Map(FILTERS.map((f) => [f.id, new Set(f.groups)]));

  function matches(c, filter, threshold) {
    if (c.space) return false;
    const groups = FILTER_GROUPS.get(filter);
    return !groups || groups.has(reason(c, threshold));
  }

  /* ---------- counting ---------- */

  /**
   * @returns {{ total, accepted, pending, threshold, confirmed, corrected, added, touched }}
   * One counter per group (they add up to total), accepted = total − pending, and
   * touched = characters the user has acted on (edited, accepted or added).
   */
  function counts(chars, threshold) {
    const k = { total: 0, accepted: 0, pending: 0, threshold: 0, confirmed: 0, corrected: 0, added: 0, touched: 0 };
    for (const c of chars) {
      if (c.space) continue;
      const group = reason(c, threshold);
      k.total++;
      k[group]++;
      if (group !== 'pending') k.accepted++;
      if (c.verified || group === 'added') k.touched++;
    }
    return k;
  }

  const PAGE_STATUS = {
    none: 'No annotation',
    new: 'Not reviewed',
    progress: 'In progress',
    complete: 'Completed'
  };

  /** Page status from its counts: complete only when nothing is pending. */
  function pageStatus(k, hasAnnotation) {
    let key;
    if (!hasAnnotation) key = 'none';
    else if (k.pending === 0) key = 'complete';
    else if (k.touched > 0) key = 'progress';
    else key = 'new';
    return { key, label: PAGE_STATUS[key] };
  }

  /* ---------- transitions (pure: return a new character, or null when nothing changes) ---------- */

  /**
   * The user typed a new value. Only a change counts: the same value is not an
   * edit (accepting is a separate action, for pending characters only).
   * Typing the OCR value back ends the correction; the character stays reviewed.
   */
  function edit(c, value) {
    if (!value || value === c.value) return null;
    if (isAdded(c)) return Object.assign({}, c, { value });
    return Object.assign({}, c, { value, verified: true });
  }

  /** Accept a pending character as it is (anything else: null). */
  const accept = (c, threshold) => (isPending(c, threshold) ? Object.assign({}, c, { verified: true }) : null);

  /** Withdraw "Accepted by you": the character is pending again. */
  const unaccept = (c, threshold) => (isConfirmed(c, threshold) ? Object.assign({}, c, { verified: false }) : null);

  /**
   * End a correction: back to the OCR value and box, the same as typing the
   * original value back, so the character stays accepted.
   */
  const restore = (c) => (isCorrected(c) ? Object.assign({}, c, { value: c.ocr.value, bbox: c.ocr.bbox }) : null);

  /** The character with a drawn outline: an upright box, or a four-corner polygon (bbox = its bounds). */
  const withBox = (c, bbox, poly) => Object.assign({}, c, { bbox, poly: poly || null });

  function createAdded(id, lineId, order, value) {
    return { id, lineId, order, value, bbox: null, poly: null, ocr: null, verified: true, space: false, virtual: false, src: null };
  }

  return {
    conf, passes, ruleText, isAdded, isCorrected, isAccepted, isPending, isConfirmed, reason, REASON_LABEL,
    GROUPS, FILTERS, matches, counts, pageStatus,
    edit, accept, unaccept, restore, withBox, createAdded
  };
});
