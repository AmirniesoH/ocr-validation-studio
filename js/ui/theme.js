/**
 * Applies the theme (Light / Dark / Auto) and the display settings that are
 * CSS variables: low-confidence color and opacity, text size and cell size.
 */
OVS.define('ui/theme', () => {
  'use strict';

  class Theme {
    constructor(app) {
      this.settings = app.settings;
      this.media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
      if (this.media && this.media.addEventListener) this.media.addEventListener('change', () => this.apply());
      this.settings.watch(['theme', 'lowColor', 'lowOpacity', 'textSize'], () => this.apply());
      this.apply();
    }

    /** 'light' or 'dark' after resolving Auto. */
    resolved() {
      const t = this.settings.get('theme');
      return t === 'auto' ? (this.media && this.media.matches ? 'dark' : 'light') : t;
    }

    apply() {
      const s = this.settings;
      const root = document.documentElement;
      const size = s.get('textSize');
      root.dataset.theme = this.resolved();
      root.style.setProperty('--low-color', s.get('lowColor'));
      root.style.setProperty('--low-opacity', s.get('lowOpacity'));
      root.style.setProperty('--text-size', size + 'px');
      root.style.setProperty('--cell-w', (Math.round(size * 0.64 * 10) / 10) + 'px');
      root.style.setProperty('--cell-h', Math.round(size * 1.75) + 'px');
    }
  }

  return { Theme };
});
