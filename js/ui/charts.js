/**
 * Charts for the Statistics view, built from plain elements on one linear scale.
 *
 * confidenceHistogram: bars stacked below/above the threshold, a dashed line at
 * the threshold, and its label in a strip directly above that line (kept inside
 * the chart near the edges), so it never collides with bar counts or axis labels.
 */
OVS.define('ui/charts', (require) => {
  'use strict';

  const { h } = require('util/dom');
  const { clamp, fmtInt } = require('util/format');

  /** Tallest bar uses this share of the plot height, leaving room for its count label. */
  const BAR_MAX = 86;

  /**
   * @param {Array<{ below, above }>} bins  equal-width bins covering 0 … 1
   * @param {number} threshold
   */
  function confidenceHistogram(bins, threshold) {
    const n = bins.length;
    const max = Math.max(1, ...bins.map((b) => b.below + b.above));
    const height = (v) => (v / max * BAR_MAX) + '%';

    const columns = bins.map((b, i) => {
      const lo = i / n, hi = (i + 1) / n, total = b.below + b.above;
      return h('div', { class: 'col', style: { left: (lo * 100) + '%', width: (100 / n) + '%' }, title: lo.toFixed(2) + '–' + hi.toFixed(2) + ': ' + fmtInt(total) + ' characters (' + fmtInt(b.below) + ' at or below the threshold)' },
        total ? h('span', { class: 'col-n', style: { bottom: height(total) }, text: fmtInt(total) }) : null,
        total ? h('div', { class: 'bar-stack', style: { height: height(total) } },
          h('i', { class: 'bar above', style: { flexGrow: b.above } }),
          h('i', { class: 'bar below', style: { flexGrow: b.below } })) : null);
    });

    const x = clamp(threshold, 0, 1) * 100 + '%';
    const label = h('span', { class: 'th-label', text: 'Threshold ' + threshold.toFixed(2) });
    const strip = h('div', { class: 'th-strip' }, label, h('span', { class: 'th-caret', style: { left: x } }));
    const plot = h('div', { class: 'plot', attrs: { role: 'img', 'aria-label': 'Histogram of OCR confidence scores with the threshold at ' + threshold.toFixed(2) } },
      h('div', { class: 'gridline', style: { bottom: BAR_MAX / 2 + '%' } }),
      h('div', { class: 'gridline', style: { bottom: BAR_MAX + '%' } }),
      columns,
      h('div', { class: 'th-line', style: { left: x } }));
    const ticks = [];
    for (let v = 0; v <= 10; v += 1) ticks.push(h('span', { class: 'tick', style: { left: v * 10 + '%' }, text: (v / 10).toFixed(1) }));

    // Centre the label over the line, but keep it inside the chart.
    // The observer disconnects once the chart is replaced (the view re-renders on every change).
    const observer = new ResizeObserver(() => {
      if (!strip.isConnected) { if (placed) observer.disconnect(); return; }
      const w = strip.getBoundingClientRect().width, lw = label.getBoundingClientRect().width; // exact, not rounded
      if (!w) return;
      label.style.left = clamp(threshold * w - lw / 2, 0, Math.max(0, w - lw)) + 'px';
      placed = true;
    });
    let placed = false;
    observer.observe(strip);

    return h('div', { class: 'chart' }, strip, plot, h('div', { class: 'axis' }, ticks));
  }

  /** @param {Array<[string, number]>} freq  most frequent first */
  function frequencyChart(freq) {
    const max = freq.length ? freq[0][1] : 1;
    const n = Math.max(1, freq.length);
    const columns = freq.map(([ch, count], i) => h('div', { class: 'col', style: { left: (i / n * 100) + '%', width: (100 / n) + '%' }, title: '“' + ch + '”: ' + fmtInt(count) },
      h('div', { class: 'bar-stack', style: { height: (count / max * BAR_MAX) + '%' } }, h('i', { class: 'bar above', style: { flexGrow: 1 } }))));
    const labels = freq.map(([ch], i) => h('span', { class: 'tick char', style: { left: ((i + 0.5) / n * 100) + '%' }, text: ch }));
    return h('div', { class: 'chart' },
      h('div', { class: 'plot', attrs: { role: 'img', 'aria-label': 'Most frequent characters' } },
        h('div', { class: 'gridline', style: { bottom: BAR_MAX / 2 + '%' } }), h('div', { class: 'gridline', style: { bottom: BAR_MAX + '%' } }), columns),
      h('div', { class: 'axis' }, labels));
  }

  return { confidenceHistogram, frequencyChart };
});
