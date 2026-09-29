"use strict";
const U = require("./utils.cjs");
const M = require("./media-index.cjs");
const Q = require("./quality-policy.cjs");
function json(value) { try { return typeof value === "string" ? JSON.parse(value) : value || {}; } catch (_) { return {}; } }
function urls(value) {
  return (Array.isArray(value) ? value : typeof value === "string" ? [value] : value && typeof value === "object" ? [value.MainUrl, value.BackupUrl, value.FallbackUrl] : []).filter(U.mediaUrl);
}
function itemList(payload) {
  const out = [], seen = new Set();
  function walk(x, depth) {
    if (!x || typeof x !== "object" || depth > 8 || seen.has(x) || seen.size > 10000) return;
    seen.add(x);
    if (x.id && x.video && typeof x.video === "object") { out.push(x); return; }
    if (Array.isArray(x)) { for (const v of x) walk(v, depth + 1); return; }
    for (const key of ["itemList", "item_list", "itemInfo", "itemStruct", "items", "data", "aweme_list"]) if (x[key]) walk(x[key], depth + 1);
  }
  walk(payload, 0); return out;
}
function model(item) {
  const video = item.video, audios = new Map(), variants = [];
  for (const a of video.bitrateAudioInfo || []) {
    const addresses = urls(a.UrlList);
    if (addresses.length) audios.set(a.FileId || a.FileHash, { urls: addresses, fileId: a.FileId || a.FileHash, role: "audio", bytes: Number(a.AudioDataSize) || null });
  }
  for (const b of video.bitrateInfo || []) {
    const addresses = urls(b.PlayAddr && b.PlayAddr.UrlList);
    if (!addresses.length) continue;
    const extra = json(b.VideoExtra), audio = audios.get(extra.audio_file_id);
    if (b.Format === "dash" && !audio) continue;
    variants.push({
      key: b.PlayAddr.UrlKey || b.GearName + "|" + addresses[0], gear: b.GearName, codec: b.CodecType, format: b.Format,
      width: Number(b.PlayAddr.Width) || 0, height: Number(b.PlayAddr.Height) || 0, bitrate: Number(b.Bitrate) || 0, fps: Number(b.BitrateFPS) || 0,
      video: { urls: addresses, role: b.Format === "dash" ? "video" : "muxed", fileId: b.PlayAddr.FileHash, bytes: Number(b.PlayAddr.DataSize) || null },
      audio: audio || null, packetMap: json(extra.PktOffsetMap), actualVideo: null, actualAudio: null
    });
  }
  if (!variants.length && U.mediaUrl(video.playAddr)) variants.push({
    key: "default", gear: "default", codec: video.codecType, format: "mp4",
    video: { urls: [video.playAddr], role: "muxed" }, audio: null, actualVideo: null, actualAudio: null
  });
  return { id: String(item.id), duration: Number(video.duration) || 0, variants, selected: null, node: null, position: null, lastVisit: 0, nativeVersion: null };
}
class PageAdapter {
  constructor(root, engine, quality = null) {
    this.quality = quality;
    this.root = root; this.engine = engine; this.items = new Map(); this.order = []; this.byUrl = new Map(); this.byPath = new Map();
    this.active = null; this.generation = 0; this.changedAt = Date.now(); this.lastError = ""; this.hydrationRead = false;
    this.prefetchController = new AbortController(); this.busy = false; this.destroyed = false;
    this.workTurn = 0; this.retryAt = 0;
    this.onRefresh = event => { if (event && ["seeking", "ratechange"].includes(event.type)) { this.changedAt = Date.now(); this.cancelPrefetch(); } this.refresh(); };
    for (const event of ["play", "seeking", "ratechange"]) root.document.addEventListener(event, this.onRefresh, true);
    this.visibility = () => { if (root.document.hidden) this.cancelPrefetch(); };
    root.document.addEventListener("visibilitychange", this.visibility);
    this.timer = root.setInterval(() => { this.refresh(); this.plan(); }, 500);
    this.refresh();
  }
  isFeed(value) {
    try { const u = new URL(value); return u.origin === this.root.location.origin && /^\/api\/(?:recommend\/item_list|item\/detail|post\/item_list|related\/item_list|following\/item_list|search\/item|search\/general|favorite\/item_list|mix\/item_list)\//.test(u.pathname); } catch (_) { return false; }
  }
  async observeResponse(response) {
    if (!response.ok || !/json/i.test(response.headers.get("content-type") || "") || Number(response.headers.get("content-length")) > 4 * U.MiB) return;
    let reader;
    try {
      reader = response.clone().body.getReader(); const chunks = []; let size = 0;
      while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength; if (size > 4 * U.MiB) { reader.cancel().catch(() => {}); return; }
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      this.ingest(JSON.parse(new TextDecoder().decode(bytes)));
    } catch (_) {} finally { if (reader) try { reader.releaseLock(); } catch (_) {} }
  }
  ingest(payload) {
    for (const raw of itemList(payload)) {
      let next;
      try { next = model(raw); } catch (_) { continue; }
      const old = this.items.get(next.id);
      if (old) {
        for (const v of next.variants) if (!old.variants.some(x => x.key === v.key && x.video.urls[0] === v.video.urls[0])) old.variants.push(v);
      } else { this.items.set(next.id, next); this.order.push(next.id); }
      const item = old || next;
      for (const variant of item.variants) for (const asset of [variant.video, variant.audio].filter(Boolean)) for (const url of asset.urls) {
        const mapping = { item, variant, asset };
        this.byUrl.set(url, mapping);
        const u = new URL(url), key = u.host + u.pathname;
        if (!this.byPath.has(key)) this.byPath.set(key, []);
        const list = this.byPath.get(key);
        if (!list.some(x => x.item.id === item.id && x.variant.key === variant.key && x.asset.role === asset.role)) list.push(mapping);
      }
    }
    for (const r of this.engine.resources.values()) if (!r.itemId && r.observed) this.associate(r);
  }
  associate(resource) {
    let matches = this.byUrl.has(resource.url) ? [this.byUrl.get(resource.url)] : [];
    if (!matches.length) { const u = new URL(resource.url); matches = this.byPath.get(u.host + u.pathname) || []; }
    const ids = new Set(matches.map(x => x.item.id));
    if (ids.size !== 1) return;
    const mapping = matches.find(x => x.asset.role !== "audio") || matches.find(x => x.item.selected === x.variant) || matches[0];
    const { item, variant, asset } = mapping; resource.itemId = item.id; resource.role = asset.role;
    if (asset.role === "audio") {
      for (const v of item.variants) if (v.audio && v.audio.fileId === asset.fileId) v.actualAudio = resource;
    } else {
      if (item.selected !== variant || variant.actualVideo && variant.actualVideo !== resource) {
        item.selected = variant; item.nativeVersion = null; item.selectedAt = Date.now(); this.changedAt = Date.now(); this.generation++; this.cancelPrefetch();
      }
      variant.actualVideo = resource;
    }
  }
  onNativeRequest(resource, range) {
    resource.observed = true; resource.lastRequested = range.start; this.associate(resource);
  }
  selectedResources(item) {
    let v = item && item.selected;
    if (item && this.quality?.available && !["fallback", "unsupported"].includes(this.quality.status(item.id).status)) {
      item.preferred = Q.choose(item.variants, this.quality.support, U.qualityMode(this.engine.settings));
      if (item.preferred) {
        v = item.preferred;
        if (!v.actualVideo || !this.engine.resources.has(v.actualVideo.key)) {
          v.actualVideo = this.engine.resource(v.video.urls[0], { credentials: "include", mode: "cors", referrer: "about:client", cache: "default" });
          v.actualVideo.itemId = item.id; v.actualVideo.role = v.video.role;
        }
      }
    } else if (item) item.preferred = null;
    if (!v || !v.actualVideo || !this.engine.resources.has(v.actualVideo.key)) return [];
    if (v.actualAudio && !this.engine.resources.has(v.actualAudio.key)) v.actualAudio = null;
    const list = [v.actualVideo];
    if (v.audio) {
      if (!v.actualAudio) {
        const template = v.actualVideo.template;
        v.actualAudio = this.engine.resource(v.audio.urls[0], { credentials: template.credentials || "include", mode: template.mode || "cors",
          referrer: template.referrer || "about:client", referrerPolicy: template.referrerPolicy || "", cache: template.cache || "default" });
        v.actualAudio.itemId = item.id; v.actualAudio.role = "audio";
      }
      list.push(v.actualAudio);
    }
    return list;
  }
  cancelPrefetch() {
    this.prefetchController.abort(U.abortError("Plan changed")); this.prefetchController = new AbortController();
    this.engine.scheduler.cancelBackground();
  }
  qualityChanged() {
    this.generation++; this.changedAt = Date.now();
    for (const item of this.items.values()) { item.preferred = null; item.nativeVersion = null; item.selectedAt = Date.now(); }
  }
  refresh() {
    if (this.destroyed) return;
    const doc = this.root.document;
    if (!this.hydrationRead) {
      const el = doc.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
      if (el && el.textContent) {
        const scope = json(el.textContent).__DEFAULT_SCOPE__ || {};
        this.ingest(scope["webapp.updated-items"] || []);
        this.ingest(scope["webapp.video-detail"] || {});
        this.hydrationRead = true;
      }
    }
    const videos = [...doc.querySelectorAll("video")];
    if (this.quality) this.quality.scan(videos);
    for (const item of this.items.values()) item.node = null;
    const candidates = [];
    for (const node of videos) {
      const wrapper = node.closest('[id^="xgwrapper-"]'), match = wrapper && /-(\d{15,25})$/.exec(wrapper.id);
      if (!match) continue;
      const item = this.items.get(match[1]); if (!item) continue;
      const article = wrapper.closest("[data-scroll-index]");
      if (article) item.position = Number(article.getAttribute("data-scroll-index"));
      item.node = node;
      const rect = node.getBoundingClientRect(), visible = Math.max(0, Math.min(rect.bottom, this.root.innerHeight) - Math.max(0, rect.top)) * Math.max(0, Math.min(rect.right, this.root.innerWidth) - Math.max(0, rect.left));
      if (visible > 0) candidates.push({ item, score: visible + (!node.paused ? 1e9 : 0) });
      if (item.selected && !item.nativeVersion && node.readyState >= 2 && Date.now() - item.selectedAt > 1000) item.nativeVersion = item.selected;
    }
    candidates.sort((a, b) => b.score - a.score);
    const next = candidates[0] && candidates[0].item || null;
    if (next !== this.active) {
      if (this.active) this.active.lastVisit = Date.now();
      this.active = next; this.changedAt = Date.now(); this.generation++; this.cancelPrefetch();
    }
    const live = this.windowItems(), keep = new Map();
    if (next) keep.set(next.id, 0);
    live.next.forEach((x, i) => keep.set(x.id, 100 + i));
    live.history.forEach((x, i) => keep.set(x.id, 20 + i));
    for (const resource of this.engine.resources.values()) resource.rank = keep.has(resource.itemId) ? keep.get(resource.itemId) : 1000;
    this.engine.store.clear(r => r.rank === 1000 && Date.now() - r.lastSeen > 30000);
    // Metadata is bounded too; byte identity remains the complete signed URL.
    for (const [key, r] of this.engine.resources) if (r.rank === 1000 && !r.blocks.length && !r.tasks.size && Date.now() - r.lastSeen > 60000) this.engine.resources.delete(key);
    if (this.items.size > 150) {
      const activeIndex = this.active ? this.order.indexOf(this.active.id) : -1;
      const discard = new Set(this.order.slice(0, Math.max(0, activeIndex - 5)).filter(id => !keep.has(id)));
      for (const id of discard) this.items.delete(id);
      this.order = this.order.filter(id => !discard.has(id));
      for (const [url, m] of this.byUrl) if (discard.has(m.item.id)) this.byUrl.delete(url);
      for (const [path, list] of this.byPath) { const remaining = list.filter(m => !discard.has(m.item.id)); if (remaining.length) this.byPath.set(path, remaining); else this.byPath.delete(path); }
    }
  }
  windowItems() {
    const index = this.active ? this.order.indexOf(this.active.id) : -1;
    const next = index >= 0 ? this.order.slice(index + 1, index + 1 + this.engine.settings.nextCount).map(id => this.items.get(id)) : [];
    const history = [...this.items.values()].filter(x => x !== this.active && x.lastVisit).sort((a, b) => b.lastVisit - a.lastVisit).slice(0, this.engine.settings.historyCount);
    return { next, history };
  }
  nativeTimes(item) {
    if (this.quality?.enabled && item?.node) {
      const lock = this.quality.status(item.id), v = item.preferred, node = item.node;
      if (v && lock.status === "locked" && lock.definition === v.gear && node.readyState >= 2 &&
        node.videoWidth === v.width && node.videoHeight === v.height) return U.timeRanges(node);
      if (!["fallback", "unsupported"].includes(lock.status)) return [];
    }
    return item && item.node && item.nativeVersion === item.selected ? U.timeRanges(item.node) : [];
  }
  cachedTimes(item) {
    const resources = this.selectedResources(item);
    if (!resources.length) return [];
    if (resources.some(r => !r.index)) return item.duration > 0 && resources.every(r => r.total && this.engine.store.has(r, 0, r.total - 1)) ? [[0, item.duration]] : [];
    return resources.map(r => M.cachedTimes(this.engine, r)).reduce(U.intersect);
  }
  available(item) { return U.mergeIntervals([...this.nativeTimes(item), ...this.cachedTimes(item)]); }
  statusItem(item, seconds) {
    const resources = this.selectedResources(item), native = this.nativeTimes(item), start = native[0] ? Math.max(0, Math.min(native[0][0], 0.15)) : 0;
    const target = Math.min(seconds, item.duration || seconds);
    if (U.ahead(native, start) >= target - 0.2) return "原生已缓冲";
    if (!resources.length) return this.quality?.enabled ? (this.quality.available ? "等待可用视频地址" : "等待播放器就绪") : "尚未预缓存 · 等待原生版本";
    if (U.ahead(this.available(item), start) >= target - 0.2) return "开头已准备";
    if (resources.some(r => r.indexTried && !r.index)) return "按字节准备 · 时长未知";
    if (resources.some(r => r.blocks.length)) return "部分准备";
    return "准备中";
  }
  async plan() {
    const current = this.active, config = this.engine.settings;
    if (this.destroyed || this.busy || !config.enabled || this.root.document.hidden || !current || !current.node || current.node.paused || Date.now() < this.retryAt || Date.now() - this.changedAt < 350) return;
    const node = current.node, nativeAhead = U.ahead(this.nativeTimes(current), node.currentTime), next = this.windowItems().next;
    const currentGoal = { item: current, from: node.currentTime, seconds: config.aheadSeconds, cap: Infinity, priority: nativeAhead / Math.max(0.25, node.playbackRate) < 12 ? 10 : 13 };
    const goals = [currentGoal, ...next.map((item, i) => ({ item, from: 0,
      seconds: !["开头已准备", "原生已缓冲"].includes(this.statusItem(item, 3)) ? Math.min(3, config.nextSeconds) : config.nextSeconds,
      cap: config.nextMiB * U.MiB, priority: i === 0 ? (this.workTurn % 4 === 3 ? 12 : 14) : 16 + i }))].sort((a, b) => a.priority - b.priority);
    // Once the next video's small startup window is ready, continue its full target.
    if (next[0]) goals.push({ item: next[0], from: 0, seconds: config.nextSeconds, cap: config.nextMiB * U.MiB, priority: 14 });
    const signal = this.prefetchController.signal;
    for (const goal of goals) {
      if (U.ahead(this.nativeTimes(goal.item), goal.from) >= Math.min(goal.seconds, Math.max(0, goal.item.duration - goal.from)) - 0.2) continue;
      const resources = this.selectedResources(goal.item);
      if (!resources.length) continue;
      if (resources.some(r => r.poisoned || r.bypassUntil > Date.now() || (this.engine.hostCooldown.get(new URL(r.url).host) || 0) > Date.now())) continue;
      for (const r of resources) {
        if (!r.indexTried) { this.runWork(() => M.loadIndex(this.engine, r, signal, goal.priority)); return; }
      }
      const plans = [];
      for (const r of resources) {
        let ranges = M.rangesFor(r.index, goal.from, goal.from + goal.seconds);
        if (!ranges) {
          const start = goal.item === current ? r.lastRequested || 0 : 0;
          const limit = goal.item === current ? U.MiB : goal.cap;
          ranges = [[start, Math.min((r.total || start + limit) - 1, start + limit - 1)]];
        }
        if (r.index && ranges.length) {
          const native = this.nativeTimes(goal.item), covered = f => native.some(t => t[0] <= f.from + 0.001 && t[1] >= f.to - 0.001);
          // Skip complete native fragments, preserving decode predecessors for any missing fragment.
          const selected = r.index.fragments.filter(f => f.start >= ranges[1][0] && f.end <= ranges[1][1]);
          const needed = new Set();
          selected.forEach((f, i) => { if (!covered(f)) { let j = i; while (j > 0 && !selected[j].sap) j--; for (; j <= i; j++) needed.add(selected[j]); } });
          if (needed.size) { plans.push({ r, range: ranges[0], init: true }); for (const f of needed) plans.push({ r, range: [f.start, f.end], init: false }); }
        } else ranges.forEach(range => plans.push({ r, range, init: false }));
      }
      plans.sort((a, b) => Number(b.init) - Number(a.init) || (a.r.role === "audio" ? -1 : 1));
      let allowance = goal.cap;
      for (const plan of plans) {
        if (allowance <= 0) break;
        const [start, rawEnd] = plan.range, end = Math.min(rawEnd, start + allowance - 1);
        allowance -= end - start + 1;
        let p = start;
        while (p <= end) {
          const block = this.engine.store.cover(plan.r, p);
          if (block) { p = block.end + 1; continue; }
          const last = Math.min(end, p + this.engine.chunkSize - 1);
          this.runWork(async () => { const lease = await this.engine.read(plan.r, p, last, { signal, priority: goal.priority }); lease.release(); });
          return;
        }
      }
    }
  }
  runWork(work) {
    this.busy = true; this.workTurn++;
    Promise.resolve().then(work).catch(e => {
      if (e.name !== "AbortError") { this.retryAt = Date.now() + 2000; if (e.code !== "BUDGET") this.lastError = e.code || "PREFETCH"; }
    }).finally(() => {
      this.busy = false;
      if (!this.destroyed) this.root.setTimeout(() => this.plan(), 80);
    });
  }
  snapshot() {
    const current = this.active, node = current && current.node, next = this.windowItems().next;
    const currentResources = this.selectedResources(current);
    const qualityLevels = this.quality ? [...new Set([...this.quality.levels(current?.id), ...Q.levels(current?.variants || [], this.quality.support)])].sort((a, b) => b - a) : [];
    const statuses = next.map(x => {
      const status = this.statusItem(x, this.engine.settings.nextSeconds);
      const lock = this.quality?.status(x.id).status || "native";
      return { id: x.id, status, quality: lock === "fallback" ? "原生回退" : this.quality?.enabled && x.preferred ? Q.label(x.preferred) : "", lock };
    });
    return {
      version: "0.3.0", enabled: this.engine.settings.enabled, maxConcurrency: 8,
      qualityTarget: U.qualityMode(this.engine.settings), qualityLevels,
      highestQuality: this.engine.settings.highestQuality, quality: this.quality?.status(current && current.id) || { status: "native", label: "原生自动" },
      concurrency: this.engine.scheduler.limit, activeRequests: this.engine.scheduler.active.size, peakRequests: this.engine.scheduler.peak,
      budgetBytes: this.engine.store.limit, residentBytes: this.engine.store.used, reservedBytes: this.engine.store.reserved, peakBytes: this.engine.store.peak,
      currentId: current && current.id, currentTime: node ? node.currentTime : 0,
      currentIndex: currentResources.map(r => ({ role: r.role, indexed: !!r.index, checked: r.indexTried, complete: !!r.total && this.engine.store.has(r, 0, r.total - 1), reason: r.indexError || "" })),
      nativeAhead: node ? U.ahead(U.timeRanges(node), node.currentTime) : 0,
      preparedAhead: node ? U.ahead(this.available(current), node.currentTime) : 0,
      nextTarget: this.engine.settings.nextCount, nextAvailable: next.length,
      nextReady: statuses.filter(x => ["开头已准备", "原生已缓冲"].includes(x.status)).length, next: statuses,
      historyKept: this.windowItems().history.length, lastError: this.lastError,
      backgroundPaused: this.root.document.hidden, resources: this.engine.resources.size,
      ...this.engine.stats, wastedPrefetch: this.engine.store.evictedUnused
    };
  }
  dispose() {
    this.destroyed = true; this.root.clearInterval(this.timer); this.cancelPrefetch();
    for (const event of ["play", "seeking", "ratechange"]) this.root.document.removeEventListener(event, this.onRefresh, true);
    this.root.document.removeEventListener("visibilitychange", this.visibility);
  }
}
module.exports = { PageAdapter, itemList, model };
