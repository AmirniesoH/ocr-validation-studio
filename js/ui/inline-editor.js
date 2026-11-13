/**
 * The single-character input that replaces a character in place.
 *
 *   Enter       confirm (and stay)
 *   Tab         save a changed value and continue with the next pending character
 *               (Shift+Tab: previous); an unchanged character is skipped, not accepted
 *   Esc         cancel
 *   click away  cancel: only Enter (or Tab, for a changed value) saves, so clicking
 *               elsewhere never accepts or changes a character by accident.
 *               Switching to another window keeps the edit open.
 *
 * Only one character is kept: typing replaces the previous one. The keys are
 * listed in the status bar, so the editor itself shows no hint.
 */
OVS.define('ui/inline-editor', (require) => {
  'use strict';

  const { h } = require('util/dom');
  const { lastChar } = require('util/format');

  /**
   * @param {object} o
   *   value       initial value
   *   isNew       styles the editor for a character being inserted
   *   label       accessible name
   *   onCommit    (value, advance: 0 | 1 | -1) => void
   *   onCancel    () => void
   * @returns {{ node: HTMLInputElement, focus(), close(), hasFocus() }}  close() removes it without committing
   */
  function createCharEditor(o) {
    let done = false;
    const input = h('input', {
      class: 'ch-input' + (o.isNew ? ' new' : ''),
      value: o.value || '',
      attrs: { 'aria-label': o.label, autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' }
    });

    const finish = (fn) => { if (done) return; done = true; fn(); };

    input.addEventListener('input', () => { input.value = lastChar(input.value); });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(() => o.onCommit(input.value, 0)); }
      else if (e.key === 'Tab') { e.preventDefault(); finish(() => o.onCommit(input.value, e.shiftKey ? -1 : 1)); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(() => o.onCancel()); }
    });
    input.addEventListener('blur', () => {
      // The window lost focus (another app, a dev-tools click): the input keeps
      // focus inside the page, so the edit simply continues when the user returns.
      if (document.activeElement === input) return;
      finish(() => o.onCancel());
    });

    return {
      node: input,
      focus() { input.focus({ preventScroll: true }); input.select(); },
      /** Remove without committing (the store already ended editing). */
      close() { done = true; input.remove(); },
      hasFocus: () => document.activeElement === input
    };
  }

  return { createCharEditor };
});
