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
