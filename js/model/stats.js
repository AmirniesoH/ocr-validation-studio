/**
 * Statistics for the Statistics view. Pure functions over pages.
 */
OVS.define('model/stats', (require) => {
  'use strict';

  const review = require('model/review');

  /** Confidence histogram: BIN_COUNT equal bins from 0 to 1. */
  const BIN_COUNT = 20;

  /**
   * @param {Array} pages
   * @param {number} threshold
   * @returns {{
   *   counts,                       review.counts() summed over the pages
   *   avgConf, confN,               mean original OCR confidence and how many characters have one
   *   bins: Array<{ below, above }> characters per confidence bin, split at the threshold
   *   freq: Array<[char, count]>    current values, most frequent first
   *   perPage: Array<{ page, counts, status }>
   * }}
   */
  function compute(pages, threshold) {
    const counts = review.counts([], threshold); // all counters at zero
    const bins = Array.from({ length: BIN_COUNT }, () => ({ below: 0, above: 0 }));
    const freq = new Map();
    const perPage = [];
    let confSum = 0, confN = 0;

    for (const page of pages) {
      const k = review.counts(page.chars, threshold);
      for (const key of Object.keys(counts)) counts[key] += k[key];
      perPage.push({ page, counts: k, status: review.pageStatus(k, page.hasAnnotation) });

      for (const c of page.chars) {
        if (c.space) continue;
        freq.set(c.value, (freq.get(c.value) || 0) + 1);
        const conf = review.conf(c);
        if (conf == null) continue;
        confSum += conf;
        confN++;
        const bin = bins[Math.min(BIN_COUNT - 1, Math.max(0, Math.floor(conf * BIN_COUNT + 1e-9)))];
        if (review.passes(conf, threshold)) bin.above++; else bin.below++;
      }
    }

    return {
      counts,
      avgConf: confN ? confSum / confN : null,
      confN,
      bins,
      freq: Array.from(freq.entries()).sort((a, b) => b[1] - a[1]),
      perPage
    };
  }

  return { compute };
});
