"use strict";
const fs = require("node:fs"), path = require("node:path");
const names = ["utils", "range-engine", "media-index", "fetch-transport", "quality-policy", "page-adapter", "panel", "entry"];
const modules = names.map(name => JSON.stringify("./" + name + ".cjs") + ":function(module,exports,require){\n" + fs.readFileSync(path.join(__dirname, "src", name + ".cjs"), "utf8") + "\n}").join(",\n");
const metadata = `// ==UserScript==
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
`;
const runtime = `(function(){"use strict";const modules={\n${modules}\n},cache={};function require(id){if(cache[id])return cache[id].exports;if(!modules[id])throw new Error("Unknown module");const module=cache[id]={exports:{}};modules[id](module,module.exports,require);return module.exports;}require("./entry.cjs").install(window,OPTIONS);})();\n`;
fs.writeFileSync(path.join(__dirname, "TikTok-Native-Buffer.user.js"), metadata + runtime.replace("OPTIONS", "{}"));
// Temporary browser diagnostics deliberately keep settings ephemeral.
if (process.argv.includes("--diagnostic")) fs.writeFileSync(path.join(__dirname, "diagnostic.js"), runtime.replace("OPTIONS", "{persist:false}"));
console.log("Built TikTok-Native-Buffer.user.js");
