/**
 * Timing helpers.
 */
OVS.define('util/async', () => {
  'use strict';

  /** Call fn once, ms after the last call. wrapped.flush() runs it now; wrapped.cancel() drops it. */
  function debounce(fn, ms) {
    let timer = null;
    const wrapped = (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
    wrapped.cancel = () => clearTimeout(timer);
    wrapped.flush = (...args) => { clearTimeout(timer); fn(...args); };
    return wrapped;
  }

  /** Call fn at most once per animation frame, with the latest arguments. */
  function rafThrottle(fn) {
    let queued = false, lastArgs = [];
    return (...args) => {
      lastArgs = args;
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; fn(...lastArgs); });
    };
  }

  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

  /**
   * Map items through an async fn with at most `limit` calls running at once.
   * Results keep the input order; a rejected call rejects the whole map.
   */
  async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => { while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); } };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
  }

  return { debounce, rafThrottle, nextFrame, mapLimit };
});
