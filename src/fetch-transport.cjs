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
