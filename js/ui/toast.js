/**
 * Short status messages at the bottom of the window.
 *   toast.show('Saved.')     toast.show('Failed: …', { error: true })     toast.show('Working…', { sticky: true })
 */
OVS.define('ui/toast', (require) => {
  'use strict';

  const { h } = require('util/dom');
  const { icon } = require('ui/icons');

  class Toast {
    constructor(root) {
      this.root = root;
      this.el = null;
      this.timer = null;
    }

    show(message, opts) {
      const o = opts || {};
      clearTimeout(this.timer);
      this.hide();
      this.el = h('div', { class: 'toast' + (o.error ? ' error' : ''), attrs: { role: o.error ? 'alert' : 'status' } },
        icon(o.error ? 'alert' : 'check', 15, 2.2), h('span', { text: message }));
      this.root.appendChild(this.el);
      if (!o.sticky) this.timer = setTimeout(() => this.hide(), o.ms || (o.error ? 6000 : 3600));
    }

    hide() {
      if (this.el) { this.el.remove(); this.el = null; }
    }
  }

  return { Toast };
});
