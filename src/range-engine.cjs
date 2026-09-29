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
