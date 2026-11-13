/**
 * DOM helpers.
 *
 *   h('button', { class: 'btn', onClick: save, attrs: { 'aria-label': 'Save' } }, icon('save'), 'Save')
 *
 * Props: class, text, style (object; keys starting with "--" set custom properties),
 * attrs (object), dataset (object), on<Event> listeners, and anything else is
 * assigned as a property (value, type, hidden, disabled, tabIndex…).
 * Children may be nodes, strings, numbers, arrays, or null/false (skipped).
 */
OVS.define('util/dom', () => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SVG_TAGS = new Set(['svg', 'path', 'circle', 'rect', 'line', 'g']);

  function h(tag, props, ...children) {
    const el = SVG_TAGS.has(tag) ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
    if (props) {
      for (const key of Object.keys(props)) {
        const val = props[key];
        if (val == null || val === false) continue;
        if (key === 'class') el.setAttribute('class', val);
        else if (key === 'text') el.textContent = val;
        else if (key === 'style') setStyle(el, val);
        else if (key === 'attrs') setAttrs(el, val);
        else if (key === 'dataset') Object.assign(el.dataset, val);
        else if (key.startsWith('on') && typeof val === 'function') el.addEventListener(key.slice(2).toLowerCase(), val);
        else el[key] = val;
      }
    }
    append(el, children);
    return el;
  }

  function append(el, children) {
    for (const child of children) {
      if (child == null || child === false) continue;
      if (Array.isArray(child)) append(el, child);
      else el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  function setStyle(el, style) {
    for (const key of Object.keys(style)) {
      if (style[key] == null) continue;
      if (key.startsWith('--')) el.style.setProperty(key, style[key]);
      else el.style[key] = style[key];
    }
  }

  function setAttrs(el, attrs) {
    for (const name of Object.keys(attrs)) {
      const v = attrs[name];
      if (v == null || v === false) el.removeAttribute(name);
      else el.setAttribute(name, v === true ? '' : String(v));
    }
  }

  /** Toggle a button's pressed state (class "on" + aria-pressed). */
  function setPressed(el, on) {
    el.classList.toggle('on', !!on);
    el.setAttribute('aria-pressed', String(!!on));
  }

  const $ = (selector, root) => (root || document).querySelector(selector);

  return { h, setPressed, $ };
});
