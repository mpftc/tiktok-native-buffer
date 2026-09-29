// ==UserScript==
// @name         TikTok Native Buffer
// @namespace    local.tiktok-native-buffer
// @version      0.3.0
// @description  保留 TikTok 原生播放器，自由选择画质，添加 Range 缓存、多视频准备和最多 8 个共享并发请求。
// @homepageURL  https://github.com/mpftc/tiktok-native-buffer
// @supportURL   https://github.com/mpftc/tiktok-native-buffer/issues
// @downloadURL  https://raw.githubusercontent.com/mpftc/tiktok-native-buffer/main/TikTok-Native-Buffer.user.js
// @updateURL    https://raw.githubusercontent.com/mpftc/tiktok-native-buffer/main/TikTok-Native-Buffer.user.js
// @match        https://www.tiktok.com/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @noframes
// @license      MIT
// ==/UserScript==
(function(){"use strict";const modules={
"./utils.cjs":function(module,exports,require){
"use strict";
const MiB = 1024 * 1024;
const DEFAULTS = Object.freeze({ enabled: true, quality: "highest", highestQuality: true, budgetMiB: 256, aheadSeconds: 60, nextCount: 3, nextSeconds: 10, nextMiB: 8, historyCount: 1, concurrency: 0 });
function qualityMode(input = {}) {
  const value = String(input.quality ?? "");
  if (["highest", "auto"].includes(value)) return value;
  if (/^\d{3,4}$/.test(value) && Number(value) >= 120 && Number(value) <= 4320) return String(Number(value));
  return input.highestQuality === false ? "auto" : "highest";
}
function abortError(message = "Canceled") { return new DOMException(message, "AbortError"); }
function error(code, message = code) { const e = new Error(message); e.code = code; return e; }
function checkAbort(signal) { if (signal && signal.aborted) throw signal.reason || abortError(); }
function linkAbort(signal, controller) {
  const cancel = () => controller.abort(signal.reason || abortError());
  if (signal) { if (signal.aborted) cancel(); else signal.addEventListener("abort", cancel, { once: true }); }
  return () => signal && signal.removeEventListener("abort", cancel);
}
function normalize(input = {}) {
  const choose = (name, choices) => choices.includes(Number(input[name])) ? Number(input[name]) : DEFAULTS[name];
  return { enabled: typeof input.enabled === "boolean" ? input.enabled : true,
    quality: qualityMode(input), highestQuality: qualityMode(input) === "highest",
    budgetMiB: choose("budgetMiB", [64, 128, 256, 512]),
    aheadSeconds: choose("aheadSeconds", [15, 30, 60, 120]),
    nextCount: choose("nextCount", [0, 1, 2, 3, 4, 5]),
    nextSeconds: choose("nextSeconds", [5, 10, 15, 30]),
    nextMiB: choose("nextMiB", [2, 4, 8, 16]),
    historyCount: choose("historyCount", [0, 1, 2]),
    concurrency: choose("concurrency", [0, 1, 2, 4, 6, 8]) };
}
function parseRange(value) {
  const m = /^bytes=(\d+)-(\d*)$/i.exec(value || "");
  if (!m) return null;
  const start = Number(m[1]), end = m[2] === "" ? null : Number(m[2]);
  return Number.isSafeInteger(start) && (end === null || Number.isSafeInteger(end) && end >= start) ? { start, end } : null;
}
function contentRange(value) {
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(value || "");
  if (!m) return null;
  const [start, end, total] = m.slice(1).map(Number);
  return [start, end, total].every(Number.isSafeInteger) && start >= 0 && end >= start && total > end ? { start, end, total } : null;
}
function mediaUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && /^v\d+(?:-[a-z0-9]+)*\.(?:tiktok\.com|tiktokcdn\.com|tiktokcdn-us\.com)$/i.test(u.hostname) &&
      /\/video\//.test(u.pathname) && !/webvtt|subtitle|caption/i.test(u.searchParams.get("mime_type") || "");
  } catch (_) { return false; }
}
function mergeIntervals(ranges, epsilon = 0.001) {
  const sorted = ranges.filter(r => Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[1] > r[0]).map(r => r.slice()).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + epsilon) last[1] = Math.max(last[1], r[1]); else out.push(r);
  }
  return out;
}
function intersect(a, b) {
  const out = [];
  for (const x of a) for (const y of b) if (Math.min(x[1], y[1]) > Math.max(x[0], y[0])) out.push([Math.max(x[0], y[0]), Math.min(x[1], y[1])]);
  return mergeIntervals(out);
}
function ahead(ranges, time) {
  const r = mergeIntervals(ranges).find(x => x[0] <= time + 0.15 && x[1] > time);
  return r ? Math.max(0, r[1] - time) : 0;
}
function timeRanges(video) {
  try { return Array.from({ length: video.buffered.length }, (_, i) => [video.buffered.start(i), video.buffered.end(i)]); } catch (_) { return []; }
}
module.exports = { MiB, DEFAULTS, normalize, qualityMode, abortError, error, checkAbort, linkAbort, parseRange, contentRange, mediaUrl, mergeIntervals, intersect, ahead, timeRanges };

},
"./range-engine.cjs":function(module,exports,require){
"use strict";
const U = require("./utils.cjs");
class Scheduler {
  constructor(limit = 2) { this.limit = limit; this.queue = []; this.active = new Set(); this.sequence = 0; this.peak = 0; }
  setLimit(n) { this.limit = Math.max(1, Math.min(8, n)); this.pump(); }
  submit(run, priority, signal) {
    const controller = new AbortController(), unlink = U.linkAbort(signal, controller);
    const row = { run, priority, controller, id: this.sequence++, running: false, done: false };
    const promise = new Promise((resolve, reject) => { row.resolve = resolve; row.reject = reject; });
    const cancel = () => {
      if (row.running || row.done) return;
      row.done = true; this.queue = this.queue.filter(x => x !== row);
      row.cleanup(); row.reject(controller.signal.reason || U.abortError());
    };
    controller.signal.addEventListener("abort", cancel, { once: true });
    row.cleanup = () => { unlink(); controller.signal.removeEventListener("abort", cancel); };
    this.queue.push(row);
    if (priority < 10 && this.active.size >= this.limit) {
      const low = [...this.active].find(x => x.priority >= 10);
      if (low) low.controller.abort(U.abortError("Foreground priority"));
    }
    if (controller.signal.aborted) cancel();
    this.pump();
    return { promise, promote: p => { row.priority = Math.min(row.priority, p); this.pump(); }, cancel: () => controller.abort(U.abortError()) };
  }
  pump() {
    this.queue.sort((a, b) => a.priority - b.priority || a.id - b.id);
    while (this.active.size < this.limit) {
      const backgroundBusy = [...this.active].some(x => x.priority >= 10);
      const i = this.queue.findIndex(x => !x.done && !x.controller.signal.aborted && (x.priority < 10 || !backgroundBusy));
      if (i < 0) break;
      const row = this.queue.splice(i, 1)[0];
      row.running = true; this.active.add(row); this.peak = Math.max(this.peak, this.active.size);
      Promise.resolve().then(() => row.run(row.controller.signal)).then(row.resolve, row.reject).finally(() => {
        row.done = true; row.cleanup(); this.active.delete(row); this.pump();
      });
    }
  }
  cancelBackground() {
    for (const r of [...this.queue, ...this.active]) if (r.priority >= 10) r.controller.abort(U.abortError("Prefetch suspended"));
  }
  stop() { for (const r of [...this.queue, ...this.active]) r.controller.abort(U.abortError("Stopped")); }
}

class RangeStore {
  constructor(limit) { this.limit = limit; this.used = 0; this.reserved = 0; this.peak = 0; this.blocks = new Set(); this.evictedUnused = 0; }
  get total() { return this.used + this.reserved; }
  measure() { this.peak = Math.max(this.peak, this.total); }
  trim(extra = 0) {
    if (this.total + extra <= this.limit) return;
    const candidates = [...this.blocks].filter(b => !b.pins).sort((a, b) => (b.resource.rank || 0) - (a.resource.rank || 0) || a.lastUse - b.lastUse);
    for (const block of candidates) { this.remove(block); if (this.total + extra <= this.limit) break; }
  }
  reserve(n) {
    this.trim(n);
    if (!Number.isSafeInteger(n) || n < 0 || this.total + n > this.limit) throw U.error("BUDGET", "Cache workspace is full");
    this.reserved += n; this.measure();
    let live = true;
    return { size: n, release: () => { if (live) { live = false; this.reserved -= n; } } };
  }
  insert(resource, start, bytes, reservation) {
    const block = { resource, start, end: start + bytes.byteLength - 1, bytes, pins: 0, lastUse: Date.now(), usedForPlayback: false };
    reservation.release(); this.used += bytes.byteLength; this.blocks.add(block); resource.blocks.push(block); resource.blocks.sort((a, b) => a.start - b.start);
    this.measure(); return block;
  }
  remove(block) {
    if (block.pins || !this.blocks.delete(block)) return false;
    this.used -= block.bytes.byteLength;
    if (!block.usedForPlayback && block.speculative) this.evictedUnused += block.bytes.byteLength;
    block.resource.blocks = block.resource.blocks.filter(b => b !== block); block.bytes = null; return true;
  }
  cover(r, offset) { return r.blocks.find(b => b.start <= offset && b.end >= offset); }
  lease(block, start, end, playback = false) {
    if (!block.bytes || start < block.start || end > block.end || start > end) throw U.error("CACHE_GAP");
    block.pins++; block.lastUse = Date.now(); if (playback) block.usedForPlayback = true;
    let live = true;
    return { bytes: block.bytes.subarray(start - block.start, end - block.start + 1), release: () => { if (live) { live = false; block.pins--; } } };
  }
  has(r, start, end) {
    let p = start;
    while (p <= end) { const b = this.cover(r, p); if (!b) return false; p = b.end + 1; }
    return true;
  }
  setLimit(n) { this.limit = n; this.trim(); }
  clear(predicate = () => true) { for (const b of [...this.blocks]) if (predicate(b.resource)) this.remove(b); }
}

class RangeEngine {
  constructor(fetcher, settings, options = {}) {
    this.fetcher = fetcher; this.settings = settings; this.chunkSize = options.chunkSize || 256 * 1024;
    this.store = new RangeStore(options.budgetBytes || settings.budgetMiB * U.MiB);
    this.scheduler = new Scheduler(settings.concurrency || 2);
    this.resources = new Map(); this.id = 0; this.hostCooldown = new Map(); this.closed = false; this.openStreams = 0;
    this.stats = { received: 0, delivered: 0, hits: 0, requests: 0, completed: 0, failures: 0, canceled: 0, fallbacks: 0, intercepted: 0 };
    this.auto = { level: 2, since: Date.now(), bytes: 0, samples: 0, baseline: 0, cooldown: 0 };
  }
  resource(url, template = {}) {
    const credentials = template.credentials || "include", mode = template.mode || "cors";
    const key = [url, credentials, mode, template.referrerPolicy || "", template.referrer || "about:client"].join("\n");
    if (!this.resources.has(key)) this.resources.set(key, {
      id: "R" + (++this.id), key, url, credentials, mode, template, total: null, mime: null, headers: null,
      blocks: [], tasks: new Set(), rank: 1000, index: null, indexTried: false, failures: 0, bypassUntil: 0, lastSeen: Date.now()
    });
    const r = this.resources.get(key); r.lastSeen = Date.now(); return r;
  }
  update(settings) {
    this.settings = settings; this.store.setLimit(settings.budgetMiB * U.MiB);
    this.scheduler.setLimit(settings.concurrency || this.auto.level);
    if (!settings.enabled || this.store.total > this.store.limit) this.scheduler.cancelBackground();
  }
  adaptive(bytes, ms) {
    if (this.settings.concurrency || ms < 10) return;
    const a = this.auto, now = Date.now(); a.bytes += bytes; a.samples++;
    if (a.samples < 8 || now - a.since < 2000 || now < a.cooldown) return;
    const rate = a.bytes / Math.max(0.001, (now - a.since) / 1000);
    const demand = this.scheduler.queue.some(r => r.priority < 10);
    if (a.baseline && rate < a.baseline * 0.85 && a.level > 1) { a.level = Math.max(1, a.level - 1); a.cooldown = now + 10000; }
    else if (demand && (!a.baseline || rate >= a.baseline * 0.95) && a.level < 8) a.level = Math.min(8, a.level + 1);
    a.baseline = rate; a.bytes = 0; a.samples = 0; a.since = now; this.scheduler.setLimit(a.level);
  }
  failure(resource, e) {
    if (e.name === "AbortError") { this.stats.canceled++; return; }
    if (e.code === "BUDGET") return;
    this.stats.failures++; resource.failures++;
    if (e.code === "IDENTITY") {
      resource.poisoned = true; resource.index = null; resource.indexTried = true;
      this.store.clear(r => r === resource);
      for (const task of resource.tasks) task.controller.abort(U.error("IDENTITY"));
    }
    if (e.code === "RATE_LIMIT" || e.code === "HTTP_403") this.hostCooldown.set(new URL(resource.url).host, Date.now() + (e.retryMs || 30000));
    if (resource.failures >= 2 || ["IDENTITY", "RANGE", "HTTP_200", "RATE_LIMIT"].includes(e.code)) resource.bypassUntil = Date.now() + 60000;
    if (!this.settings.concurrency) { this.auto.level = Math.max(1, Math.floor(this.auto.level / 2)); this.auto.cooldown = Date.now() + 10000; this.scheduler.setLimit(this.auto.level); }
  }
  async fetchBlock(resource, start, end, signal, priority) {
    U.checkAbort(signal);
    const wanted = end - start + 1, reservation = this.store.reserve(wanted * 2);
    const timeout = new AbortController(), unlink = U.linkAbort(signal, timeout);
    const timer = setTimeout(() => timeout.abort(U.error("TIMEOUT", "Media chunk timed out")), 15000);
    let response, reader;
    const begun = Date.now();
    try {
      const headers = new Headers(resource.template.headers || {});
      headers.set("Range", "bytes=" + start + "-" + end);
      this.stats.requests++;
      response = await this.fetcher(resource.url, {
        method: "GET", mode: resource.mode, credentials: resource.credentials,
        headers, signal: timeout.signal, redirect: "follow",
        referrerPolicy: resource.template.referrerPolicy || undefined,
        referrer: resource.template.referrer || undefined,
        cache: resource.template.cache || "default"
      });
      if (response.status !== 206) {
        const e = U.error(response.status === 429 ? "RATE_LIMIT" : "HTTP_" + response.status);
        const retry = response.headers.get("retry-after");
        if (retry) e.retryMs = Math.min(300000, Math.max(1000, /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()));
        throw e;
      }
      const cr = U.contentRange(response.headers.get("content-range"));
      if (!cr || cr.start !== start || cr.end !== Math.min(end, cr.total - 1)) throw U.error("RANGE");
      const length = cr.end - cr.start + 1, declared = response.headers.get("content-length");
      const encoding = response.headers.get("content-encoding");
      if (encoding && encoding !== "identity" || declared !== null && Number(declared) !== length) throw U.error("RANGE");
      const validator = response.headers.get("etag") || response.headers.get("last-modified") || null;
      if (resource.total !== null && resource.total !== cr.total || resource.validator && validator && resource.validator !== validator) throw U.error("IDENTITY");
      const mime = (response.headers.get("content-type") || "").split(";")[0];
      if (!/^(video\/mp4|audio\/mp4|application\/octet-stream)$/.test(mime)) throw U.error("CONTENT_TYPE");
      if (resource.mime && resource.mime !== mime) throw U.error("IDENTITY");
      resource.total = cr.total; resource.mime = mime; resource.validator = validator || resource.validator;
      resource.headers = new Headers(response.headers); resource.responseUrl = response.url || resource.url;
      const bytes = new Uint8Array(length); let offset = 0;
      if (!response.body) throw U.error("EMPTY_BODY");
      reader = response.body.getReader();
      while (true) {
        U.checkAbort(timeout.signal);
        const result = await reader.read();
        if (result.done) break;
        this.stats.received += result.value.byteLength;
        if (offset + result.value.byteLength > length) throw U.error("RANGE");
        bytes.set(result.value, offset); offset += result.value.byteLength;
      }
      U.checkAbort(timeout.signal);
      if (offset !== length) throw U.error("SHORT_BODY");
      const block = this.store.insert(resource, start, bytes, reservation); block.speculative = priority >= 10;
      block.pins++; // Hold ownership until every waiting consumer has acquired its lease.
      resource.failures = 0; this.stats.completed++; this.adaptive(length, Date.now() - begun); return block;
    } catch (e) {
      try { if (reader) await reader.cancel(); else if (response && response.body) await response.body.cancel(); } catch (_) {}
      throw timeout.signal.aborted ? timeout.signal.reason || U.abortError() : e;
    } finally {
      clearTimeout(timer); unlink(); if (reader) try { reader.releaseLock(); } catch (_) {}
      reservation.release();
    }
  }
  task(resource, start, end, priority) {
    const task = { resource, start, end, priority, waiters: new Set(), controller: new AbortController(), finished: false };
    resource.tasks.add(task);
    task.handle = this.scheduler.submit(async signal => {
      try { return await this.fetchBlock(resource, start, end, signal, task.priority); }
      catch (e) {
        if (e.name === "AbortError" || ["BUDGET", "RANGE", "IDENTITY", "HTTP_200", "HTTP_403", "RATE_LIMIT", "CONTENT_TYPE"].includes(e.code)) throw e;
        return this.fetchBlock(resource, start, end, signal, 0);
      }
    }, priority, task.controller.signal);
    task.handle.promise.then(block => {
      task.finished = true; resource.tasks.delete(task);
      for (const w of [...task.waiters]) {
        task.waiters.delete(w); w.unlink();
        if (w.signal && w.signal.aborted) w.reject(w.signal.reason || U.abortError());
        else if (w.start > block.end) w.reject(U.error("EOF"));
        else w.resolve(this.store.lease(block, w.start, Math.min(w.end, block.end), w.priority < 10));
      }
      block.pins--;
      if (this.closed) this.store.clear();
    }, e => {
      task.finished = true; resource.tasks.delete(task); this.failure(resource, e);
      for (const w of [...task.waiters]) { task.waiters.delete(w); w.unlink(); w.reject(e); }
    });
    return task;
  }
  subscribe(task, start, end, priority, signal) {
    U.checkAbort(signal);
    task.priority = Math.min(task.priority, priority); task.handle.promote(priority);
    return new Promise((resolve, reject) => {
      const waiter = { start, end, priority, signal, resolve, reject };
      const cancel = () => {
        if (!task.waiters.delete(waiter)) return;
        waiter.unlink(); reject(signal.reason || U.abortError());
        if (!task.waiters.size && !task.finished) task.controller.abort(U.abortError());
      };
      waiter.unlink = () => signal && signal.removeEventListener("abort", cancel);
      task.waiters.add(waiter); if (signal) signal.addEventListener("abort", cancel, { once: true });
      if (signal && signal.aborted) cancel();
    });
  }
  acquire(resource, start, end, priority, signal) {
    U.checkAbort(signal);
    const cached = this.store.cover(resource, start);
    if (cached) {
      const last = Math.min(end, cached.end);
      if (priority < 10) this.stats.hits += last - start + 1;
      return { end: last, promise: Promise.resolve(this.store.lease(cached, start, last, priority < 10)) };
    }
    const existing = [...resource.tasks].find(t => !t.controller.signal.aborted && t.start <= start && t.end >= start);
    if (existing) { const last = Math.min(end, existing.end); return { end: last, promise: this.subscribe(existing, start, last, priority, signal) }; }
    let last = Math.min(end, start + this.chunkSize - 1);
    for (const block of resource.blocks) if (block.start > start) last = Math.min(last, block.start - 1);
    for (const task of resource.tasks) if (!task.controller.signal.aborted && task.start > start) last = Math.min(last, task.start - 1);
    if (resource.total !== null) last = Math.min(last, resource.total - 1);
    if (last < start) throw U.error("EOF");
    const task = this.task(resource, start, last, priority);
    return { end: last, promise: this.subscribe(task, start, last, priority, signal) };
  }
  async meta(resource, signal, priority = 0) {
    if (resource.total !== null) return;
    const part = this.acquire(resource, 0, 4095, priority, signal);
    const lease = await part.promise; lease.release();
  }
  async read(resource, start, end, options = {}) {
    if (this.closed) throw U.abortError("Engine closed");
    const { signal, priority = 0 } = options; U.checkAbort(signal);
    if (resource.poisoned) throw U.error("IDENTITY");
    await this.meta(resource, signal, priority); U.checkAbort(signal);
    end = Math.min(end, resource.total - 1);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end) throw U.error("EOF");
    const length = end - start + 1;
    if (length > 4 * U.MiB) throw U.error("READ_LIMIT");
    const outputReservation = this.store.reserve(length);
    const controller = new AbortController(), unlink = U.linkAbort(signal, controller), promises = [];
    let leases = [];
    try {
      let offset = start;
      while (offset <= end) {
        const part = this.acquire(resource, offset, end, priority, controller.signal);
        promises.push(part.promise); offset = part.end + 1;
      }
      leases = await Promise.all(promises); U.checkAbort(controller.signal);
      if (resource.poisoned) throw U.error("IDENTITY");
      const bytes = new Uint8Array(length); let p = 0;
      for (const l of leases) { bytes.set(l.bytes, p); p += l.bytes.byteLength; }
      if (p !== length) throw U.error("CACHE_GAP");
      let live = true;
      return { bytes, release: () => { if (live) { live = false; outputReservation.release(); } } };
    } catch (e) {
      controller.abort(e);
      const settled = await Promise.allSettled(promises);
      leases = settled.filter(x => x.status === "fulfilled").map(x => x.value);
      outputReservation.release(); throw e;
    } finally { for (const l of leases) l.release(); unlink(); }
  }
  async prefetch(resource, ranges, signal, priority = 12, byteLimit = Infinity) {
    if ((this.hostCooldown.get(new URL(resource.url).host) || 0) > Date.now() || resource.bypassUntil > Date.now()) return 0;
    let done = 0;
    for (const range of ranges) for (let p = range[0]; p <= range[1]; p += this.chunkSize) {
      U.checkAbort(signal);
      const end = Math.min(range[1], p + this.chunkSize - 1);
      if (done + end - p + 1 > byteLimit) return done;
      const lease = await this.read(resource, p, end, { signal, priority }); done += lease.bytes.byteLength; lease.release();
    }
    return done;
  }
  stop() {
    this.closed = true; this.scheduler.stop();
    for (const r of this.resources.values()) for (const t of r.tasks) t.controller.abort(U.abortError());
    this.store.clear();
  }
}
module.exports = { Scheduler, RangeStore, RangeEngine };

},
"./media-index.cjs":function(module,exports,require){
"use strict";
const U = require("./utils.cjs");
function parseMP4(bytes) {
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (p, n) => String.fromCharCode(...bytes.subarray(p, p + n));
  const uint64 = p => { const n = Number(d.getBigUint64(p)); if (!Number.isSafeInteger(n)) throw U.error("INDEX_INTEGER"); return n; };
  function boxes(start, end) {
    const out = [];
    for (let p = start; p + 8 <= Math.min(end, bytes.length);) {
      let size = d.getUint32(p), header = 8; const type = str(p + 4, 4);
      if (size === 1) { if (p + 16 > bytes.length) break; size = uint64(p + 8); header = 16; }
      if (size === 0) size = end - p;
      if (size < header || !Number.isSafeInteger(p + size)) throw U.error("INDEX_BOX");
      out.push({ p, size, header, type, body: p + header, end: p + size, complete: p + size <= bytes.length });
      p += size;
    }
    return out;
  }
  const top = boxes(0, bytes.length);
  if (!top.some(b => b.type === "ftyp")) return { recognized: false, need: 0, handlers: [], fragments: null };
  const moov = top.find(b => b.type === "moov"), sidx = top.find(b => b.type === "sidx");
  const incomplete = top.find(b => !b.complete && ["moov", "sidx"].includes(b.type));
  if (incomplete) return { recognized: true, need: incomplete.end, handlers: [], fragments: null };
  const handlers = [], shifts = []; let safeTimeline = true, movieScale = 0;
  if (moov && moov.complete) {
    const children = boxes(moov.body, moov.end), mvhd = children.find(b => b.type === "mvhd");
    if (mvhd && mvhd.complete && mvhd.body + 32 <= mvhd.end) movieScale = d.getUint32(mvhd.body + (bytes[mvhd.body] === 1 ? 20 : 12));
    for (const trak of children.filter(b => b.type === "trak" && b.complete)) {
      const tc = boxes(trak.body, trak.end), mdia = tc.find(b => b.type === "mdia");
      if (!mdia || !mdia.complete) continue;
      const mc = boxes(mdia.body, mdia.end), hdlr = mc.find(b => b.type === "hdlr"), mdhd = mc.find(b => b.type === "mdhd");
      if (hdlr && hdlr.body + 12 <= hdlr.end) handlers.push(str(hdlr.body + 8, 4));
      const mediaScale = mdhd && mdhd.body + (bytes[mdhd.body] === 1 ? 24 : 16) <= mdhd.end ? d.getUint32(mdhd.body + (bytes[mdhd.body] === 1 ? 20 : 12)) : 0;
      const edts = tc.find(b => b.type === "edts"); let shift = 0;
      if (edts && edts.complete) {
        const elst = boxes(edts.body, edts.end).find(b => b.type === "elst");
        if (elst) {
          if (!elst.complete || !movieScale || !mediaScale || elst.body + 8 > elst.end) safeTimeline = false;
          else {
            const v = bytes[elst.body], count = d.getUint32(elst.body + 4), size = v === 1 ? 20 : 12;
            let p = elst.body + 8, empty = 0, real = 0;
            if (v > 1 || count > 2 || p + count * size > elst.end) safeTimeline = false;
            else for (let i = 0; i < count; i++, p += size) {
              const duration = v === 1 ? uint64(p) : d.getUint32(p);
              const mediaTime = v === 1 ? Number(d.getBigInt64(p + 8)) : d.getInt32(p + 4);
              const rate = d.getInt16(p + (v === 1 ? 16 : 8)), fraction = d.getInt16(p + (v === 1 ? 18 : 10));
              if (!Number.isSafeInteger(mediaTime) || rate !== 1 || fraction !== 0) safeTimeline = false;
              if (mediaTime === -1 && !real) empty += duration / movieScale;
              else if (mediaTime >= 0 && !real) { real++; shift = empty - mediaTime / mediaScale; }
              else safeTimeline = false;
            }
          }
        }
      }
      shifts.push(shift);
    }
  }
  const base = { recognized: true, need: !sidx && top.length && top[top.length - 1].complete ? bytes.length + 65536 : 0, handlers, fragments: null, safeTimeline };
  if (!sidx || !sidx.complete || !safeTimeline || handlers.length !== 1) return base;
  const p = sidx.body, version = bytes[p];
  if (version > 1 || p + (version === 0 ? 24 : 32) > sidx.end) throw U.error("INDEX_SIDX");
  const scale = d.getUint32(p + 8);
  if (!scale) throw U.error("INDEX_SCALE");
  let q = p + 12;
  const read = () => { const n = version === 0 ? d.getUint32(q) : uint64(q); q += version === 0 ? 4 : 8; return n; };
  const earliest = read(), offset = read(); q += 2; const count = d.getUint16(q); q += 2;
  if (q + count * 12 > sidx.end || !count) throw U.error("INDEX_COUNT");
  let cursor = sidx.end + offset, time = earliest / scale + (shifts[0] || 0);
  const fragments = [];
  for (let i = 0; i < count; i++, q += 12) {
    const reference = d.getUint32(q), length = reference & 0x7fffffff, duration = d.getUint32(q + 4) / scale, sap = d.getUint32(q + 8);
    if (reference >>> 31 || !length || !Number.isFinite(duration) || duration <= 0 || !Number.isSafeInteger(cursor + length)) return base;
    fragments.push({ start: cursor, end: cursor + length - 1, from: time, to: time + duration,
      sap: !!(sap >>> 31) && ((sap >>> 28) & 7) <= 2 && (sap & 0x0fffffff) === 0 });
    cursor += length; time += duration;
  }
  return { recognized: true, handlers, safeTimeline: true, fragments, initEnd: fragments[0].start - 1, duration: time, need: 0 };
}
async function loadIndex(engine, resource, signal, priority = 10) {
  if (resource.index) return resource.index;
  if (resource.indexTried) return null;
  // A canceled attempt remains retryable; concurrent attempts share range tasks.
  let size = 65536, result;
  while (size <= U.MiB) {
    const lease = await engine.read(resource, 0, size - 1, { signal, priority });
    try { result = parseMP4(lease.bytes); }
    catch (e) { resource.indexTried = true; resource.indexError = e.code || "INDEX_FORMAT"; return null; }
    finally { lease.release(); }
    if (result.fragments) {
      if (result.fragments.some(f => f.end >= resource.total)) { resource.indexTried = true; resource.indexError = "INDEX_BOUNDS"; return null; }
      resource.index = result; resource.indexTried = true; return result;
    }
    if (!result.need || result.need <= size || result.need > U.MiB || size >= resource.total) break;
    size = Math.min(U.MiB, Math.max(size * 2, result.need));
  }
  resource.indexTried = true; resource.container = result; return null;
}
function rangesFor(index, from, to) {
  if (!index || !index.fragments || !index.fragments.length) return null;
  const fs = index.fragments; let first = fs.findIndex(f => f.to > from);
  if (first < 0) return [];
  while (first > 0 && !fs[first].sap) first--;
  let last = first;
  while (last + 1 < fs.length && fs[last + 1].from < to) last++;
  return [[0, index.initEnd], [fs[first].start, fs[last].end]];
}
function cachedTimes(engine, resource) {
  const index = resource.index;
  if (!index || !engine.store.has(resource, 0, index.initEnd)) return [];
  const ranges = []; let decodable = false;
  for (const f of index.fragments) {
    const stored = engine.store.has(resource, f.start, f.end);
    decodable = stored && (f.sap || decodable);
    if (decodable) ranges.push([f.from, f.to]);
  }
  return U.mergeIntervals(ranges);
}
module.exports = { parseMP4, loadIndex, rangesFor, cachedTimes };

},
"./fetch-transport.cjs":function(module,exports,require){
"use strict";
const U = require("./utils.cjs");
function eligible(request) {
  if (request.method !== "GET" || !U.mediaUrl(request.url) || request.mode === "no-cors" || request.integrity || request.keepalive || request.redirect !== "follow") return null;
  if ([...request.headers.keys()].some(k => !["range", "accept"].includes(k))) return null;
  return U.parseRange(request.headers.get("range"));
}
function decorate(response, url, type) {
  const clone = response.clone.bind(response);
  Object.defineProperties(response, {
    url: { configurable: true, value: url },
    type: { configurable: true, value: type || "cors" },
    clone: { configurable: true, value: () => decorate(clone(), url, type) }
  });
  return response;
}
async function createResponse(engine, resource, range, signal) {
  U.checkAbort(signal); await engine.meta(resource, signal);
  const end = Math.min(range.end === null ? resource.total - 1 : range.end, resource.total - 1);
  if (range.start > end) throw U.error("EOF");
  engine.openStreams++;
  const lifetime = new AbortController(), unlink = U.linkAbort(signal, lifetime);
  let controller, finished = false, cursor = range.start, scheduled = range.start, first = true;
  const pending = [];
  const clean = () => {
    if (finished) return;
    finished = true; engine.openStreams--; unlink(); lifetime.signal.removeEventListener("abort", aborted);
    lifetime.abort(U.abortError());
    for (const p of pending.splice(0)) p.promise.then(l => l.release(), () => {});
  };
  const aborted = () => { if (finished) return; const reason = lifetime.signal.reason || U.abortError(); clean(); if (controller) try { controller.error(reason); } catch (_) {} };
  lifetime.signal.addEventListener("abort", aborted, { once: true });
  const fill = () => {
    const count = Math.max(1, Math.min(8, engine.scheduler.limit));
    while (!finished && pending.length < count && scheduled <= end) {
      const size = first ? Math.min(65536, engine.chunkSize) : engine.chunkSize;
      const start = scheduled, last = Math.min(end, start + size - 1); first = false; scheduled = last + 1;
      const promise = engine.read(resource, start, last, { signal: lifetime.signal, priority: resource.mime === "audio/mp4" ? 0 : 1 });
      promise.catch(() => {}); pending.push({ start, end: last, promise });
    }
  };
  const stream = new ReadableStream({
    start(c) { controller = c; if (lifetime.signal.aborted) aborted(); },
    async pull(c) {
      if (finished) return;
      fill();
      const part = pending.shift();
      if (!part) { clean(); c.close(); return; }
      let lease;
      try {
        lease = await part.promise;
        if (finished) return;
        U.checkAbort(lifetime.signal);
        if (part.start !== cursor || lease.bytes.byteLength !== part.end - part.start + 1) throw U.error("STREAM_ORDER");
        cursor = part.end + 1; engine.stats.delivered += lease.bytes.byteLength;
        // The returned buffer is a private copy; the site cannot mutate cached bytes.
        c.enqueue(lease.bytes);
        if (cursor > end) { clean(); c.close(); }
      } catch (e) {
        if (!finished) { clean(); try { c.error(e); } catch (_) {} }
      } finally { if (lease) lease.release(); }
    },
    cancel() { clean(); }
  }, { highWaterMark: 0 });
  const headers = new Headers(resource.headers || {});
  headers.set("Content-Type", resource.mime);
  headers.set("Content-Range", "bytes " + range.start + "-" + end + "/" + resource.total);
  headers.set("Content-Length", String(end - range.start + 1));
  headers.set("Accept-Ranges", "bytes"); headers.delete("Content-Encoding");
  return decorate(new Response(stream, { status: 206, statusText: "Partial Content", headers }), resource.responseUrl || resource.url, "cors");
}
function installFetch(root, engine, adapter, original) {
  const wrapped = function(input, init) {
    // Constructing a Request around a POST body can consume its stream. Leave business calls untouched.
    const method = (init && init.method || input && input.method || "GET").toUpperCase();
    if (method !== "GET") return original.call(root, input, init);
    let url;
    try { url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, root.location && root.location.href).href; }
    catch (_) { return original.call(root, input, init); }
    if (!U.mediaUrl(url) && !adapter.isFeed(url)) return original.call(root, input, init);
    let request;
    try { request = new Request(input, init); } catch (_) { return original.apply(root, arguments); }
    const range = eligible(request);
    if (range) {
      const resource = engine.resource(request.url, {
        credentials: request.credentials, mode: request.mode, headers: request.headers,
        referrer: request.referrer, referrerPolicy: request.referrerPolicy, cache: request.cache
      });
      adapter.onNativeRequest(resource, range);
      if (engine.settings.enabled && !resource.poisoned && resource.bypassUntil <= Date.now() && (engine.hostCooldown.get(new URL(resource.url).host) || 0) <= Date.now()) {
        return createResponse(engine, resource, range, request.signal).then(response => {
          engine.stats.intercepted++; return response;
        }).catch(e => {
          if (request.signal.aborted || e.name === "AbortError") throw request.signal.reason || e;
          engine.stats.fallbacks++; adapter.lastError = e.code || "FETCH";
          return original.call(root, input, init);
        });
      }
    }
    const result = original.call(root, input, init);
    if (!range && request.method === "GET" && adapter.isFeed(request.url)) result.then(r => adapter.observeResponse(r)).catch(() => {});
    return result;
  };
  root.fetch = wrapped;
  return () => { if (root.fetch === wrapped) root.fetch = original; };
}
module.exports = { eligible, decorate, createResponse, installFetch };

},
"./quality-policy.cjs":function(module,exports,require){
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

},
"./page-adapter.cjs":function(module,exports,require){
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

},
"./panel.cjs":function(module,exports,require){
"use strict";
const U = require("./utils.cjs");
function mountPanel(root, api) {
  const host = root.document.createElement("div"); host.id = "tnb-panel";
  host.setAttribute("translate", "no"); host.className = "notranslate"; host.lang = "zh-CN";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>
    :host{all:initial;position:fixed;right:16px;bottom:20px;z-index:2147483000;font:13px/1.5 system-ui,sans-serif;color:#edf2f7;color-scheme:dark}
    *{box-sizing:border-box}button,select{font:inherit;color:inherit;background:#202933;border:1px solid #455465;border-radius:6px;padding:5px 8px}button{cursor:pointer}button:hover{background:#304256}
    .toggle{box-shadow:0 3px 15px #0005;background:#142b32;border-color:#40828a;padding:8px 12px}.panel{width:310px;max-height:75vh;overflow:auto;padding:16px;background:#131b24f7;border:1px solid #405268;border-radius:12px;box-shadow:0 8px 30px #0006;margin-bottom:8px}
    [hidden]{display:none!important}.head{display:flex;align-items:center;justify-content:space-between}.head strong{font-size:15px}h3{font-size:13px;margin:14px 0 6px;color:#7ed4d4}.row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:7px 0}.value{font-variant-numeric:tabular-nums}small{color:#a5b6c7;font-size:11px}.track{height:5px;background:#2a3644;border-radius:5px;margin:6px 0 10px;overflow:hidden}.bar{background:#57c6bc;height:100%;width:0}ol{padding-left:22px;margin:5px 0}.foot{display:flex;gap:8px;margin-top:12px}label{display:flex;align-items:center;justify-content:space-between;margin:8px 0;gap:8px}select{max-width:140px}.status{color:#80d8b5;margin:8px 0 2px}.warn{color:#ffcc8a}
    </style><section class="panel notranslate" translate="no" hidden aria-label="TikTok 缓冲设置">
    <div class="head"><strong>原生播放器 · 缓冲</strong><button data-action="close" aria-label="收起">×</button></div>
    <div class="status" id="status">等待媒体请求</div>
    <label>视频画质<select name="quality" id="quality-select" aria-label="视频画质" aria-describedby="quality-options quality-note"></select></label>
    <div class="row"><span>播放画质</span><span class="value" id="quality"></span></div>
    <div><small id="quality-options"></small></div><div><small id="quality-note" aria-live="polite"></small></div>
    <div class="row"><span>脚本数据预算</span><span class="value" id="memory"></span></div><div class="track"><div class="bar" id="bar"></div></div>
    <div class="row"><span>播放器已缓冲</span><span class="value" id="native"></span></div>
    <div class="row"><span>连续可用覆盖</span><span class="value" id="prepared"></span></div>
    <small>可用覆盖含原生缓冲和已核对的缓存；缓存不会直接拉长原进度条。</small><div><small id="index-mode"></small></div>
    <div class="row"><span>后续准备就绪</span><span class="value" id="next"></span></div><ol id="queue"></ol>
    <div class="row"><span>正在下载 / 并发上限</span><span class="value" id="connections"></span></div><small id="request-history"></small>
    <h3>缓冲设置</h3><div id="settings"></div>
    <small>容量按 MiB 计，含在途预留及交付副本；原生媒体缓冲和解码内存另计。设置按标签页生效。</small>
    <div class="foot"><button data-action="enable">暂停接管</button><button data-action="clear">清理闲置缓存</button></div>
    <div id="detail"><small></small></div>
    </section><button class="toggle" data-action="toggle">缓冲 · 等待</button>`;
  const $ = id => shadow.getElementById(id), fields = [
    ["budgetMiB", "缓冲容量", [64,128,256,512], n => n + " MiB"],
    ["aheadSeconds", "当前向前准备", [15,30,60,120], n => n + " 秒"],
    ["nextCount", "后续视频数量", [0,1,2,3,4,5], n => n + " 条"],
    ["nextSeconds", "每条准备开头", [5,10,15,30], n => n + " 秒"],
    ["nextMiB", "每条字节上限", [2,4,8,16], n => n + " MiB"],
    ["historyCount", "回看保留数量", [0,1,2], n => n + " 条"],
    ["concurrency", "最高并发", [0,1,2,4,6,8], n => n ? String(n) : "自动（最多 8）"]
  ];
  for (const [key, label, values, format] of fields) {
    const row = root.document.createElement("label"); row.append(root.document.createTextNode(label));
    const select = root.document.createElement("select"); select.name = key; select.setAttribute("aria-label", label);
    for (const n of values) { const option = root.document.createElement("option"); option.value = String(n); option.textContent = format(n); select.append(option); }
    select.value = String(api.getSettings()[key]); select.addEventListener("change", () => { api.setSettings({ [key]: Number(select.value) }); render(); }); row.append(select); $("settings").append(row);
  }
  const qualitySelect = $("quality-select");
  qualitySelect.addEventListener("change", () => { api.setSettings({ quality: qualitySelect.value }); render(); });
  let qualitySignature = "";
  const panel = shadow.querySelector(".panel"), toggle = shadow.querySelector(".toggle"), enable = shadow.querySelector('[data-action="enable"]');
  shadow.addEventListener("click", event => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "toggle") panel.hidden = !panel.hidden;
    if (action === "close") panel.hidden = true;
    if (action === "enable") api.setSettings({ enabled: !api.getSettings().enabled });
    if (action === "clear") api.clearCache();
    render();
  });
  function render() {
    const s = api.getStatus(), cfg = api.getSettings(), mib = n => (n / U.MiB).toFixed(1);
    const tiers = [...new Set([1080,720,540,480,360, ...s.qualityLevels, ...(Number(cfg.quality) > 0 ? [Number(cfg.quality)] : [])])].sort((a, b) => b - a);
    const signature = tiers.join(",");
    if (signature !== qualitySignature && shadow.activeElement !== qualitySelect) {
      qualitySignature = signature; qualitySelect.replaceChildren();
      for (const [value, text] of [["highest", "最高画质"], ...tiers.map(n => [String(n), n + "P"]), ["auto", "原生自动"]]) {
        const option = root.document.createElement("option"); option.value = value; option.textContent = text; qualitySelect.append(option);
      }
      qualitySelect.value = cfg.quality;
    }
    $("quality").textContent = s.quality.status === "locked" ? "已固定 " + s.quality.label : s.quality.status === "native" ? "原生自动" : s.quality.status === "fallback" ? "固定未生效 · 原生回退" : s.quality.status === "unsupported" ? "该版本暂不支持固定" : "等待播放器就绪";
    $("quality-options").textContent = s.qualityLevels.length ? "本条可选：" + s.qualityLevels.map(n => n + "P").join(" / ") : "本条可选画质：等待视频信息";
    const mismatch = s.quality.status === "locked" && Number(cfg.quality) > 0 && s.quality.label !== cfg.quality + "P";
    $("quality-note").textContent = mismatch ? `本条无 ${cfg.quality}P，已使用 ${s.quality.label}；后续仍按所选画质准备。` : "应用于当前及后续视频，刷新后保留。";
    $("memory").textContent = `${mib(s.residentBytes + s.reservedBytes)} / ${cfg.budgetMiB} MiB`;
    $("bar").style.width = Math.min(100, (s.residentBytes + s.reservedBytes) / s.budgetBytes * 100) + "%";
    $("native").textContent = s.nativeAhead.toFixed(1) + " 秒"; $("prepared").textContent = s.preparedAhead.toFixed(1) + " 秒";
    $("index-mode").textContent = s.currentIndex.some(r => r.checked && !r.indexed && !r.complete) ? "当前为字节缓存模式：未完整缓存时，时长未知。" : "";
    $("next").textContent = `${s.nextReady} / ${s.nextTarget} 条`;
    $("connections").textContent = `${s.activeRequests} / ${s.concurrency}`;
    $("request-history").textContent = `本页并发峰值 ${s.peakRequests} · 已完成 ${s.completed} 个分块`;
    $("status").textContent = !s.enabled ? "已暂停 · 新请求由原生下载" : s.backgroundPaused ? "后台 · 预取暂停" : !s.currentId ? "等待可识别的视频" : s.intercepted ? "下载接管已生效" : "等待原生媒体请求";
    $("queue").replaceChildren(); for (const [i, item] of s.next.entries()) { const li = root.document.createElement("li"); li.textContent = `后 ${i + 1} 条 · ${item.quality ? item.quality + " · " : ""}${item.status}`; $("queue").append(li); }
    if (s.nextAvailable < s.nextTarget) { const li = root.document.createElement("li"); li.textContent = `页面已提供 ${s.nextAvailable} / ${s.nextTarget} 条`; $("queue").append(li); }
    $("detail").firstElementChild.textContent = `缓存命中 ${mib(s.hits)} MiB · 原生回退 ${s.fallbacks} 次${s.lastError ? " · 最近状态 " + s.lastError : ""}`;
    enable.textContent = s.enabled ? "暂停接管" : "启用接管";
    toggle.textContent = s.enabled ? `缓冲 · ${s.nativeAhead.toFixed(0)} 秒 · 后 ${s.nextReady}/${s.nextTarget}` : "缓冲 · 已暂停";
    for (const select of shadow.querySelectorAll("select")) if (shadow.activeElement !== select) select.value = String(cfg[select.name]);
  }
  (root.document.body || root.document.documentElement).append(host); render();
  const timer = root.setInterval(render, 1000);
  return () => { root.clearInterval(timer); host.remove(); };
}
module.exports = { mountPanel };

},
"./entry.cjs":function(module,exports,require){
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

}
},cache={};function require(id){if(cache[id])return cache[id].exports;if(!modules[id])throw new Error("Unknown module");const module=cache[id]={exports:{}};modules[id](module,module.exports,require);return module.exports;}require("./entry.cjs").install(window,{});})();
