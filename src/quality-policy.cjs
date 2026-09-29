"use strict";
const U = require("./utils.cjs");
function codec(value) {
  const s = String(value || "").toLowerCase();
  return /h265|hevc|hvc1|hev1/.test(s) ? "h265" : /h264|avc/.test(s) ? "h264" : /av1|av01/.test(s) ? "av1" : "";
}
function describe(v) {
  return { width: Number(v.width) || 0, height: Number(v.height) || 0, fps: Number(v.fps) || 0,
    bitrate: Number(v.bitrate) || 0, codec: codec(v.codec || v.codecType), format: String(v.format || "").toUpperCase(),
    definition: v.gear || v.definition || v.gearName || "" };
}
function resolution(v) {
  const d = describe(v), match = /(?:^|_)(4320|2160|1440|1080|960|720|540|480|360|240)(?:_|$)/.exec(d.definition);
  return match ? Number(match[1]) : Math.min(d.width, d.height);
}
function label(v) { return v ? (resolution(v) || "?") + "P" : "未知"; }
function playable(list, support) {
  return list.filter(v => { const d = describe(v); return d.width > 0 && d.height > 0 && support[d.codec] && ["MP4", "DASH"].includes(d.format); });
}
function levels(list, support) { return [...new Set(playable(list, support).map(resolution))].sort((a, b) => b - a); }
function choose(list, support, quality = "highest") {
  if (quality === "auto") return null;
  let valid = playable(list, support);
  const target = Number(quality);
  if (target > 0 && valid.length) {
    const lower = valid.filter(v => resolution(v) <= target);
    // Use the best lower tier; if none exists, the lowest offered tier keeps playback available.
    const tier = lower.length ? Math.max(...lower.map(resolution)) : Math.min(...valid.map(resolution));
    valid = valid.filter(v => resolution(v) === tier);
  }
  return valid.sort((a, b) => {
    const x = describe(a), y = describe(b);
    return resolution(b) - resolution(a) || y.width * y.height - x.width * x.height || y.fps - x.fps ||
      ({ h265: 2, av1: 1, h264: 0 }[y.codec] - { h265: 2, av1: 1, h264: 0 }[x.codec]) || y.bitrate - x.bitrate;
  })[0] || null;
}
function key(v) { return v ? [v.fileId || "", v.definition || v.gearName || "", v.codecType, v.format, v.bitrate, (v.url || [])[0]].join("|") : ""; }
function findPlayer(video) {
  const wrapper = video.closest('[id^="xgwrapper-"]');
  if (!wrapper) return null;
  const name = Object.keys(wrapper).find(k => k.startsWith("__reactFiber$"));
  let fiber = name && wrapper[name];
  const valid = p => p && p.playerType === "NEW_TT" && Array.isArray(p.bitrateList) && typeof p.changeVideo === "function" && typeof p._init === "function" && p.config?.videoInfo;
  for (let level = 0; fiber && level < 8; level++, fiber = fiber.return) {
    const direct = fiber.memoizedProps && fiber.memoizedProps.player;
    if (valid(direct)) return direct;
    let hook = fiber.memoizedState;
    for (let i = 0; hook && i < 32; i++, hook = hook.next) if (valid(hook.memoizedState?.current)) return hook.memoizedState.current;
  }
  return null;
}
function playbackConfig(config, element) {
  return { ...config, playerConfig: { ...config.playerConfig, startTime: element.currentTime || 0,
    autoplay: !element.paused, volume: element.volume, muted: element.muted, playbackRate: element.playbackRate } };
}
class QualityPolicy {
  constructor(root, settings) {
    this.root = root; this.settings = settings; this.hooks = new Map(); this.originals = new WeakMap(); this.prepared = new WeakMap();
    this.attempts = new WeakMap(); this.players = new Set(); this.records = new Map(); this.failed = new Set(); this.closed = false; this.armed = false;
    const element = root.document.createElement("video"), supports = type => {
      try { return !!(root.MediaSource?.isTypeSupported(type) || element.canPlayType(type)); } catch (_) { return false; }
    };
    this.support = { h264: supports('video/mp4; codecs="avc1.640028"'), h265: supports('video/mp4; codecs="hvc1.1.6.L153.B0"'), av1: supports('video/mp4; codecs="av01.0.08M.08"') };
  }
  get mode() { return U.qualityMode(this.settings()); }
  get enabled() { return this.armed && !this.closed && this.settings().enabled && this.mode !== "auto"; }
  get available() { return this.enabled && this.hooks.size > 0; }
  levels(id) {
    const player = [...this.players].find(p => String(p.vid) === String(id));
    const info = player && this.originals.get(player)?.videoInfo;
    return levels(info?.bitrateList || [], this.support);
  }
  record(id, data) {
    this.records.set(String(id), { ...this.records.get(String(id)), ...data });
    while (this.records.size > 200) this.records.delete(this.records.keys().next().value);
  }
  prepare(config) {
    if (!this.enabled || !config?.videoInfo || !Array.isArray(config.videoInfo.bitrateList)) return config;
    const info = config.videoInfo, best = choose(info.bitrateList, this.support, this.mode);
    if (this.failed.has(String(info.vid))) return config;
    if (!best) return config;
    let audio = info.audioBitrateList || [];
    if (String(best.format).toUpperCase() === "DASH") {
      const fileId = best.mediaExtra?.audioFileId;
      audio = audio.filter(a => fileId && a.fileId === fileId);
      if (!audio.length) return config;
    }
    const result = { ...config,
      videoInfo: { ...info, ...best, bitrateList: [best], audioBitrateList: audio },
      playerConfig: { ...config.playerConfig, codecType: best.codecType, format: best.format } };
    this.prepared.set(result, config);
    return result;
  }
  hook(player) {
    const proto = Object.getPrototypeOf(player);
    if (this.hooks.has(proto)) return;
    const original = proto._init;
    if (typeof original !== "function") return;
    const policy = this;
    function wrapped(config) {
      const source = policy.prepared.get(config) || config;
      policy.originals.set(this, source);
      const next = policy.prepare(source);
      const result = original.call(this, next);
      if (next !== source) {
        const best = next.videoInfo.bitrateList[0], id = source.videoInfo.vid;
        policy.record(id, { status: key(this.curBitrate) === key(best) ? "locked" : "fallback", label: label(best), definition: best.definition });
        policy.attempts.set(this, String(id) + "|" + key(best));
      }
      return result;
    }
    proto._init = wrapped; this.hooks.set(proto, { original, wrapped });
  }
  scan(videos) {
    const players = new Set();
    for (const element of videos) {
      let player;
      try { player = findPlayer(element); } catch (_) { continue; }
      if (!player || player.element !== element || !player.vid) continue;
      players.add(player); this.hook(player);
      if (!this.originals.has(player)) this.originals.set(player, player.config);
      if (!this.enabled) continue;
      const source = this.originals.get(player);
      if (String(source?.videoInfo?.vid) !== String(player.vid)) { this.originals.set(player, player.config); continue; }
      const id = String(player.vid);
      if (this.failed.has(id)) continue;
      if (element.error || player.player?.error) {
        this.failed.add(id); if (this.failed.size > 200) this.failed.delete(this.failed.values().next().value);
        this.record(id, { status: "fallback", label: "原生自动" });
        try { player.changeVideo(playbackConfig(source, element), player.state, true); } catch (_) {}
        continue;
      }
      const next = this.prepare(source);
      if (next === source) { this.record(player.vid, { status: "unsupported", label: "未知" }); continue; }
      const best = next.videoInfo.bitrateList[0], wanted = String(player.vid) + "|" + key(best);
      if (key(player.curBitrate) === key(best)) {
        this.record(player.vid, { status: "locked", label: label(best), definition: best.definition });
        continue;
      }
      if (this.attempts.get(player) === wanted) { this.record(player.vid, { status: "fallback", label: label(best) }); continue; }
      this.attempts.set(player, wanted);
      try {
        // Invoke the site's existing reset/load path, preserving its element, controls and playback state.
        player.changeVideo(playbackConfig(source, element), player.state, true);
      } catch (_) { this.record(player.vid, { status: "fallback", label: label(best) }); }
    }
    this.players = players;
  }
  update(previous, next) {
    const before = U.qualityMode(previous), after = U.qualityMode(next);
    if (before === after && previous.enabled === next.enabled) return;
    this.records.clear(); this.failed.clear(); this.attempts = new WeakMap();
    // Fixed-tier changes are applied by the following scan; auto/off restores the full native list.
    if (!(previous.enabled && before !== "auto") || next.enabled && after !== "auto") return;
    for (const player of this.players) {
      const source = this.originals.get(player), element = player.element;
      if (!source || !element || String(source.videoInfo?.vid) !== String(player.vid)) continue;
      try { player.changeVideo(playbackConfig(source, element), player.state, true); } catch (_) {}
    }
  }
  status(id) {
    if (!this.enabled) return { status: "native", label: "原生自动" };
    return this.records.get(String(id)) || { status: this.available ? "planned" : "unavailable", label: "等待播放器" };
  }
  dispose() {
    this.closed = true;
    for (const [proto, value] of this.hooks) if (proto._init === value.wrapped) proto._init = value.original;
    this.hooks.clear(); this.players.clear();
  }
}
module.exports = { QualityPolicy, choose, label, resolution, levels, codec, describe, findPlayer };
