"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const U = require("../src/utils.cjs"), { Scheduler, RangeStore, RangeEngine } = require("../src/range-engine.cjs");
const { createResponse, eligible, installFetch } = require("../src/fetch-transport.cjs");
const M = require("../src/media-index.cjs"), { PageAdapter, itemList, model } = require("../src/page-adapter.cjs");
const URL1 = "https://v16-webapp-prime.tiktok.com/video/tos/example/media-video-hvc1/?token=one";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(options = {}) {
  const bytes = Uint8Array.from({ length: options.size || 60000 }, (_, i) => i % 251), calls = [];
  let active = 0, peak = 0, canceled = 0;
  const fetcher = async (url, init) => {
    const range = U.parseRange(new Headers(init.headers).get("range")); assert.ok(range && range.end !== null);
    calls.push({ ...range, credentials: init.credentials }); active++; peak = Math.max(peak, active);
    let done = false;
    const finish = () => { if (!done) { done = true; active--; } };
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); finish(); canceled++; reject(init.signal.reason || U.abortError()); };
      const timer = setTimeout(() => {
        init.signal.removeEventListener("abort", abort); finish();
        const end = Math.min(range.end, bytes.length - 1), body = bytes.slice(range.start, end + 1);
        const headers = { "content-type": "video/mp4", "content-range": `bytes ${range.start}-${end}/${bytes.length}`, "content-length": String(body.length) };
        if (options.mutate) options.mutate(headers, calls.length);
        const response = new Response(options.short ? body.subarray(0, body.length - 1) : body, { status: options.status || 206, headers });
        resolve(response);
      }, options.delay === undefined ? (range.start % 7 + 2) : options.delay);
      init.signal.addEventListener("abort", abort, { once: true }); if (init.signal.aborted) abort();
    });
  };
  const engine = new RangeEngine(fetcher, U.normalize({ concurrency: options.concurrency || 8 }), { chunkSize: 1024, budgetBytes: options.budget || 1024 * 1024 });
  const resource = engine.resource(URL1);
  return { bytes, calls, engine, resource, fetcher, get peak() { return peak; }, get active() { return active; }, get canceled() { return canceled; } };
}
async function read(f, start, end, options) { const lease = await f.engine.read(f.resource, start, end, options); const bytes = lease.bytes.slice(); lease.release(); return bytes; }

test("single ranges and integer boundaries", () => {
  assert.deepEqual(U.parseRange("bytes=3-"), { start: 3, end: null });
  assert.deepEqual(U.parseRange("bytes=0-0"), { start: 0, end: 0 });
  for (const x of ["bytes=-5", "bytes=3-2", "bytes=0-4,6-9", "bytes=9007199254740992-"]) assert.equal(U.parseRange(x), null);
  assert.equal(U.contentRange("bytes 0-10/10"), null);
  assert.equal(U.normalize({ concurrency: 9 }).concurrency, 0);
  assert.equal(U.normalize({ concurrency: 8 }).concurrency, 8);
});
test("strict media eligibility preserves unrelated requests", () => {
  assert.ok(eligible(new Request(URL1, { headers: { Range: "bytes=0-" }, credentials: "include" })));
  assert.equal(eligible(new Request(URL1, { headers: { Range: "bytes=0-", "If-Range": "x" } })), null);
  assert.equal(eligible(new Request("https://www.tiktok.com/api/item/detail/", { headers: { Range: "bytes=0-" } })), null);
  assert.equal(U.mediaUrl("https://v16-webapp-prime.tiktok.com.evil.example/video/a"), false);
});
test("overlapping reads share in-flight and resident intervals", async () => {
  const f = fixture(); await f.engine.meta(f.resource);
  const [a, b] = await Promise.all([read(f, 1000, 8999), read(f, 4000, 12999)]);
  assert.deepEqual(a, f.bytes.slice(1000, 9000)); assert.deepEqual(b, f.bytes.slice(4000, 13000));
  const intervals = f.calls.map(x => [x.start, Math.min(x.end, f.bytes.length - 1)]).sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < intervals.length; i++) assert.ok(intervals[i][0] > intervals[i - 1][1], "duplicate network interval");
  const n = f.calls.length; await read(f, 5000, 6000); assert.equal(f.calls.length, n);
  assert.ok(f.peak <= 8 && f.peak > 1); assert.ok(f.calls.every(c => c.credentials === "include")); assert.equal(f.engine.store.reserved, 0);
});
test("one consumer abort does not cancel another consumer", async () => {
  const f = fixture({ delay: 15 }); await f.engine.meta(f.resource);
  const c = new AbortController(), p = read(f, 2000, 7000, { signal: c.signal });
  const q = read(f, 2000, 7000); const rejected = assert.rejects(p, { name: "AbortError" });
  await delay(2); c.abort(); await rejected;
  assert.deepEqual(await q, f.bytes.slice(2000, 7001)); assert.equal(f.canceled, 0); assert.equal(f.engine.store.reserved, 0);
});
test("canceling the last waiter aborts the bounded request", async () => {
  const f = fixture({ delay: 25 }); await f.engine.meta(f.resource);
  const c = new AbortController(), p = read(f, 10000, 19000, { signal: c.signal });
  const rejected = assert.rejects(p, { name: "AbortError" }); await delay(2); c.abort(); await rejected; await delay(2);
  assert.ok(f.canceled > 0); assert.equal(f.active, 0); assert.equal(f.engine.store.reserved, 0);
});
test("open range streams byte-exactly through EOF including file tail", async () => {
  const f = fixture({ size: 35023 }), response = await createResponse(f.engine, f.resource, { start: 2101, end: null });
  assert.equal(response.status, 206); assert.equal(response.headers.get("content-range"), "bytes 2101-35022/35023");
  assert.equal(response.headers.get("content-length"), String(35023 - 2101)); assert.equal(response.url, URL1);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), f.bytes.slice(2101));
  assert.equal(response.bodyUsed, true); assert.equal(f.engine.store.reserved, 0); assert.equal(f.engine.openStreams, 0);
});
test("finite ranges clamp at EOF; clone keeps response metadata", async () => {
  const f = fixture({ size: 3000 }), response = await createResponse(f.engine, f.resource, { start: 2500, end: 7000 });
  const clone = response.clone(); assert.equal(clone.url, URL1); assert.equal(clone.type, "cors");
  const [a, b] = await Promise.all([response.arrayBuffer(), clone.arrayBuffer()]);
  assert.deepEqual(new Uint8Array(a), f.bytes.slice(2500)); assert.deepEqual(new Uint8Array(a), new Uint8Array(b));
});
test("backpressure and cancel prevent whole-file eager download", async () => {
  const f = fixture({ size: 100000, delay: 3 }), response = await createResponse(f.engine, f.resource, { start: 0, end: null });
  const count = f.calls.length; await delay(15); assert.equal(f.calls.length, count);
  const reader = response.body.getReader(); assert.ok((await reader.read()).value.length); await reader.cancel(); await delay(15);
  assert.ok(f.engine.stats.received < 20000); assert.equal(f.active, 0); assert.equal(f.engine.store.reserved, 0); assert.equal(f.engine.openStreams, 0);
});
test("stream abort reaches body and frees request reservations", async () => {
  const f = fixture({ delay: 15 }), c = new AbortController();
  const response = await createResponse(f.engine, f.resource, { start: 3000, end: null }, c.signal), reader = response.body.getReader();
  const pending = reader.read(), rejected = assert.rejects(pending, { name: "AbortError" }); c.abort(); await rejected; await delay(20);
  assert.equal(f.engine.store.reserved, 0); assert.equal(f.active, 0); assert.equal(f.engine.openStreams, 0);
});
test("all resources and tracks share a maximum of eight requests", async () => {
  const f = fixture({ delay: 5 });
  const jobs = Array.from({ length: 4 }, (_, i) => { const r = f.engine.resource(URL1 + i); return f.engine.read(r, 0, 16000).then(l => l.release()); });
  await Promise.all(jobs); assert.equal(f.peak, 8); assert.equal(f.engine.scheduler.peak, 8); assert.equal(f.engine.store.reserved, 0);
});
test("cache budget includes output and in-flight memory", async () => {
  const f = fixture({ budget: 10000, concurrency: 2 });
  for (let start = 0; start < 30000; start += 1000) await read(f, start, start + 999);
  assert.ok(f.engine.store.peak <= 10000); assert.ok(f.engine.store.used <= 10000); assert.equal(f.engine.store.reserved, 0);
});
test("store evicts unpinned distant resources first", () => {
  const store = new RangeStore(20), a = { rank: 0, blocks: [] }, b = { rank: 100, blocks: [] };
  const x = store.insert(a, 0, new Uint8Array(10), store.reserve(10)); store.insert(b, 0, new Uint8Array(10), store.reserve(10));
  const lease = store.lease(x, 0, 9); const allocation = store.reserve(10); assert.equal(b.blocks.length, 0); assert.equal(a.blocks.length, 1);
  allocation.release(); lease.release(); store.clear(); assert.equal(store.total, 0);
});
test("invalid status, ranges and short bodies never enter cache", async t => {
  for (const opts of [{ status: 200 }, { status: 416 }, { short: true }, { mutate: h => h["content-range"] = "bytes 1-1024/60000" }, { mutate: h => h["content-type"] = "text/html" }]) {
    await t.test(JSON.stringify(opts), async () => { const f = fixture(opts); await assert.rejects(read(f, 0, 100)); assert.equal(f.engine.store.used, 0); assert.equal(f.engine.store.reserved, 0); });
  }
});
test("changed resource identity is rejected; signed URLs stay separate", async () => {
  const f = fixture({ mutate: (h, n) => { h.etag = n === 1 ? '"one"' : '"two"'; } });
  await f.engine.meta(f.resource); await assert.rejects(read(f, 2000, 2500), { code: "IDENTITY" });
  assert.notEqual(f.resource, f.engine.resource(URL1.replace("one", "two"))); assert.equal(f.resource.poisoned, true); assert.equal(f.resource.blocks.length, 0);
  await assert.rejects(read(f, 0, 100), { code: "IDENTITY" });
});
test("before response failure falls back once to original fetch", async () => {
  const f = fixture({ status: 200 }); let fallback = 0;
  const original = async () => { fallback++; return new Response("native"); }, root = { fetch: original };
  const adapter = { onNativeRequest() {}, isFeed() { return false; } };
  const undo = installFetch(root, f.engine, adapter, original);
  assert.equal(await (await root.fetch(URL1, { headers: { Range: "bytes=0-" } })).text(), "native");
  assert.equal(fallback, 1); assert.equal(f.engine.stats.fallbacks, 1); undo(); assert.equal(root.fetch, original);
});
test("scheduler preempts background and never exceeds global ceiling", async () => {
  const scheduler = new Scheduler(1); let backgroundAborted = false;
  const bg = scheduler.submit(signal => new Promise((resolve, reject) => signal.addEventListener("abort", () => { backgroundAborted = true; reject(signal.reason); }, { once: true })), 12);
  const rejected = assert.rejects(bg.promise, { name: "AbortError" }); await delay(1);
  const fg = scheduler.submit(async () => 42, 0); assert.equal(await fg.promise, 42); await rejected;
  assert.equal(backgroundAborted, true); assert.equal(scheduler.peak, 1); scheduler.setLimit(99); assert.equal(scheduler.limit, 8);
});
test("unrelated POST Request bodies are not disturbed", async () => {
  const f = fixture(), original = async input => new Response(await input.text()), root = { fetch: original };
  const undo = installFetch(root, f.engine, { isFeed: () => false }, original);
  const input = new Request("https://www.tiktok.com/api/example/", { method: "POST", body: "business-body" });
  assert.equal(await (await root.fetch(input)).text(), "business-body"); assert.equal(f.calls.length, 0); undo();
});

function box(type, payload) { const b = Buffer.alloc(8 + payload.length); b.writeUInt32BE(b.length); b.write(type, 4); payload.copy(b, 8); return b; }
function sidxFixture(version = 0) {
  const hdlr = Buffer.alloc(24); hdlr.write("vide", 8);
  const mdhd = Buffer.alloc(24); mdhd.writeUInt32BE(1000, 12);
  const moov = box("moov", box("trak", box("mdia", Buffer.concat([box("hdlr", hdlr), box("mdhd", mdhd)]))));
  const payload = Buffer.alloc((version ? 32 : 24) + 36); payload[0] = version; payload.writeUInt32BE(1000, 8);
  let p = version ? 28 : 20; payload.writeUInt16BE(3, p + 2); p += 4;
  for (let i = 0; i < 3; i++, p += 12) { payload.writeUInt32BE(100, p); payload.writeUInt32BE(2000, p + 4); payload.writeUInt32BE(i === 1 ? 0 : 0x90000000, p + 8); }
  return Buffer.concat([box("ftyp", Buffer.from("isom0000")), moov, box("sidx", payload), Buffer.alloc(300)]);
}
test("SIDX v0/v1 timeline, keyframe backtrack and independent track intersection", () => {
  for (const v of [0, 1]) {
    const parsed = M.parseMP4(sidxFixture(v)); assert.equal(parsed.fragments.length, 3); assert.equal(parsed.duration, 6);
    const ranges = M.rangesFor(parsed, 2.5, 3); assert.equal(ranges[1][0], parsed.fragments[0].start); assert.equal(ranges[1][1], parsed.fragments[1].end);
  }
  assert.deepEqual(U.intersect([[0, 5.873], [5.873, 12]], [[0, 5.851]]), [[0, 5.851]]);
  assert.equal(U.ahead([[0, 5], [8, 30]], 4), 1);
});
test("cached timeline requires initialization and decode predecessors", () => {
  const index = M.parseMP4(sidxFixture()), r = { index }, stored = new Set();
  const engine = { store: { has: (_, a, b) => stored.has(a + ":" + b) } };
  const put = (a, b) => stored.add(a + ":" + b); put(0, index.initEnd);
  put(index.fragments[1].start, index.fragments[1].end); assert.deepEqual(M.cachedTimes(engine, r), []);
  put(index.fragments[0].start, index.fragments[0].end); assert.deepEqual(M.cachedTimes(engine, r), [[0, 4]]);
});
test("unknown progressive MP4 falls back without inventing a time index", () => {
  const b = Buffer.concat([box("ftyp", Buffer.from("isom0000")), box("mdat", Buffer.alloc(200))]);
  assert.equal(M.parseMP4(b).fragments, null); assert.equal(M.rangesFor(null, 0, 10), null);
  assert.equal(M.parseMP4(new Uint8Array([1,2,3])).recognized, false);
});
test("feed models match DASH audio by file identity", () => {
  const input = { itemList: [{ id: "123", video: { duration: 60, bitrateInfo: [{ Format: "dash", GearName: "hvc1", PlayAddr: { UrlList: [URL1] }, VideoExtra: JSON.stringify({ audio_file_id: "a" }) }], bitrateAudioInfo: [{ FileId: "a", UrlList: [URL1.replace("video-hvc1", "audio-mp4a")] }] } }] };
  const items = itemList(input), item = model(items[0]); assert.equal(items.length, 1); assert.equal(item.variants[0].audio.fileId, "a"); assert.equal(item.selected, null);
  assert.deepEqual(itemList({ user: input }), []);
  input.itemList[0].video.bitrateAudioInfo[0].UrlList = { MainUrl: URL1, BackupUrl: URL1 + "b", FallbackUrl: "https://unrelated.example/a" };
  assert.equal(model(input.itemList[0]).variants[0].audio.urls.length, 2);
});
test("expired registry references cannot restart prefetch outside retention accounting", () => {
  const f = fixture(), adapter = { engine: f.engine }, item = { selected: { actualVideo: f.resource } };
  assert.deepEqual(PageAdapter.prototype.selectedResources.call(adapter, item), [f.resource]);
  f.engine.resources.delete(f.resource.key);
  assert.deepEqual(PageAdapter.prototype.selectedResources.call(adapter, item), []);
});
