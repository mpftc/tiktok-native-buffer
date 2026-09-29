"use strict";
const U = require("./utils.cjs");
const { RangeEngine } = require("./range-engine.cjs");
const { PageAdapter } = require("./page-adapter.cjs");
const { QualityPolicy } = require("./quality-policy.cjs");
const { installFetch } = require("./fetch-transport.cjs");
const { mountPanel } = require("./panel.cjs");
const STORAGE = "tiktok-native-buffer:settings:v1";
function install(root = window, options = {}) {
  if (root.__TikTokNativeBuffer) return root.__TikTokNativeBuffer;
  let saved = {};
  if (options.persist !== false) try { saved = JSON.parse(root.localStorage.getItem(STORAGE) || "{}"); } catch (_) {}
  const settings = U.normalize({ ...saved, ...options.settings }), original = root.fetch;
  const engine = new RangeEngine(original.bind(root), settings), quality = new QualityPolicy(root, () => engine.settings), adapter = new PageAdapter(root, engine, quality);
  const restore = installFetch(root, engine, adapter, original);
  quality.armed = true; adapter.refresh();
  let disposePanel = () => {}, stopped = false;
  const api = {
    getStatus: () => adapter.snapshot(),
    getSettings: () => ({ ...engine.settings }),
    setSettings: changes => {
      if (stopped) return;
      const previous = engine.settings;
      const patch = { ...changes };
      // Accept the previous public toggle without letting its saved value override the new selector.
      if (!("quality" in patch) && typeof patch.highestQuality === "boolean") patch.quality = patch.highestQuality ? "highest" : "auto";
      adapter.cancelPrefetch(); engine.update(U.normalize({ ...engine.settings, ...patch }));
      if (U.qualityMode(previous) !== U.qualityMode(engine.settings) || previous.enabled !== engine.settings.enabled) adapter.qualityChanged();
      quality.update(previous, engine.settings); adapter.refresh();
      if (options.persist !== false) try { root.localStorage.setItem(STORAGE, JSON.stringify(engine.settings)); } catch (_) {}
      return api.getSettings();
    },
    clearCache: () => { adapter.cancelPrefetch(); engine.store.clear(); },
    stop: () => {
      if (stopped) return; stopped = true;
      // Existing streaming consumers finish under their captured engine; future requests pass through.
      const previous = { ...engine.settings };
      engine.settings.enabled = false; quality.update(previous, engine.settings); quality.dispose(); adapter.dispose(); restore(); disposePanel();
      const release = root.setInterval(() => { engine.store.clear(); if (!engine.openStreams && !engine.scheduler.active.size && !engine.scheduler.queue.length) { root.clearInterval(release); engine.stop(); } }, 500);
      delete root.__TikTokNativeBuffer;
    }
  };
  Object.defineProperty(root, "__TikTokNativeBuffer", { value: api, configurable: true });
  const mount = () => { if (!stopped && options.panel !== false) disposePanel = mountPanel(root, api); };
  if (root.document.body) mount(); else root.document.addEventListener("DOMContentLoaded", mount, { once: true });
  return api;
}
module.exports = { install };
