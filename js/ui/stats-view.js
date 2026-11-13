/**
 * Statistics view. Covers the workspace while open (the toolbar and the
 * document list stay usable) and closes when a page is opened.
 * "This page" shows only that page's figures; the Pages table appears for "All documents".
 */
OVS.define('ui/stats-view', (require) => {
  'use strict';

  const { h } = require('util/dom');
  const { fmtInt, percent, plural } = require('util/format');
  const { debounce } = require('util/async');
  const { icon } = require('ui/icons');
  const { segmented } = require('ui/controls');
  const { sidePanel } = require('ui/side-panel');
  const { pageLabel, STATUS_COLOR } = require('ui/labels');
  const { confidenceHistogram, frequencyChart } = require('ui/charts');
  const stats = require('model/stats');

  /** Number columns of the Pages table: [header, column class]. Widths are in css/panels.css. */
  const COUNT_COLUMNS = [['Characters', 'c-total'], ['Accepted', 'c-acc'], ['Accepted by you', 'c-you'], ['Pending', 'c-pend'], ['Corrected', 'c-corr'], ['Manually added', 'c-add']];


  class StatsView {
    constructor(root, app) {
      this.root = root;
      this.app = app;
      this.scope = 'all';
      const refresh = debounce(() => { if (!root.hidden) this.render(); }, 150);
      app.bus.onAny(['chars:changed', 'project:changed', 'page:changed'], refresh);
      app.settings.watch(['threshold'], refresh);
      sidePanel(root, app, { id: 'stats', label: 'Statistics', onOpen: () => this.render() });
    }

    render() {
      const store = this.app.store;
      const current = store.currentPage();
      const pageScope = this.scope === 'page' && !!current;
      const pages = pageScope ? [current] : store.pageList();
      const result = stats.compute(pages, store.threshold);
      const sections = pages.length
        ? [this.kpis(result, pages.length), this.progress(result), h('div', { class: 'grid2' }, this.confidenceCard(result), this.frequencyCard(result)), pageScope ? null : this.pagesTable(result)]
        : [h('div', { class: 'card' }, h('h4', { text: 'No documents yet' }), h('div', { class: 'sub', text: 'Import a document and its annotation file to see statistics.' }))];
      this.root.replaceChildren(h('div', { class: 'st-in' }, this.header(current, pageScope), sections));
    }

    header(current, pageScope) {
      const store = this.app.store;
      const scopeLabel = pageScope
        ? pageLabel(store.documentOf(current), current)
        : plural(store.documents.length, 'document') + ' · ' + plural(store.pageList().length, 'page');
      return h('div', { class: 'st-head' },
        h('button', { class: 'btn sm ghost', onClick: () => store.setPanel(null) }, icon('chevronLeft', 15, 2), 'Back to workspace'),
        h('h2', { text: 'Statistics' }),
        h('span', { class: 'pane-meta', text: scopeLabel }),
        h('div', { class: 'grow' }),
        segmented('Statistics scope', [{ value: 'page', label: 'This page' }, { value: 'all', label: 'All documents' }], this.scope, (v) => { this.scope = v; this.render(); }));
    }

    kpis(r, pageCount) {
      const k = r.counts, th = this.app.store.threshold;
      const tile = (label, value, sub, color) => h('div', { class: 'kpi' }, h('span', { class: 'k' }, h('i', { style: { background: color } }), label), h('span', { class: 'v', text: value }), h('span', { class: 's', text: sub }));
      return h('div', { class: 'kpis' },
        tile('Total characters', fmtInt(k.total), plural(pageCount, 'page'), 'var(--text3)'),
        tile('Accepted', fmtInt(k.accepted), percent(k.accepted, k.total, 1) + ' of all characters', 'var(--ok-auto)'),
        tile('Accepted by you', fmtInt(k.confirmed), 'Pending ones you accepted unchanged', 'var(--ok)'),
        tile('Pending', fmtInt(k.pending), 'Confidence ≤ ' + th.toFixed(2) + ', not reviewed', 'var(--warn)'),
        tile('Corrected', fmtInt(k.corrected), 'Changed by you', 'var(--fix)'),
        tile('Manually added', fmtInt(k.added), 'Missed by the OCR', 'var(--add)'),
        tile('Average OCR confidence', r.avgConf == null ? '—' : r.avgConf.toFixed(3), 'Original scores of ' + fmtInt(r.confN) + ' characters', 'var(--chart)'));
    }

    progress(r) {
      const k = r.counts;
      // One segment per group (model/review.js); together they are all characters.
      const segments = [
        ['Accepted by confidence', k.threshold, 'var(--ok-auto)'],
        ['Accepted by you', k.confirmed, 'var(--ok)'],
        ['Corrected', k.corrected, 'var(--fix)'],
        ['Manually added', k.added, 'var(--add)'],
        ['Pending', k.pending, 'var(--warn)']
      ];
      return h('div', { class: 'card' },
        h('h4', { text: 'Validation progress' }),
        h('div', { class: 'sub', text: percent(k.accepted, k.total, 1) + ' accepted (' + fmtInt(k.confirmed) + ' by you, ' + fmtInt(k.corrected) + ' corrected, ' + fmtInt(k.added) + ' added) · ' + fmtInt(k.pending) + ' pending' }),
        h('div', { class: 'stack', attrs: { role: 'img', 'aria-label': segments.map((s) => s[0] + ' ' + s[1]).join(', ') } },
          segments.map(([label, n, color]) => (n ? h('i', { style: { width: (n / Math.max(1, k.total) * 100) + '%', background: color }, title: label + ': ' + fmtInt(n) }) : null))),
        h('div', { class: 'legend' }, segments.map(([label, n, color]) => h('span', null, h('i', { style: { background: color } }), label + ' ', h('b', { text: fmtInt(n) })))));
    }

    confidenceCard(r) {
      return h('div', { class: 'card' },
        h('h4', { text: 'OCR confidence distribution' }),
        h('div', { class: 'sub', text: 'Original scores of ' + fmtInt(r.confN) + ' characters. Manually added characters have none.' }),
        confidenceHistogram(r.bins, this.app.store.threshold),
        h('div', { class: 'legend' },
          h('span', null, h('i', { style: { background: 'var(--warn)' } }), 'At or below threshold'),
          h('span', null, h('i', { style: { background: 'var(--chart)' } }), 'Above threshold')));
    }

    frequencyCard(r) {
      const top = r.freq.slice(0, 32);
      return h('div', { class: 'card' },
        h('h4', { text: 'Character frequency' }),
        h('div', { class: 'sub', text: 'Top ' + top.length + ' current values, spaces excluded' }),
        frequencyChart(top),
        h('div', { class: 'legend' },
          h('span', null, 'Most frequent: ', h('b', { class: 'mono', text: r.freq.slice(0, 5).map((f) => f[0] + ' ' + f[1]).join('   ') })),
          h('span', null, 'Distinct characters: ', h('b', { text: String(r.freq.length) }))));
    }

    pagesTable(r) {
      const store = this.app.store;
      const rows = r.perPage.map((x) => {
        const doc = store.documentOf(x.page);
        const k = x.counts;
        const pct = k.total ? Math.round(k.accepted / k.total * 100) : 0;
        const pageName = doc.pageIds.length > 1 ? (doc.kind === 'pdf' ? 'p. ' + x.page.pageNo : x.page.name) : null;
        return h('tr', null,
          // A long document name gives way to the page name, so rows of one document stay distinguishable.
          h('td', { class: 'c-page' }, h('span', { class: 'pcell', attrs: { 'data-tip-overflow': pageName ? doc.name + ' · ' + pageName : doc.name } },
            h('b', { class: 'medium', text: doc.name }), pageName ? h('span', { class: 'muted', text: pageName }) : null)),
          h('td', { class: 'c-status' }, h('span', { class: 'spill s-' + x.status.key }, h('span', { class: 'sdot' }), x.status.label)),
          h('td', { class: 'c-share' }, h('span', { class: 'progrow' }, h('span', { class: 'prog' }, h('i', { style: { width: pct + '%', background: STATUS_COLOR[x.status.key] } })), h('span', { class: 'pct', text: pct + '%' }))),
          [k.total, k.accepted, k.confirmed, k.pending, k.corrected, k.added].map((v, i) => h('td', { class: 'n ' + COUNT_COLUMNS[i][1], text: fmtInt(v), attrs: { 'data-tip-overflow': '' } })),
          h('td', { class: 'c-open' }, h('button', { class: 'btn sm', onClick: () => this.app.commands.openPage(x.page.id) }, 'Open')));
      });
      return h('div', { class: 'card' },
        h('h4', { text: 'Pages' }),
        h('div', { class: 'sub', text: 'A page is completed when none of its characters are pending.' }),
        h('div', { class: 'tscroll' }, h('table', { class: 'ptable' },
          h('thead', null, h('tr', null,
            [['Page', 'c-page'], ['Status', 'c-status'], ['Accepted share', 'c-share']].map(([t, c]) => h('th', { class: c, text: t, attrs: { 'data-tip-overflow': '' } })),
            COUNT_COLUMNS.map(([t, c]) => h('th', { class: 'n ' + c, text: t, attrs: { 'data-tip-overflow': '' } })),
            h('th', { class: 'c-open' }))),
          h('tbody', null, rows))));
    }
  }

  return { StatsView };
});
