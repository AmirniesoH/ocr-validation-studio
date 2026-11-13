/**
 * Reusable controls: dropdown menus, menu items, two-step confirm buttons,
 * switches, sliders, segmented controls and selects. Each returns a DOM element.
 */
OVS.define('ui/controls', (require) => {
  'use strict';

  const { h, setPressed } = require('util/dom');
  const { icon } = require('ui/icons');

  /**
   * Attach a dropdown menu to a trigger. build(close) returns the menu content
   * each time it opens, so the menu always reflects the current state.
   * The menu is shifted left if it would overflow the window.
   */
  function dropdown(wrap, trigger, build, opts) {
    let menu = null;
    const close = () => {
      if (!menu) return;
      menu.remove();
      menu = null;
      trigger.setAttribute('aria-expanded', 'false');
      trigger.classList.remove('on');
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', onKey, true);
    };
    const outside = (e) => { if (menu && !menu.contains(e.target) && !trigger.contains(e.target)) close(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); trigger.focus(); } };
    const open = () => {
      menu = h('div', { class: 'menu ' + ((opts && opts.className) || ''), attrs: { role: 'menu' } }, build(close));
      wrap.appendChild(menu);
      const overflow = menu.getBoundingClientRect().right - (window.innerWidth - 8);
      if (overflow > 0) menu.style.left = -overflow + 'px';
      trigger.setAttribute('aria-expanded', 'true');
      trigger.classList.add('on');
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('keydown', onKey, true);
      const first = menu.querySelector('button');
      if (first) first.focus({ preventScroll: true });
    };
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.addEventListener('click', () => (menu ? close() : open()));
    return { open, close, isOpen: () => !!menu };
  }

  /** opts: { icon?, badge?, tone?, label, description?, hint?, onClick } */
  function menuItem(opts, close) {
    return h('button', { class: 'mi', attrs: { role: 'menuitem' }, onClick: () => { if (close) close(); opts.onClick(); } },
      opts.icon ? h('span', { class: 'mico' }, icon(opts.icon, 16)) : null,
      opts.badge ? h('span', { class: 'ftype' + (opts.tone ? ' ' + opts.tone : ''), text: opts.badge }) : null,
      h('span', { class: 'mi-t' }, opts.label, opts.description ? h('span', { class: 'mi-sub', text: opts.description }) : null),
      opts.hint ? h('span', { class: 'mi-hint', text: opts.hint }) : null);
  }

  /**
   * A button that needs a second click to run a destructive action.
   * opts: { className, label, confirmLabel, icon?, showText? }
   */
  /**
   * A button that asks for a second click before acting.
   * opts: { className, label, confirmLabel (text, or a function returning it), icon?, showText? }
   */
  function confirmButton(opts, onConfirm) {
    let armed = false, timer = null;
    const text = opts.showText ? h('span', { text: opts.label }) : null;
    const btn = h('button', { class: opts.className, attrs: { 'aria-label': opts.label, 'data-tip': opts.showText ? null : opts.label } },
      opts.icon ? h('span', { class: opts.showText ? 'mico' : '' }, icon(opts.icon, opts.showText ? 16 : 14)) : null, text);
    const label = (l) => { btn.setAttribute('aria-label', l); if (text) text.textContent = l; else btn.dataset.tip = l; };
    const disarm = () => { armed = false; btn.classList.remove('confirming'); label(opts.label); };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (armed) { clearTimeout(timer); disarm(); onConfirm(); return; }
      armed = true;
      btn.classList.add('confirming');
      label(typeof opts.confirmLabel === 'function' ? opts.confirmLabel() : opts.confirmLabel);
      timer = setTimeout(disarm, 3500);
    });
    return btn;
  }

  function switchButton(id, label, checked, onChange) {
    const btn = h('button', { class: 'sw', id, attrs: { role: 'switch', 'aria-checked': String(!!checked), 'aria-label': label } });
    btn.addEventListener('click', () => {
      const on = btn.getAttribute('aria-checked') !== 'true';
      btn.setAttribute('aria-checked', String(on));
      onChange(on);
    });
    btn.setValue = (on) => btn.setAttribute('aria-checked', String(!!on));
    return btn;
  }

  /** Range input whose filled track follows its value. input.setValue(v) updates it without firing. */
  function slider(id, { min, max, step, value, width }, onInput) {
    const input = h('input', { class: 'range', id, type: 'range', min, max, step, value, style: { width: width || null } });
    const fill = () => input.style.setProperty('--fill', ((input.value - min) / (max - min) * 100) + '%');
    input.addEventListener('input', () => { fill(); onInput(parseFloat(input.value)); });
    input.setValue = (v) => { input.value = v; fill(); };
    fill();
    return input;
  }

  /** options: [{ value, label?, icon?, tip? }]. el.setValue(v) updates the selection. */
  function segmented(label, options, value, onChange) {
    const wrap = h('div', { class: 'seg', attrs: { role: 'group', 'aria-label': label } });
    const buttons = options.map((o) => {
      const b = h('button', { dataset: { value: String(o.value) }, attrs: { 'aria-label': o.icon ? (o.tip || o.label) : null, 'data-tip': o.icon ? o.tip : null } },
        o.icon ? icon(o.icon, 15) : null, o.icon ? null : o.label);
      b.addEventListener('click', () => { wrap.setValue(o.value); onChange(o.value); });
      wrap.appendChild(b);
      return b;
    });
    wrap.setValue = (v) => buttons.forEach((b) => setPressed(b, b.dataset.value === String(v)));
    wrap.setValue(value);
    return wrap;
  }

  /** options: [[value, label]]. parse converts the selected string back (e.g. Number). */
  function select(id, options, value, onChange, parse) {
    const el = h('select', { class: 'sel', id }, options.map(([v, l]) => h('option', { value: String(v), text: l })));
    el.value = String(value);
    el.addEventListener('change', () => onChange(parse ? parse(el.value) : el.value));
    return el;
  }

  return { dropdown, menuItem, confirmButton, switchButton, slider, segmented, select };
});
