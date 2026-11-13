/**
 * User preferences, kept in localStorage.
 *
 *   settings.get('threshold')
 *   settings.set('threshold', 0.8)                      emits settings:changed
 *   settings.watch(['boxColor', 'boxOpacity'], redraw)  runs on those keys and on reset
 *
 * To add a setting: give it a default here (and a range if it is a number set
 * with a slider), a control in ui/settings-panel.js, and read it wherever it applies.
 */
OVS.define('core/settings', () => {
  'use strict';

  const STORAGE_KEY = 'ovs.settings.v2';

  const DEFAULTS = Object.freeze({
    // Confidence
    threshold: 0.75,
    confHighlight: true,
    lowColor: '#D2691E',
    lowOpacity: 0.6,
    // Bounding boxes
    showBoxes: true,
    imageLabels: true,      // label above the hovered or selected box: character, confidence, status
    boxColor: '#2B59C3',
    boxOpacity: 0.45,
    boxThickness: 1,
    // General
    theme: 'auto',          // 'light' | 'dark' | 'auto'
    defaultZoom: 'width',   // 'width' | 'page' | '100' | '150' | '200'
    textSize: 16,
    loupeZoom: 4,
    drawShape: 'box',       // 'box' | 'poly': outline last used for a manually added character
    // Display
    lineNumbers: true,
    indent: true,
    statusMarks: true,
    hoverConfidence: true,  // confidence label above the hovered character in Digital Text
    dimOthers: true,
    showSpaces: false,
    // Layout
    navCollapsed: false,
    split: 0.48,
    // Export
    exportScope: 'page',    // 'page' | 'doc' | 'all'
    exportLineBreaks: true,
    exportParagraphs: true,
    exportPageHeaders: true
  });

  /** Allowed range of numeric settings. Sliders use it, and stored values are kept inside it. */
  const RANGES = Object.freeze({
    threshold: { min: 0, max: 1, step: 0.01 },
    lowOpacity: { min: 0.2, max: 1, step: 0.05 },
    boxOpacity: { min: 0.1, max: 1, step: 0.05 },
    boxThickness: { min: 0.5, max: 3, step: 0.5 },
    split: { min: 0, max: 1 }
  });

  /** A value of the right type, inside its range; otherwise undefined. */
  function validate(key, value) {
    if (typeof value !== typeof DEFAULTS[key]) return undefined;
    if (typeof value === 'number') {
      if (!isFinite(value)) return undefined;
      const r = RANGES[key];
      if (r) return Math.min(r.max, Math.max(r.min, value));
    }
    return value;
  }

  function known(key) {
    if (!(key in DEFAULTS)) throw new Error('Unknown setting "' + key + '"');
  }

  class Settings {
    constructor(bus) {
      this.bus = bus;
      this.values = Object.assign({}, DEFAULTS, this.load());
    }

    /** Stored values, keeping only known keys with a valid value. */
    load() {
      let stored = {};
      try { stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch (e) { /* blocked or corrupt */ }
      const clean = {};
      for (const key of Object.keys(DEFAULTS)) {
        const value = key in stored ? validate(key, stored[key]) : undefined;
        if (value !== undefined) clean[key] = value;
      }
      return clean;
    }

    persist() {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.values)); } catch (e) { /* kept in memory only */ }
    }

    get(key) {
      known(key);
      return this.values[key];
    }

    set(key, value) {
      known(key);
      value = validate(key, value);
      if (value === undefined) throw new Error('Invalid value for setting "' + key + '"');
      if (this.values[key] === value) return;
      this.values[key] = value;
      this.persist();
      this.bus.emit('settings:changed', { key, value });
    }

    /** Back to defaults, keeping theme and layout. */
    reset() {
      const keep = { theme: this.values.theme, navCollapsed: this.values.navCollapsed, split: this.values.split };
      this.values = Object.assign({}, DEFAULTS, keep);
      this.persist();
      this.bus.emit('settings:changed', { key: '*' });
    }

    /** Run fn when any of the keys changes (or after a reset). Returns an unsubscribe function. */
    watch(keys, fn) {
      const set = new Set(keys);
      return this.bus.on('settings:changed', (e) => { if (e.key === '*' || set.has(e.key)) fn(e); });
    }
  }

  return { Settings, RANGES };
});
