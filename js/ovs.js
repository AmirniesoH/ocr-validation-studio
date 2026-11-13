/**
 * OCR Validation Studio: module system.
 *
 * The app ships as plain <script> files so it runs straight from disk
 * (double-clicking index.html), where browsers refuse ES modules. This file
 * gives those scripts explicit, named dependencies instead of a pile of globals:
 *
 *   OVS.define('model/review', (require) => {
 *     const { clamp } = require('util/format');
 *     return { isPending, ... };          // the module's public API
 *   });
 *
 *   const review = OVS.require('model/review');
 *
 * Factories run lazily, the first time a module is required, so the order of
 * <script> tags does not matter as long as every file is loaded before the app
 * starts. Circular dependencies are reported with the full chain.
 */
(function () {
  'use strict';

  const factories = new Map();
  const instances = new Map();
  const resolving = [];

  function define(name, factory) {
    if (factories.has(name)) throw new Error('Module "' + name + '" is defined twice.');
    factories.set(name, factory);
  }

  function require(name) {
    if (instances.has(name)) return instances.get(name);
    const factory = factories.get(name);
    if (!factory) throw new Error('Unknown module "' + name + '". Check that its <script> tag is in index.html.');
    if (resolving.includes(name)) throw new Error('Circular dependency: ' + resolving.concat(name).join(' → '));
    resolving.push(name);
    try {
      const api = factory(require);
      instances.set(name, api);
      return api;
    } finally {
      resolving.pop();
    }
  }

  window.OVS = { version: '2.0.0', define, require, modules: () => Array.from(factories.keys()) };
})();
