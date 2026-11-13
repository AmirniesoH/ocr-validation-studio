/**
 * Content of the Export menu: the formats from io/exporters.js, the scope
 * (page / document / all) and text options, with a live preview of the text output.
 */
OVS.define('ui/export-menu', (require) => {
  'use strict';

  const { h } = require('util/dom');
  const { menuItem, switchButton, segmented } = require('ui/controls');
  const exporters = require('io/exporters');

  const TEXT_OPTIONS = [
    ['exportLineBreaks', 'Preserve original line breaks'],
    ['exportParagraphs', 'Keep paragraph spacing'],
    ['exportPageHeaders', 'Page headings between pages']
  ];

  function buildExportMenu(app, close) {
    const s = app.settings;
    if (app.store.isEmpty()) {
      return [h('div', { class: 'mlabel', text: 'Nothing to export yet' }), h('div', { class: 'mi-sub menu-note', text: 'Import a document first.' })];
    }

    const pre = h('pre', { class: 'xprev' });
    const previewName = h('span');
    const refresh = () => {
      const p = exporters.preview(app, s.get('exportScope'), 14);
      pre.textContent = p.text;
      previewName.textContent = p.filename;
    };

    const items = (group) => exporters.FORMATS.filter((f) => f.group === group)
      .map((f) => menuItem({ badge: f.badge, tone: f.tone, label: f.label, description: f.description, onClick: () => app.commands.exportAs(f.id) }, close));

    const scope = segmented('Export scope', exporters.SCOPES.map((x) => ({ value: x.id, label: x.label })), s.get('exportScope'), (v) => { s.set('exportScope', v); refresh(); });
    const options = TEXT_OPTIONS.map(([key, label]) => h('div', { class: 'xrow' }, h('span', { text: label }), switchButton('x-' + key, label, s.get(key), (v) => { s.set(key, v); refresh(); })));
    refresh();

    return h('div', { class: 'xgrid' },
      h('div', { class: 'xcol' },
        h('div', { class: 'mlabel', text: 'Validated text' }), items('text'),
        h('div', { class: 'mdiv' }),
        h('div', { class: 'mlabel', text: 'Annotations and data' }), items('data')),
      h('div', { class: 'xcol xside' },
        h('div', { class: 'mlabel flush', text: 'Scope' }), scope,
        options,
        h('div', { class: 'mlabel flush' }, 'Preview · ', previewName),
        pre));
  }

  return { buildExportMenu };
});
