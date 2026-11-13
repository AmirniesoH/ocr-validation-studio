/**
 * Tooltips for any element with a data-tip attribute.
 *
 *   <button data-tip="Close">               shown below the element
 *   <button data-tip-up="Zoom in">          shown above
 *   <button data-tip="…" data-tip-side="right">   shown to the right
 *   <td data-tip-overflow="full text">     shown only while the element's text is cut
 *                                          off (ellipsis); the value defaults to its text
 *
 * One tooltip element lives at the top of the page (position: fixed, highest
 * layer), so it is never clipped by a scrolling list or covered by the
 * neighbouring pane. It flips to the other side when there is no room and is
 * kept inside the window. The text is re-read while it is shown, so a label
 * that changes on click ("Click again to close") updates in place.
 *
 * Tooltips are skipped for touch input and for open menu buttons (aria-expanded).
 */
OVS.define('ui/tooltip', (require) => {
  'use strict';

  const { h } = require('util/dom');

  const SELECTOR = '[data-tip], [data-tip-up], [data-tip-overflow]';
  const GAP = 7;      // distance from the element
  const MARGIN = 8;   // minimum distance from the window edge
  const DELAY = 250;  // ms before showing

  function bindTooltips() {
    const tip = h('div', { class: 'tooltip', attrs: { role: 'tooltip', 'aria-hidden': 'true' } });
    document.body.appendChild(tip);

    let target = null;  // element the tooltip belongs to
    let timer = null;
    let frame = null;

    const clipped = (el) => el.scrollWidth - el.clientWidth > 1;
    /** Whether the element, or one of its children, is cut off. */
    const truncated = (el) => clipped(el) || Array.prototype.some.call(el.children, clipped);
    const isOverflowTip = (el) => el.hasAttribute('data-tip-overflow') && !el.hasAttribute('data-tip') && !el.hasAttribute('data-tip-up');
    const textOf = (el) => {
      if (isOverflowTip(el)) return truncated(el) ? (el.getAttribute('data-tip-overflow') || el.textContent.trim()) : '';
      return el.getAttribute('data-tip') || el.getAttribute('data-tip-up') || '';
    };
    const sideOf = (el) => el.getAttribute('data-tip-side') || (el.hasAttribute('data-tip-up') ? 'top' : 'bottom');
    const suppressed = (el) => el.getAttribute('aria-expanded') === 'true' || !textOf(el);

    /** Place the tooltip next to the element, flipping and clamping to fit the window. */
    function place() {
      const r = target.getBoundingClientRect();
      const w = tip.offsetWidth, ht = tip.offsetHeight;
      const vw = window.innerWidth, vh = window.innerHeight;
      let side = sideOf(target);
      const fits = {
        bottom: r.bottom + GAP + ht <= vh - MARGIN,
        top: r.top - GAP - ht >= MARGIN,
        right: r.right + GAP + w <= vw - MARGIN,
        left: r.left - GAP - w >= MARGIN
      };
      const opposite = { bottom: 'top', top: 'bottom', right: 'left', left: 'right' };
      if (!fits[side] && fits[opposite[side]]) side = opposite[side];

      let x, y;
      if (side === 'top' || side === 'bottom') {
        x = r.left + r.width / 2 - w / 2;
        y = side === 'bottom' ? r.bottom + GAP : r.top - GAP - ht;
      } else {
        x = side === 'right' ? r.right + GAP : r.left - GAP - w;
        y = r.top + r.height / 2 - ht / 2;
      }
      x = Math.max(MARGIN, Math.min(x, vw - MARGIN - w));
      y = Math.max(MARGIN, Math.min(y, vh - MARGIN - ht));
      tip.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
    }

    /** While visible: follow the element, pick up label changes, hide when it goes away. */
    function track() {
      frame = null;
      if (!target) return;
      if (!target.isConnected || suppressed(target)) { hide(); return; }
      const text = textOf(target);
      if (tip.textContent !== text) tip.textContent = text;
      place();
      frame = requestAnimationFrame(track);
    }

    function show(el) {
      target = el;
      tip.textContent = textOf(el);
      tip.classList.toggle('full', isOverflowTip(el)); // full text: wrap rather than cut
      tip.classList.add('on');
      place();
      if (!frame) frame = requestAnimationFrame(track);
    }

    function hide() {
      clearTimeout(timer);
      timer = null;
      target = null;
      tip.classList.remove('on');
      if (frame) { cancelAnimationFrame(frame); frame = null; }
    }

    function enter(el, immediate) {
      if (el === target) return;
      hide();
      if (suppressed(el)) return;
      if (immediate) show(el);
      else { target = el; timer = setTimeout(() => { if (target === el) show(el); }, DELAY); }
    }

    document.addEventListener('pointerover', (e) => {
      if (e.pointerType === 'touch') return;
      const el = e.target.closest && e.target.closest(SELECTOR);
      if (el) enter(el, !!tip.classList.contains('on')); // moving between buttons: no delay
      else if (target) hide();
    });
    document.addEventListener('pointerout', (e) => {
      if (target && !(e.relatedTarget && target.contains(e.relatedTarget))) {
        const into = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest(SELECTOR);
        if (!into) hide();
      }
    });
    // Keyboard users get the tooltip on focus.
    document.addEventListener('focusin', (e) => {
      const el = e.target.closest && e.target.closest(SELECTOR);
      if (el && el.matches(':focus-visible')) enter(el, true);
    });
    document.addEventListener('focusout', () => { if (target && !target.matches(':hover')) hide(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
    document.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
  }

  return { bindTooltips };
});
