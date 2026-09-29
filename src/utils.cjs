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
