/*!
 * dsh-media-player — client half (browser bundle) · v0.1.0
 *
 * 一个 file viewer 同时接管音频与视频（exts 合并），核心目标：
 *   1) 视频：原生 <video controls preload="metadata"> —— 自带拖动条、自带全屏；
 *   2) 音频：**一条独立的、整轨时间轴的可拖 scrubber**，拖动直接写
 *      el.currentTime，与「频谱 / 音准」完全解耦（波形没解码也能 seek）；
 *   3) 频谱：AnalyserNode.getByteFrequencyData → canvas 对数分桶柱状图；
 *   4) 音准：AnalyserNode.getFloatTimeDomainData → 归一化自相关(ACF)+抛物线插值
 *      → Hz / 音名 / 音分（零依赖，几 KB 代码）。
 *
 * Bundle 形态：官方 DSH client-bundle 形状（lazy-CJS 闭包 + __ModuleLoader__），
 * react 从宿主 module table 里 require，其余全部内联。**不要**写 import/export。
 *
 * 为什么音频要自己做进度条（核心痛点）：原生 <audio> 若不开 controls 就没有
 * 拖动条；开了 controls 样式与面板也不统一，而且用户之前遇到的「波形解码失败
 * 连 seek 一起废」问题正是把两者绑在一起造成的。这里进度条只依赖
 * loadedmetadata 给出的 duration（或 seekable.end），与 Web Audio 解码无关。
 *
 * 硬约束（踩过的坑，别再犯）：
 *   - 必须有 exports.apply，否则 cordis 判 invalid plugin；
 *   - 注册必须包在 ctx.effect 里，否则停用/重挂时报 "already registered"；
 *   - fetch / src 一律**根相对路径**（/dsh-media-player/media?...），绝不拼宿主
 *     绝对 origin —— 换端口 + CSP 都会立刻死；
 *   - AudioContext 必须在**用户手势**里创建/resume，否则元素音频会被静音
 *     （createMediaElementSource 后 context 处于 suspended = 完全没声音）；
 *     所以视频默认不建 graph，只有用户点「频谱」开关才建。
 */
window.__ModuleLoader__.load({
  id: "dsh-media-player",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    "use strict";

    var react = require("react");
    var h = react.createElement;

    var VERSION = "0.1.1";

    // ── 扩展名（host 的 MEDIA_TYPES 必须与这里保持一致）────────────────────
    var VIDEO_EXTS = [
      "mp4", "m4v", "webm", "mov", "qt", "mkv", "avi", "wmv", "flv",
      "ogv", "ogg", "mpeg", "mpg", "3gp", "3g2", "m2ts"
    ];
    var AUDIO_EXTS = [
      "mp3", "wav", "wave", "flac", "oga", "opus", "m4a", "aac", "wma",
      "aif", "aiff", "amr", "ape", "caf", "mka"
    ];
    var MEDIA_EXTS = VIDEO_EXTS.concat(AUDIO_EXTS.filter(function (x) {
      return VIDEO_EXTS.indexOf(x) === -1;
    }));

    var VIDEO_SET = {};
    for (var vi = 0; vi < VIDEO_EXTS.length; vi++) VIDEO_SET[VIDEO_EXTS[vi]] = true;

    function extOf(path) {
      var name = String(path || "").replace(/^.*[\\/]/, "");
      var dot = name.lastIndexOf(".");
      return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
    }

    function isVideoPath(path) {
      return VIDEO_SET[extOf(path)] === true;
    }

    // ── URL（一律根相对）──────────────────────────────────────────────────
    function baseParams(scope, path) {
      var params = new URLSearchParams({ sessionId: scope.sessionId, path: path });
      if (scope.cwd !== undefined && scope.cwd !== "") params.set("cwd", scope.cwd);
      return params;
    }

    function mediaUrl(scope, path) {
      return "/dsh-media-player/media?" + baseParams(scope, path).toString();
    }

    /** 内置下载路由（浏览器解不了码时至少还能把原文件抓下来）。 */
    function downloadUrl(scope, path) {
      var params = baseParams(scope, path);
      params.set("download", "1");
      return "/sidebar/file?" + params.toString();
    }

    /** 歌词路由（根相对，同源）：只带 path + cwd，宿主按 cwd 做路径围栏。 */
    function lyricUrl(scope, path) {
      var params = new URLSearchParams({ path: path });
      if (scope.cwd !== undefined && scope.cwd !== "") params.set("cwd", scope.cwd);
      return "/dsh-media-player/lyric?" + params.toString();
    }

    /** 字幕路由（根相对，同源）：宿主把 .vtt/.srt/.ass 统一转成 VTT 回吐。 */
    function subtitleUrl(scope, path) {
      var params = new URLSearchParams({ path: path });
      if (scope.cwd !== undefined && scope.cwd !== "") params.set("cwd", scope.cwd);
      return "/dsh-media-player/subtitle?" + params.toString();
    }

    /** 二分查找「最后一个 t <= currentTime 的行号」；无线索返回 -1。 */
    function findLyricIndex(lines, t) {
      if (!lines || lines.length === 0) return -1;
      var lo = 0, hi = lines.length - 1, ans = -1;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (lines[mid].t <= t + 1e-6) { ans = mid; lo = mid + 1; }
        else { hi = mid - 1; }
      }
      return ans;
    }

    // ── 字幕（自绘）：VTT/SRT 解析 + 命中 + 偏好 ──────────────────────────────
    // 原生 <track> 的 ::cue 字号在 Chrome 下极不可靠，故不渲染原生轨、改为自绘层。
    // 下面是纯函数区，测试脚本按 SUBTITLE_PURE 标记整段抽取求值，防止与实现漂移。
    // === SUBTITLE_PURE_BEGIN ===
    var SUBTITLE_SIZES = [16, 20, 24, 30]; // 4 档字号（px），默认下标 1 = 20
    var SUBTITLE_POS = [10, 18, 28]; // 3 档距容器底部百分比（越大越靠上），默认下标 1

    function subtitleParseTimestamp(str) {
      if (typeof str !== "string") return NaN;
      var m = str.match(/(\d{1,3}):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?/);
      if (m) {
        var hh = Number(m[1]), mm = Number(m[2]), ss = Number(m[3]);
        var ms = m[4] ? Number((m[4] + "00").slice(0, 3)) : 0;
        return hh * 3600 + mm * 60 + ss + ms / 1000;
      }
      m = str.match(/(\d{1,3}):(\d{1,2})(?:[.,](\d{1,3}))?/);
      if (m) {
        var mm2 = Number(m[1]), ss2 = Number(m[2]);
        var ms2 = m[3] ? Number((m[3] + "00").slice(0, 3)) : 0;
        return mm2 * 60 + ss2 + ms2 / 1000;
      }
      return NaN;
    }

    function subtitleStripTags(s) {
      return String(s)
        .replace(/<[^>]*>/g, "")
        .replace(/\{[^}]*\}/g, "")
        .trim();
    }

    // 同时吃 VTT（"WEBVTT" 头 + 点毫秒）与 SRT（cue 序号 + 逗号毫秒）。
    function parseSubtitleCues(text) {
      var cues = [];
      if (typeof text !== "string" || text.length === 0) return cues;
      var s = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
      var blocks = s.split(/\n{2,}/);
      for (var i = 0; i < blocks.length; i++) {
        var lines = blocks[i].split("\n");
        var tIdx = -1;
        for (var j = 0; j < lines.length; j++) {
          if (lines[j].indexOf("-->") !== -1) { tIdx = j; break; }
        }
        if (tIdx === -1) continue; // WEBVTT / NOTE / STYLE 头块跳过
        var timing = lines[tIdx];
        var parts = timing.split("-->");
        if (parts.length < 2) continue;
        var start = subtitleParseTimestamp(parts[0]);
        // 结束时间后面可能跟 cue 设置（align:middle 等），只取第一个时间片段
        var endMatch = parts[1].match(/^\s*(\d{1,3}:\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?|\d{1,3}:\d{1,2}(?:[.,]\d{1,3})?)/);
        var end = endMatch ? subtitleParseTimestamp(endMatch[1]) : NaN;
        if (!isFinite(start) || !isFinite(end)) continue;
        var body = subtitleStripTags(lines.slice(tIdx + 1).join("\n"));
        if (body === "") continue;
        cues.push({ start: start, end: end, text: body });
      }
      cues.sort(function (a, b) { return a.start - b.start; });
      return cues;
    }

    // 返回 t 时刻命中的 cue 下标（start<=t<=end），无则 -1。
    function findSubtitleCue(cues, t) {
      if (!cues || cues.length === 0) return -1;
      var lo = 0, hi = cues.length - 1, ans = -1;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (cues[mid].start <= t + 1e-6) { ans = mid; lo = mid + 1; }
        else { hi = mid - 1; }
      }
      if (ans === -1) return -1;
      if (t <= cues[ans].end + 1e-6) return ans;
      return -1;
    }

    function clampIdx(i, n) {
      var v = Number(i);
      if (!isFinite(v)) return 0;
      v = Math.round(v);
      if (v < 0) return 0;
      if (v > n - 1) return n - 1;
      return v;
    }

    var SUBTITLE_PREFS_KEY = "dsh-media-player.subtitlePrefs";
    var DEFAULT_SUBTITLE_PREFS = { on: true, sizeIdx: 1, posIdx: 1 };

    function loadSubtitlePrefs() {
      var out = {
        on: DEFAULT_SUBTITLE_PREFS.on,
        sizeIdx: DEFAULT_SUBTITLE_PREFS.sizeIdx,
        posIdx: DEFAULT_SUBTITLE_PREFS.posIdx
      };
      try {
        var raw = window.localStorage.getItem(SUBTITLE_PREFS_KEY);
        if (raw) {
          var p = JSON.parse(raw);
          if (p && typeof p === "object") {
            if (typeof p.on === "boolean") out.on = p.on;
            out.sizeIdx = clampIdx(p.sizeIdx, SUBTITLE_SIZES.length);
            out.posIdx = clampIdx(p.posIdx, SUBTITLE_POS.length);
          }
        }
      } catch (e) { /* localStorage 不可用则用默认 */ }
      return out;
    }

    function saveSubtitlePrefs(p) {
      try {
        window.localStorage.setItem(SUBTITLE_PREFS_KEY, JSON.stringify({
          on: !!p.on,
          sizeIdx: clampIdx(p.sizeIdx, SUBTITLE_SIZES.length),
          posIdx: clampIdx(p.posIdx, SUBTITLE_POS.length)
        }));
      } catch (e) { /* 忽略 */ }
    }

    // ── 歌词开关偏好（音频）：持久化为 {show:boolean}，默认开启 ────────────────
    var LYRIC_PREFS_KEY = "dsh-media-player.lyricPrefs";
    var DEFAULT_LYRIC_PREFS = { show: true };

    function loadLyricPrefs() {
      var out = { show: DEFAULT_LYRIC_PREFS.show };
      try {
        var raw = window.localStorage.getItem(LYRIC_PREFS_KEY);
        if (raw) {
          var p = JSON.parse(raw);
          if (p && typeof p === "object" && typeof p.show === "boolean") out.show = p.show;
        }
      } catch (e) { /* localStorage 不可用则用默认 */ }
      return out;
    }

    function saveLyricPrefs(p) {
      try {
        window.localStorage.setItem(LYRIC_PREFS_KEY, JSON.stringify({ show: !!p.show }));
      } catch (e) { /* 忽略 */ }
    }

    // 歌词区是否渲染：非视频 + 开关开启 + 有可渲染内容（含"无歌词"占位）。
    function shouldRenderLyricBlock(lyricOn, isVideo, lyric) {
      if (isVideo || !lyricOn || !lyric) return false;
      if (lyric.source === "lrc" && lyric.lines && lyric.lines.length > 0) return true;
      if (lyric.source === "plain" && lyric.text) return true;
      if (lyric.source === "none") return true;
      return false;
    }

    // 是否存在真实歌词内容（决定是否显示歌词开关按钮；"无歌词"占位不算）。
    function hasLyricContent(lyric) {
      if (!lyric) return false;
      if (lyric.source === "lrc" && lyric.lines && lyric.lines.length > 0) return true;
      if (lyric.source === "plain" && lyric.text) return true;
      return false;
    }
    // === SUBTITLE_PURE_END ===

    // ── 小工具 ─────────────────────────────────────────────────────────────
    function pad2(n) {
      return n < 10 ? "0" + n : String(n);
    }

    function fmtTime(sec) {
      if (typeof sec !== "number" || !isFinite(sec) || sec < 0) return "--:--";
      var total = Math.floor(sec);
      var s = total % 60;
      var m = Math.floor(total / 60) % 60;
      var hr = Math.floor(total / 3600);
      return hr > 0
        ? hr + ":" + pad2(m) + ":" + pad2(s)
        : m + ":" + pad2(s);
    }

    function errText(err) {
      if (err === null || err === undefined) return "unknown";
      if (typeof err === "string") return err;
      if (err.message) return String(err.message);
      return String(err);
    }

    // ── 音名换算 ───────────────────────────────────────────────────────────
    var NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

    function freqToNote(hz) {
      if (typeof hz !== "number" || !isFinite(hz) || hz <= 0) {
        return { name: "\u2014", hz: 0, cents: 0, midi: 0 };
      }
      var midi = 69 + 12 * (Math.log(hz / 440) / Math.LN2);
      var rounded = Math.round(midi);
      var idx = ((rounded % 12) + 12) % 12;
      var octave = Math.floor(rounded / 12) - 1;
      return {
        name: NOTE_NAMES[idx] + octave,
        hz: hz,
        cents: Math.round((midi - rounded) * 100),
        midi: midi
      };
    }

    // ── 基频估计：归一化自相关 + 抛物线插值 ────────────────────────────────
    // 输入 2048 点、相关窗口 1024 点：55Hz~2kHz 全落在可测范围内，
    // 单次约 0.8M 次乘加，调用侧再按 4 帧一次节流。
    var PITCH_MIN_HZ = 55;
    var PITCH_MAX_HZ = 2000;
    var SILENCE_RMS = 0.008;
    var PITCH_FLOOR = 0.5;

    function detectPitchRaw(buf, sampleRate) {
      var size = buf.length;
      var half = size >> 1;
      if (half < 64) return 0;

      var sum = 0;
      var i;
      for (i = 0; i < half; i++) sum += buf[i] * buf[i];
      var rms = Math.sqrt(sum / half);
      if (!(rms > SILENCE_RMS)) return 0;

      var minLag = Math.max(2, Math.floor(sampleRate / PITCH_MAX_HZ));
      var maxLag = Math.min(half - 2, Math.ceil(sampleRate / PITCH_MIN_HZ));
      if (maxLag <= minLag) return 0;

      var n = maxLag - minLag + 1;
      var corrs = new Float32Array(n);
      var e0 = 0;
      for (i = 0; i < half; i++) e0 += buf[i] * buf[i];
      if (!(e0 > 0)) return 0;

      var bestCorr = 0;
      for (var k = 0; k < n; k++) {
        var lag = minLag + k;
        var c = 0;
        var e = 0;
        for (i = 0; i < half; i++) {
          var a = buf[i];
          var b = buf[i + lag];
          c += a * b;
          e += b * b;
        }
        var norm = c / Math.sqrt(e0 * e + 1e-12);
        corrs[k] = norm;
        if (norm > bestCorr) bestCorr = norm;
      }
      if (!(bestCorr >= PITCH_FLOOR)) return 0;

      // 🔴 关键：取「第一个足够高的局部峰」，**不要**取全局最大值。
      // 归一化 ACF 在 period 的 2×/3×/4× 处几乎同样相关（纯正弦甚至完全等值），
      // 直接拿全局最大会随机落在长 lag 上 —— 实测 440Hz 会被读成 110Hz、
      // 880Hz 被读成 220Hz，全是八度（含四度）错位。周期最小又能达到全局峰
      // 90% 的那个峰才是基频。
      var gate = Math.max(PITCH_FLOOR, bestCorr * 0.9);
      var pick = -1;
      // 必须是「先升后降」的真局部峰：边界 k=0 不算峰（低频信号的 ACF 在极小
      // lag 处本来就很高 —— lag=24 @48k 对 110Hz 仍有 cos(0.345)=0.94，把
      // 它当峰会直接读出 2000Hz 的假高音）。
      for (var q = 1; q < n - 1; q++) {
        if (corrs[q] >= gate && corrs[q] > corrs[q - 1] && corrs[q] >= corrs[q + 1]) {
          pick = q;
          break;
        }
      }
      if (pick < 0) {
        for (var q2 = 0; q2 < n; q2++) {
          if (corrs[q2] === bestCorr) {
            pick = q2;
            break;
          }
        }
      }
      if (pick < 0) return 0;

      // 抛物线插值（亚样本精度）
      var delta = 0;
      if (pick > 0 && pick < n - 1) {
        var y0 = corrs[pick - 1];
        var y1 = corrs[pick];
        var y2 = corrs[pick + 1];
        var denom = y0 - 2 * y1 + y2;
        if (Math.abs(denom) > 1e-9) delta = (y0 - y2) / (2 * denom);
        if (delta > 0.5) delta = 0.5;
        if (delta < -0.5) delta = -0.5;
      }
      var period = minLag + pick + delta;
      if (!(period > 0)) return 0;
      var hz = sampleRate / period;
      if (!isFinite(hz) || hz < PITCH_MIN_HZ || hz > PITCH_MAX_HZ) return 0;
      return hz;
    }

    // ── canvas 频谱 ────────────────────────────────────────────────────────
    var SPECTRUM_MIN_HZ = 40;
    var SPECTRUM_MAX_HZ = 16000;

    function fitCanvas(canvas) {
      var dpr = window.devicePixelRatio || 1;
      var cssW = canvas.clientWidth || 320;
      var cssH = canvas.clientHeight || 96;
      var w = Math.max(1, Math.round(cssW * dpr));
      var hh = Math.max(1, Math.round(cssH * dpr));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== hh) canvas.height = hh;
      return { w: w, h: hh, dpr: dpr };
    }

    /**
     * 画柱状频谱（对数频率分桶，低频不挤、高频不空）。
     * @param {HTMLCanvasElement} canvas
     * @param {Uint8Array|null} bins getByteFrequencyData 结果；null = 画静默基线
     * @param {number} sampleRate
     * @param {number} fftSize
     */
    function drawSpectrum(canvas, bins, sampleRate, fftSize) {
      var c2d = canvas.getContext("2d");
      if (!c2d) return;
      var dims = fitCanvas(canvas);
      var w = dims.w;
      var hh = dims.h;
      c2d.clearRect(0, 0, w, hh);

      // 底：一条极淡的中轴 + 分隔，让空白画布也有"仪器感"
      c2d.fillStyle = "rgba(140,150,180,0.14)";
      c2d.fillRect(0, hh - Math.max(1, dims.dpr), w, Math.max(1, dims.dpr));

      var bars = Math.max(16, Math.min(96, Math.floor(w / (6 * dims.dpr))));
      var barW = w / bars;
      var gap = Math.max(1, Math.floor(barW * 0.22));

      for (var i = 0; i < bars; i++) {
        var v = 0;
        if (bins && sampleRate > 0 && fftSize > 0) {
          var binHz = sampleRate / fftSize;
          var f0 = SPECTRUM_MIN_HZ * Math.pow(SPECTRUM_MAX_HZ / SPECTRUM_MIN_HZ, i / bars);
          var f1 = SPECTRUM_MIN_HZ * Math.pow(SPECTRUM_MAX_HZ / SPECTRUM_MIN_HZ, (i + 1) / bars);
          var b0 = Math.max(0, Math.floor(f0 / binHz));
          var b1 = Math.max(b0, Math.floor(f1 / binHz));
          var peak = 0;
          for (var bi = b0; bi <= b1 && bi < bins.length; bi++) {
            if (bins[bi] > peak) peak = bins[bi];
          }
          v = peak / 255;
          // 轻微提升低频以外的观感（高频能量天然小）
          v = Math.min(1, v * (1 + 0.35 * (1 - i / bars)));
        }
        // 零能量柱不画（暂停后留下的"一排钉子"会让人误以为还在播）
        if (!(v > 0)) continue;
        var bh = Math.max(1, Math.round(v * (hh - 2)));
        var x = Math.round(i * barW);
        var ratio = bars <= 1 ? 0 : i / (bars - 1);
        if (ratio < 0.5) c2d.fillStyle = "#3fbf9a";
        else if (ratio < 0.8) c2d.fillStyle = "#4c8dff";
        else c2d.fillStyle = "#f0a94a";
        c2d.globalAlpha = 0.95;
        c2d.fillRect(x, hh - bh, Math.max(1, Math.round(barW) - gap), bh);
      }
      c2d.globalAlpha = 1;

      if (!bins) {
        c2d.fillStyle = "rgba(140,150,180,0.55)";
        c2d.font = Math.round(11 * dims.dpr) + "px system-ui, -apple-system, 'Segoe UI', sans-serif";
        c2d.textAlign = "center";
        c2d.textBaseline = "middle";
        c2d.fillText("\u5f85\u64ad\u653e", w / 2, hh / 2);
      }
    }

    // 图标尺寸入参归一化：本文件的图标既能被「按位置」调用（宿主 icon 回调传数字，
    // 如 function (size) { return IconMedia(size); }），也会被当作 React 组件调用
    // （h(IconX, { size: 15 }) —— 此时首参收到的是 props 对象）。
    // 若把 props 对象直接当 width/height 用，SVG 得到的是非法长度，浏览器按 auto
    // 处理 → 退化成 100%（无约束时按默认 300×150），在没固定尺寸的 flex 容器里
    // 就被撑成巨型图标（本插件喇叭图标撑满预览区即此因）。
    function iconSize(input, fallback) {
      var n = typeof input === "number"
        ? input
        : (input && typeof input.size === "number" ? input.size : NaN);
      return (isFinite(n) && n > 0) ? n : fallback;
    }

    // ── 图标（16px，1.5px 描边，currentColor）──────────────────────────────
    function IconMedia(props) {
      var size = iconSize(props, 16);
      return h("svg", {
        width: size, height: size, viewBox: "0 0 16 16", fill: "none",
        xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true"
      }, [
        h("rect", {
          key: "f", x: 1.5, y: 2.5, width: 13, height: 11, rx: 2.5,
          stroke: "currentColor", strokeWidth: 1.5
        }),
        h("circle", {
          key: "c", cx: 8, cy: 8, r: 2.4, stroke: "currentColor", strokeWidth: 1.5
        })
      ]);
    }

    function IconPlay(props) {
      var size = iconSize(props, 16);
      return h("svg", {
        width: size, height: size, viewBox: "0 0 16 16", fill: "currentColor",
        xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true"
      }, [h("path", { key: "p", d: "M4.5 2.8v10.4l8.5-5.2z" })]);
    }

    function IconPause(props) {
      var size = iconSize(props, 16);
      return h("svg", {
        width: size, height: size, viewBox: "0 0 16 16", fill: "currentColor",
        xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true"
      }, [
        h("rect", { key: "a", x: 4, y: 2.8, width: 3, height: 10.4, rx: 0.8 }),
        h("rect", { key: "b", x: 9, y: 2.8, width: 3, height: 10.4, rx: 0.8 })
      ]);
    }

    function IconVolume(props) {
      var size = iconSize(props, 15);
      return h("svg", {
        width: size, height: size, viewBox: "0 0 16 16", fill: "none",
        xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true"
      }, [
        h("path", {
          key: "s", d: "M2.5 6h2.2L8 3.2v9.6L4.7 10H2.5z",
          fill: "currentColor", stroke: "currentColor", strokeWidth: 1.1, strokeLinejoin: "round"
        }),
        h("path", {
          key: "w", d: "M10.4 5.6a3.4 3.4 0 0 1 0 4.8M12.2 4a5.6 5.6 0 0 1 0 8",
          stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round"
        })
      ]);
    }

    function IconSpectrum(props) {
      var size = iconSize(props, 15);
      return h("svg", {
        width: size, height: size, viewBox: "0 0 16 16", fill: "none",
        xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true"
      }, [
        h("path", {
          key: "b",
          d: "M2.5 12.5V8.5M5.4 12.5V5.5M8.3 12.5V2.5M11.2 12.5V6.5M14 12.5V9.5",
          stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round"
        })
      ]);
    }

    function IconLoop(props) {
      var size = iconSize(props, 15);
      return h("svg", {
        width: size, height: size, viewBox: "0 0 16 16", fill: "none",
        xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true"
      }, [
        h("path", {
          key: "p",
          d: "M3 6.5A3.5 3.5 0 0 1 6.5 3h6M13 9.5A3.5 3.5 0 0 1 9.5 13h-6M11 1.6l1.9 1.4L11 4.4M5 14.4l-1.9-1.4L5 11.6",
          stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round"
        })
      ]);
    }

    function IconSubtitle(props) {
      var size = iconSize(props, 15);
      return h("svg", {
        width: size, height: size, viewBox: "0 0 16 16", fill: "none",
        xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true"
      }, [
        h("rect", {
          key: "r", x: 1.5, y: 3, width: 13, height: 10, rx: 2.5,
          stroke: "currentColor", strokeWidth: 1.3
        }),
        h("path", {
          key: "l",
          d: "M4.2 8.2h3M8.8 8.2h3M4.2 10.6h2.2M8.2 10.6h3.6",
          stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round"
        })
      ]);
    }

    // 歌词图标：矩形 + 若干条横线（与字幕图标同风格）
    function IconLyric(props) {
      var size = iconSize(props, 15);
      return h("svg", {
        width: size, height: size, viewBox: "0 0 16 16", fill: "none",
        xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true"
      }, [
        h("rect", {
          key: "r", x: 1.5, y: 2.5, width: 13, height: 11, rx: 2.5,
          stroke: "currentColor", strokeWidth: 1.3
        }),
        h("path", {
          key: "l",
          d: "M4.2 6h7.6M4.2 8.2h5.6M4.2 10.4h6.6",
          stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round"
        })
      ]);
    }

    // ── 样式常量 ───────────────────────────────────────────────────────────
    var LABEL = "var(--dsw-alias-label-secondary, #8b90a0)";
    var BRAND = "var(--dsw-alias-brand-primary, #4c8dff)";
    var LINK = "var(--dsw-alias-link-normal, #4c8dff)";
    var BORDER = "var(--dsw-alias-border-l2, rgba(140,150,180,0.28))";
    var SURFACE = "var(--dsw-alias-bg-layer-2, rgba(140,150,180,0.08))";
    var TEXT = "var(--dsw-alias-label-primary, inherit)";

    var btnStyle = {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      gap: "4px",
      height: "26px",
      minWidth: "26px",
      padding: "0 7px",
      borderRadius: "7px",
      border: "1px solid " + BORDER,
      background: "transparent",
      color: TEXT,
      cursor: "pointer",
      fontSize: "12px",
      lineHeight: 1,
      boxSizing: "border-box",
      fontFamily: "inherit"
    };

    var btnOnStyle = Object.assign({}, btnStyle, {
      background: "color-mix(in srgb, " + BRAND + " 16%, transparent)",
      borderColor: "color-mix(in srgb, " + BRAND + " 55%, transparent)"
    });

    // ── viewer 组件 ────────────────────────────────────────────────────────
    function MediaViewer(props) {
      var scope = props.scope;
      var path = props.path;
      var isVideo = isVideoPath(path);
      var src = mediaUrl(scope, path);
      var dl = downloadUrl(scope, path);

      var mediaRef = react.useRef(null);
      var canvasRef = react.useRef(null);
      var rafRef = react.useRef(0);
      var actxRef = react.useRef(null);
      var analyserRef = react.useRef(null);
      var freqRef = react.useRef(null);
      var waveRef = react.useRef(null);
      var boundElRef = react.useRef(null);
      var dragRef = react.useRef(false);
      var lastSeekRef = react.useRef(0);
      var tickRef = react.useRef(0);
      var silentRef = react.useRef(0);
      var lastNoteRef = react.useRef({ name: "\u2014", hz: 0, cents: 0 });

      var durState = react.useState(0);
      var duration = durState[0];
      var setDuration = durState[1];

      var timeState = react.useState(0);
      var time = timeState[0];
      var setTime = timeState[1];

      var playState = react.useState(false);
      var playing = playState[0];
      var setPlaying = playState[1];

      var volState = react.useState(1);
      var volume = volState[0];
      var setVolume = volState[1];

      var rateState = react.useState(1);
      var rate = rateState[0];
      var setRate = rateState[1];

      var loopState = react.useState(false);
      var loop = loopState[0];
      var setLoop = loopState[1];

      // 音频默认开频谱（播放一定由本组件按钮触发 → 手势内可 resume）；
      // 视频默认关（原生控件播放时无手势，建 graph 会把声音静掉）。
      var anaState = react.useState(!isVideo);
      var analyse = anaState[0];
      var setAnalyse = anaState[1];

      var readyState = react.useState(false);
      var graphReady = readyState[0];
      var setGraphReady = readyState[1];

      var noteState = react.useState({ name: "\u2014", hz: 0, cents: 0 });
      var note = noteState[0];
      var setNote = noteState[1];

      var errState = react.useState("");
      var error = errState[0];
      var setError = errState[1];

      var dragState = react.useState(false);
      var dragging = dragState[0];
      var setDragging = dragState[1];

      // ── 歌词（音频文本轨）：state + 引用（refs 供时间回调读取，避免闭包过期）──
      var lyricState = react.useState({ source: "", lines: [], text: "" });
      var lyric = lyricState[0];
      var setLyric = lyricState[1];
      var curLyricState = react.useState(-1);
      var curLyricIdx = curLyricState[0];
      var setCurLyricIdx = curLyricState[1];
      var lyricWrapRef = react.useRef(null);
      var lyricLinesRef = react.useRef([]);
      var lyricElsRef = react.useRef([]);
      var curLyricRef = react.useRef(-1);

      // 歌词开关（音频）：默认开启（保持现有可见歌词），偏好持久化到 localStorage
      var lyricPrefsRef = react.useRef(null);
      if (lyricPrefsRef.current === null) lyricPrefsRef.current = loadLyricPrefs();
      var lyricOnState = react.useState(lyricPrefsRef.current.show);
      var lyricOn = lyricOnState[0];
      var setLyricOn = lyricOnState[1];
      function changeLyricOn(v) {
        setLyricOn(v);
        saveLyricPrefs({ show: v });
      }

      // ── 字幕状态（仅视频；自绘层替代原生 track）────────────────────────────
      var subPrefsRef = react.useRef(null);
      if (subPrefsRef.current === null) subPrefsRef.current = loadSubtitlePrefs();
      var subPrefs0 = subPrefsRef.current;

      var subOnState = react.useState(subPrefs0.on);
      var subOn = subOnState[0];
      var setSubOn = subOnState[1];

      var subSizeState = react.useState(subPrefs0.sizeIdx);
      var subSizeIdx = subSizeState[0];
      var setSubSizeIdx = subSizeState[1];

      var subPosState = react.useState(subPrefs0.posIdx);
      var subPosIdx = subPosState[0];
      var setSubPosIdx = subPosState[1];

      var subPanelState = react.useState(false);
      var subPanelOpen = subPanelState[0];
      var setSubPanelOpen = subPanelState[1];

      var subAvailState = react.useState(false);
      var subAvail = subAvailState[0];
      var setSubAvail = subAvailState[1];

      var subTextState = react.useState("");
      var subText = subTextState[0];
      var setSubText = subTextState[1];

      var subCuesRef = react.useRef([]);
      var subTextRef = react.useRef("");

      // 按时间命中当前字幕条；只在文字真正变化时 setState（避免每帧重渲染）。
      function updateSubtitleText(t) {
        var cues = subCuesRef.current;
        var idx = findSubtitleCue(cues, t);
        var txt = idx >= 0 ? cues[idx].text : "";
        if (txt !== subTextRef.current) {
          subTextRef.current = txt;
          setSubText(txt);
        }
      }

      function changeSubOn(v) {
        setSubOn(v);
        saveSubtitlePrefs({ on: v, sizeIdx: subSizeIdx, posIdx: subPosIdx });
      }
      function changeSubSize(i) {
        var nv = clampIdx(i, SUBTITLE_SIZES.length);
        setSubSizeIdx(nv);
        saveSubtitlePrefs({ on: subOn, sizeIdx: nv, posIdx: subPosIdx });
      }
      function changeSubPos(i) {
        var nv = clampIdx(i, SUBTITLE_POS.length);
        setSubPosIdx(nv);
        saveSubtitlePrefs({ on: subOn, sizeIdx: subSizeIdx, posIdx: nv });
      }

      // 播放进度变化时更新当前行；只在行号真正变化时 setState（避免每帧重渲染）。
      function updateLyricIndex(t) {
        var lines = lyricLinesRef.current;
        if (!lines || lines.length === 0) {
          if (curLyricRef.current !== -1) { curLyricRef.current = -1; setCurLyricIdx(-1); }
          return;
        }
        var idx = findLyricIndex(lines, t);
        if (idx !== curLyricRef.current) { curLyricRef.current = idx; setCurLyricIdx(idx); }
      }

      // ── 时长：优先 el.duration，其次 seekable.end（部分封装容器 duration=Infinity）
      function durationOf(el) {
        if (!el) return 0;
        if (typeof el.duration === "number" && isFinite(el.duration) && el.duration > 0) return el.duration;
        try {
          var sk = el.seekable;
          if (sk && sk.length > 0) {
            var end = sk.end(sk.length - 1);
            if (typeof end === "number" && isFinite(end) && end > 0) return end;
          }
        } catch (err) { /* 忽略：跨源或未就绪时会抛 */ }
        return 0;
      }

      // 可拖拽上限：duration 优先，其次 seekable/buffered 末端（部分 mp3 preload=metadata 时 duration=Infinity）
      function playableEnd(el) {
        if (!el) return 0;
        var best = durationOf(el);
        try {
          var sk = el.seekable;
          if (sk && sk.length > 0) {
            var e = sk.end(sk.length - 1);
            if (isFinite(e) && e > best) best = e;
          }
        } catch (err) { /* 忽略 */ }
        try {
          var bf = el.buffered;
          if (bf && bf.length > 0) {
            var be = bf.end(bf.length - 1);
            if (isFinite(be) && be > best) best = be;
          }
        } catch (err) { /* 忽略 */ }
        return best > 0 ? best : 0;
      }

      // ── 真 seek：直接写 currentTime，与频谱/波形无关
      function hardSeek(value) {
        var el = mediaRef.current;
        if (!el) return;
        var d = playableEnd(el);
        if (!(d > 0)) return;
        var target = Number(value);
        if (!isFinite(target)) return;
        if (target < 0) target = 0;
        if (target > d) target = d;
        if (target >= d) target = Math.max(0, d - 0.05);
        try {
          el.currentTime = target;
        } catch (err) {
          setError("\u8df3\u8f6c\u5931\u8d25\uff1a" + errText(err));
        }
        setTime(target);
      }

      // ── Web Audio 图（必须在用户手势里调用）──────────────────────────────
      function promoteGraph() {
        if (analyserRef.current) {
          if (actxRef.current && actxRef.current.state === "suspended") actxRef.current.resume();
          return true;
        }
        var el = mediaRef.current;
        if (!el) return false;
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) {
          setAnalyse(false);
          setError("\u6b64\u6d4f\u89c8\u5668\u4e0d\u652f\u6301 Web Audio\uff0c\u9891\u8c31/\u97f3\u51c6\u4e0d\u53ef\u7528");
          return false;
        }
        try {
          var actx = new AC();
          var source = actx.createMediaElementSource(el);
          var an = actx.createAnalyser();
          an.fftSize = 2048;
          an.smoothingTimeConstant = 0.75;
          source.connect(an);
          an.connect(actx.destination);
          actxRef.current = actx;
          analyserRef.current = an;
          freqRef.current = new Uint8Array(an.frequencyBinCount);
          waveRef.current = new Float32Array(an.fftSize);
          boundElRef.current = el;
          if (actx.state === "suspended") actx.resume();
          setGraphReady(true);
          startLoop();
          return true;
        } catch (err) {
          setGraphReady(false);
          setAnalyse(false);
          setError("\u9891\u8c31\u521d\u59cb\u5316\u5931\u8d25\uff1a" + errText(err));
          return false;
        }
      }

      // ── rAF 循环（只在分析开 + 正在播时跑）────────────────────────────────
      function stopLoop() {
        if (rafRef.current) {
          window.cancelAnimationFrame(rafRef.current);
          rafRef.current = 0;
        }
      }

      function startLoop() {
        if (rafRef.current) return;
        var step = function () {
          rafRef.current = window.requestAnimationFrame(step);
          var canvas = canvasRef.current;
          var an = analyserRef.current;
          if (!canvas || !an) return;
          if (boundElRef.current !== mediaRef.current) return;

          var bins = freqRef.current;
          if (bins && typeof an.getByteFrequencyData === "function") {
            an.getByteFrequencyData(bins);
            drawSpectrum(canvas, bins, an.context.sampleRate, an.fftSize);
          }

          // 音准：4 帧算一次（~15Hz），静音 6 次后清空读数
          tickRef.current = (tickRef.current + 1) % 4;
          if (tickRef.current !== 0) return;
          var wave = waveRef.current;
          if (!wave || typeof an.getFloatTimeDomainData !== "function") return;
          an.getFloatTimeDomainData(wave);
          var hz = detectPitchRaw(wave, an.context.sampleRate);
          if (hz > 0) {
            silentRef.current = 0;
            var info = freqToNote(hz);
            var prev = lastNoteRef.current;
            if (prev.name !== info.name || Math.abs(prev.hz - info.hz) > 0.8) {
              lastNoteRef.current = info;
              setNote(info);
            }
          } else {
            silentRef.current += 1;
            if (silentRef.current === 6 && lastNoteRef.current.name !== "\u2014") {
              lastNoteRef.current = { name: "\u2014", hz: 0, cents: 0 };
              setNote(lastNoteRef.current);
            }
          }
        };
        rafRef.current = window.requestAnimationFrame(step);
      }

      // ── 播放 / 暂停 ───────────────────────────────────────────────────────
      function togglePlay() {
        var el = mediaRef.current;
        if (!el) return;
        if (el.paused) {
          if (analyse && !analyserRef.current) promoteGraph();
          else if (actxRef.current && actxRef.current.state === "suspended") actxRef.current.resume();
          var p = el.play();
          if (p && typeof p.catch === "function") {
            p.catch(function (err) {
              setError("\u64ad\u653e\u5931\u8d25\uff1a" + errText(err));
            });
          }
        } else {
          el.pause();
        }
      }

      // ── 媒体元素事件 + 生命周期 ───────────────────────────────────────────
      react.useEffect(function () {
        var el = mediaRef.current;
        if (!el) return undefined;

        // ── 传输层救援 ──────────────────────────────────────────────────────
        // dsh-app 自定义协议桥(forwardWebRequest)会把响应头 content-length 剥掉，
        // 导致 <audio>/<video> 拿不到总字节数 → duration=Infinity、seekable=[0,0]，
        // 滑块被禁用；即便时长能显示出来，写 currentTime 也会被夹回 0（无法 seek）。
        // 对策：探测到非法时长时，把整段媒体 fetch 成 Blob（Blob 自带确定长度），
        // 以它作为 element.src → duration 与 seekable 都恢复，滑块可正常拖动。
        var objUrl = null;
        var rescueBusy = false;
        var rescued = false;
        var cancelled = false;
        var validDur = function (d) { return typeof d === "number" && isFinite(d) && d > 0; };
        var tryRescue = function () {
          if (rescueBusy || rescued || cancelled) return;
          rescueBusy = true;
          var wasPlaying = !el.paused && !el.ended;
          var pos = el.currentTime || 0;
          fetch(src).then(function (r) {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.blob();
          }).then(function (blob) {
            if (cancelled) throw new Error("cancelled");
            if (!blob || blob.size <= 0) throw new Error("empty");
            if (blob.size > 300 * 1024 * 1024) throw new Error("too-large");
            if (objUrl) { try { URL.revokeObjectURL(objUrl); } catch (e) {} }
            objUrl = URL.createObjectURL(blob);
            rescued = true;
            rescueBusy = false;
            var restore = function () {
              el.removeEventListener("loadedmetadata", restore);
              if (cancelled) return;
              try { if (pos > 0) el.currentTime = pos; } catch (e) {}
              setDuration(durationOf(el));
              setTime(el.currentTime || 0);
              if (wasPlaying) {
                var p = el.play();
                if (p && typeof p.catch === "function") p.catch(function () {});
              }
            };
            el.addEventListener("loadedmetadata", restore);
            el.src = objUrl;
            try { el.load(); } catch (e) {}
          }).catch(function () {
            rescueBusy = false;
          });
        };
        var onMeta = function () {
          var d = durationOf(el);
          setDuration(d);
          // 时长与 seekable 都拿不到 → 触发 Blob 救援（每源只做一次）。
          // 音频与视频都受传输层 content-length 剥离影响（duration=Infinity、
          // seekable=[0,0]、写 currentTime 被夹回 0），统一走 Blob 救援；
          // 超大视频由 tryRescue 内的 300MB 体积护栏兜底，避免整段读入内存。
          if (!validDur(el.duration) && !(d > 0)) tryRescue();
        };
        var onTime = function () {
          if (!dragRef.current) setTime(el.currentTime || 0);
          updateLyricIndex(el.currentTime || 0);
          updateSubtitleText(el.currentTime || 0);
        };
        var onPlay = function () {
          setPlaying(true);
          setError("");
          if (analyse) {
            if (!analyserRef.current) {
              // 播放可能来自原生控件（无手势）→ 只在已有 graph 时看图
            } else {
              startLoop();
            }
          }
        };
        var onPause = function () {
          setPlaying(false);
          stopLoop();
          var canvas = canvasRef.current;
          if (canvas) drawSpectrum(canvas, null, 0, 0);
        };
        var onEnded = function () {
          setPlaying(false);
          stopLoop();
          setTime(durationOf(el));
        };
        var onErr = function () {
          setError("\u65e0\u6cd5\u64ad\u653e\u6b64\u6587\u4ef6\uff08\u6d4f\u89c8\u5668\u53ef\u80fd\u4e0d\u652f\u6301\u8be5\u7f16\u7801\uff1a." +
            extOf(path) + "\uff09");
        };
        var onProgress = function () {
          var d = durationOf(el);
          if (d > 0) setDuration(d);
        };

        el.addEventListener("loadedmetadata", onMeta);
        el.addEventListener("durationchange", onMeta);
        el.addEventListener("timeupdate", onTime);
        el.addEventListener("play", onPlay);
        el.addEventListener("playing", onPlay);
        el.addEventListener("pause", onPause);
        el.addEventListener("ended", onEnded);
        el.addEventListener("error", onErr);
        el.addEventListener("progress", onProgress);
        el.addEventListener("canplay", onProgress);
        el.addEventListener("loadeddata", onProgress);

        el.volume = volume;
        el.playbackRate = rate;
        el.loop = loop;

        onMeta();
        return function () {
          cancelled = true;
          el.removeEventListener("loadedmetadata", onMeta);
          el.removeEventListener("durationchange", onMeta);
          el.removeEventListener("timeupdate", onTime);
          el.removeEventListener("play", onPlay);
          el.removeEventListener("playing", onPlay);
          el.removeEventListener("pause", onPause);
          el.removeEventListener("ended", onEnded);
          el.removeEventListener("error", onErr);
          el.removeEventListener("progress", onProgress);
          el.removeEventListener("canplay", onProgress);
          el.removeEventListener("loadeddata", onProgress);
          if (objUrl) { try { URL.revokeObjectURL(objUrl); } catch (e) {} }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [src]);

      // ── 歌词加载（音频文本轨）：切源即重拉，切歌/卸载时中断并清空 ──────────
      react.useEffect(function () {
        lyricLinesRef.current = [];
        lyricElsRef.current = [];
        curLyricRef.current = -1;
        setCurLyricIdx(-1);
        setLyric({ source: "", lines: [], text: "" });
        if (isVideo) return undefined;
        var aborted = false;
        var ctrl = typeof AbortController === "function" ? new AbortController() : null;
        fetch(lyricUrl(scope, path), ctrl ? { signal: ctrl.signal } : undefined)
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (data) {
            if (aborted || !data) return;
            if (data.ok === true && data.source === "lrc" && Array.isArray(data.lines) && data.lines.length > 0) {
              lyricLinesRef.current = data.lines;
              setLyric({ source: "lrc", lines: data.lines, text: "" });
              updateLyricIndex((mediaRef.current && mediaRef.current.currentTime) || 0);
            } else if (data.ok === true && data.source === "plain" && typeof data.text === "string") {
              lyricLinesRef.current = [];
              setLyric({ source: "plain", lines: [], text: data.text });
            } else {
              setLyric({ source: "none", lines: [], text: "" });
            }
          })
          .catch(function () { if (!aborted) setLyric({ source: "none", lines: [], text: "" }); });
        return function () {
          aborted = true;
          if (ctrl) { try { ctrl.abort(); } catch (e) { /* 忽略 */ } }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [src, path]);

      // ── 字幕加载（仅视频）：拉 VTT 文本 → 解析 cue；无字幕静默不显示 ──────
      react.useEffect(function () {
        subCuesRef.current = [];
        subTextRef.current = "";
        setSubText("");
        setSubAvail(false);
        if (!isVideo) return undefined;
        var aborted = false;
        var ctrl = typeof AbortController === "function" ? new AbortController() : null;
        fetch(subtitleUrl(scope, path), ctrl ? { signal: ctrl.signal } : undefined)
          .then(function (r) { return r.ok ? r.text() : null; }) // 404 / no-subtitle → null
          .then(function (text) {
            if (aborted || text === null || text === undefined) return;
            var cues = parseSubtitleCues(text);
            if (cues.length === 0) return;
            subCuesRef.current = cues;
            setSubAvail(true);
            updateSubtitleText((mediaRef.current && mediaRef.current.currentTime) || 0);
          })
          .catch(function () { /* 静默：无字幕不影响播放 */ });
        return function () {
          aborted = true;
          if (ctrl) { try { ctrl.abort(); } catch (e) { /* 忽略 */ } }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [src, path]);

      // 当前行变化 → 把它滚到歌词区正中（平滑）
      react.useEffect(function () {
        var wrap = lyricWrapRef.current;
        var el = lyricElsRef.current[curLyricIdx];
        if (!wrap || !el) return;
        var target = el.offsetTop - wrap.clientHeight / 2 + el.offsetHeight / 2;
        if (!(target > 0)) target = 0;
        try { wrap.scrollTo({ top: target, behavior: "smooth" }); }
        catch (e) { wrap.scrollTop = target; }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [curLyricIdx]);

      // 卸载时收干净：停 rAF、关 AudioContext
      react.useEffect(function () {
        return function () {
          stopLoop();
          var actx = actxRef.current;
          actxRef.current = null;
          analyserRef.current = null;
          if (actx && typeof actx.close === "function") {
            try { actx.close(); } catch (err) { /* 忽略 */ }
          }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      // 音量 / 倍速 / 循环 跟随 state
      react.useEffect(function () {
        var el = mediaRef.current;
        if (!el) return;
        el.volume = Math.max(0, Math.min(1, volume));
      }, [volume]);

      react.useEffect(function () {
        var el = mediaRef.current;
        if (!el) return;
        el.playbackRate = rate;
      }, [rate]);

      react.useEffect(function () {
        var el = mediaRef.current;
        if (!el) return;
        el.loop = loop;
      }, [loop]);

      // 分析开关：关 → 停循环 + 清屏；开 → 已有 graph 才续跑（建 graph 必须手势）
      react.useEffect(function () {
        if (!analyse) {
          stopLoop();
          var canvas = canvasRef.current;
          if (canvas) drawSpectrum(canvas, null, 0, 0);
          return;
        }
        if (analyserRef.current && playing) startLoop();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [analyse]);

      react.useEffect(function () {
        if (!analyse || !graphReady) return;
        if (playing) startLoop();
        else stopLoop();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [playing, analyse, graphReady]);

      // ── 子块 ─────────────────────────────────────────────────────────────
      var title = props.title || path;

      var videoEl = h("video", {
        ref: mediaRef,
        key: "media",
        src: src,
        controls: true,
        preload: "metadata",
        playsInline: true,
        style: {
          width: "100%",
          height: "100%",
          flex: "1 1 auto",
          minHeight: "160px",
          maxHeight: "100%",
          background: "#000",
          borderRadius: "8px",
          outline: "none",
          display: "block"
        }
      }); // 不渲染原生 <track>：改为下方自绘字幕层，避免原生 + 自绘双份叠加

      // 自绘字幕层：绝对定位贴视频底部、水平居中、半透明黑底白字、不挡点击。
      var subtitleOverlay = (isVideo && subAvail && subOn && subText)
        ? h("div", {
          key: "subtitle",
          "aria-live": "off",
          style: {
            position: "absolute",
            left: "50%",
            transform: "translateX(-50%)",
            bottom: SUBTITLE_POS[clampIdx(subPosIdx, SUBTITLE_POS.length)] + "%",
            maxWidth: "92%",
            padding: "4px 10px",
            borderRadius: "8px",
            background: "rgba(0,0,0,0.62)",
            color: "#fff",
            fontSize: SUBTITLE_SIZES[clampIdx(subSizeIdx, SUBTITLE_SIZES.length)] + "px",
            lineHeight: 1.35,
            fontWeight: 600,
            textAlign: "center",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            textShadow: "0 1px 2px rgba(0,0,0,0.9)",
            pointerEvents: "none",
            zIndex: 5,
            boxSizing: "border-box"
          }
        }, subText)
        : null;

      var mediaEl = isVideo
        ? h("div", {
          key: "media-wrap",
          style: {
            position: "relative",
            display: "flex",
            flex: "1 1 auto",
            minHeight: "160px",
            maxHeight: "100%",
            minWidth: 0
          }
        }, [videoEl, subtitleOverlay])
        : h("audio", {
          ref: mediaRef,
          key: "media",
          src: src,
          preload: "auto",
          style: { display: "none" }
        });

      var coverCard = h("div", {
        key: "cover",
        style: {
          display: "flex",
          alignItems: "center",
          gap: "12px",
          padding: "14px 16px",
          borderRadius: "10px",
          background: SURFACE,
          border: "1px solid " + BORDER,
          minWidth: 0
        }
      }, [
        h("div", {
          key: "ico",
          style: {
            flex: "none",
            width: "44px",
            height: "44px",
            borderRadius: "10px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "color-mix(in srgb, " + BRAND + " 18%, transparent)",
            color: BRAND
          }
        }, [h(IconMedia, { key: "i", size: 24 })]),
        h("div", {
          key: "txt",
          style: { minWidth: 0, display: "flex", flexDirection: "column", gap: "3px" }
        }, [
          h("div", {
            key: "t",
            title: path,
            style: {
              fontSize: "13px",
              fontWeight: 600,
              color: TEXT,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap"
            }
          }, title),
          h("div", {
            key: "m",
            style: { fontSize: "12px", color: LABEL }
          }, "audio \u00b7 " + extOf(path) + "\u00b7 " + fmtTime(duration))
        ])
      ]);

      // ── 歌词区（音频）：固定高 120px、overflow 自动、当前行加粗高亮并居中 ─────
      var lyricBoxStyle = {
        flex: "none",
        position: "relative",
        height: "120px",
        overflowY: "auto",
        overflowX: "hidden",
        padding: "6px 8px",
        borderRadius: "8px",
        background: SURFACE,
        border: "1px solid " + BORDER,
        scrollBehavior: "smooth"
      };
      var lyricBlock = null;
      if (shouldRenderLyricBlock(lyricOn, isVideo, lyric)) {
        if (lyric.source === "lrc" && lyric.lines.length > 0) {
          lyricBlock = h("div", {
            key: "lyric",
            ref: lyricWrapRef,
            style: lyricBoxStyle
          }, lyric.lines.map(function (line, idx) {
            var active = idx === curLyricIdx;
            return h("div", {
              key: idx,
              ref: function (node) { lyricElsRef.current[idx] = node; },
              style: {
                fontSize: "12.5px",
                lineHeight: "1.5",
                padding: "2px 6px",
                borderRadius: "4px",
                textAlign: "center",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                color: active ? BRAND : LABEL,
                fontWeight: active ? 700 : 400,
                opacity: active ? 1 : 0.5,
                transition: "opacity .15s, color .15s"
              }
            }, line.text === "" ? "\u00a0" : line.text);
          }));
        } else if (lyric.source === "plain" && lyric.text) {
          lyricBlock = h("div", {
            key: "lyric",
            ref: lyricWrapRef,
            style: lyricBoxStyle
          }, h("div", {
            key: "plain",
            style: {
              fontSize: "12.5px",
              lineHeight: "1.6",
              textAlign: "center",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              color: LABEL
            }
          }, lyric.text));
        } else if (lyric.source === "none") {
          lyricBlock = h("div", {
            key: "lyric",
            style: {
              flex: "none",
              fontSize: "11.5px",
              color: LABEL,
              textAlign: "center",
              padding: "4px 0"
            }
          }, "\u65e0\u6b4c\u8bcd");
        }
      }

      // 音频专用的整轨 scrubber（核心：拖动 = 直接写 currentTime）
      var playable = playableEnd(mediaRef.current) || duration;
      var scrubber = h("input", {
        key: "scrub",
        type: "range",
        min: 0,
        max: playable > 0 ? playable : 0,
        step: 0.01,
        value: playable > 0 ? Math.min(time, playable) : 0,
        disabled: !(playable > 0 && isFinite(playable)),
        "aria-label": "\u64ad\u653e\u8fdb\u5ea6",
        title: playable > 0 ? "\u62d6\u52a8\u5230\u4efb\u610f\u4f4d\u7f6e" : "\u5c1a\u672a\u83b7\u53d6\u65f6\u957f",
        onPointerDown: function () {
          dragRef.current = true;
          setDragging(true);
        },
        onPointerUp: function (event) {
          dragRef.current = false;
          setDragging(false);
          hardSeek(event.currentTarget.value);
        },
        onPointerCancel: function () {
          dragRef.current = false;
          setDragging(false);
        },
        onChange: function (event) {
          var v = Number(event.currentTarget.value);
          setTime(v);
          if (dragRef.current) {
            var now = Date.now();
            if (now - lastSeekRef.current >= 90) {
              lastSeekRef.current = now;
              hardSeek(v);
            }
          } else {
            hardSeek(v);
          }
        },
        style: {
          width: "100%",
          margin: 0,
          accentColor: BRAND,
          cursor: playable > 0 ? "pointer" : "default",
          height: "20px"
        }
      });

      var timeRow = h("div", {
        key: "times",
        style: {
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: "11.5px",
          color: LABEL,
          fontVariantNumeric: "tabular-nums",
          marginTop: "-2px"
        }
      }, [
        h("span", { key: "now" }, fmtTime(time)),
        h("span", { key: "dur" }, fmtTime(duration)),
        dragging ? h("span", {
          key: "drag",
          style: { color: BRAND, fontWeight: 600 }
        }, "\u62d6\u52a8\u4e2d") : null
      ]);

      var playBtn = h("button", {
        key: "play",
        type: "button",
        title: playing ? "\u6682\u505c" : "\u64ad\u653e",
        onClick: togglePlay,
        style: btnStyle
      }, [h(playing ? IconPause : IconPlay, { key: "i", size: 16 })]);

      var volumeGroup = h("div", {
        key: "vol",
        style: { display: "flex", alignItems: "center", gap: "5px", color: LABEL }
      }, [
        h(IconVolume, { key: "i", size: 15 }),
        h("input", {
          key: "r",
          type: "range",
          min: 0,
          max: 1,
          step: 0.01,
          value: volume,
          "aria-label": "\u97f3\u91cf",
          title: "\u97f3\u91cf " + Math.round(volume * 100) + "%",
          onChange: function (event) { setVolume(Number(event.currentTarget.value)); },
          style: { width: "64px", margin: 0, accentColor: BRAND, cursor: "pointer" }
        })
      ]);

      var rateSelect = h("select", {
        key: "rate",
        value: String(rate),
        title: "\u500d\u901f",
        "aria-label": "\u500d\u901f",
        onChange: function (event) { setRate(Number(event.currentTarget.value)); },
        style: {
          height: "26px",
          borderRadius: "7px",
          border: "1px solid " + BORDER,
          background: "transparent",
          color: TEXT,
          fontSize: "12px",
          padding: "0 4px",
          cursor: "pointer",
          fontFamily: "inherit"
        }
      }, [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(function (r) {
        return h("option", { key: String(r), value: String(r) }, r + "x");
      }));

      var loopBtn = h("button", {
        key: "loop",
        type: "button",
        title: loop ? "\u5faa\u73af\uff1a\u5f00" : "\u5faa\u73af\uff1a\u5173",
        onClick: function () { setLoop(!loop); },
        style: loop ? btnOnStyle : btnStyle
      }, [h(IconLoop, { key: "i", size: 15 })]);

      var spectrumBtn = h("button", {
        key: "spec",
        type: "button",
        title: analyse ? "\u9891\u8c31 / \u97f3\u51c6\uff1a\u5f00" : "\u9891\u8c31 / \u97f3\u51c6\uff1a\u5173",
        onClick: function () {
          if (analyse) {
            setAnalyse(false);
            return;
          }
          // 用户手势内建 graph：这一下就是拿 AudioContext 的唯一可靠时机
          setAnalyse(true);
          var ok = promoteGraph();
          if (ok && playing) startLoop();
        },
        style: analyse ? btnOnStyle : btnStyle
      }, [h(IconSpectrum, { key: "i", size: 15 })]);

      // ── 字幕按钮 + 设置面板（仅视频且检测到字幕文件时出现）─────────────────
      var miniBtnStyle = {
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        height: "22px", minWidth: "22px", padding: "0 8px", borderRadius: "6px",
        border: "1px solid " + BORDER, background: "transparent", color: "#e8eaef",
        cursor: "pointer", fontSize: "12px", lineHeight: 1, fontFamily: "inherit",
        boxSizing: "border-box"
      };
      var subRowStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" };

      var subtitleBtn = null;
      var subtitlePanel = null;
      var subtitleGroup = null;
      if (isVideo && subAvail) {
        subtitleBtn = h("button", {
          key: "sub-btn",
          type: "button",
          title: "\u5b57\u5e55\u8bbe\u7f6e",
          onClick: function () { setSubPanelOpen(!subPanelOpen); },
          style: subOn ? btnOnStyle : btnStyle
        }, [h(IconSubtitle, { key: "i", size: 15 })]);

        subtitlePanel = subPanelOpen
          ? h("div", {
            key: "sub-panel",
            style: {
              position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 30,
              minWidth: "188px", padding: "10px", borderRadius: "10px",
              background: "rgba(20,22,28,0.96)", border: "1px solid " + BORDER,
              boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
              display: "flex", flexDirection: "column", gap: "9px",
              color: "#e8eaef", fontSize: "12px"
            }
          }, [
            h("div", { key: "on", style: subRowStyle }, [
              h("span", { key: "l" }, "\u663e\u793a\u5b57\u5e55"),
              h("input", {
                key: "c", type: "checkbox", checked: subOn,
                onChange: function (e) { changeSubOn(!!e.currentTarget.checked); },
                style: { accentColor: BRAND, cursor: "pointer", width: "15px", height: "15px" }
              })
            ]),
            h("div", { key: "size", style: subRowStyle }, [
              h("span", { key: "l" }, "\u5b57\u53f7"),
              h("div", { key: "g", style: { display: "flex", alignItems: "center", gap: "6px" } }, [
                h("button", {
                  key: "mi", type: "button", title: "\u51cf\u5c0f\u5b57\u53f7",
                  onClick: function () { changeSubSize(subSizeIdx - 1); },
                  disabled: subSizeIdx <= 0,
                  style: Object.assign({}, miniBtnStyle, subSizeIdx <= 0 ? { opacity: 0.4, cursor: "default" } : null)
                }, "A-"),
                h("span", {
                  key: "v",
                  style: { minWidth: "40px", textAlign: "center", fontVariantNumeric: "tabular-nums" }
                }, SUBTITLE_SIZES[clampIdx(subSizeIdx, SUBTITLE_SIZES.length)] + "px"),
                h("button", {
                  key: "pl", type: "button", title: "\u589e\u5927\u5b57\u53f7",
                  onClick: function () { changeSubSize(subSizeIdx + 1); },
                  disabled: subSizeIdx >= SUBTITLE_SIZES.length - 1,
                  style: Object.assign({}, miniBtnStyle, subSizeIdx >= SUBTITLE_SIZES.length - 1 ? { opacity: 0.4, cursor: "default" } : null)
                }, "A+")
              ])
            ]),
            h("div", { key: "pos", style: subRowStyle }, [
              h("span", { key: "l" }, "\u4f4d\u7f6e"),
              h("div", { key: "g", style: { display: "flex", alignItems: "center", gap: "6px" } }, [
                h("button", {
                  key: "dn", type: "button", title: "\u4e0b\u79fb",
                  onClick: function () { changeSubPos(subPosIdx - 1); },
                  disabled: subPosIdx <= 0,
                  style: Object.assign({}, miniBtnStyle, subPosIdx <= 0 ? { opacity: 0.4, cursor: "default" } : null)
                }, "\u4e0b\u79fb"),
                h("button", {
                  key: "up", type: "button", title: "\u4e0a\u79fb",
                  onClick: function () { changeSubPos(subPosIdx + 1); },
                  disabled: subPosIdx >= SUBTITLE_POS.length - 1,
                  style: Object.assign({}, miniBtnStyle, subPosIdx >= SUBTITLE_POS.length - 1 ? { opacity: 0.4, cursor: "default" } : null)
                }, "\u4e0a\u79fb")
              ])
            ])
          ])
          : null;

        subtitleGroup = h("div", {
          key: "sub-group",
          style: { position: "relative", display: "inline-flex" }
        }, [subtitleBtn, subtitlePanel]);
      }

      // ── 歌词开关按钮（仅音频且存在歌词时出现；视频走字幕）──────────────────
      var lyricBtn = null;
      if (!isVideo && hasLyricContent(lyric)) {
        lyricBtn = h("button", {
          key: "lyric-btn",
          type: "button",
          title: lyricOn ? "\u5173\u95ed\u6b4c\u8bcd" : "\u663e\u793a\u6b4c\u8bcd",
          onClick: function () { changeLyricOn(!lyricOn); },
          style: lyricOn ? btnOnStyle : btnStyle
        }, [h(IconLyric, { key: "i", size: 15 })]);
      }

      var downloadLink = h("a", {
        key: "dl",
        href: dl,
        download: true,
        title: "\u4e0b\u8f7d\u539f\u6587\u4ef6",
        style: {
          color: LINK,
          textDecoration: "none",
          fontSize: "12px",
          marginLeft: "auto",
          flex: "none"
        }
      }, "\u4e0b\u8f7d");

      var controls = h("div", {
        key: "controls",
        style: {
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "8px",
          flex: "none"
        }
      }, [playBtn, volumeGroup, rateSelect, loopBtn, spectrumBtn, subtitleGroup, lyricBtn, downloadLink]);

      var spectrumBlock = analyse
        ? h("div", {
          key: "spec-block",
          style: {
            display: "flex",
            flexDirection: "column",
            gap: "6px",
            flex: "none"
          }
        }, [
          h("canvas", {
            key: "cv",
            ref: canvasRef,
            style: {
              width: "100%",
              height: "96px",
              display: "block",
              borderRadius: "8px",
              background: SURFACE,
              border: "1px solid " + BORDER
            }
          }),
          h("div", {
            key: "pitch",
            style: {
              display: "flex",
              alignItems: "baseline",
              gap: "10px",
              fontSize: "12px",
              color: LABEL,
              minHeight: "20px"
            }
          }, [
            h("span", { key: "l", style: { flex: "none" } }, "\u97f3\u51c6"),
            h("span", {
              key: "n",
              style: {
                fontSize: "17px",
                fontWeight: 700,
                color: note.hz > 0 ? BRAND : LABEL,
                fontVariantNumeric: "tabular-nums",
                minWidth: "42px"
              }
            }, note.name),
            h("span", {
              key: "hz",
              style: { fontVariantNumeric: "tabular-nums" }
            }, note.hz > 0 ? note.hz.toFixed(1) + " Hz" : "\u2014"),
            note.hz > 0
              ? h("span", {
                key: "ct",
                style: { color: Math.abs(note.cents) <= 15 ? LABEL : "#f0a94a" }
              }, (note.cents >= 0 ? "+" : "") + note.cents + " \u00a2")
              : null,
            !graphReady
              ? h("span", {
                key: "hint",
                style: { marginLeft: "auto", color: LABEL, fontSize: "11.5px" }
              }, "\u70b9\u4e00\u4e0b\u64ad\u653e\u624d\u5f00\u59cb\u5206\u6790")
              : null
          ])
        ])
        : null;

      var errBlock = error
        ? h("div", {
          key: "err",
          style: {
            flex: "none",
            fontSize: "12px",
            color: "#e86b6b",
            background: "rgba(232,107,107,0.10)",
            border: "1px solid rgba(232,107,107,0.35)",
            borderRadius: "7px",
            padding: "6px 9px",
            wordBreak: "break-word"
          }
        }, error)
        : null;

      var children = isVideo
        ? [mediaEl, controls, errBlock, spectrumBlock]
        : [mediaEl, coverCard, lyricBlock, scrubber, timeRow, controls, errBlock, spectrumBlock];

      return h("div", {
        style: {
          display: "flex",
          flexDirection: "column",
          gap: "10px",
          padding: "12px",
          height: "100%",
          minWidth: 0,
          minHeight: 0,
          boxSizing: "border-box",
          overflow: "auto"
        }
      }, children);
    }

    // ── 注册 ───────────────────────────────────────────────────────────────
    var inject = ["betterSidebar"];

    function apply(ctx) {
      var sidebar = ctx.betterSidebar;
      if (sidebar === undefined) return;
      // 必须包 ctx.effect：fiber teardown / HMR / 插件停用时把 disposer 跑掉，
      // 否则再次激活会抛 "already registered"。
      // 注意这里**只传一个参数**（execute）—— 客户端半边保持与 dsh-video-preview
      // 生产实现一致的调用形态，label 只在宿主半边用（宿主侧由 cordis 直接消费）。
      ctx.effect(function () {
        return sidebar.registerFileViewer({
          id: "media",
          title: "Media",
          icon: function (size) { return IconMedia(size); },
          exts: MEDIA_EXTS,
          // 优先级高于 dsh-video-preview / @huanlin audio（默认 50），
          // 这样音视频都落到本 viewer，方便一次测全 seek + 频谱 + 音准。
          // 若想让出视频，把这里改回 50 以下即可。
          priority: 60,
          // 字节由本 viewer 自己拼 /dsh-media-player/media 取（Range 路由），
          // 不让宿主先读一遍文件。
          fetchStrategy: "none",
          component: MediaViewer
        });
      });
    }

    module.exports = {
      inject: inject,
      apply: apply,
      version: VERSION
    };
    return module.exports;
  }
});