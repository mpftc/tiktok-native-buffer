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
