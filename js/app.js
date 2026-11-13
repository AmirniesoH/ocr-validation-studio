/**
 * Application entry point: creates the shared services and mounts the
 * components into the regions of index.html.
 *
 * Every component receives `app`:
 *   app.bus        events                 (core/event-bus.js)
 *   app.settings   preferences            (core/settings.js)
 *   app.store      documents, pages, UI   (core/store.js)
 *   app.commands   user actions           (core/commands.js)
 *   app.images     page images            (io/images.js)
 *   app.autosave   drafts in IndexedDB    (io/autosave.js)
 *   app.toast      messages               (ui/toast.js)
 *   app.dialogs    choice dialogs         (ui/choice-dialog.js)
 *   app.viewer     the image viewer, for zoom shortcuts
 */
OVS.define('app', (require) => {
  'use strict';

  const { $ } = require('util/dom');

  /** The text pane never gets narrower than this; the image pane's minimum comes from its controls. */
  const TEXT_MIN_WIDTH = 300;

  /** Shared services: state, settings, events and the services built on them. */
  function createServices() {
    const { EventBus } = require('core/event-bus');
    const { Settings } = require('core/settings');
    const { Store } = require('core/store');
    const { Commands } = require('core/commands');
    const { ImageService } = require('io/images');
    const { AutoSave } = require('io/autosave');
    const { Toast } = require('ui/toast');

    const bus = new EventBus();
    const settings = new Settings(bus);
    const app = { bus, settings };
    app.store = new Store(bus, settings);
    app.toast = new Toast($('#toasts'));
    app.dialogs = require('ui/choice-dialog');
    app.images = new ImageService(bus);
    app.autosave = new AutoSave(app);
    app.commands = new Commands(app);
    // The threshold is a setting, but filters and counts treat it as a view change.
    settings.watch(['threshold'], () => bus.emit('ui:view', {}));
    return app;
  }

  /** Mount every component into its region of index.html. */
  function mountComponents(app) {
    const shell = require('ui/shell');
    new (require('ui/theme').Theme)(app);
    new (require('ui/toolbar').Toolbar)($('#toolbar'), app);
    new (require('ui/nav-panel').NavPanel)($('#nav'), app);
    app.viewer = new (require('ui/viewer').Viewer)($('#viewer'), app);
    const text = new (require('ui/text-panel').TextPanel)($('#text'), app);
    new (require('ui/inspector').Inspector)(text.inspectorMount, app);
    new (require('ui/settings-panel').SettingsPanel)($('#settings'), app);
    new (require('ui/stats-view').StatsView)($('#stats'), app);
    new (require('ui/import-dialog').ImportDialog)($('#dialogs'), app);
    new shell.StatusBar($('#statusbar'), app);
    new shell.Welcome($('#welcome'), app);
    shell.bindResizer($('#resizer'), $('#viewer'), $('#text'), app, () => ({ left: app.viewer.minWidth(), right: TEXT_MIN_WIDTH }));
    require('ui/file-drop').guardWindow(app);
    require('ui/shortcuts').bindShortcuts(app);
    require('ui/tooltip').bindTooltips();

    const syncPanes = () => { for (const id of ['#viewer', '#resizer', '#text']) $(id).hidden = app.store.isEmpty(); };
    app.bus.on('project:changed', syncPanes);
    syncPanes();
  }

  /** Restore the previous session, then keep saving drafts. */
  async function restoreSession(app) {
    if (await app.autosave.open()) {
      try {
        if (await app.autosave.restore()) app.toast.show('Restored your previous session from this browser.');
      } catch (err) {
        console.error('[OVS] Could not restore the previous session', err);
      }
      app.autosave.attach();
    }
    app.bus.emit('save:status');
  }

  async function start() {
    const app = createServices();
    mountComponents(app);
    await restoreSession(app);
    window.OVSApp = app; // for debugging in the console
    return app;
  }

  return { start };
});

// Start once every script has loaded.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => OVS.require('app').start());
else OVS.require('app').start();
