/**
 * Top toolbar: Import and Export menus, Undo/Redo, Save all with the auto-save
 * indicator, Statistics, Settings and the theme switcher.
 * The toolbar sits above every workspace overlay, so its menus are never hidden.
 */
OVS.define('ui/toolbar', (require) => {
  'use strict';

  const { h } = require('util/dom');
  const { clock } = require('util/format');
  const { docTag } = require('ui/labels');
  const { icon, logo } = require('ui/icons');
  const { dropdown, menuItem, segmented } = require('ui/controls');
  const { entriesFromInput, ACCEPT } = require('io/importer');
  const { buildExportMenu } = require('ui/export-menu');

  class Toolbar {
    constructor(root, app) {
      this.root = root;
      this.app = app;
      this.render();
      app.bus.onAny(['page:changed', 'project:changed'], () => this.updateCrumb());
      app.bus.on('project:changed', () => this.updateSave()); // a sample project shows that it is not kept
      app.bus.on('history:changed', () => this.updateHistory());
      app.bus.on('save:status', () => this.updateSave());
      app.bus.on('ui:panel', () => this.updatePanels());
      app.settings.watch(['theme'], () => this.themeSeg.setValue(app.settings.get('theme')));
      this.updateCrumb();
      this.updateHistory();
      this.updateSave();
      this.updatePanels();
    }

    render() {
      const app = this.app, cmd = app.commands;
      this.crumb = h('div', { class: 'crumb' });

      // Import
      const pickers = {
        image: this.filePicker(ACCEPT.image),
        pdf: this.filePicker(ACCEPT.pdf),
        folder: this.filePicker('', true),
        annotation: this.filePicker(ACCEPT.annotation)
      };
      // New project
      this.newBtn = h('button', { class: 'ib', attrs: { 'aria-label': 'New project', 'data-tip': 'Start a new, empty project' }, onClick: () => cmd.newProject() },
        icon('filePlus', 17), h('span', { class: 'hide-md', text: 'New project' }));

      // Import
      const importWrap = h('div', { class: 'menu-wrap' });
      const importBtn = h('button', { class: 'ib', attrs: { 'data-tip': 'Import documents and annotation files' } }, icon('import', 17), h('span', { text: 'Import' }), icon('chevronDown', 12, 2));
      importWrap.append(importBtn, ...Object.values(pickers));
      dropdown(importWrap, importBtn, (close) => [
        h('div', { class: 'mlabel', text: 'Documents' }),
        menuItem({ icon: 'image', label: 'Import image', description: 'PNG, JPEG, WebP or GIF scans', hint: 'Ctrl O', onClick: () => pickers.image.click() }, close),
        menuItem({ icon: 'file', label: 'Import PDF', description: 'Multi-page documents, one entry per page', onClick: () => pickers.pdf.click() }, close),
        menuItem({ icon: 'folder', label: 'Import folder', description: 'Every image and annotation file inside', onClick: () => pickers.folder.click() }, close),
        h('div', { class: 'mdiv' }),
        h('div', { class: 'mlabel', text: 'Annotations' }),
        menuItem({ icon: 'braces', label: 'Import annotation file', description: 'JSON, Parquet or SQLite with character boxes, values and confidence', onClick: () => pickers.annotation.click() }, close),
        h('div', { class: 'mdiv' }),
        menuItem({ icon: 'sparkle', label: 'Try sample documents', description: 'Starts a new project with four practice pages (not kept)', onClick: () => cmd.loadSample() }, close)
      ]);

      // Export
      const exportWrap = h('div', { class: 'menu-wrap' });
      const exportBtn = h('button', { class: 'ib', attrs: { 'data-tip': 'Export validated text and annotations' } }, icon('export', 17), h('span', { text: 'Export' }), icon('chevronDown', 12, 2));
      exportWrap.appendChild(exportBtn);
      dropdown(exportWrap, exportBtn, (close) => buildExportMenu(app, close), { className: 'xmenu' });

      // History and saving
      this.undoBtn = h('button', { class: 'ib', attrs: { 'aria-label': 'Undo', 'data-tip': 'Undo · Ctrl Z' }, onClick: () => cmd.undo() }, icon('undo', 17));
      this.redoBtn = h('button', { class: 'ib', attrs: { 'aria-label': 'Redo', 'data-tip': 'Redo · Ctrl Shift Z' }, onClick: () => cmd.redo() }, icon('redo', 17));
      this.badge = h('span', { class: 'badge num', hidden: true });
      const saveBtn = h('button', { class: 'btn primary', attrs: { 'data-tip': 'Write the validated annotation files · Ctrl S' }, onClick: () => cmd.saveAll() },
        icon('save', 16), h('span', { text: 'Save all' }), this.badge);
      this.autosaveIcon = h('span', { class: 'autosave-icon' });
      this.autosaveText = h('span', { class: 'hide-md' }); // below 1280px the icon's tooltip carries the status
      this.autosave = h('span', { class: 'autosave', attrs: { 'aria-live': 'polite' } }, this.autosaveIcon, this.autosaveText);

      // Panels and theme
      this.statsBtn = h('button', { class: 'ib', attrs: { 'aria-label': 'Statistics', 'data-tip': 'Document statistics' }, onClick: () => cmd.togglePanel('stats') }, icon('chart', 17), h('span', { class: 'hide-lg', text: 'Statistics' }));
      this.settingsBtn = h('button', { class: 'ib', attrs: { 'aria-label': 'Settings', 'data-tip': 'Settings' }, onClick: () => cmd.togglePanel('settings') }, icon('sliders', 17), h('span', { class: 'hide-lg', text: 'Settings' }));
      this.themeSeg = segmented('Theme', [
        { value: 'light', icon: 'sun', tip: 'Light theme' },
        { value: 'dark', icon: 'moon', tip: 'Dark theme' },
        { value: 'auto', icon: 'monitor', tip: 'Match system' }
      ], app.settings.get('theme'), (v) => app.settings.set('theme', v));

      this.root.append(
        h('div', { class: 'brand' }, logo(), h('span', { class: 'brand-name', text: 'OCR Validation Studio' })),
        this.crumb,
        h('div', { class: 'tsep' }), this.newBtn, importWrap, exportWrap,
        h('div', { class: 'tsep' }), this.undoBtn, this.redoBtn,
        h('div', { class: 'tsep' }), saveBtn, this.autosave,
        h('div', { class: 'grow' }), this.statsBtn, this.settingsBtn, this.themeSeg);
    }

    /** Hidden file input that opens the import dialog with the chosen files. */
    filePicker(accept, folder) {
      const input = h('input', { type: 'file', class: 'vh', accept, multiple: true, tabIndex: -1, attrs: { 'aria-hidden': 'true', webkitdirectory: folder || null } });
      input.addEventListener('change', () => {
        const entries = entriesFromInput(input);
        input.value = '';
        if (entries.length) this.app.commands.openImport(null, entries);
      });
      return input;
    }

    updateCrumb() {
      const store = this.app.store;
      const page = store.currentPage();
      const doc = store.documentOf(page);
      this.newBtn.disabled = store.isEmpty();
      this.crumb.replaceChildren();
      if (!doc) return;
      const where = doc.pageIds.length > 1 || doc.kind === 'pdf' ? 'Page ' + page.pageNo + ' of ' + doc.pageIds.length : 'Single image';
      this.crumb.append(h('span', { class: 'ftag', text: docTag(doc) }), h('b', { text: doc.name }), h('span', { text: '/' }), h('span', { text: where }));
    }

    updateHistory() {
      this.undoBtn.disabled = !this.app.store.history.canUndo();
      this.redoBtn.disabled = !this.app.store.history.canRedo();
    }

    updateSave() {
      const unsaved = this.app.store.unsaved;
      this.badge.hidden = unsaved === 0;
      this.badge.textContent = unsaved;
      if (this.app.store.isSampleProject()) {
        this.autosave.className = 'autosave';
        this.autosaveIcon.replaceChildren(icon('sparkle', 15));
        this.autosaveText.textContent = 'Sample · not kept';
        this.autosave.title = 'Sample · not kept. Sample documents are for practice: they start fresh every time and are never saved in the browser. Use New project to work on your own documents.';
        return;
      }
      const autosave = this.app.autosave;
      const state = autosave ? autosave.state : 'off';
      const problem = state === 'off' || state === 'error';
      this.autosave.className = 'autosave' + (state === 'saving' ? ' busy' : problem ? ' warn' : '');
      this.autosaveIcon.replaceChildren(icon(problem ? 'cloudOff' : 'cloud', 15));
      this.autosaveText.textContent = {
        saving: 'Saving draft…',
        off: 'Auto-save off',
        error: 'Auto-save failed',
        saved: autosave && autosave.lastSaved ? 'Draft saved ' + clock(autosave.lastSaved) : '',
        idle: ''
      }[state];
      const status = this.autosaveText.textContent;
      this.autosave.title = (status ? status + '. ' : '') + (state === 'off'
        ? 'This browser blocks local storage here, so drafts are not kept. Use Save all before closing.'
        : 'Your work is kept in this browser automatically. Save all writes the validated annotation files.');
    }

    updatePanels() {
      const panel = this.app.store.ui.panel;
      this.statsBtn.classList.toggle('on', panel === 'stats');
      this.settingsBtn.classList.toggle('on', panel === 'settings');
    }
  }

  return { Toolbar };
});
