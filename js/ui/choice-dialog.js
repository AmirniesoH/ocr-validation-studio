/**
 * A small modal that asks the user to pick one of a few clearly explained options.
 *
 *   const id = await choose({
 *     title, message,
 *     options: [{ id, label, description, tone?: 'primary' | 'danger', icon? }],
 *     cancel: 'cancel'          returned for Esc or a click outside the dialog
 *   });
 *
 * The first option gets focus. Tab and the arrow keys move between options.
 */
OVS.define('ui/choice-dialog', (require) => {
  'use strict';

  const { h } = require('util/dom');
  const { icon } = require('ui/icons');

  let counter = 0;

  function choose(o) {
    return new Promise((resolve) => {
      const returnFocus = document.activeElement;
      const titleId = 'choice-title-' + (++counter);
      const buttons = o.options.map((opt) => h('button', {
        class: 'choice' + (opt.tone ? ' ' + opt.tone : ''),
        dataset: { id: opt.id },
        onClick: () => done(opt.id)
      },
      opt.icon ? h('span', { class: 'choice-icon' }, icon(opt.icon, 18)) : null,
      h('span', { class: 'choice-text' }, h('b', { text: opt.label }), h('span', { text: opt.description }))));

      const dialog = h('div', { class: 'dlg choice-dlg', attrs: { role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': titleId } },
        h('div', { class: 'dlg-h' },
          h('div', { class: 'grow' }, h('h2', { id: titleId, text: o.title }), o.message ? h('p', { text: o.message }) : null)),
        h('div', { class: 'dlg-b choices' }, buttons));
      const scrim = h('div', { class: 'scrim' }, dialog);

      function done(id) {
        scrim.remove();
        if (returnFocus && returnFocus.isConnected && returnFocus.focus) returnFocus.focus({ preventScroll: true });
        resolve(id);
      }

      scrim.addEventListener('click', (e) => { if (e.target === scrim) done(o.cancel); });
      scrim.addEventListener('keydown', (e) => {
        e.stopPropagation();
        const i = buttons.indexOf(document.activeElement);
        const move = (d) => { e.preventDefault(); buttons[(i + d + buttons.length) % buttons.length].focus(); };
        if (e.key === 'Escape') { e.preventDefault(); done(o.cancel); }
        else if (e.key === 'Tab') move(e.shiftKey ? -1 : 1);
        else if (e.key === 'ArrowDown') move(1);
        else if (e.key === 'ArrowUp') move(-1);
      });

      document.body.appendChild(scrim);
      buttons[0].focus();
    });
  }

  return { choose };
});
