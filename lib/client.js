/*!
 * dsh-sidebar-media-player — client half (browser bundle) · v0.1.0
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
 *   - fetch / src 一律**根相对路径**（/dsh-sidebar-media-player/media?...），绝不拼宿主
 *     绝对 origin —— 换端口 + CSP 都会立刻死；
 *   - AudioContext 必须在**用户手势**里创建/resume，否则元素音频会被静音
 *     （createMediaElementSource 后 context 处于 suspended = 完全没声音）；
 *     所以视频默认不建 graph，只有用户点「频谱」开关才建。
 */
window.__ModuleLoader__.load({
  id: "dsh-sidebar-media-player",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    "use strict";

    var react = require("react");
    var h = react.createElement;
    // 模块级 hooks 别名：第⑤步搬进来的 QQOnlinePanel 用的是裸 useState/useEffect/useRef 写法
    // （A 的顶层有同名解构），补齐这三个，避免 ReferenceError → 整个面板白屏。
    var useState = react.useState;
    var useEffect = react.useEffect;
    var useRef = react.useRef;

    /* =============================================================================
     * _sidebar_premium_turntable.jsx
     * dsh-sidebar-media-player v0.2.0 —— 唱盘（黑胶）组件规格实现
     *
     * 【为什么要它】
     *   用户原话：「没看到唱盘」→ 之前的封面卡片只有一枚 24px 的通用 IconMedia 图标，
     *   完全没有「唱盘 / 黑胶」的可感知形象。本组件给出一个真正有质感的唱盘：
     *   细密同心沟槽、高光扫过、封面中心标签、带阴影的唱针臂。
     *
     * 【接入方式】（按代码特征锚点，不要按行号，行号会漂移）
     *   目标文件：<插件目录>\lib\client.js
     *
     *   锚点 A：`var h = react.createElement;`
     *            → 在它**后面**粘贴本文件的全部内容（不含末尾的 module.exports 也无害）。
     *   锚点 B：变量声明区 `var VERSION = "0.2.0";`
     *            → 紧接着加一行：`var Turntable = makeTurntable(react);`
     *   锚点 C：封面卡片里的图标块 —— 在函数中查找
     *              `key: "ico"` 且 `width: "44px", height: "44px"` 的那个 div
     *            → 把它的 children（`h(IconMedia, { key: "i", size: 24 })`）替换为
     *                 `h(Turntable, { key: "tt", playing: playing, coverUrl: coverThumb, size: 44 })`
     *              并把该 div 的 width/height 改成 44px（保持不变即可），去掉它的
     *              圆角底色/边框背景（唱盘自带底盘），避免两层底色叠在一起发灰。
     *
     * 【props 接口】
     *   playing : boolean  是否正在播放（true → 唱片转 + 唱针摆动入槽；false → 唱针抬起）
     *   coverUrl: string   封面图 URL（可空；空则中心标签用统一底色 + 中心孔）
     *   size   : number    组件边长（px），默认 64；封面卡片里用 44
     *   stopped: boolean  是否处于「停止」态（停止复位：唱针完全抬起，唱片保持静止）
     *   id     : string    可选，指定 SVG 内 defs 的 id 前缀（多实例时避免 id 冲突）
     *   title  : string    可选，悬停提示
     *
     * 【动画约束】
     *   - 旋转 / 摆臂 / 抬起 全部由 CSS（@keyframes + transition）驱动；
     *     JS 只在「状态切换的那一瞬间」读一次角度、写一次 transform，绝不每帧改 transform。
     *   - 暂停时不是瞬停：用一次 transition 让唱片再滑 16° 缓缓停下（1.5s 减速曲线）。
     *   - 恢复播放时用负 animation-delay 从当前角度续转，视觉上不跳。
     *
     * 【无第三方依赖】只用 React.createElement（与插件内既有 `h` 同一风格）与内联 SVG。
     * ========================================================================== */


    /* ── 组件用到的 CSS（一次性注入 <style id>，避免污染全局）───────────── */
    var TURNTABLE_CSS = [
      '.dsw-turntable{display:block;line-height:0;filter:drop-shadow(0 2px 6px rgba(0,0,0,0.35));}',
      '.dsw-turntable svg{display:block;width:100%;height:100%;overflow:visible;}',
      '.dsw-turntable__disc{transform-origin:50px 50px;will-change:transform;}',
      '.dsw-turntable__tonearm{transform-origin:78px 20px;transform:rotate(-16deg);',
      'transition:transform 520ms cubic-bezier(0.34,1.18,0.45,1);}',
      '.dsw-turntable.is-playing .dsw-turntable__tonearm{transform:rotate(0deg);',
      'animation:dsw-turntable-arm-swing 600ms cubic-bezier(0.30,1.34,0.45,1) forwards;}',
      '.dsw-turntable__tonearm-shadow{opacity:0.5;transition:opacity 520ms ease;}',
      '.dsw-turntable.is-playing .dsw-turntable__tonearm-shadow{opacity:0.85;}',
      '@keyframes dsw-turntable-spin{from{transform:rotate(0deg);}to{transform:rotate(360deg);}}',
      '@keyframes dsw-turntable-arm-swing{',
      '0%{transform:rotate(-16deg);}',
      '52%{transform:rotate(3.4deg);}',
      '76%{transform:rotate(-1.3deg);}',
      '100%{transform:rotate(0deg);}'
    ].join('\n');

    var __dswTurntableUid = 0;

    /**
     * 工厂：把 React 注入进来，拿到 createElement（插件内是 `h`）。
     * @param {object} react 宿主 React（插件里来自 require('react')）
     * @returns {Function} Turntable 组件
     */
    function makeTurntable(react) {
      var h = react.createElement;
      var useRef = react.useRef;
      var useEffect = react.useEffect;
      var TURN_DURATION = 5.4;   // 一圈秒数（线性）
      var DECEL_MS = 1500;       // 暂停减速时长

      function ensureStyle() {
        if (typeof document === 'undefined') return;
        if (document.getElementById('dsw-turntable-style')) return;
        var st = document.createElement('style');
        st.id = 'dsw-turntable-style';
        st.textContent = TURNTABLE_CSS;
        (document.head || document.documentElement).appendChild(st);
      }

      /* ── 沟槽环（细密同心纹理）───────────────────────────────────────── */
      function grooves() {
        var out = [];
        var r = 16.5;
        var i = 0;
        while (r < 41.2) {
          out.push(h('circle', {
            key: 'gl' + i, cx: 50, cy: 50, r: r,
            fill: 'none', stroke: 'rgba(255,255,255,0.045)', strokeWidth: 0.55
          }));
          out.push(h('circle', {
            key: 'gd' + i, cx: 50, cy: 50, r: r + 0.5,
            fill: 'none', stroke: 'rgba(0,0,0,0.38)', strokeWidth: 0.5
          }));
          r += 1.35;
          i++;
        }
        return out;
      }

      function Turntable(props) {
        props = props || {};
        var playing = !!props.playing;
        var stopped = !!props.stopped;
        var coverUrl = props.coverUrl || '';
        var size = props.size || 64;
        var uid = useRef(null);
        if (!uid.current) { uid.current = (props.id || 'dsw-tt-' + (++__dswTurntableUid)); }
        var defsId = uid.current;

        var discRef = useRef(null);
        var angleRef = useRef(0);
        var wasPlayingRef = useRef(false);
        var timerRef = useRef(null);

        useEffect(function () { ensureStyle(); }, []);

        useEffect(function () {
          var el = discRef.current;
          if (!el) return;
          var was = wasPlayingRef.current;
          wasPlayingRef.current = playing;

          if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }

          /* ── 起播：从当前角度续转（负 delay，避免跳一下）────────────── */
          if (playing && !was) {
            el.style.transition = 'none';
            el.style.animation = 'none';
            el.style.transform = 'rotate(' + angleRef.current + 'deg)';
            void el.offsetWidth;                      // 强制 reflow，让 animation 重新开始
            el.style.animation = 'dsw-turntable-spin ' + TURN_DURATION + 's linear infinite';
            el.style.animationDelay = '-' + (angleRef.current / 360 * TURN_DURATION) + 's';
            el.style.animationPlayState = 'running';
            return;
          }

          /* ── 暂停 / 停止：读一次当前角度 → transition 减速滑停 ──────── */
          if (!playing && was) {
            var angle = angleRef.current;
            var anims = (el.getAnimations && el.getAnimations) ? el.getAnimations() : [];
            for (var i = 0; i < anims.length; i++) {
              var a = anims[i];
              var nm = (a.animationName || '');
              if (nm.indexOf('dsw-turntable-spin') >= 0) {
                var ct = Number(a.currentTime) || 0;
                angle = (ct / (TURN_DURATION * 1000)) * 360;
                break;
              }
            }
            angle = ((angle % 360) + 360) % 360;
            angleRef.current = angle;

            el.style.animation = 'none';
            el.style.animationDelay = '';
            el.style.animationPlayState = '';
            el.style.transition = 'none';
            el.style.transform = 'rotate(' + angle + 'deg)';
            void el.offsetWidth;
            var target = angle + 16;                 // 缓缓再滑 16° 后停住
            el.style.transition = 'transform ' + DECEL_MS + 'ms cubic-bezier(0.16,0.62,0.22,1)';
            el.style.transform = 'rotate(' + target + 'deg)';
            timerRef.current = setTimeout(function () {
              var e2 = discRef.current;
              if (e2) {
                e2.style.transition = 'none';
                e2.style.transform = 'rotate(' + target + 'deg)';
              }
              angleRef.current = target;
              timerRef.current = null;
            }, DECEL_MS + 40);
          }
        }, [playing]);

        var cls = 'dsw-turntable' + (playing ? ' is-playing' : '') + (stopped ? ' is-stopped' : '');

        /* ── 中心标签：有封面贴封面图，无封面用统一底色 ───────────────── */
        var labelChildren = [];
        if (coverUrl) {
          labelChildren.push(h('image', {
            key: 'cover',
            href: coverUrl,
            x: 36, y: 36, width: 28, height: 28,
            preserveAspectRatio: 'xMidYMid slice',
            clipPath: 'url(#' + defsId + '-label)'
          }));
        } else {
          labelChildren.push(h('circle', {
            key: 'lbl', cx: 50, cy: 50, r: 14,
            fill: 'rgba(76,141,255,0.22)',
            stroke: 'rgba(255,255,255,0.16)', strokeWidth: 0.8
          }));
        }
        labelChildren.push(h('circle', {
          key: 'hole', cx: 50, cy: 50, r: 1.7, fill: '#0a0b0f'
        }));

        var svg = h('svg', {
          key: 'svg',
          viewBox: '0 0 100 100',
          xmlns: 'http://www.w3.org/2000/svg',
          role: 'img',
          'aria-label': props.title || '唱盘'
        }, [
          h('defs', { key: 'defs' }, [
            h('radialGradient', { key: 'g1', id: defsId + '-vinyl', cx: '50%', cy: '46%', r: '62%' }, [
              h('stop', { key: 's1', offset: '0%', stopColor: '#31353f' }),
              h('stop', { key: 's2', offset: '55%', stopColor: '#1b1e25' }),
              h('stop', { key: 's3', offset: '100%', stopColor: '#0f1116' })
            ]),
            h('radialGradient', { key: 'g2', id: defsId + '-label', cx: '50%', cy: '42%', r: '66%' }, [
              h('stop', { key: 'l1', offset: '0%', stopColor: 'rgba(255,255,255,0.16)' }),
              h('stop', { key: 'l2', offset: '100%', stopColor: 'rgba(255,255,255,0.04)' })
            ]),
            h('clipPath', { key: 'cp', id: defsId + '-label' }, [
              h('circle', { key: 'c', cx: 50, cy: 50, r: 14 })
            ])
          ]),
          /* 唱盘底盘 */
          h('circle', {
            key: 'plate', cx: 50, cy: 50, r: 47.5,
            fill: 'rgba(18,20,26,0.55)',
            stroke: 'rgba(140,150,180,0.24)', strokeWidth: 1
          }),
          /* ── 唱片（旋转层）────────────────────────────────────────── */
          h('g', { key: 'disc', ref: discRef, className: 'dsw-turntable__disc' }, [
            h('circle', { key: 'v', cx: 50, cy: 50, r: 42, fill: 'url(#' + defsId + '-vinyl)' }),
            h('g', { key: 'gr' }, grooves()),
            h('circle', {
              key: 'ring', cx: 50, cy: 50, r: 42,
              fill: 'none', stroke: 'rgba(255,255,255,0.12)', strokeWidth: 1.6
            }),
            h('circle', {
              key: 'ring2', cx: 50, cy: 50, r: 40.4,
              fill: 'none', stroke: 'rgba(0,0,0,0.45)', strokeWidth: 1
            }),
            h('circle', {
              key: 'sep', cx: 50, cy: 50, r: 15.6,
              fill: 'none', stroke: 'rgba(255,255,255,0.10)', strokeWidth: 0.8
            }),
            /* 高光：放在旋转层内 → 随盘转动 = 高光扫过 */
            h('ellipse', {
              key: 'gloss', cx: 33, cy: 27, rx: 21, ry: 12,
              fill: 'rgba(255,255,255,0.055)'
            }),
            h('path', {
              key: 'gloss2',
              d: 'M18 34 Q50 14 82 32',
              fill: 'none', stroke: 'rgba(255,255,255,0.10)', strokeWidth: 2.4,
              strokeLinecap: 'round'
            }),
            /* 中心标签 */
            h('circle', {
              key: 'lbg', cx: 50, cy: 50, r: 14, fill: 'url(#' + defsId + '-label)'
            }),
            h('g', { key: 'label' }, labelChildren)
          ]),
          /* ── 唱针臂（静止层，不随盘转）────────────────────────────── */
          h('g', { key: 'arm', className: 'dsw-turntable__tonearm' }, [
            h('path', {
              key: 'shadow',
              className: 'dsw-turntable__tonearm-shadow',
              d: 'M78 20 L46 34',
              fill: 'none', stroke: 'rgba(0,0,0,0.55)', strokeWidth: 3.8,
              strokeLinecap: 'round', transform: 'translate(1.2,1.6)'
            }),
            h('circle', {
              key: 'base', cx: 78, cy: 20, r: 7.4,
              fill: 'rgba(30,33,41,0.95)',
              stroke: 'rgba(170,180,200,0.38)', strokeWidth: 1
            }),
            h('circle', {
              key: 'baseHi', cx: 75.8, cy: 17.6, r: 2.3,
              fill: 'rgba(255,255,255,0.20)'
            }),
            h('path', {
              key: 'arm',
              d: 'M78 20 L46 34',
              fill: 'none', stroke: 'rgba(216,223,236,0.88)', strokeWidth: 2.1,
              strokeLinecap: 'round'
            }),
            h('circle', {
              key: 'pivot', cx: 78, cy: 20, r: 2.1,
              fill: 'rgba(236,242,252,0.92)'
            }),
            h('path', {
              key: 'head',
              d: 'M47.4 33.2 l-4.2 5.6 l5.4 -1.4 z',
              fill: '#e9eef7'
            }),
            h('ellipse', {
              key: 'headShadow', cx: 43.6, cy: 39.4, rx: 4.2, ry: 1.6,
              fill: 'rgba(0,0,0,0.42)'
            })
          ])
        ]);

        return h('div', {
          key: 'root',
          className: cls,
          title: props.title || '',
          style: {
            width: size + 'px',
            height: size + 'px',
            position: 'relative',
            flex: 'none'
          }
        }, [svg]);
      }

      Turntable.displayName = 'DsSidebarTurntable';
      return Turntable;
    }

    var VERSION = "0.2.0";

    var Turntable = makeTurntable(react);

    // ── 扩展名（host 的 MEDIA_TYPES 必须与这里保持一致）────────────────────
    var VIDEO_EXTS = [
      "mp4", "m4v", "webm", "mov", "qt", "mkv", "avi", "wmv", "flv",
      "ogv", "ogm", "mpeg", "mpg", "3gp", "3g2", "m2ts"
    ];
    var AUDIO_EXTS = [
      "mp3", "wav", "wave", "flac", "oga", "ogg", "opus", "m4a", "aac", "wma",
      "aif", "aiff", "amr", "ape", "caf", "mka"
    ];
    var MEDIA_EXTS = VIDEO_EXTS.concat(AUDIO_EXTS.filter(function (x) {
      return VIDEO_EXTS.indexOf(x) === -1;
    }));

    var VIDEO_SET = {};
    for (var vi = 0; vi < VIDEO_EXTS.length; vi++) VIDEO_SET[VIDEO_EXTS[vi]] = true;

    var MEDIA_SET = {};
    for (var mi = 0; mi < MEDIA_EXTS.length; mi++) MEDIA_SET[MEDIA_EXTS[mi]] = true;

    function extOf(path) {
      var name = String(path || "").replace(/^.*[\\/]/, "");
      var dot = name.lastIndexOf(".");
      return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
    }

    function isVideoPath(path) {
      return VIDEO_SET[extOf(path)] === true;
    }

    // ── 拖放目录递归读取（webkitGetAsEntry）───────────────────────────────
    function readEntryFiles(entry) {
      return new Promise(function (resolve) {
        if (!entry) { resolve([]); return; }
        if (entry.isFile) {
          entry.file(function (f) { resolve(f ? [f] : []); }, function () { resolve([]); });
          return;
        }
        if (!entry.isDirectory || !entry.createReader) { resolve([]); return; }
        var reader = entry.createReader();
        var all = [];
        var step = function () {
          reader.readEntries(function (ents) {
            if (!ents || !ents.length) { resolve(all); return; }
            var ps = [];
            for (var i = 0; i < ents.length; i++) ps.push(readEntryFiles(ents[i]));
            Promise.all(ps).then(function (arrs) {
              for (var j = 0; j < arrs.length; j++) all = all.concat(arrs[j]);
              step();
            });
          }, function () { resolve(all); });
        };
        step();
      });
    }

    // ── 显式 MIME（Blob 救援时给浏览器一个确定类型，避免内容嗅探失败）───────
    // 与 host 的 MEDIA_TYPES 同源；只在拿不到可信 Content-Type 时兜底。
    var MEDIA_MIME = {
      flac: "audio/flac",
      oga: "audio/ogg",
      opus: "audio/ogg",
      ogg: "audio/ogg",
      ogv: "video/ogg",
      wav: "audio/wav",
      wave: "audio/wav",
      mka: "audio/x-matroska",
      mkv: "video/x-matroska",
      m2ts: "video/mp2t",
      aif: "audio/aiff",
      aiff: "audio/aiff",
      aac: "audio/aac",
      amr: "audio/amr",
      ape: "audio/x-ape",
      caf: "audio/x-caf",
      m4a: "audio/mp4",
      m4v: "video/mp4",
      mp3: "audio/mpeg",
      mp4: "video/mp4",
      webm: "video/webm",
      mpeg: "video/mpeg",
      mpg: "video/mpeg",
      "3gp": "video/3gpp",
      "3g2": "video/3gpp2",
      qt: "video/quicktime",
      mov: "video/quicktime",
      avi: "video/x-msvideo",
      wmv: "video/x-ms-wmv",
      flv: "video/x-flv",
      wma: "audio/x-ms-wma"
    };

    function mimeForPath(path) {
      return MEDIA_MIME[extOf(path)] || "";
    }

    // ── URL（一律根相对）──────────────────────────────────────────────────
    // 🔴 收口点：sessionId 必带且非空。
    // 实测（运行中宿主）：GET /media 不带 sessionId → 400 {"code":"bad-request",
    // "message":"sessionId is required"}；空串同样被当缺失。后端只要求非空、
    // 不校验真伪（sessionId=demo 即 200 + accept-ranges: bytes），
    // 所以这里对 undefined/null/"" 统一回落稳定占位串 "smp" ——
    // 一处收口，mediaUrl / downloadUrl / 所有调用点都不会再拼出空 sessionId。
    function baseParams(scope, path) {
      var sc = scope || {};
      var sid = (sc.sessionId === undefined || sc.sessionId === null || sc.sessionId === "")
        ? "smp"
        : String(sc.sessionId);
      var params = new URLSearchParams({ sessionId: sid, path: path });
      // cwd 是第二道围栏基准：带上它，库外目录也能按「会话目录」放通。
      if (sc.cwd !== undefined && sc.cwd !== null && sc.cwd !== "") params.set("cwd", sc.cwd);
      return params;
    }

    function mediaUrl(scope, path) {
      return "/dsh-sidebar-media-player/media?" + baseParams(scope, path).toString();
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
      return "/dsh-sidebar-media-player/lyric?" + params.toString();
    }

    /** 字幕路由（根相对，同源）：宿主把 .vtt/.srt/.ass 统一转成 VTT 回吐。 */
    function subtitleUrl(scope, path) {
      var params = new URLSearchParams({ path: path });
      if (scope.cwd !== undefined && scope.cwd !== "") params.set("cwd", scope.cwd);
      return "/dsh-sidebar-media-player/subtitle?" + params.toString();
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

    var SUBTITLE_PREFS_KEY = "dsh-sidebar-media-player.subtitlePrefs";
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
    var LYRIC_PREFS_KEY = "dsh-sidebar-media-player.lyricPrefs";
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
    /* =============================================================================
     * _sidebar_premium_spectrum.js
     * dsh-sidebar-media-player v0.2.0 —— 频谱「视觉升级」规格实现（可直接替换）
     *
     * 【接入方式】（按代码特征锚点，不要按行号，行号会漂移）
     *   目标文件：<插件目录>\lib\client.js
     *   锚点 A：函数声明 `function drawSpectrum(canvas, bins, sampleRate, fftSize) {`
     *            → 用本文件的 drawSpectrum 整体替换该函数（连同它下面的旧实现体一起删）。
     *   锚点 B：函数 `fitCanvas(canvas)`（同文件，靠前）
     *            → 本文件自带 specFitCanvas，不覆盖宿主 fitCanvas；两者可共存。
     *   锚点 C：常量 `var SPECTRUM_MIN_HZ = 40;` / `var SPECTRUM_MAX_HZ = 16000;`
     *            → 若宿主已有这两行，保留宿主的、删掉本文件里的副本（避免重复定义困惑）。
     *   锚点 D：调用点 `drawSpectrum(canvas, bins, sampleRate, fftSize)`（rAF 循环内）
     *            → 调用签名完全不变，无需改调用点。
     *
     * 【本文件对外只暴露 3 个名字】
     *   drawSpectrum(canvas, bins, sampleRate, fftSize)   // 替换宿主同名函数
     *   resetSpectrumState()                              // 播放停止/换轨时调用，清空包络
     *   SPECTRUM_RAMP                                     // 色标常量，便于外部调色
     *   其它辅助函数一律 spec 前缀，避免与宿主重名冲突。
     *
     * 【硬约束（踩过坑）】
     *   - 禁止使用 round-rect 便捷方法（Electron/Chromium 版本不保证有）→ 圆角一律 path + arcTo 手写。
     *   - 禁止 8 位 hex（#RRGGBBAA）→ 半透明一律 rgba()，本文件不出现任何 8 位 hex。
     *   - 柱宽/坐标一律纯浮点，禁止 Math.round 取整（取整 = 梳齿/摩尔纹来源）。
     *   - 颜色不写死主题色：优先读宿主 CSS 变量，读不到再退回默认色。
     *
     * 【视觉效果要点】
     *   横向色相：低频青绿 #35d0a8 → 中频品牌蓝 #4c8dff → 高频淡紫 #b48cff → 暖金 #f0a94a
     *   纵向明度：每根柱底淡顶亮（逐柱 createLinearGradient）+ 顶部 1px 高光边
     *   柱形：上宽下窄的「竹节」梯形 + 顶部圆角（arcTo 手写）
     *   镜像：主区 72% + 倒影区 28%，倒影低 alpha + 纵向 alpha 衰减 + 1px 垂直位移
     *   包络：attack 0.60 / release 0.14（闭包持久化 prevBars），取代旧 EMA
     *   低频增益补偿：0.35 → 0.12
     *   静音态：2~3px 残桩 + 呼吸起伏（不是死板横条，不是空白）
     *   安全边：画布内 8px（CSS px，随 dpr 缩放）
     * ========================================================================== */


    /* ── 频段（若宿主已有同名常量，删掉下面两行，用宿主的）────────────────── */
    /* ── 可调参数 ─────────────────────────────────────────────────────────── */
    var SPEC_MAIN_RATIO   = 0.72;   // 主柱区占可用高度比例
    var SPEC_REFL_RATIO   = 0.28;   // 倒影区占可用高度比例
    var SPEC_ATTACK       = 0.60;   // 包络上升系数（越大越跟手）
    var SPEC_RELEASE      = 0.14;   // 包络下降系数（越小越黏）
    var SPEC_LOW_BOOST    = 0.12;   // 低频观感补偿（原实现 0.35，明显过冲）
    var SPEC_SAFE_PX      = 8;      // 画布安全边（CSS px）
    var SPEC_PEAK_FRAMES  = 3;      // 峰值保持帧数
    var SPEC_BAR_SLOT_PX  = 7;      // 每根柱占位宽度下限（CSS px），决定柱数
    var SPEC_MAX_BARS     = 72;     // 柱数上限（再多就糊）
    var SPEC_MIN_BARS     = 24;     // 柱数下限
    var SPEC_GAP_RATIO    = 0.30;   // 柱缝占位宽比例（缝隙均匀 = 不出现梳齿）
    var SPEC_STEM_RATIO   = 0.42;   // 柱底「竹节」收窄比例（底宽 = 柱宽 × 该值）
    var SPEC_GLOW_PX      = 9;      // 柔和光晕半径（CSS px）

    /* ── 色标（低频 → 高频的色相走向）───────────────────────────────────── */
    var SPECTRUM_RAMP = [
      { at: 0.00, c: [0x35, 0xd0, 0xa8] },  // 青绿（低频）
      { at: 0.40, c: [0x4c, 0x8d, 0xff] },  // 品牌蓝（中频）
      { at: 0.72, c: [0xb4, 0x8c, 0xff] },  // 淡紫（中高频）
      { at: 1.00, c: [0xf0, 0xa9, 0x4a] }   // 暖金（最高频）
    ];

    /* ── 主题 token 读取（宿主 CSS 变量 → 兜底色）────────────────────────── */
    var SPEC_TOKEN_FALLBACK = {
      brand: '#4c8dff',
      border: 'rgba(140,150,180,0.28)',
      surface: 'rgba(140,150,180,0.08)'
    };
    var __specTokenCache = { at: 0, brand: null };

    function specReadToken(name, fallback) {
      try {
        var root = document && document.documentElement;
        if (!root || !window.getComputedStyle) return fallback;
        var v = window.getComputedStyle(root).getPropertyValue(name);
        if (v) return String(v).trim();
      } catch (e) { /* 宿主无 DOM 环境 */ }
      return fallback;
    }

    function specBrandHex() {
      var now = (window.performance && performance.now) ? performance.now() : Date.now();
      if (__specTokenCache.brand && (now - __specTokenCache.at) < 4000) return __specTokenCache.brand;
      var raw = specReadToken('--dsw-alias-brand-primary', SPEC_TOKEN_FALLBACK.brand);
      var hex = specToHex(raw);
      __specTokenCache.brand = hex;
      __specTokenCache.at = now;
      return hex;
    }

    function specToHex(raw) {
      if (!raw) return null;
      var s = String(raw).trim();
      var m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(s);
      if (m) {
        var h = m[1];
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        return '#' + h.toLowerCase();
      }
      var rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(s);
      if (rgb) {
        var n = (parseInt(rgb[1], 10) << 16) | (parseInt(rgb[2], 10) << 8) | parseInt(rgb[3], 10);
        var out = '#' + ('000000' + n.toString(16)).slice(-6);
        return out;
      }
      return null;
    }

    /* ── 颜色工具（全部走 rgba()，绝不用 8 位 hex）───────────────────────── */
    function specHex2Rgb(hex) {
      var s = String(hex || '#000000').replace('#', '');
      if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
      var n = parseInt(s, 16);
      if (isNaN(n)) n = 0;
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }

    function specRgba(rgb, alpha) {
      var a = Math.max(0, Math.min(1, alpha));
      return 'rgba(' + Math.round(rgb[0]) + ',' + Math.round(rgb[1]) + ',' + Math.round(rgb[2]) + ',' + a.toFixed(3) + ')';
    }

    function specMixRgb(a, b, t) {
      var k = Math.max(0, Math.min(1, t));
      return [
        a[0] + (b[0] - a[0]) * k,
        a[1] + (b[1] - a[1]) * k,
        a[2] + (b[2] - a[2]) * k
      ];
    }

    function specLighten(rgb, amount) {
      return specMixRgb(rgb, [255, 255, 255], amount);
    }

    /** 按 t∈[0,1] 取色标颜色（逐柱插值 → 横向连续过渡，绝不三段硬切） */
    function specRampColor(t) {
      var x = Math.max(0, Math.min(1, t));
      var ramp = SPECTRUM_RAMP;
      for (var i = 0; i < ramp.length - 1; i++) {
        var s = ramp[i], e = ramp[i + 1];
        if (x >= s.at && x <= e.at) {
          var span = (e.at - s.at) || 1;
          return specMixRgb(s.c, e.c, (x - s.at) / span);
        }
      }
      return ramp[ramp.length - 1].c.slice();
    }

    /* ── 画布尺寸（不覆盖宿主 fitCanvas）───────────────────────────────── */
    function specFitCanvas(canvas) {
      var dpr = (window.devicePixelRatio || 1);
      var cssW = canvas.clientWidth || 320;
      var cssH = canvas.clientHeight || 84;
      var w = Math.max(1, Math.round(cssW * dpr));
      var h = Math.max(1, Math.round(cssH * dpr));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      return { w: w, h: h, dpr: dpr };
    }

    /* ── 状态（包络 / 峰值保持，跨帧持久化）─────────────────────────────── */
    var __specState = {
      env: [],      // 包络后的柱值 0..1
      peak: [],     // 峰值保持值 0..1
      peakAge: [],  // 峰值年龄（帧）
      bars: 0
    };

    function resetSpectrumState() {
      __specState.env.length = 0;
      __specState.peak.length = 0;
      __specState.peakAge.length = 0;
      __specState.bars = 0;
    }

    /* ── 形状：上宽下窄的竹节柱（顶部圆角，arcTo 手写，禁用 round-rect 便捷方法）── */
    function specColumnPath(ctx, cx, topY, botY, topW, botW) {
      var h = botY - topY;
      var r = Math.min(topW * 0.5, h * 0.9, 3.2 * ctx.__dpr);
      var tx = cx - topW * 0.5;
      var bx = cx - botW * 0.5;
      ctx.beginPath();
      ctx.moveTo(bx, botY);
      ctx.lineTo(tx, topY + r);
      ctx.arcTo(tx, topY, tx + r, topY, r);
      ctx.lineTo(tx + topW - r, topY);
      ctx.arcTo(tx + topW, topY, tx + topW, topY + r, r);
      ctx.lineTo(bx + botW, botY);
      ctx.closePath();
    }

    /* ── 形状：倒影柱（顶部接基线，底部圆角 = 主柱的上下镜像）──────────── */
    function specMirrorPath(ctx, cx, topY, botY, topW, botW) {
      var h = botY - topY;
      var r = Math.min(botW * 0.5, h * 0.9, 3.2 * ctx.__dpr);
      var tx = cx - topW * 0.5;
      var bx = cx - botW * 0.5;
      ctx.beginPath();
      ctx.moveTo(tx, topY);
      ctx.lineTo(tx, topY + h - r);
      ctx.arcTo(tx, botY, tx + r, botY, r);
      ctx.lineTo(tx + topW - r, botY);
      ctx.arcTo(tx + topW, botY, tx + topW, botY - r, r);
      ctx.lineTo(bx + botW, topY);
      ctx.closePath();
    }

    /* =========================================================================
     * 主绘制
     * ====================================================================== */
    function drawSpectrum(canvas, bins, sampleRate, fftSize) {
      var c2d = canvas.getContext && canvas.getContext('2d');
      if (!c2d) return;
      var dims = specFitCanvas(canvas);
      var w = dims.w, h = dims.h, dpr = dims.dpr;
      c2d.__dpr = dpr;
      c2d.clearRect(0, 0, w, h);

      var safe = SPEC_SAFE_PX * dpr;
      var innerW = w - safe * 2;
      var innerH = h - safe * 2;
      if (innerW <= 8 * dpr || innerH <= 8 * dpr) return;

      var availH = innerH;
      var reflSpan = availH * SPEC_REFL_RATIO;
      var mainSpan = availH - reflSpan - 1.5 * dpr;
      if (mainSpan <= 4 * dpr) { mainSpan = availH * 0.6; reflSpan = availH * 0.25; }
      var baseline = safe + mainSpan;            // 主柱底 / 倒影顶
      var baseLineY = h - safe - dpr;           // 能量基线（最底）

      /* ── 柱布局：纯浮点，缝隙均匀 ──────────────────────────────────── */
      var bars = Math.max(SPEC_MIN_BARS, Math.min(SPEC_MAX_BARS, Math.floor(innerW / (SPEC_BAR_SLOT_PX * dpr))));
      var slot = innerW / bars;
      var gap = slot * SPEC_GAP_RATIO;
      var barW = slot - gap;
      var botW = barW * SPEC_STEM_RATIO;

      /* ── 采样：对数分桶 + 低频补偿(0.12) ───────────────────────────── */
      var targets = new Float32Array(bars);
      var binHz = (sampleRate > 0 && fftSize > 0) ? (sampleRate / fftSize) : 0;
      var f0 = SPECTRUM_MIN_HZ;
      var step = Math.pow(SPECTRUM_MAX_HZ / SPECTRUM_MIN_HZ, 1 / bars);
      var maxBin = (bins && bins.length) ? bins.length : 0;
      for (var i = 0; i < bars; i++) {
        var f1 = f0 * step;
        var v = 0;
        if (bins && binHz > 0 && maxBin > 0) {
          var b0 = Math.max(0, Math.floor(f0 / binHz));
          var b1 = Math.max(b0, Math.floor(f1 / binHz));
          var pk = 0;
          for (var bi = b0; bi <= b1 && bi < maxBin; bi++) {
            if (bins[bi] > pk) pk = bins[bi];
          }
          v = pk / 255;
          v = Math.min(1, v * (1 + SPEC_LOW_BOOST * (1 - i / bars)));
        }
        targets[i] = v;
        f0 = f1;
      }

      /* ── 包络 attack/release（闭包持久化，取代旧 EMA 平滑）────────── */
      var env = __specState.env, peak = __specState.peak, age = __specState.peakAge;
      if (__specState.bars !== bars) {
        env = new Float32Array(bars);
        peak = new Float32Array(bars);
        age = new Int32Array(bars);
        __specState.env = env; __specState.peak = peak; __specState.peakAge = age;
        __specState.bars = bars;
      }
      var energy = 0;
      for (var j = 0; j < bars; j++) {
        var prev = env[j];
        var k = (targets[j] > prev) ? SPEC_ATTACK : SPEC_RELEASE;
        var cur = prev + (targets[j] - prev) * k;
        if (cur < 0.0015) cur = 0;
        env[j] = cur;
        if (cur > energy) energy = cur;
        if (cur >= peak[j]) { peak[j] = cur; age[j] = 0; }
        else {
          age[j] += 1;
          if (age[j] > SPEC_PEAK_FRAMES) {
            var d = (peak[j] - cur) * 0.18;
            peak[j] = (d > 0) ? peak[j] - d : cur;
          }
        }
      }

      // 频谱样式（第 5 项）：wave = 折线波形。判定口径与条上迷你频谱一致
      // （SMP_STORE.getPrefs().specStyle === "wave"），复用同一份包络，只换画法。
      // 放在这里（包络算完之后、玻璃底纹之前）→ 面板大频谱与侧边栏预览同时生效。
      if (SMP_STORE.getPrefs && SMP_STORE.getPrefs().specStyle === "wave") {
        var wpad = safe;
        var wbase = h - safe - dpr;
        var wInnerH = availH - 1.5 * dpr;
        if (wInnerH <= 4 * dpr) wInnerH = availH * 0.6;
        c2d.beginPath();
        for (var wI = 0; wI < bars; wI++) {
          var wX = wpad + wI * slot + slot * 0.5;
          var wY = wbase - Math.max(1.5 * dpr, env[wI] * wInnerH);
          if (wI === 0) c2d.moveTo(wX, wY); else c2d.lineTo(wX, wY);
        }
        var wGrad = c2d.createLinearGradient(0, wbase, 0, wpad);
        wGrad.addColorStop(0, specRgba(specRampColor(0), 0.32));
        wGrad.addColorStop(0.55, specRgba(specRampColor(0.55), 0.80));
        wGrad.addColorStop(1, specRgba(specLighten(specRampColor(1), 0.30), 0.98));
        c2d.strokeStyle = wGrad;
        c2d.lineWidth = Math.max(1.2 * dpr, 1.2);
        c2d.lineJoin = "round";
        c2d.lineCap = "round";
        c2d.stroke();
        return;
      }

      var now = (window.performance && performance.now) ? performance.now() : Date.now();
      var brand = specHex2Rgb(specBrandHex());

      /* ── 玻璃面板底纹（让画布像一块打磨过的面板，不像输入框）────────── */
      var glass = c2d.createLinearGradient(0, safe, 0, h - safe);
      glass.addColorStop(0, 'rgba(255,255,255,0.045)');
      glass.addColorStop(0.45, 'rgba(255,255,255,0.012)');
      glass.addColorStop(1, 'rgba(0,0,0,0.055)');
      c2d.fillStyle = glass;
      c2d.fillRect(safe, safe, innerW, availH);

      /* ── 底部「能量基线」：比柱更细的一条，随能量增强 ───────────────── */
      c2d.fillStyle = specRgba(brand, 0.14 + 0.30 * energy);
      c2d.fillRect(safe, baseLineY, innerW, Math.max(1, dpr * 0.75));

      /* ── 倒影（柔化：低 alpha + 纵向衰减 + 1px 垂直位移）────────────── */
      c2d.save();
      for (var ri = 0; ri < bars; ri++) {
        var e = env[ri];
        if (e <= 0.002) continue;
        var t = bars <= 1 ? 0 : ri / (bars - 1);
        var rc = specRampColor(t);
        var cx = safe + ri * slot + slot * 0.5;
        var rTop = baseline + 1.0 * dpr;          // 轻微垂直位移（脱离基线）
        var rH = e * reflSpan;
        if (rH <= 0.5 * dpr) continue;
        var rg = c2d.createLinearGradient(0, rTop, 0, rTop + rH);
        rg.addColorStop(0, specRgba(rc, 0.20));
        rg.addColorStop(0.45, specRgba(rc, 0.085));
        rg.addColorStop(1, specRgba(rc, 0.0));
        c2d.fillStyle = rg;
        specMirrorPath(c2d, cx, rTop, rTop + rH, barW, botW);
        c2d.fill();
      }
      c2d.restore();

      /* ── 主柱（0.72 区）：逐柱渐变 + 光晕 + 顶部 1px 高光 ───────────── */
      c2d.save();
      c2d.shadowBlur = SPEC_GLOW_PX * dpr;
      c2d.shadowOffsetY = 0;
      for (var mi = 0; mi < bars; mi++) {
        var me = env[mi];
        var mt = bars <= 1 ? 0 : mi / (bars - 1);
        var mc = specRampColor(mt);
        var mcx = safe + mi * slot + slot * 0.5;

        /* 静音/零能量：不是空白 —— 2~3px 残桩 + 轻微呼吸起伏 */
        var stemH = (2.2 + 1.1 * (0.5 + 0.5 * Math.sin(now / 900 + mi * 0.63))) * dpr;
        var bh = me * mainSpan;
        if (bh < stemH) bh = stemH;

        var topY = baseline - bh;
        var grad = c2d.createLinearGradient(0, baseline, 0, topY);
        grad.addColorStop(0, specRgba(mc, 0.30));
        grad.addColorStop(0.5, specRgba(mc, 0.74));
        grad.addColorStop(1, specRgba(specLighten(mc, 0.30), 0.98));
        c2d.fillStyle = grad;
        c2d.shadowColor = specRgba(mc, me > 0.002 ? 0.30 : 0.12);
        specColumnPath(c2d, mcx, topY, baseline, barW, botW);
        c2d.fill();

        /* 顶部 1px 高光边（更亮的白，压住顶部轮廓） */
        if (me > 0.002) {
          var hw = Math.max(1, barW - 2 * Math.min(barW * 0.5, 3.2 * dpr));
          c2d.shadowBlur = 0;
          c2d.fillStyle = 'rgba(255,255,255,0.42)';
          c2d.fillRect(mcx - hw * 0.5, topY, hw, Math.max(1, dpr * 0.9));
          c2d.shadowBlur = SPEC_GLOW_PX * dpr;
        }
      }
      c2d.restore();

      /* ── 峰值保持线（顶部 3 帧衰减）─────────────────────────────────── */
      c2d.save();
      for (var pi = 0; pi < bars; pi++) {
        var pv = peak[pi];
        if (pv <= 0.004) continue;
        var pt = bars <= 1 ? 0 : pi / (bars - 1);
        var pc = specRampColor(pt);
        var pcx = safe + pi * slot + slot * 0.5;
        var ph = pv * mainSpan;
        var py = baseline - ph - Math.max(1, dpr * 1.6);
        c2d.fillStyle = specRgba(specLighten(pc, 0.55), 0.55);
        c2d.fillRect(pcx - barW * 0.5, py, barW, Math.max(1, dpr * 0.8));
      }
      c2d.restore();

      /* ── 静音文案（淡、居中，不喧宾夺主）──────────────────────────── */
      if (!bins) {
        c2d.save();
        c2d.fillStyle = 'rgba(160,168,186,0.55)';
        c2d.font = '500 ' + Math.round(10.5 * dpr) + 'px system-ui, -apple-system, "Segoe UI", sans-serif';
        c2d.textAlign = 'center';
        c2d.textBaseline = 'middle';
        c2d.fillText('待播放', w * 0.5, baseline - 15 * dpr);
        c2d.restore();
      }
    }

    /* 便于外部/测试使用 */

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

    // 歌词模式图标：左半 = 歌词条（duo 两行 / board 四行），右半 = 双向切换箭头
    // 当前句条用 BRAND 高亮，其余条走 currentColor 半透明；形状随模式变化，可直接看出状态
    function IconLyricMode(props) {
      var size = iconSize(props, 16);
      var mode = (props && props.mode) === "board" ? "board" : "duo";
      var lines = (mode === "board")
        ? [[1.9, 4.3, 8.4], [1.9, 7.1, 6.4], [1.9, 9.9, 7.8], [1.9, 12.7, 4.8]]
        : [[1.9, 5.7, 8.4], [1.9, 10.5, 5.2]];
      var kids = [];
      for (var i = 0; i < lines.length; i++) {
        var ln = lines[i];
        kids.push(h("line", {
          key: "l" + i,
          x1: ln[0], y1: ln[1], x2: ln[0] + ln[2], y2: ln[1],
          stroke: i === 0 ? "var(--dsw-alias-brand-primary, #4c8dff)" : "currentColor",
          strokeWidth: i === 0 ? 1.7 : 1.2,
          strokeLinecap: "round",
          opacity: i === 0 ? 1 : 0.6
        }));
      }
      kids.push(h("path", {
        key: "a1",
        d: "M11.9 4.7h2.3M13.1 3.7l1 1-1 1",
        stroke: "currentColor", strokeWidth: 1, strokeLinecap: "round",
        strokeLinejoin: "round", opacity: 0.55
      }));
      kids.push(h("path", {
        key: "a2",
        d: "M14.2 12.3h-2.3M12.9 11.3l-1 1 1 1",
        stroke: "currentColor", strokeWidth: 1, strokeLinecap: "round",
        strokeLinejoin: "round", opacity: 0.55
      }));
      return h("svg", {
        width: size, height: size, viewBox: "0 0 16 16", fill: "none",
        xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true"
      }, kids);
    }

    // ── 样式常量 ───────────────────────────────────────────────────────────
    // 歌词导航图标：上一句（向上箭头）/ 下一句（向下箭头）/ 自动跟随（环形箭头+点）
    // 手动（十字准星）/ 对齐当前句（落点标记）
    function IconLyricStep(props) {
      var size = iconSize(props, 16);
      var up = (props.dir) === "up";
      return h("svg", {
        width: size, height: size, viewBox: "0 0 16 16", fill: "none",
        xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true"
      }, [
        h("path", {
          key: "p",
          d: up ? "M8 12.6V5.4M4.9 8.5L8 5.4l3.1 3.1" : "M8 3.4v7.2M4.9 7.5L8 10.6l3.1-3.1",
          stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round"
        })
      ]);
    }
    function IconLyricFollow(props) {
      var size = iconSize(props, 16);
      var manual = (props.mode) === "manual";
      var kids = [];
      if (manual) {
        kids.push(h("circle", {
          key: "c", cx: 8, cy: 8, r: 3.1,
          stroke: "currentColor", strokeWidth: 1.2, opacity: 0.8
        }));
        kids.push(h("path", {
          key: "t",
          d: "M8 1.9v2.2M8 11.9v2.2M1.9 8h2.2M11.9 8h2.2",
          stroke: "var(--dsw-alias-brand-primary, #4c8dff)", strokeWidth: 1.2, strokeLinecap: "round"
        }));
      } else {
        kids.push(h("path", {
          key: "a",
          d: "M12.6 8a4.6 4.6 0 1 1-1.5-3.4",
          stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round"
        }));
        kids.push(h("path", {
          key: "h",
          d: "M11.1 2.6v2.4h-2.4",
          stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round", strokeLinejoin: "round"
        }));
        kids.push(h("circle", {
          key: "d", cx: 8, cy: 8, r: 1.5,
          fill: "var(--dsw-alias-brand-primary, #4c8dff)"
        }));
      }
      return h("svg", {
        width: size, height: size, viewBox: "0 0 16 16", fill: "none",
        xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true"
      }, kids);
    }
    function IconLyricAlign(props) {
      var size = iconSize(props, 16);
      return h("svg", {
        width: size, height: size, viewBox: "0 0 16 16", fill: "none",
        xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true"
      }, [
        h("path", {
          key: "l", d: "M2.4 12.4h11.2",
          stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round", opacity: 0.6
        }),
        h("path", {
          key: "d", d: "M8 3.4v5.2M5.9 6.7L8 9l2.1-2.3",
          stroke: "var(--dsw-alias-brand-primary, #4c8dff)", strokeWidth: 1.3,
          strokeLinecap: "round", strokeLinejoin: "round"
        }),
        h("circle", {
          key: "c", cx: 8, cy: 12.4, r: 1.2,
          fill: "var(--dsw-alias-brand-primary, #4c8dff)"
        })
      ]);
    }
    var LABEL = "var(--dsw-alias-label-secondary, #8b90a0)";
    var BRAND = "var(--dsw-alias-brand-primary, #4c8dff)";
    var LINK = "var(--dsw-alias-link-normal, #4c8dff)";
    var BORDER = "var(--dsw-alias-border-l2, rgba(140,150,180,0.28))";
    var SURFACE = "var(--dsw-alias-bg-layer-2, rgba(140,150,180,0.08))";
    var TEXT = "var(--dsw-alias-label-primary, inherit)";

    // ── 歌词显示：内置歌词表 / 动画样式 / 显示模式偏好 ──────────────────────────
    // 四段色标与频谱一致（青绿→品牌蓝→淡紫→暖金）
    var LYRIC_GRADIENT =
      "linear-gradient(90deg, #35d0a8 0%, #4c8dff 38%, #b48cff 68%, #f0a94a 100%)";
    var LYRIC_MODE_KEY = "dsh-sidebar-media-player.lyricMode";
    function loadLyricMode() {
      try {
        var v = window.localStorage.getItem(LYRIC_MODE_KEY);
        if (v === "duo" || v === "board") return v;
      } catch (e) { /* 忽略 */ }
      return "duo";
    }
    function saveLyricMode(m) {
      try { window.localStorage.setItem(LYRIC_MODE_KEY, m); } catch (e) { /* 忽略 */ }
    }
    // ── 歌词跟随模式（auto=自动跟唱 / manual=手动）────────────────────────────
    var LYRIC_FOLLOW_KEY = "dsh-sidebar-media-player.lyricFollow";
    function loadLyricFollow() {
      try {
        var v = window.localStorage.getItem(LYRIC_FOLLOW_KEY);
        if (v === "manual" || v === "auto") return v;
      } catch (e) { /* 忽略 */ }
      return "auto";
    }
    function saveLyricFollow(m) {
      try { window.localStorage.setItem(LYRIC_FOLLOW_KEY, m); } catch (e) { /* 忽略 */ }
    }
    // ── 歌词时间偏移（秒）：正值 = 歌词提前出现；步进 0.2s，范围 ±10s ──────────
    var LYRIC_OFFSET_KEY = "dsh-sidebar-media-player.lyricOffset";
    function loadLyricOffset() {
      try {
        var v = parseFloat(window.localStorage.getItem(LYRIC_OFFSET_KEY));
        if (isFinite(v)) return Math.max(-10, Math.min(10, v));
      } catch (e) { /* 忽略 */ }
      return 0;
    }
    function saveLyricOffset(v) {
      try { window.localStorage.setItem(LYRIC_OFFSET_KEY, String(v)); } catch (e) { /* 忽略 */ }
    }
    // 有效时间：offset 为全局平移（正值=提前）；align 为单句对齐锚点（自 idx 起整体平移）
    function lyricEffTime(lines, i, offset, align) {
      if (!lines || i < 0 || i >= lines.length) return 0;
      var t = lines[i].t - (offset || 0);
      if (align && typeof align.idx === "number" && i >= align.idx) t += (align.delta || 0);
      return t;
    }
    function lyricActiveIndex(lines, audioTime, offset, align) {
      if (!lines || lines.length === 0) return -1;
      var idx = -1;
      for (var i = 0; i < lines.length; i++) {
        if (lyricEffTime(lines, i, offset, align) <= audioTime + 1e-6) idx = i;
      }
      return idx;
    }
    var LYRIC_CSS = [
      ".dsw-lyric-sweep{background-size:220% 100%;-webkit-animation:dsw-lyric-sweep 3.6s linear infinite;animation:dsw-lyric-sweep 3.6s linear infinite;}",
      "@keyframes dsw-lyric-sweep{0%{background-position:0% 50%;}100%{background-position:220% 50%;}}",
      ".dsw-lyric-cursor{-webkit-animation:dsw-lyric-cursor 1.05s ease-in-out infinite;animation:dsw-lyric-cursor 1.05s ease-in-out infinite;}",
      "@keyframes dsw-lyric-cursor{0%,100%{transform:translateY(0);opacity:.8;}50%{transform:translateY(-3px);opacity:1;}}"
    ].join("\n");
    function ensureLyricStyle() {
      try {
        if (typeof document === "undefined") return;
        if (document.getElementById("dsw-lyric-style")) return;
        var st = document.createElement("style");
        st.id = "dsw-lyric-style";
        st.textContent = LYRIC_CSS;
        (document.head || document.documentElement).appendChild(st);
      } catch (e) { /* 忽略 */ }
    }
    ensureLyricStyle();
    // 内置歌词（无外挂 .lrc 时的回落）：按文件名关键字匹配
    var BUILTIN_LYRIC_TABLE = [
      {
        name: "夏天的尾巴",
        lines: [
      { t: 1.5, text: "蝉声退到 电线杆左边", section: "Intro" },
      { t: 4.9, text: "风扇转不停 吹不散留恋", section: "Intro" },
      { t: 8.3, text: "冰棍化在 玻璃杯沿", section: "Intro" },
      { t: 11.7, text: "像夏天 最后一点甜", section: "Intro" },
      { t: 15.6, text: "马路还烫 天色已经变淡", section: "Verse" },
      { t: 18.9, text: "你踩着影子 走在我右手边", section: "Verse" },
      { t: 22.2, text: "说还有三天 就要搬去另一端", section: "Verse" },
      { t: 25.5, text: "我数着蝉鸣 假装没听见", section: "Verse" },
      { t: 29.2, text: "泳池的水 一夜之间抽干", section: "Verse" },
      { t: 32.5, text: "晒黑的肩膀 慢慢褪回从前", section: "Verse" },
      { t: 35.8, text: "便利店的冰柜 空了一半", section: "Verse" },
      { t: 39.1, text: "我买了两支 你说不用还", section: "Verse" },
      { t: 42.9, text: "我把西瓜 切成了两半", section: "Pre-Chorus" },
      { t: 46.0, text: "一半给你 一半我慢慢吃完", section: "Pre-Chorus" },
      { t: 49.1, text: "风从窗缝 吹进来一点凉", section: "Pre-Chorus" },
      { t: 52.2, text: "像你说的 那种舍不得讲", section: "Pre-Chorus" },
      { t: 55.8, text: "这是夏天的尾巴 一晃就散", section: "Chorus" },
      { t: 59.1, text: "像冰棍化在 手心一片甜", section: "Chorus" },
      { t: 62.4, text: "你回头笑 说别这样看", section: "Chorus" },
      { t: 65.7, text: "可我知道 秋天已经到门外边", section: "Chorus" },
      { t: 69.5, text: "行李箱轮子 在楼道里响", section: "Verse" },
      { t: 72.8, text: "你把钥匙 放在鞋柜上面", section: "Verse" },
      { t: 76.1, text: "说以后 大概不会再回来", section: "Verse" },
      { t: 79.4, text: "我说好 轻得自己都没听见", section: "Verse" },
      { t: 83.2, text: "我把西瓜 切成了两半", section: "Pre-Chorus" },
      { t: 86.3, text: "一半给你 一半我慢慢吃完", section: "Pre-Chorus" },
      { t: 89.4, text: "风从窗缝 吹进来一点凉", section: "Pre-Chorus" },
      { t: 92.5, text: "像你说的 那种舍不得讲", section: "Pre-Chorus" },
      { t: 96.1, text: "这是夏天的尾巴 一晃就散", section: "Chorus" },
      { t: 99.4, text: "像冰棍化在 手心一片甜", section: "Chorus" },
      { t: 102.7, text: "你回头笑 说别这样看", section: "Chorus" },
      { t: 106.0, text: "可我知道 秋天已经到门外边", section: "Chorus" },
      { t: 109.8, text: "如果蝉 能多叫一整晚", section: "Bridge" },
      { t: 112.9, text: "如果风扇 能转得再慢一点", section: "Bridge" },
      { t: 116.0, text: "我就把 这个夏天 再借三天", section: "Bridge" },
      { t: 119.1, text: "等你走了 我再还给时间", section: "Bridge" },
      { t: 122.6, text: "蝉声退到 电线杆左边", section: "Outro" },
      { t: 125.2, text: "风扇还在转 一整晚", section: "Outro" },
      { t: 127.8, text: "冰棍化尽 玻璃杯沿", section: "Outro" },
      { t: 130.4, text: "这个夏天 留不住的甜", section: "Outro" },
      { t: 133.0, text: "我一个人 慢慢吃完", section: "Outro" }
        ]
      }
    ];
    function builtinLyricLines(name) {
      if (!name) return null;
      var low = String(name).toLowerCase();
      for (var i = 0; i < BUILTIN_LYRIC_TABLE.length; i++) {
        var e = BUILTIN_LYRIC_TABLE[i];
        if (low.indexOf(String(e.name).toLowerCase()) >= 0) return e.lines;
      }
      return null;
    }

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
    // SmpPlayerBody：完整播放器主体（封面 / 进度 / 文件夹 / 下载 / 频谱 / 音准 /
    // 唱盘 / 歌词双模式 / 四个歌词功能）。原 MediaViewer 的实现整体搬到这里，
    // 由两处复用：① MediaViewer 薄壳（点开媒体文件预览）② SmpPlayerPanel 面板顶部。
    // 🔴 一份实现两处复用，绝不复制第二份（"改一处忘一处"已经吃过亏）。
    function SmpPlayerBody(props) {
      var scope = props.scope;
      var path = props.path;
      // 面板模式：不绑定 <audio> 事件、不另建 AudioContext，全部读模块级 store/analyser
      var isPanelBody = props.mode === "panel";
      var dl = downloadUrl(scope, path);

      // ── 本地播放列表（文件夹选择 / 拖放导入 → blob 直读）──────────────────
      var plState = react.useState(null);
      var playlist = plState[0];
      var setPlaylist = plState[1];
      var plRef = react.useRef(null);
      plRef.current = playlist;
      var dirInputRef = react.useRef(null);
      var fileOnlyRef = react.useRef(null);
      // P0：自绘目录浏览器开关（宿主里 <input type=file> 弹不出系统框）
      var pickerState = react.useState(false);
      var pickerOpen = pickerState[0];
      var setPickerOpen = pickerState[1];
      var dragRef = react.useRef(false);
      var dragState = react.useState(false);
      var isDragOver = dragState[0];
      var setDragOver = dragState[1];
      var nextRef = react.useRef(null);

      var localItem = playlist && playlist.items && playlist.items.length
        ? playlist.items[playlist.idx]
        : null;
      var src = localItem ? localItem.url : mediaUrl(scope, path);
      var displayPath = localItem ? localItem.name : path;
      var isVideo = localItem ? localItem.isVideo : isVideoPath(path);

      // 把一批 File 变成播放列表（blob 直读）
      var applyFileList = function (files) {
        var arr = Array.prototype.slice.call(files || []);
        var items = [];
        for (var i = 0; i < arr.length; i++) {
          var f = arr[i];
          if (!f) continue;
          var nm = f.name || "";
          var ex = extOf(nm);
          if (MEDIA_SET[ex] !== true) continue;
          items.push({
            url: URL.createObjectURL(f),
            name: nm,
            isVideo: VIDEO_SET[ex] === true
          });
        }
        if (!items.length) return false;
        var old = plRef.current;
        if (old && old.items) {
          for (var j = 0; j < old.items.length; j++) {
            try { URL.revokeObjectURL(old.items[j].url); } catch (e) {}
          }
        }
        setPlaylist({ items: items, idx: 0 });
        return true;
      };

      // 下一首
      var playNext = function () {
        var pl = plRef.current;
        if (!pl || !pl.items || pl.items.length < 2) return;
        var idx = (pl.idx + 1) % pl.items.length;
        setPlaylist({ items: pl.items, idx: idx });
      };
      nextRef.current = playNext;

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
    // Blob 救援入口（effect 闭包里定义，交给 togglePlay / error 事件跨作用域调用）
    var rescueRef = react.useRef(null);

    /* ── S2：音频元素归模块级 store ────────────────────────────────────────
     * 音频分支不再从 React 树渲染 <audio>（见下方 mediaEl），mediaRef 改指向
     * store 自己造的模块级元素 —— 组件卸载不销毁它，播放不中断。
     * 这两条 effect 必须声明在「媒体元素事件」effect（下方）**之前**：
     * React 按声明顺序执行 effects，事件绑定要能拿到已指向的 mediaRef。
     * 卸载时**不置空** mediaRef.current —— store 的兜底控制还要用它。
     * ─────────────────────────────────────────────────────────────────────── */
    react.useEffect(function () {
      if (isVideo) return undefined;
      mediaRef.current = SMP_STORE.audioEl();
      return undefined;
    }, [isVideo]);

    // 换源：与原 <audio src> 属性同语义；同源不重复设，避免重置播放位置。
    react.useEffect(function () {
      if (isVideo) return undefined;
      var e = SMP_STORE.audioEl();
      mediaRef.current = e;
      if (e.getAttribute("data-smp-src") !== src) {
        e.setAttribute("data-smp-src", src);
        e.src = src;
        // 换源后元素换流：旧 captureStream 的 analyser 恒无数据 → 频谱/音准会静默死。
        // 清 boundElRef 让 promoteGraph 的守卫失效 → 下次取样前重绑（复用同一个
        // AudioContext，不新建，避免 context 泄漏）。
        boundElRef.current = null;
        if (analyse) { try { promoteGraph(); } catch (e0p) {} }
      }
      return undefined;
    }, [isVideo, src]);

    // 条上显示的标题：与渲染块里的 title 同源（此处提前算，供 store 快照与条使用）。
    var smpTitle = props.title || displayPath;

    // 控制面回填：组件在树里时，条上的控制走组件自己的闭包（与改造前逐字一致）；
    // 组件卸载时 cleanup 把 ctl 置回 null → store 自动退化为兜底控制。
    react.useEffect(function () {
      SMP_STORE.setCtl({
        toggle: function () { togglePlay(); },
        seek: function (t) { hardSeek(t); },
        next: function () { if (nextRef.current) nextRef.current(); }
      });
      return function () { SMP_STORE.setCtl(null); };
    });

    // 🔴 初值从**模块级元素**读（不是写死的 0/false）：侧边栏重开时元素可能还在播，
    //    沿用固定初值会出现「UI 显示暂停但声音还在」。
    var durState = react.useState(function () {
      if (isVideo) return 0;
      var e0 = SMP_STORE.audioEl();
      return isFinite(e0.duration) && e0.duration > 0 ? e0.duration : 0;
    });
    var duration = durState[0];
    var setDuration = durState[1];

    var timeState = react.useState(function () {
      if (isVideo) return 0;
      var e0 = SMP_STORE.audioEl();
      return isFinite(e0.currentTime) && e0.currentTime > 0 ? e0.currentTime : 0;
    });
    var time = timeState[0];
    var setTime = timeState[1];

    var playState = react.useState(function () {
      if (isVideo) return false;
      var e0 = SMP_STORE.audioEl();
      return !e0.paused && !e0.ended;
    });
    var playing = playState[0];
    var setPlaying = playState[1];

    var volState = react.useState(function () {
      if (isVideo) return 1;
      var e0 = SMP_STORE.audioEl();
      return typeof e0.volume === "number" ? e0.volume : 1;
    });
    var volume = volState[0];
    var setVolume = volState[1];

    var rateState = react.useState(function () {
      if (isVideo) return 1;
      var e0 = SMP_STORE.audioEl();
      return typeof e0.playbackRate === "number" ? e0.playbackRate : 1;
    });
    var rate = rateState[0];
    var setRate = rateState[1];

    var loopState = react.useState(function () {
      if (isVideo) return false;
      return !!SMP_STORE.audioEl().loop;
    });
    var loop = loopState[0];
    var setLoop = loopState[1];

    // 🔴 面板模式：本实例**不绑** <audio> 事件（见下方事件 effect 的 isPanelBody 早退），
    // 播放态由模块级 store 快照单向灌回本地 state，保证面板 UI 始终跟着那台真播放器走。
    // 注意：useSmpStore 必须**无条件**调用（hooks 规则），面板/预览两模式都调，预览模式下方 effect 直接 return。
    var panelSnap = useSmpStore();
    // 面板模式歌词回灌用：只看 rev（换了一份 lyrics 才回灌），避免每帧 timeupdate 都进分支
    var panelLyricRevRef = react.useRef(-1);
    react.useEffect(function () {
      if (!isPanelBody || !panelSnap) return;
      setPlaying(!!panelSnap.playing);
      setTime(typeof panelSnap.time === "number" ? panelSnap.time : 0);
      setDuration(typeof panelSnap.duration === "number" ? panelSnap.duration : 0);
      if (typeof panelSnap.volume === "number") setVolume(panelSnap.volume);
      if (typeof panelSnap.rate === "number") setRate(panelSnap.rate);
      setLoop(!!panelSnap.loop);
      // QQ 在线曲的歌词由 store 侧 loadQQLLyric 拉（宿主 /qq/lyric 代理），是模块级的；
      // 组件只读自己的 lyricState → 不接这份快照就永远显示「无歌词」。换了一份才回灌。
      if (panelSnap.lyricLinesRev !== panelLyricRevRef.current) {
        panelLyricRevRef.current = panelSnap.lyricLinesRev;
        var pLines = Array.isArray(panelSnap.lyricLines) ? panelSnap.lyricLines : [];
        lyricLinesRef.current = pLines.slice();
        setLyric(pLines.length
          ? { source: "lrc", lines: pLines.slice(), text: "" }
          : { source: "none", lines: [], text: "" });
      }
      // 🔴 面板模式的高亮行只能从 store 灌：面板不绑 audio，updateLyricIndex 不跑，
      //    只回灌歌词数组、不回灌索引 → curLyricIdx 永远停在 -1，所有行都是低亮、滚动不动，
      //    用户看到的就是「QQ 歌词不动」。store 的 tickLyric 现在会 publish lyricIdx。
      if (typeof panelSnap.lyricIdx === "number" && panelSnap.lyricIdx !== curLyricRef.current) {
        curLyricRef.current = panelSnap.lyricIdx;
        setCurLyricIdx(panelSnap.lyricIdx);
      }
    }, [
      isPanelBody,
      panelSnap && panelSnap.playing,
      panelSnap && panelSnap.time,
      panelSnap && panelSnap.duration,
      panelSnap && panelSnap.volume,
      panelSnap && panelSnap.rate,
      panelSnap && panelSnap.loop,
      panelSnap && panelSnap.lyricLinesRev,
      panelSnap && panelSnap.lyricIdx
    ]);

    // S6：只订阅 prefs 这一片（引用不变就返回旧值 → 不触发重渲染）。
    // 不用 useSmpStore()：那会让整个播放器每条 timeupdate 都重渲，没必要。
    // 🔴 必须声明在下面所有用到 smpPrefs 的地方之前（含 effect 依赖数组 —— 依赖数组每次渲染都求值，
    // 提前使用会因 var 提升拿到 undefined 并抛 TypeError，整棵子树不渲染 = 面板白屏）。
    var smpPrefsState = react.useState(SMP_STORE.getPrefs());
    var smpPrefs = smpPrefsState[0];

    // 🔴 面板模式频谱：本实例不建 AudioContext（事件也不绑），优先复用模块级共享 analyser
    // 画实时彩色柱；没在播（无 analyser）时画一组低矮静止柱 —— 保证「面板第一眼就有频谱」，
    // 而不是一块白/空画布。预览模式（非 panel）走原有 startLoop 逻辑，不受影响。
    react.useEffect(function () {
      if (!isPanelBody) return undefined;
      if (smpPrefs.specShow === false) return undefined;
      var raf = 0;
      var idle = null;
      var lastEnsure = 0;
      var lastResume = 0;
      var binsBuf = null;
      var step = function (ts) {
        raf = requestAnimationFrame(step);
        var cv = canvasRef.current;
        if (!cv) return;
        var an = SMP_STORE.getAnalyser ? SMP_STORE.getAnalyser() : null;
        // 🔴 面板没有自己的播放器事件去 promoteGraph。若 store 还没图，主动要图（ensureGraph 有
        //    graphAn/graphEl 守卫，已建即返回；流无音轨时静默 null）。每 500ms 至多一次，不狂建。
        if (!an && SMP_STORE.ensureGraph && (!ts || ts - lastEnsure > 500)) {
          lastEnsure = ts || 0;
          try { an = SMP_STORE.ensureGraph(); } catch (e0eg) {}
        }
        if (an) {
          // 🔴 不能每帧 resume：无手势时 AudioContext.resume() 返回 pending Promise，每帧一个会
          //    堆微任务把 renderer 拖死（"点开面板卡死"的元凶之一）。至多每 500ms 尝试一次并吞掉 rejection。
          if (an.context && an.context.state === "suspended" && (!ts || ts - lastResume > 500)) {
            lastResume = ts || 0;
            try {
              var pr = an.context.resume();
              if (pr && typeof pr.catch === "function") pr.catch(function () {});
            } catch (eRsm) {}
          }
          if (!binsBuf || binsBuf.length !== an.frequencyBinCount) binsBuf = new Uint8Array(an.frequencyBinCount);
          try { an.getByteFrequencyData(binsBuf); } catch (e) { an = null; }
          if (an) { drawSpectrum(cv, binsBuf, an.context.sampleRate, an.fftSize); return; }
        }
        if (!idle) {
          idle = new Uint8Array(64);
          for (var i = 0; i < 64; i++) idle[i] = 16 + Math.round(10 * Math.abs(Math.sin(i * 0.7)));
        }
        drawSpectrum(cv, idle, 48000, 2048);
      };
      step();
      return function () { if (raf) cancelAnimationFrame(raf); };
    }, [isPanelBody, smpPrefs.specShow]);

    // 状态发布：条上的只读渲染读同一份快照（组件在时不重复操作元素）。
    react.useEffect(function () {
      // 🔴 面板模式是**只读镜像**：它没有自己的文件视图（title/path 归 store，由列表或 QQ
      //    起播时写入）。这里若照发 smpTitle/displayPath，会把 store 里刚写好的歌名覆盖成空
      //    ——用户看到"音乐在放、界面却写未在播放"就是这个。
      if (isPanelBody) {
        SMP_STORE.publish({ mounted: true });
        return;
      }
      SMP_STORE.publish({
        mounted: true, isVideo: isVideo, title: smpTitle, path: displayPath,
        playing: playing, time: time, duration: duration,
        volume: volume, rate: rate, loop: loop,
        list: playlist, listLen: playlist && playlist.items ? playlist.items.length : 0,
        idx: playlist ? playlist.idx : 0
      });
    }, [isVideo, smpTitle, displayPath, playing, time, duration, volume, rate, loop, playlist]);

    // 建图失败后**不每帧重试**：只在元素真正拿到元数据 / 可播时再试一次。
    // （404 曲或首次挂载时 captureStream 给的是空流，等 canplay 才有音轨。）
    react.useEffect(function () {
      if (isPanelBody) return undefined;
      var el = mediaRef.current;
      if (!el) return undefined;
      var retry = function () {
        if (!analyse || analyserRef.current) return;
        try { promoteGraph(); } catch (e0r) {}
      };
      try {
        el.addEventListener("loadedmetadata", retry);
        el.addEventListener("canplay", retry);
      } catch (e0a) {}
      return function () {
        try {
          el.removeEventListener("loadedmetadata", retry);
          el.removeEventListener("canplay", retry);
        } catch (e0b) {}
      };
    }, [analyse, isPanelBody]);

    // 组件卸载只撤销 mounted 标记：元素与 list/idx 留在 store 里，条继续可用。
    react.useEffect(function () {
      return function () { SMP_STORE.publish({ mounted: false }); };
    }, []);

      // 音频默认开频谱（播放一定由本组件按钮触发 → 手势内可 resume）；
      // 视频默认关（原生控件播放时无手势，建 graph 会把声音静掉）。
      // （prefs 状态与 smpPrefsState 已上移到外层作用域，见上方「S6：只订阅 prefs」注释 ——
      //  原先是 var 声明写在 effect 回调里，外层 effect 依赖数组提前读它 → 渲染即崩 = 面板白屏）
      react.useEffect(function () {
        return SMP_STORE.subscribe(function () {
          var p = SMP_STORE.getPrefs();
          smpPrefsState[1](function (old) { return old === p ? old : p; });
        });
      }, []);

      var anaState = react.useState(!isVideo);
      // ogg/webm 修正（Lead 批 2 顺手修·既有行为）：webm 容器可能是**纯音频**，
      // videoWidth/videoHeight 为 0。这种情况要降级到音频条 UI，而不是留一个黑框控件。
      var videoAudioOnlyState = react.useState(false);
      var videoAudioOnly = videoAudioOnlyState[0], setVideoAudioOnly = videoAudioOnlyState[1];
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
      // S4：把「歌词行 / 偏移 / 对齐」同步到 SMP_STORE 的去重游标（引用比较，避免每帧 publish）
      var smpLyricSync = react.useRef({ lines: null, offset: 0, align: null });
      var lyricElsRef = react.useRef([]);
      var curLyricRef = react.useRef(-1);

      // 歌词开关（音频）：默认开启（保持现有可见歌词），偏好持久化到 localStorage
      var lyricPrefsRef = react.useRef(null);
      if (lyricPrefsRef.current === null) lyricPrefsRef.current = loadLyricPrefs();
      var lyricOnState = react.useState(lyricPrefsRef.current.show);
      var lyricOn = lyricOnState[0];
      var setLyricOn = lyricOnState[1];
      function changeLyricOn(v) {
        lyricUserToggledRef.current = true;
        setLyricOn(v);
        saveLyricPrefs({ show: v });
      }

      // 歌词显示模式："duo"=两句两句（当前句放大居中）｜ "board"=歌词板（全词滚动）
      var lyricModePrefsRef = react.useRef(null);
      if (lyricModePrefsRef.current === null) lyricModePrefsRef.current = loadLyricMode();
      var lyricModeState = react.useState(lyricModePrefsRef.current);
      var lyricMode = lyricModeState[0];
      var setLyricMode = lyricModeState[1];
      function changeLyricMode(m) {
        setLyricMode(m);
        saveLyricMode(m);
      }

      // 歌词跟随模式："auto"=随播自动高亮/滚动（默认）｜ "manual"=手动（按钮控制高亮）
      var lyricFollowPrefsRef = react.useRef(null);
      if (lyricFollowPrefsRef.current === null) lyricFollowPrefsRef.current = loadLyricFollow();
      var lyricFollowState = react.useState(lyricFollowPrefsRef.current);
      var lyricFollow = lyricFollowState[0];
      var setLyricFollow = lyricFollowState[1];
      var lyricFollowRef = react.useRef(lyricFollowPrefsRef.current);
      function changeLyricFollow(m) {
        lyricFollowRef.current = m;
        setLyricFollow(m);
        saveLyricFollow(m);
        if (m === "auto") {
          // 自动跟唱 = 歌词必须可见
          setLyricOn(true);
          saveLyricPrefs({ show: true });
          updateLyricIndex((mediaRef.current && mediaRef.current.currentTime) || 0);
        }
      }
      // 用户是否手动切换过歌词显隐（决定自动模式下是否强制显示）
      var lyricUserToggledRef = react.useRef(false);

      // 歌词时间偏移（秒）：正值 = 歌词提前出现；步进 0.2s，范围 ±10s
      var lyricOffsetPrefsRef = react.useRef(null);
      if (lyricOffsetPrefsRef.current === null) lyricOffsetPrefsRef.current = loadLyricOffset();
      var lyricOffsetState = react.useState(lyricOffsetPrefsRef.current);
      var lyricOffset = lyricOffsetState[0];
      var setLyricOffset = lyricOffsetState[1];
      var lyricOffsetRef = react.useRef(lyricOffsetPrefsRef.current);
      function changeLyricOffset(v) {
        var nv = Math.round(Math.max(-10, Math.min(10, v)) * 100) / 100;
        lyricOffsetRef.current = nv;
        setLyricOffset(nv);
        saveLyricOffset(nv);
        updateLyricIndex((mediaRef.current && mediaRef.current.currentTime) || 0);
      }
      // 单句对齐锚点：{ idx, delta }，自 idx 起整体平移 delta（会话内生效，不持久化）
      var lyricAlignState = react.useState(null);
      var lyricAlign = lyricAlignState[0];
      var setLyricAlign = lyricAlignState[1];
      var lyricAlignRef = react.useRef(null);
      function changeLyricAlign(a) {
        lyricAlignRef.current = a;
        setLyricAlign(a);
        updateLyricIndex((mediaRef.current && mediaRef.current.currentTime) || 0);
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
        // ── S4：把歌词数据与参数同步给 store（条上歌词用它滚动；侧边栏关闭后仍生效）
        // 只在引用/数值真变化时同步，避免每个 timeupdate 都 publish 重置当前行。
        var sy = smpLyricSync.current;
        if (sy.lines !== lines || sy.offset !== lyricOffsetRef.current || sy.align !== lyricAlignRef.current) {
          sy.lines = lines;
          sy.offset = lyricOffsetRef.current;
          sy.align = lyricAlignRef.current;
          try {
            SMP_STORE.setLyricLines(lines || [], true);
            SMP_STORE.setLyricCfg({ offset: sy.offset, align: sy.align });
          } catch (e0) { /* store 不在则忽略 */ }
        }
        if (!lines || lines.length === 0) {
          if (curLyricRef.current !== -1) { curLyricRef.current = -1; setCurLyricIdx(-1); }
          return;
        }
        // 手动模式：不随播放自动推进当前句（由上一句/下一句/对齐按钮控制）
        // 例外：首次定位（尚未选过句）仍按播放位置落一次，之后交给用户控制
        if (lyricFollowRef.current !== "auto" && curLyricRef.current !== -1) return;
        var idx = lyricActiveIndex(lines, t, lyricOffsetRef.current, lyricAlignRef.current);
        if (idx !== curLyricRef.current) { curLyricRef.current = idx; setCurLyricIdx(idx); }
      }

      // 跳到指定歌词行：seek 到该行起始（已计入偏移/对齐），并立即把它设为当前句
      function seekLyricLine(idx) {
        var lines = lyricLinesRef.current;
        if (!lines || lines.length === 0) return;
        var i = Math.max(0, Math.min(lines.length - 1, idx));
        var target = lyricEffTime(lines, i, lyricOffsetRef.current, lyricAlignRef.current);
        if (target < 0) target = 0;
        hardSeek(target);
        curLyricRef.current = i;
        setCurLyricIdx(i);
      }
      // 上一句 / 下一句
      function navLyricLine(dir) {
        var lines = lyricLinesRef.current;
        if (!lines || lines.length === 0) return;
        var ci = curLyricRef.current;
        if (ci < 0) {
          // 还没有选中任何句：以"当前正在唱的那句"为基准
          ci = lyricActiveIndex(lines, (mediaRef.current && mediaRef.current.currentTime) || 0,
            lyricOffsetRef.current, lyricAlignRef.current);
          if (ci < 0) ci = 0;
        }
        seekLyricLine(ci + dir);
      }
      // 对齐当前句：把这一句锚到当前播放位置，其后各行按同样差值整体平移
      function alignCurrentLyricLine() {
        var lines = lyricLinesRef.current;
        if (!lines || lines.length === 0) return;
        var el = mediaRef.current;
        var now = (el && el.currentTime) || 0;
        var ci = curLyricRef.current;
        if (ci < 0) {
          ci = lyricActiveIndex(lines, now, lyricOffsetRef.current, lyricAlignRef.current);
          if (ci < 0) ci = 0;
        }
        var delta = now - lyricEffTime(lines, ci, lyricOffsetRef.current, null);
        changeLyricAlign({ idx: ci, delta: delta });
        curLyricRef.current = ci;
        setCurLyricIdx(ci);
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
        // 🔴 面板模式无自有 <audio>（mediaRef 为空），真播放器是模块级 store.audioEl()。
        // 旧代码只取 mediaRef.current → 面板里 seek 永远 return（快进失效）。按模式取对元素。
        var el = (isPanelBody && SMP_STORE.audioEl) ? SMP_STORE.audioEl() : mediaRef.current;
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
        // 🔴 音频路径：图由 store 统一建（唯一实例），组件只"要图"。
        //    面板是用户主界面，不能等"点开文件预览"才有频谱——预览与面板共用同一份 analyser。
        //    视频路径（<video> 元素）仍由本组件自建：store 持有的是那个 <audio>，两者不同元素。
        if (!isVideo) {
          var sharedAn = null;
          try { sharedAn = SMP_STORE.getAnalyser ? SMP_STORE.getAnalyser() : null; } catch (e0g) {}
          if (!sharedAn) {
            try { if (SMP_STORE.ensureGraph) sharedAn = SMP_STORE.ensureGraph(); } catch (e0e) {}
          }
          if (sharedAn) {
            if (analyserRef.current !== sharedAn) {
              analyserRef.current = sharedAn;
              freqRef.current = new Uint8Array(sharedAn.frequencyBinCount || 1024);
              waveRef.current = new Float32Array(sharedAn.fftSize || 2048);
            }
            boundElRef.current = mediaRef.current;
            setGraphReady(true);
            startLoop();
            return true;
          }
          // store 暂时建不出图（空轨道 / 无 Web Audio）→ 静止频谱，不做任何重试风暴
          setGraphReady(false);
          return false;
        }
        var el = mediaRef.current;
        if (!el) return false;
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) {
          setAnalyse(false);
          // 频谱/音准属"装饰层"，缺能力只降级，不打扰用户（内部错误不上屏）
          try { console.warn("[smp] 此环境无 Web Audio，频谱/音准已静默关闭"); } catch (e0w) {}
          return false;
        }
        // 复用现有 AudioContext：换源时不能 new（每次新建会泄漏，且旧 context 里的
        // analyser 会变成孤儿）。只有首次或旧的已 closed 才新建。
        var actx = actxRef.current;
        var needNewCtx = !actx || actx.state === "closed";
        // 已经绑到「当前这个元素」、且 context 还活着 → 直接复用，不重复建图。
        // 守卫必须比 boundElRef：换源后元素流换了，旧 analyser 恒无数据（频谱/音准静默死）。
        if (!needNewCtx && analyserRef.current && boundElRef.current === el) {
          if (actx.state === "suspended") actx.resume();
          return true;
        }
        try {
          if (needNewCtx) { actx = new AC(); actxRef.current = actx; }
          var an = actx.createAnalyser();
          an.fftSize = 2048;
          an.smoothingTimeConstant = 0.75;
          // ── S2：TAP 取样，不再重定向元素输出 ─────────────────────────────
          // 旧法 createMediaElementSource(el) 把元素输出整体搬进 Web Audio 图：
          // 图一停 / 元素换源 → 整条静音（"切歌后没声音"的成因）。
          // 新法 el.captureStream() 只旁路取一份 MediaStream，元素保持原生播放路径。
          var stream = null;
          if (typeof el.captureStream === "function") stream = el.captureStream();
          else if (typeof el.mozCaptureStream === "function") stream = el.mozCaptureStream();
          // 🔴 元素还没拿到可用音源时（404 曲 / 尚未 loadedmetadata / QQ 代理流首帧）
          //    captureStream() 会返回**没有任何 audio track 的空流**，丢进
          //    createMediaStreamSource 必抛 InvalidStateError。先验轨道：空流静默不建图，
          //    维持静止频谱，等 loadedmetadata / canplay 再来一次（绝不做每帧重试）。
          var audioTracks = null;
          try {
            audioTracks = (stream && typeof stream.getAudioTracks === "function") ? stream.getAudioTracks() : null;
          } catch (e0tr) { audioTracks = null; }
          if (stream && audioTracks && audioTracks.length === 0) {
            try { console.info("[smp] 频谱暂不建图：MediaStream 还没有 audio track，等元数据到达"); } catch (e0i) {}
            return false;
          }
          if (stream) {
            var srcNode = actx.createMediaStreamSource(stream);
            srcNode.connect(an);
            // 图必须连到 destination 才会被 Chromium 真正驱动（否则 analyser 无数据），
            // 但元素已自行出声 → 经 0 增益 sink 接地：图活跃、不重复发声。
            var sink = actx.createGain();
            sink.gain.value = 0;
            an.connect(sink);
            sink.connect(actx.destination);
          } else {
            // 兜底：无 captureStream 的极旧内核仍走旧法（此时必须经 destination 出声）
            var elNode = actx.createMediaElementSource(el);
            elNode.connect(an);
            an.connect(actx.destination);
          }
          actxRef.current = actx;
          // 重绑时旧的 analyser 必须先断开，否则同一个 context 上会越挂越多（换源反复触发）。
          var prevAn = analyserRef.current;
          if (prevAn && prevAn !== an) { try { prevAn.disconnect(); } catch (e0d) {} }
          analyserRef.current = an;
          // S3b（非动不可·第 4 处）：把 analyser 共享给播放条只读复用，
          // 条上不另建 AudioContext（对同一 media 元素重复 captureStream 取样会互扰）。
          try { SMP_STORE.setAnalyser(an); } catch (e0s) { /* store 未就绪时忽略 */ }
          freqRef.current = new Uint8Array(an.frequencyBinCount);
          waveRef.current = new Float32Array(an.fftSize);
          boundElRef.current = el;
          if (actx.state === "suspended") actx.resume();
          setGraphReady(true);
          startLoop();
          return true;
        } catch (err) {
          // 频谱/图形层是"装饰层"：失败只静默降级（静止柱），绝不 setError。
          // 这里曾经把 InvalidStateError 渲染成红框怼到用户脸上。
          // 也不 setAnalyse(false)：留着开关，等 loadedmetadata / canplay 还能再试一次。
          setGraphReady(false);
          try {
            console.warn("[smp] 频谱建图失败（静默降级，显示静止频谱）", err && err.message ? err.message : err);
          } catch (e0w2) {}
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
              // NotSupportedError = 资源选择阶段就失败（FLAC 等容器在 dsh-app 桥下可能命不中），
              // 先交给 Blob 救援重试一次，别把「no supported sources」当结论丢给用户。
              var msg = String((err && err.message) || "");
              var srcFail = (err && err.name === "NotSupportedError") || /supported source|Format error/i.test(msg);
              if (srcFail && rescueRef.current) {
                rescueRef.current();
                return;
              }
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

        // 🔴 面板模式实例不绑 <audio> 事件（模块级 <audio> 是单例，两个实例都绑会双触发）。
        // 面板实例的 playing/time/duration 由 store 快照同步，见下方 panelSnap effect。
        if (isPanelBody) return undefined;

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
            if (!r.ok) {
              var e403 = new Error("HTTP " + r.status);
              e403.rescueReason = "HTTP " + r.status;
              throw e403;
            }
            return r.blob();
          }).then(function (blob) {
            if (cancelled) throw new Error("cancelled");
            if (!blob || blob.size <= 0) {
              var e0 = new Error("empty");
              e0.rescueReason = "empty";
              throw e0;
            }
            if (blob.size > 300 * 1024 * 1024) {
              var eBig = new Error("too-large");
              eBig.rescueReason = "too-large";
              throw eBig;
            }
            // 显式重贴 MIME：Blob 自带确定长度 + 可信类型，绕开协议桥的
            // content-type 透传差异与浏览器内容嗅探，FLAC 等无损容器才稳。
            var mime = mimeForPath(path);
            if (mime && blob.type !== mime) {
              try { blob = blob.slice(0, blob.size, mime); } catch (e) {}
            }
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
              setError("");
              if (wasPlaying) {
                var p = el.play();
                if (p && typeof p.catch === "function") p.catch(function () {});
              }
            };
            el.addEventListener("loadedmetadata", restore);
            el.src = objUrl;
            try { el.load(); } catch (e) {}
          }).catch(function (err) {
            rescueBusy = false;
            if (cancelled || rescued) return;
            var reason = (err && err.rescueReason) || "";
            if (!reason) return; // 非护栏错误（如用户切换了文件）保持静默
            var hint = reason === "too-large"
              ? "\u6587\u4ef6\u8fc7\u5927\uff08300MB \u4e0a\u9650\uff09\uff0c\u65e0\u6cd5\u6574\u6bb5\u8f7d\u5165\u64ad\u653e"
              : reason === "empty"
                ? "\u8bfb\u5230\u7684\u5a92\u4f53\u4e3a\u7a7a\uff080 \u5b57\u8282\uff09"
                : reason.indexOf("403") >= 0
                  ? "\u65e0\u6743\u8bbf\u95ee\u8be5\u8def\u5f84\uff08HTTP 403\uff0c\u4f1a\u8bdd\u5de5\u4f5c\u76ee\u5f55\u4e4b\u5916\u7684\u6587\u4ef6\u88ab\u62e6\uff09"
                  : "\u8bfb\u53d6\u5a92\u4f53\u5931\u8d25\uff08" + reason + "\uff09";
            setError("\u64ad\u653e\u5931\u8d25\uff1a" + hint);
          });
        };
        rescueRef.current = tryRescue;
        var onMeta = function () {
          var d = durationOf(el);
          setDuration(d);
          // ogg/webm 修正：webm 可能是纯音频。metadata 到了就能读 videoWidth，
          // 0 → 降级音频 UI；>0 → 纠回视频 UI（换源自动纠正，不需要额外重置逻辑）。
          if (isVideo) {
            var vw = (typeof el.videoWidth === "number") ? el.videoWidth : -1;
            if (vw === 0) setVideoAudioOnly(true);
            else if (vw > 0) setVideoAudioOnly(false);
          }
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
          try { resetSpectrumState(); } catch (e) {}
          var canvas = canvasRef.current;
          if (canvas) drawSpectrum(canvas, null, 0, 0);
        };
        var onEnded = function () {
          setPlaying(false);
          stopLoop();
          setTime(durationOf(el));
          // 本地播放列表：自动下一首
          var pl = plRef.current;
          if (pl && pl.items && pl.items.length > 1 && nextRef.current) {
            nextRef.current();
          }
        };
        var onErr = function () {
          // MEDIA_ERR_SRC_NOT_SUPPORTED(4) / MEDIA_ERR_DECODE(3)：直读源命不中时
          // 先走一次 Blob 救援（确定长度 + 显式 MIME），救不动才报编码不支持。
          var code = el.error ? el.error.code : 0;
          if (!rescued && (code === 4 || code === 3) && rescueRef.current) {
            tryRescue();
            return;
          }
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
        // 换歌：单句对齐锚点属于上一首，重置
        if (lyricAlignRef.current !== null) {
          lyricAlignRef.current = null;
          setLyricAlign(null);
        }
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
              var bi = builtinLyricLines(displayPath || path);
              if (bi) {
                lyricLinesRef.current = bi;
                setLyric({ source: "lrc", lines: bi, text: "" });
                updateLyricIndex((mediaRef.current && mediaRef.current.currentTime) || 0);
              } else {
                setLyric({ source: "none", lines: [], text: "" });
              }
            }
            // 自动跟唱：开歌即显示歌词（用户手动关过则尊重用户选择）
            if (!lyricUserToggledRef.current && lyricFollowRef.current === "auto") {
              setLyricOn(true);
              saveLyricPrefs({ show: true });
            }
          })
          .catch(function () {
            if (aborted) return;
            var bi2 = builtinLyricLines(displayPath || path);
            if (bi2) {
              lyricLinesRef.current = bi2;
              setLyric({ source: "lrc", lines: bi2, text: "" });
              updateLyricIndex((mediaRef.current && mediaRef.current.currentTime) || 0);
            } else {
              setLyric({ source: "none", lines: [], text: "" });
            }
            // 自动跟唱：开歌即显示歌词（用户手动关过则尊重用户选择）
            if (!lyricUserToggledRef.current && lyricFollowRef.current === "auto") {
              setLyricOn(true);
              saveLyricPrefs({ show: true });
            }
          });
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
      }, [curLyricIdx, lyricMode]);

      // 卸载时收干净：停 rAF、关 AudioContext
      react.useEffect(function () {
        return function () {
          stopLoop();
          var actx = actxRef.current;
          actxRef.current = null;
          analyserRef.current = null;
          // 🔴 音频路径的图归 store 所有（组件只"要图"），卸载时**绝不能清** ——
          //    清了条与面板就再不显示频谱；只有视频路径（组件自己建的图）才需要置空。
          if (isVideo) {
            try { SMP_STORE.setAnalyser(null); } catch (err0) {}
          }
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
      // 面板模式没有 props.playlist / props.path（播放由模块级 <audio> 承担），标题必须从
      // store 读，否则恒为「未在播放」——用户看到"音乐在放、界面说没在播"就是这个根因。
      var title = props.title
        || (isPanelBody && panelSnap && panelSnap.title ? panelSnap.title : "")
        || displayPath
        || "\u672a\u5728\u64ad\u653e";
      // 副标题里的扩展名：面板模式要从 store 的 path 取（QQ 曲没有扩展名 → 整段省略，
      // 避免出现「audio · · 0:00」这种两个间隔点连着的怪样子）。
      var subExt = extOf(isPanelBody ? ((panelSnap && panelSnap.path) || "") : (path || ""));

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

      var mediaEl = (isVideo && !videoAudioOnly)
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
        // ── S2：音频分支不再从 React 树渲染 <audio> ──────────────────────────
        // 元素改由 SMP_STORE.audioEl() 持有（模块级、挂 document.body），
        // 组件卸载不销毁它 → 侧边栏收起后播放不中断、条仍能控制。
        // 元素与 src 的接线见上方「S2：音频元素归模块级 store」两条 effect。
        : null;

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
            display: "flex",
            alignItems: "center",
            justifyContent: "center"
          }
        }, [h(Turntable, { key: "tt", playing: (isPanelBody && panelSnap && typeof panelSnap.playing === "boolean") ? panelSnap.playing : playing, coverUrl: "", size: 44 })]),
        h("div", {
          key: "txt",
          style: { minWidth: 0, display: "flex", flexDirection: "column", gap: "3px" }
        }, [
          h("div", {
            key: "t",
            title: displayPath,
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
          }, "audio" + (subExt ? " \u00b7 " + subExt : "") + " \u00b7 " + fmtTime(duration))
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
      // ── 歌词区（音频）：两种模式共用这一块区域 ────────────────────────────────
      //   duo  = 两句两句：当前句放大居中高亮，前后两句小号灰色，其余隐藏
      //   board= 歌词板：全词多行，当前句高亮并滚动跟随，副歌段放大加粗
      var hasLyricLines = lyric.source === "lrc" && lyric.lines.length > 0;
      // 🔴 修复歌词抖（2026-11-12 用户报「歌词抖」）：transform / font-size 的过渡
      //    会让换句时「位移 + 字号」缓慢补间，叠加当前句 inline transform 的缩放，
      //    整块高度反复重排 → 连续抖动。只保留不引起布局/位移抖动的属性过渡。
      var LYRIC_TRANS =
        "opacity .22s ease, color .22s ease, background-color .22s ease";

      // 手动开始播放：点歌词任意一句 → 跳到该句时间并从那里接着播。
      // 用户要求「本地曲识别到的歌词可以手动开始播放」：本地/在线都适用（只跳时间，不改速度）。
      function seekToLyricLine(idx) {
        var lines = lyric.lines;
        if (!lines || !lines.length || idx < 0 || idx >= lines.length) return;
        var t = lyricEffTime(lines, idx, lyricOffset, lyricAlign);
        try { hardSeek(t); } catch (eS) { return; }
        try {
          var eS2 = (isPanelBody && SMP_STORE.audioEl) ? SMP_STORE.audioEl() : mediaRef.current;
          if (eS2 && eS2.paused) {
            var pS = eS2.play();
            if (pS && typeof pS.catch === "function") pS.catch(function () {});
          }
        } catch (eP) {}
      }
      function lyricLineEnd(idx) {
        var lines = lyric.lines;
        if (idx + 1 < lines.length) return lyricEffTime(lines, idx + 1, lyricOffset, lyricAlign);
        return lyricEffTime(lines, idx, lyricOffset, lyricAlign) + 3.2;
      }
      function lyricProgress(idx) {
        if (idx < 0 || idx >= lyric.lines.length) return 0;
        var s = lyricEffTime(lyric.lines, idx, lyricOffset, lyricAlign);
        var e = lyricLineEnd(idx);
        if (!(e > s)) return 0;
        var p = (time - s) / (e - s);
        if (p < 0) p = 0;
        if (p > 1) p = 1;
        return p;
      }
      // 当前句：暗色底文 + 渐变扫光覆盖层（按播放进度揭示）＋行首读词光标
      function renderActiveLine(text, idx, fontSize) {
        var p = lyricProgress(idx);
        var cut = (100 - p * 100).toFixed(2) + "%";
        var dotTop = Math.round(fontSize * 0.72 - 3);
        return h("span", {
          key: "act",
          style: { display: "inline-block", maxWidth: "100%", verticalAlign: "top" }
        }, [
          h("span", {
            key: "dot",
            className: "dsw-lyric-cursor",
            style: {
              display: "inline-block",
              width: "6px",
              height: "6px",
              borderRadius: "50%",
              marginRight: "6px",
              marginTop: dotTop + "px",
              verticalAlign: "top",
              background: "linear-gradient(135deg, " + BRAND + ", #f0a94a)"
            }
          }),
          h("span", {
            key: "wrap",
            style: { position: "relative", display: "inline-block", maxWidth: "100%" }
          }, [
            h("span", {
              key: "b",
              style: {
                display: "inline-block",
                color: TEXT,
                opacity: 0.38,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word"
              }
            }, text),
            h("span", {
              key: "l",
              className: "dsw-lyric-sweep",
              style: {
                position: "absolute",
                left: "0",
                top: "0",
                width: "100%",
                backgroundImage: LYRIC_GRADIENT,
                WebkitBackgroundClip: "text",
                backgroundClip: "text",
                color: "transparent",
                WebkitTextFillColor: "transparent",
                clipPath: "inset(0 " + cut + " 0 0)",
                WebkitClipPath: "inset(0 " + cut + " 0 0)",
                transition: "clip-path .25s linear",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                pointerEvents: "none"
              }
            }, text)
          ])
        ]);
      }
      function chorusLine(line) {
        return !!(line && line.section === "Chorus");
      }

      var lyricBlock = null;
      // S 修正：主体歌词动效档位（面板设置页 lyricFx 优先，回落组件内偏好）
      var smpFx = smpPickLyricFx((panelSnap && panelSnap.lyricFx) || (smpPrefs && smpPrefs.lyricFx) || "slide");
      // S 修正：面板设置页的「歌词显示」也管主体歌词块（两套开关合并，任一关即关）
      if (shouldRenderLyricBlock(lyricOn && smpPrefs.lyricShow !== false, isVideo, lyric)) {
        if (hasLyricLines && lyricMode === "board") {
          // 歌词板：全词多行 + 当前句高亮 + 副歌放大加粗 + 淡底
          var boardStyle = {
            flex: "none",
            position: "relative",
            height: "150px",
            overflowY: "auto",
            overflowX: "hidden",
            padding: "6px 8px",
            borderRadius: "8px",
            // 歌词面板透明（第 3 项）：默认 true = 现状（SURFACE 淡底）；
            // 关掉这一项才是「不透明实底」，与对方语义相反故用 !== false 取默认真。
            background: SURFACE,  // panelTrans 已从 PREFS_DEF 移除（无独立歌词面板），恒用 SURFACE 默认外观
            border: "1px solid " + BORDER,
            scrollBehavior: "smooth"
          };
          lyricBlock = h("div", {
            key: "lyric",
            ref: lyricWrapRef,
            style: boardStyle
          }, lyric.lines.map(function (line, idx) {
            var active = idx === curLyricIdx;
            var chorus = chorusLine(line);
            // 修复歌词抖：全行统一字号（副歌仅靠字重+底色区分），消除换句时行高突变引起的整块跳动。
            var fs = "13.5px";
            return h("div", {
              // key 只在「当前句」与「非当前句」之间切换 → 该行变当前句时重挂载，
              // 让 .smp-lyric-fx-* 的 CSS 动画每次都从头重播（只换 class 不会重播）。
              // 其它行 key 稳定不变，不会整块重建、滚动位置不受影响。
              key: active ? ("cur-" + idx) : ("n-" + idx),
              ref: function (node) { lyricElsRef.current[idx] = node; },
              // S 修正：当前句挂动效档位 class（歌词板模式），复用既有 .smp-lyric-fx-* 四条 CSS
              className: active ? ("smp-lyric-fx-" + smpFx) : undefined,
              style: {
                fontSize: fs,
                lineHeight: "1.45",
                padding: chorus ? "4px 6px" : "2px 6px",
                borderRadius: "6px",
                textAlign: "center",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                color: active ? TEXT : (chorus ? TEXT : LABEL),
                fontWeight: active ? 700 : (chorus ? 700 : 400),
                opacity: active ? 1 : (chorus ? 0.5 : 0.42),
                backgroundColor: chorus
                  ? "color-mix(in srgb, " + BRAND + " 9%, transparent)"
                  : "transparent",
                // 修复歌词抖：不再对当前句叠加 translateY/scale 位移缩放（与过渡叠加会抖）。
                transform: "none",
                transformOrigin: "center",
                transition: LYRIC_TRANS
              },
              onClick: function () { seekToLyricLine(idx); },
              title: "\u4ece\u8fd9\u4e00\u53e5\u5f00\u59cb\u64ad\u653e"
            }, active
              ? renderActiveLine(line.text === "" ? "\u00a0" : line.text, idx, parseFloat(fs))
              : (line.text === "" ? "\u00a0" : line.text));
          }));
        } else if (hasLyricLines) {
          // 两句两句：只留 前一句 / 当前句 / 后一句
          var ci = curLyricIdx < 0 ? 0 : curLyricIdx;
          var lo = Math.max(0, ci - 1);
          var hi = Math.min(lyric.lines.length - 1, ci + 1);
          var rows = [];
          for (var ri = lo; ri <= hi; ri++) {
            var line2 = lyric.lines[ri];
            var isCur = ri === ci && curLyricIdx >= 0;
            var role = ri === ci ? "cur" : (ri < ci ? "prev" : "next");
            // 修复歌词抖：三行统一字号，当前句靠字重/颜色/透明度+扫光区分，行高恒定不跳动。
            var fs2 = "15px";
            rows.push(h("div", {
              // 同歌词板：只在 cur / 非 cur 之间切 key，当前句重挂载使动效每次重播
              key: role === "cur" ? ("cur-" + ri) : ("n-" + ri),
              // S 修正：当前句挂动效档位 class（两句模式）
              className: role === "cur" ? ("smp-lyric-fx-" + smpFx) : undefined,
              style: {
                fontSize: fs2,
                lineHeight: "1.35",
                padding: "1px 6px",
                borderRadius: "6px",
                textAlign: "center",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                color: role === "cur" ? TEXT : LABEL,
                fontWeight: role === "cur" ? 700 : 400,
                opacity: role === "cur" ? 1 : (role === "prev" ? 0.32 : 0.45),
                // 修复歌词抖：统一 transform:none，避免与过渡叠加造成位移抖动。
                transform: "none",
                transformOrigin: "center",
                transition: LYRIC_TRANS,
                cursor: "pointer"
              },
              onClick: function () { seekToLyricLine(ri); },
              title: "\u4ece\u8fd9\u4e00\u53e5\u5f00\u59cb\u64ad\u653e"
            }, isCur
              ? renderActiveLine(line2.text === "" ? "\u00a0" : line2.text, ri, parseFloat(fs2))
              : (line2.text === "" ? "\u00a0" : line2.text)));
          }
          lyricBlock = h("div", {
            key: "lyric",
            style: {
              flex: "none",
              position: "relative",
              height: "108px",
              overflow: "hidden",
              padding: "6px 8px",
              borderRadius: "8px",
              background: SURFACE,
              border: "1px solid " + BORDER,
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              gap: "2px"
            }
          }, rows);
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
          }, "无歌词");
        }
      }

      // 音频专用的整轨 scrubber（核心：拖动 = 直接写 currentTime）
      // ── 歌词工具条：上一句 / 下一句 / 偏移[-][+] / 对齐当前句 / 自动跟随 ────────
      var lyricPanel = null;
      if (lyricBlock) {
        var lyricTools = null;
        if (hasLyricLines) {
          var lyricToolStyle = {
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            height: "22px",
            minWidth: "22px",
            padding: "0 6px",
            borderRadius: "6px",
            border: "1px solid " + BORDER,
            background: "transparent",
            color: "#e8eaef",
            cursor: "pointer",
            fontSize: "11px",
            lineHeight: 1,
            fontFamily: "inherit",
            boxSizing: "border-box",
            flex: "none"
          };
          var offLabel = (lyricOffset >= 0 ? "+" : "") + lyricOffset.toFixed(1) + "s";
          lyricTools = h("div", {
            key: "ltools",
            style: {
              flex: "none",
              display: "flex",
              alignItems: "center",
              gap: "4px",
              padding: "0 2px"
            }
          }, [
            h("button", {
              key: "prev", type: "button", title: "上一句", "aria-label": "上一句",
              onClick: function () { navLyricLine(-1); },
              style: lyricToolStyle
            }, [h(IconLyricStep, { key: "i", dir: "up", size: 13 })]),
            h("button", {
              key: "next", type: "button", title: "下一句", "aria-label": "下一句",
              onClick: function () { navLyricLine(1); },
              style: lyricToolStyle
            }, [h(IconLyricStep, { key: "i", dir: "down", size: 13 })]),
            h("button", {
              key: "offm", type: "button", title: "歌词延后 0.2 秒", "aria-label": "歌词延后",
              onClick: function () { changeLyricOffset(lyricOffsetRef.current - 0.2); },
              style: lyricToolStyle
            }, "\u2212"),
            h("span", {
              key: "offv",
              title: "歌词时间偏移（正值 = 歌词提前出现）",
              style: {
                fontSize: "10.5px",
                color: LABEL,
                minWidth: "56px",
                textAlign: "center",
                fontVariantNumeric: "tabular-nums",
                whiteSpace: "nowrap"
              }
            }, "\u6b4c\u8bcd " + offLabel),
            h("button", {
              key: "offp", type: "button", title: "歌词提前 0.2 秒", "aria-label": "歌词提前",
              onClick: function () { changeLyricOffset(lyricOffsetRef.current + 0.2); },
              style: lyricToolStyle
            }, "+"),
            
            h("button", {
              key: "follow", type: "button",
              title: lyricFollow === "auto" ? "歌词跟随：自动（点击切换为手动）" : "歌词跟随：手动（点击切换为自动）",
              "aria-label": "切换歌词跟随模式",
              onClick: function () { changeLyricFollow(lyricFollow === "auto" ? "manual" : "auto"); },
              style: Object.assign({}, lyricToolStyle, {
                color: lyricFollow === "auto" ? BRAND : "#e8eaef"
              })
            }, [h(IconLyricFollow, { key: "i", mode: lyricFollow, size: 13 })])
          ]);
        }
        // 🔴 用户 2026-11-12 明确要求：歌词对齐/微调那一整条（↑ ↓ − 「歌词 x.xs」+ ⟳）全部删掉，
        //    只保留歌词本体（点某一句可直接从该句开始播）。lyricTools 的构造保留但不挂载，
        //    这样回滚只需把下面这行改回 lyricTools ? [lyricTools, lyricBlock] : [lyricBlock]。
        lyricPanel = h("div", {
          key: "lyricpanel",
          style: { flex: "none", display: "flex", flexDirection: "column", gap: "4px" }
        }, [lyricBlock]);
      } else {
        // 🔴 空态不许留白：没在播 / 没歌词时也要给一块「无歌词」占位，
        // 否则面板第一眼看上去就是「界面没了」。
        lyricPanel = h("div", {
          key: "lyricpanel-empty",
          "data-smp": "lyric-empty",
          style: {
            flex: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "64px",
            borderRadius: "10px",
            border: "1px dashed " + BORDER,
            background: "transparent",
            color: LABEL,
            fontSize: "13px"
          }
        }, "\u65e0\u6b4c\u8bcd");
      }

      // 总时长优先用「元数据时长」：面板播本地文件时 el.duration 常为 Infinity，
      // playableEnd 只能退到 buffered 末端（才缓冲几秒），于是进度条 max 很小，
      // 看起来就是「本地没有播放进度」。durMeta 由宿主 /duration 解析容器头得到。
      var _elForLen = (isPanelBody && SMP_STORE.audioEl) ? SMP_STORE.audioEl() : mediaRef.current;
      var playable = (isFinite(duration) && duration > 0) ? duration : playableEnd(_elForLen);
      var scrubber = h("input", {
        key: "scrub",
        type: "range",
        min: 0,
        max: playable > 0 ? playable : 1,
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
        onClick: function (ev) {
          // 🔴 手势内建图 + resume：AudioContext 需用户手势才能 running，否则频谱/音准恒 0。
          try {
            var anG = SMP_STORE.ensureGraph ? SMP_STORE.ensureGraph() : null;
            if (anG && anG.context && anG.context.state === "suspended") anG.context.resume();
          } catch (eBg) {}
          return togglePlay(ev);
        },
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
          onChange: function (event) {
            var v = Number(event.currentTarget.value);
            setVolume(v);
            // 面板模式真实播放器是模块级 store.audioEl（isPanelBody 时本组件不持有 el），
            // 只改本地 state 不写回元素 → 旧版「拖音量没反应」。面板模式直接写 store。
            if (isPanelBody) { try { SMP_STORE.setVolume(v); } catch (eVs) {} }
          },
          style: { width: "64px", margin: 0, accentColor: BRAND, cursor: "pointer" }
        })
      ]);

      // QQ 在线曲：代理流是版权试听/加密链接，变速会把音高和节奏一起拉坏 → 默认禁止变速；
      // 本地曲（含 lrc 识别）照常可选. 判定：store 快照里的曲目 path 为 qq: 前缀，
      // 或当前曲目就是本地列表里带 qqMid 的那首.
      var isQqTrack = !!(
        (panelSnap && panelSnap.path && /^qq:/.test(String(panelSnap.path))) ||
        (localItem && localItem.qqMid)
      );
      var rateSelect = h("select", {
        key: "rate",
        value: String(rate),
        title: isQqTrack ? "QQ 在线曲不支持变速" : "\u500d\u901f",
        "aria-label": "\u500d\u901f",
        disabled: isQqTrack,
        onChange: function (event) {
          if (isQqTrack) return;
          var v = Number(event.currentTarget.value);
          setRate(v);
          // 面板模式真实播放器是 store.audioEl，本地 setRate 不写回元素 → 旧版变速无效。手写回。
          if (isPanelBody) { try { var e0r = SMP_STORE.audioEl(); if (e0r) e0r.playbackRate = v; } catch (eVr) {} }
        },
        style: {
          height: "26px",
          borderRadius: "7px",
          border: "1px solid " + BORDER,
          background: "transparent",
          color: TEXT,
          fontSize: "12px",
          padding: "0 4px",
          cursor: isQqTrack ? "not-allowed" : "pointer",
          opacity: isQqTrack ? 0.45 : 1,
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

      // ── 文件夹入口（本环境无 Electron preload/dialog，webkitdirectory 是唯一可行路径）──
      // P0：三条通道 —— ① webkitdirectory input ② showDirectoryPicker（File System Access）
      //      ③ 「文件」按钮（纯 file input，不选目录）。任何一条能用即可播上。
      function openDirectoryFallback() {
        // 🔴 这是**末位遗留兜底、当前无调用点**（「文件夹」按钮走三级兜底，见 folderBtn.onClick）。
        //    window.showDirectoryPicker 在 Electron 里失败是**静默**的（不存在时直接 return，
        //    连报错都没有），所以绝不能放在主路上先试它 —— 试它只会让按钮看起来"点了没反应"。
        //    保留仅为历史兼容，且带日志，便于日后确认它到底有没有被走到。
        try { console.info("[smp] picker route=", "showDirectoryPicker(legacy)"); } catch (eL) {}
        // 必须在用户手势里**同步**调用（不能 await 之后再调，会丢手势）
        var picker = typeof window !== "undefined" ? window.showDirectoryPicker : null;
        if (typeof picker !== "function") return;
        var p;
        try { p = picker.call(window, { mode: "read" }); } catch (eA) { return; }
        if (!p || typeof p.then !== "function") return;
        p.then(function (dirHandle) {
          var collected = [];
          function walk(handle, prefix) {
            var it = handle.entries();
            function step() {
              return it.next().then(function (r) {
                if (r.done) return null;
                var nm = r.value[0];
                var hd = r.value[1];
                if (hd.kind === "directory") return walk(hd, prefix + nm + "/").then(step);
                return hd.getFile().then(function (f) {
                  try { Object.defineProperty(f, "webkitRelativePath", { value: prefix + nm, configurable: true }); } catch (eB) {}
                  collected.push(f);
                  return step();
                });
              });
            }
            return step();
          }
          return walk(dirHandle, dirHandle.name + "/").then(function () {
            if (collected.length) applyFileList(collected);
          });
        }).catch(function () {});
      }

      var folderClicked = { inputFired: false };
      var folderBtn = h("button", {
        key: "folder",
        type: "button",
        "data-smp": "folder-btn",
        title: "选择文件夹（本地直读）",
        onClick: function (ev) {
          // ── 「文件夹」按钮：先落诊断，再按**三级兜底**选路 ──────────────────
          // 真因可能有三个候选（点到宿主自己的文件树图标 / renderer 跑旧 bundle /
          // MediaViewer 没渲染），所以第一行先把可观测事实打出来，不猜。
          try {
            console.info(
              "[smp] folder clicked",
              !!dirInputRef.current,
              (ev && ev.currentTarget && ev.currentTarget.outerHTML || "").slice(0, 120),
              "webkitdirInputs=" + document.querySelectorAll("input[webkitdirectory]").length
            );
          } catch (e0) {}

          // 三级兜底（每级先判可用性；前一级抛错/不可用才下一级）：
          //   ① ctx.uiWorkspace.pickDirectory()          —— 宿主给的服务（若存在）
          //   ② window.__DSH_DIRECTORY_PICKER__.pick()   —— 宿主 preload contextBridge 的官方通道，
          //      主进程侧是 dialog.showOpenDialog({properties:["openDirectory","createDirectory"]})，
          //      返回**绝对路径**（这才是能拿到目录路径的那条路）。
          //   ③ 自绘目录浏览器（后端 /dir 列目录 + 前端点选）。
          // ⚠️ webkitdirectory 即使弹框成功，Electron 也不再暴露所选目录的路径
          //    （breaking change 原文："webkitdirectory no longer exposes the path"），所以它不能当主路。
          var chain = [];
          var ws = (props.ctx && props.ctx.uiWorkspace) || null;
          if (ws && typeof ws.pickDirectory === "function") {
            chain.push({ name: "uiWorkspace.pickDirectory", run: function () { return ws.pickDirectory(); } });
          }
          var dp = (typeof window !== "undefined" && window.__DSH_DIRECTORY_PICKER__) || null;
          if (dp && typeof dp.pick === "function") {
            chain.push({ name: "__DSH_DIRECTORY_PICKER__.pick", run: function () { return dp.pick(); } });
          }

          function done(dir) {
            // null / undefined / "" = 用户取消 —— 当正常结果处理，不报错、也不降级
            if (dir === null || dir === undefined || dir === "") {
              try { console.info("[smp] picker cancelled by user"); } catch (eC) {}
              return;
            }
            try { console.info("[smp] picker ->", dir); } catch (eP) {}
            setErr("");
            setNote("正在载入 " + dir + " …");
            smpPlayLibraryDir(dir, "", props.scope).then(function (res) {
              if (res && res.ok && res.count) { setNote(""); }
              else setNote((res && res.err) || "这个目录里没有可播放的文件");
            });
          }

          function step(i) {
            if (i >= chain.length) {
              try { console.info("[smp] picker route=", "drawer"); } catch (eR) {}
              setPickerOpen(true);
              return;
            }
            var it = chain[i];
            try { console.info("[smp] picker route=", it.name); } catch (eR2) {}
            var p;
            try { p = it.run(); } catch (e1) {
              try { console.warn("[smp] picker route threw, next:", it.name, errText(e1)); } catch (e2) {}
              step(i + 1);
              return;
            }
            if (!p || typeof p.then !== "function") { done(p); return; }
            p.then(function (dir) { done(dir); }).catch(function (e3) {
              try { console.warn("[smp] picker route rejected, next:", it.name, errText(e3)); } catch (e4) {}
              step(i + 1);
            });
          }
          step(0);
        },
        style: btnStyle
      }, [h("span", { key: "t", style: { fontSize: "11.5px" } }, "文件夹")]);

      var fileBtn = h("button", {
        key: "filebtn",
        type: "button",
        title: "选择文件（可多选，不用选目录）",
        onClick: function () {
          try { if (fileOnlyRef.current) fileOnlyRef.current.click(); } catch (e4) {}
        },
        style: btnStyle
      }, [h("span", { key: "t", style: { fontSize: "11.5px" } }, "文件")]);

      var nextBtn = playlist
        ? h("button", {
          key: "next",
          type: "button",
          title: "\u4e0b\u4e00\u9996",
          onClick: function () { playNext(); },
          style: btnStyle
        }, [h("span", { key: "t", style: { fontSize: "11.5px" } }, "\u4e0b\u4e00\u9996")])
        : null;

      // 歌词显示模式切换：两句两句 / 歌词板（图标按钮，形状随模式变化）
      var lyricModeBtn = null;
      if (!isVideo) {
        lyricModeBtn = h("button", {
          key: "lyric-mode",
          type: "button",
          title: lyricMode === "duo" ? "歌词显示：两句两句（点击切换为歌词板）" : "歌词显示：歌词板（点击切换为两句两句）",
          "aria-label": "切换歌词显示模式",
          onClick: function () { changeLyricMode(lyricMode === "duo" ? "board" : "duo"); },
          style: Object.assign({}, lyricMode === "board" ? btnOnStyle : btnStyle, {
            width: "26px",
            minWidth: "26px",
            padding: "0",
            color: lyricMode === "board" ? BRAND : TEXT
          })
        }, [h(IconLyricMode, {
          key: "i",
          mode: lyricMode,
          size: 16
        })]);
      }

      var controls = h("div", {
        key: "controls",
        style: {
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "8px",
          flex: "none"
        }
      }, [playBtn, volumeGroup, rateSelect, loopBtn, spectrumBtn, folderBtn, fileBtn, nextBtn, subtitleGroup, lyricBtn, lyricModeBtn, downloadLink]);

      // ── 音准 chip：刻度尺 + 滑块点 + 数值（颜色按偏差分三档）──────────────
      var pitchChip = null;
      if (note.hz > 0) {
        var cents = note.cents || 0;
        var absC = Math.abs(cents);
        var centsColor = absC <= 10 ? "#7ee0c0" : (absC <= 25 ? TEXT : "#f0a94a");
        var trackPos = Math.max(0, Math.min(1, (cents + 50) / 100));
        pitchChip = h("div", {
          key: "chip",
          style: {
            position: "relative",
            flex: "none",
            marginLeft: "auto",
            width: "132px",
            height: "18px",
            borderRadius: "9px",
            background: "linear-gradient(90deg, " +
              "color-mix(in srgb, #7ee0c0 16%, transparent) 0%, " +
              "color-mix(in srgb, " + SURFACE + " 70%, transparent) 50%, " +
              "color-mix(in srgb, #f0a94a 16%, transparent) 100%)",
            border: "1px solid " + BORDER,
            overflow: "hidden"
          }
        }, [
          h("div", {
            key: "ticks",
            style: {
              position: "absolute", inset: "0",
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "0 4px"
            }
          }, (function () {
            var out = [];
            for (var i = 0; i <= 10; i++) {
              var major = i === 5;
              out.push(h("span", {
                key: "k" + i,
                style: {
                  width: "1px",
                  height: major ? "9px" : "5px",
                  background: major ? "rgba(180,190,210,0.45)" : "rgba(180,190,210,0.22)",
                  flex: "none"
                }
              }));
            }
            return out;
          })()),
          h("div", {
            key: "mid",
            style: {
              position: "absolute", left: "50%", top: "3px", bottom: "3px",
              width: "1px", background: "rgba(255,255,255,0.28)"
            }
          }),
          h("div", {
            key: "knob",
            style: {
              position: "absolute",
              left: "calc(" + (trackPos * 100) + "% - 5px)",
              top: "50%",
              width: "10px", height: "10px",
              marginTop: "-5px",
              borderRadius: "50%",
              background: centsColor,
              boxShadow: "0 0 6px color-mix(in srgb, " + centsColor + " 65%, transparent)"
            }
          }),
          h("span", {
            key: "val",
            style: {
              position: "absolute",
              right: "6px", top: "50%",
              transform: "translateY(-50%)",
              fontSize: "10.5px",
              fontVariantNumeric: "tabular-nums",
              color: centsColor,
              background: "color-mix(in srgb, " + SURFACE + " 60%, transparent)",
              padding: "0 4px",
              borderRadius: "5px"
            }
          }, (cents >= 0 ? "+" : "") + cents + " \u00a2")
        ]);
      }

      // 频谱显示（第 4 项）：关掉后侧边栏也不画（条上同步不渲染 canvas），
      // 但音准 chip 不归这一项管 —— 它跟在频谱块里，随块一起隐藏是既有结构。
      var spectrumBlock = (analyse && smpPrefs.specShow !== false)
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
              height: "84px",
              display: "block",
              borderRadius: "10px",
              background: "linear-gradient(180deg, color-mix(in srgb, " + BRAND + " 10%, transparent) 0%, " +
                "color-mix(in srgb, " + SURFACE + " 55%, transparent) 100%)",
              border: "1px solid " + BORDER,
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.06)"
            }
          }),
          h("div", {
            key: "pitch",
            style: {
              display: "flex",
              alignItems: "center",
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
            note.hz > 0 ? pitchChip : null,
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

      // 本地 blob 播放没有真实路径 → 按路径取歌词/字幕/封面会失效，给一行提示
      var localHint = playlist
        ? h("div", {
          key: "lhint",
          style: {
            flex: "none",
            fontSize: "11.5px",
            color: LABEL,
            lineHeight: 1.5
          }
        }, "\u672c\u5730\u64ad\u653e\uff08blob \u76f4\u8bfb\uff09\uff1a\u5b57\u5e55 / \u6b4c\u8bcd / \u5c01\u9762\u6309\u8def\u5f84\u52a0\u8f7d\u5df2\u5931\u6548\uff1b" +
          "\u76f4\u63a5\u62d6\u97f3\u9891\u6587\u4ef6\u5230\u8fd9\u91cc\u4e5f\u53ef\u64ad\u3002")
        : null;

      // S 修正：面板设置页的「进度条」也管主体——关掉时 scrubber 与 timeRow 一起消失
      var smpProgressOn = (smpPrefs.progressShow !== false);
      // 播放失败（store 级 playError）：QQ 曲 VIP / 版权受限 → 中文；本地文件仍走下面 errBlock 的真实诊断
      var smpPlayErrEl = (panelSnap && panelSnap.playError)
        ? h("div", { key: "playerr", className: "smp-play-err", role: "alert" }, panelSnap.playError)
        : null;
      var children = isVideo
        ? [mediaEl, controls, localHint, smpPlayErrEl || errBlock, spectrumBlock]
        : [mediaEl, h("div", { key: "hero", style: { display: "flex", gap: 10, alignItems: "center", minWidth: 0 } }, [coverCard, lyricPanel]), smpProgressOn ? scrubber : null, smpProgressOn ? timeRow : null, controls, localHint, smpPlayErrEl || errBlock, spectrumBlock];

      // ── 拖放播放 ─────────────────────────────────────────────────────────
      // 坑：better-sidebar 的 Sidebar.tsx osFileDragShield 会对 Files 拖拽
      // preventDefault + stopPropagation（防 DSH composer 遮罩）→ 插件自己的
      // onDrop 必须**先** preventDefault + stopPropagation 抢占，否则被宿主吞掉。
      var onDragOver = function (e) {
        try { e.preventDefault(); e.stopPropagation(); } catch (err) {}
        try { if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"; } catch (err2) {}
        if (!dragRef.current) { dragRef.current = true; setDragOver(true); }
      };
      var onDragLeave = function (e) {
        try { e.preventDefault(); e.stopPropagation(); } catch (err) {}
        if (dragRef.current) { dragRef.current = false; setDragOver(false); }
      };
      var onDrop = function (e) {
        try { e.preventDefault(); e.stopPropagation(); } catch (err) {}
        dragRef.current = false;
        setDragOver(false);
        var dt = e.dataTransfer;
        if (!dt) return;
        var files = dt.files;
        if (files && files.length) {
          applyFileList(files);
          return;
        }
        if (dt.items && dt.items.length) {
          var entries = [];
          for (var i = 0; i < dt.items.length; i++) {
            var it = dt.items[i];
            if (it && it.kind === "file" && it.webkitGetAsEntry) {
              var en = it.webkitGetAsEntry();
              if (en) entries.push(en);
            }
          }
          if (entries.length) {
            Promise.all(entries.map(function (en) { return readEntryFiles(en); }))
              .then(function (arrs) {
                var flat = [];
                for (var j = 0; j < arrs.length; j++) flat = flat.concat(arrs[j]);
                applyFileList(flat);
              });
          }
        }
      };

      var dirInput = h("input", {
        key: "dirinput",
        ref: dirInputRef,
        type: "file",
        webkitdirectory: "",
        directory: "",
        multiple: true,
        onChange: function (e) {
          try { folderClicked.inputFired = true; } catch (eM) {}
          var inp = e.target;
          applyFileList(inp && inp.files);
          if (inp) { try { inp.value = ""; } catch (err) {} }
        },
        // P0：不要用 display:none —— Chromium 里隐藏的 file input 调 click() 有几率不弹框，
        // 移到屏幕外但保持渲染（经典兜底写法）。
        style: { position: "fixed", left: "-9999px", top: "0", width: "1px", height: "1px", opacity: 0, pointerEvents: "none" }
      });

      // P0：纯文件入口（不选目录）—— 目录选择在宿主里若不支持，这条一定可用
      var fileInput = h("input", {
        key: "fileinput",
        ref: fileOnlyRef,
        type: "file",
        multiple: true,
        accept: "audio/*,video/*",
        onChange: function (e) {
          var inp = e.target;
          applyFileList(inp && inp.files);
          if (inp) { try { inp.value = ""; } catch (err) {} }
        },
        style: { position: "fixed", left: "-9999px", top: "0", width: "1px", height: "1px", opacity: 0, pointerEvents: "none" }
      });

      return h("div", {
        className: "smp-player-body" + (isPanelBody ? " panel" : ""),
        "data-smp": isPanelBody ? "player-body-panel" : "player-body",
        onDragOver: onDragOver,
        onDragLeave: onDragLeave,
        onDrop: onDrop,
        // 🔴 高度策略两套，不能共用：
        //   · 预览模式（MediaViewer）：宿主给的是有确定高度的容器 → height:100% 撑满，overflow:auto 内部滚。
        //   · 面板模式（SmpPlayerPanel）：父级 .smp-pp-player 是 flex:0 0 auto（高度由内容定），
        //     若这里仍写 height:100%，就变成"相对一个由内容撑高的父级取百分比"，父级高度一旦拿不到（宿主页签
        //     容器不给定高），整块算成 0 高 → 内容全渲染但看不见 = 白屏。
        //     故面板模式改成 height:auto（由内容撑）+ overflow:visible（不裁弹层/自绘抽屉）。
        style: isPanelBody
          ? {
            display: "flex",
            flexDirection: "column",
            gap: "10px",
            padding: "12px",
            height: "auto",
            minWidth: 0,
            minHeight: 0,
            boxSizing: "border-box",
            overflow: "visible",
            outline: isDragOver ? "1px dashed " + BRAND : "none",
            borderRadius: isDragOver ? "10px" : "none"
          }
          : {
            display: "flex",
            flexDirection: "column",
            gap: "10px",
            padding: "12px",
            height: "100%",
            minWidth: 0,
            minHeight: 0,
            boxSizing: "border-box",
            overflow: "auto",
            outline: isDragOver ? "1px dashed " + BRAND : "none",
            borderRadius: isDragOver ? "10px" : "none"
          }
      }, [dirInput, fileInput].concat(pickerOpen ? [h(SmpDirPicker, {
        key: "dirpicker",
        onClose: function () { setPickerOpen(false); },
        onPickDir: function (d) { return smpPlayLibraryDir(d, ""); },
        onPickFile: function (d, nm) { return smpPlayLibraryDir(d, nm); }
      })] : []).concat(children));
    }

    // MediaViewer：文件预览入口（registerFileViewer）。
    // 用户 2026-11-12 定案：**预览与侧边栏面板必须是同一个界面**（同一个插件、同一份实现）。
    //   · 音频文件 → 直接渲染完整面板 SmpPlayerPanel（本地音乐 / QQ音乐 / 系统配置 三页），
    //     并把被打开的文件设成 store 的当前曲目 → 全站只有一个播放器、一份状态。
    //   · 视频文件 → 仍走原来的薄壳（SmpPlayerBody 的 video 分支；面板模式不渲染 <video>）。
    // 注意：SmpPlayerPanel 是模块作用域的函数声明，运行到这里时已定义（hoisted）。
    function MediaViewer(props) {
      var rawPath = (props && (props.path || (props.file && props.file.path))) || "";
      if (isVideoPath(rawPath)) return h(SmpPlayerBody, props);
      var scRef = react.useRef(null);
      if (!scRef.current) {
        scRef.current = {
          sessionId: (props && props.sessionId) || "smp",
          cwd: (props && props.cwd) || undefined
        };
      }
      react.useEffect(function () {
        if (!rawPath) return undefined;
        var nm = rawPath.replace(/^.*[\\/]/, "");
        try {
          SMP_STORE.setScope(scRef.current);
          // 只在「当前曲目不是它」时装载：否则每次渲染都会把播放位置重置回 0
          if (SMP_STORE.getState().path !== rawPath) {
            SMP_STORE.loadIndex([{ name: nm, path: rawPath }], true, 0);
          }
        } catch (eMV) { /* 装载失败不阻塞界面渲染 */ }
        return undefined;
      }, [rawPath]);
      return h("div", {
        key: "mv",
        className: "smp-mv-wrap",
        style: { height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }
      }, [h(SmpPlayerPanel, { key: "panel", scope: scRef.current })]);
    }

    /* =========================================================================
     * S2 · 模块级播放状态单例（store）
     * 为什么：<audio> 与 playlist 原本都关在 MediaViewer 组件里 —— 侧边栏一收起，
     *   组件销毁 → 输入框上/下的条既没有元素可控，也没有曲目可显示。
     * 设计（三条）：
     *   1) **元素归模块**：store 自己造 <audio>（display:none、append 到 body），
     *      不从 React 树渲染 → 组件卸载不会销毁它，播放不中断；
     *   2) **快照换新对象**：publish 换新引用，订阅方（React useSyncExternalStore /
     *      条上只读渲染）才能按引用比较认出变化；
     *   3) **控制面双模**：组件存活时走组件回填的 ctl（行为与改造前逐字一致），
     *      组件不在时走 store 兜底（直接操作模块级元素 + 自持 list/idx）。
     *      于是「侧边栏开着」与「侧边栏收起」两态都能控，且开着时零行为变化。
     * 注意：analyser / 频谱仍留在组件内（S3 迷你频谱需要时再模块化）。
     * ========================================================================= */
    var SMP_HAS = Object.prototype.hasOwnProperty;

    // S6 播放设置的默认值 —— **模块级**，因为 SmpMusicBar（store 之外）也要拿它兜底；
    // 放进 store IIFE 里会让条上拿到 undefined。默认值 = 改造前现状：
    // 装完不动设置，外观与之前逐字一致。
    var PREFS_DEF = {
      freeMinutes: 0,        // 本地累计的免费时长（分钟）—— 不伪造 QQ 服务端奖励
      freeAuto: true,        // 每满 30 分钟自动再跑一轮「看广告」并叠加 30 分钟
      freeAutoAt: 0,         // 上次自动跑「看广告」的时间戳（ms）—— 按真实时间循环，不依赖手动累计
      lyricShow: true,       // 1 歌词显示
      lyricFx: "slide",      // 2 歌词动效 none|slide|blur|karaoke
      // 3 歌词面板透明（panelTrans）已删除：它没有 UI 入口但真被消费，
      //   一旦存档写成 false 用户只能清 localStorage 才能恢复 —— 属"用户无法恢复的隐藏状态"。
      //   删键后 MediaViewer 里 `smpPrefs.panelTrans !== false` 恒为 true（undefined !== false），
      //   也就是永远停在默认外观。不补 UI 入口：我们没有独立歌词面板。
      specShow: true,        // 4 频谱显示
      specStyle: "bar",      // 5 频谱样式 bar|wave
      badgeShow: true,       // 6 音质徽章
      progressShow: true,    // 7 进度条
      barBgShow: true,       // 8 播放条背景
      immersion: 50          // 9 沉浸感 0-100（50 = 现状背景浓度）
    };

    var SMP_STORE = (function () {
      // 🔴 模块级单例必须挂全局：client bundle 若被 __ModuleLoader__ 二次求值（HMR/重复注册），
      //    会生成第二个 store + 第二套挂载，表现为页面上同时出现两条播放条
      //    （上一条有歌、下一条「未在播放」——两实例各读各的快照）。
      var __g = (typeof globalThis !== "undefined") ? globalThis : (typeof window !== "undefined" ? window : null);
      if (__g && __g.__DSH_SMP_STORE__) return __g.__DSH_SMP_STORE__;
      var el = null;
      var listeners = [];
      var ctl = null;          // 组件回填的控制面；null 表示组件不在树里
      // 播放条位置（S3a）：dock = 输入框上侧（默认，照抄对方默认行为）；bottom = 贴窗口底边。
      // 同一时刻只渲染一条（Lead m00314 ③ 裁决：改回照抄互斥）。持久化到 localStorage。
      var BAR_POS_KEY = "smp.barPos";
      // 条收起态（2026-11-11 用户报「找不到关闭按钮」）：常显 × → 收起成一行（只留音符+歌名），
      // 再点这一行任意处展开。面板里的那条不受影响（面板能直接关）。
      var BAR_HIDDEN_KEY = "smp.barHidden";
      function readBarHidden() {
        try { return window.localStorage.getItem(BAR_HIDDEN_KEY) === "1"; } catch (e0) { return false; }
      }
      function readBarPos() {
        try {
          var v = window.localStorage.getItem(BAR_POS_KEY);
          return (v === "bottom" || v === "dock") ? v : "dock";
        } catch (e0) { return "dock"; }
      }

      // ── S6：播放设置（聚合一个键 smp.prefs；不散成 9 个键，也不碰既有 6 键） ──
      // 默认值 = 改造前现状：装完不动设置，外观与之前逐字一致。
      // 键名要能被离线测试断言，故集中在此处定义、不散落到各处。
      var SMP_PREFS_KEY = "smp.prefs";
      // 默认值表在模块级（见 PREFS_DEF 定义处）——条上组件也要读它做兜底。
      var PREFS_FX = { none: 1, slide: 1, blur: 1, karaoke: 1, rainbow: 1 };
      var PREFS_STYLE = { bar: 1, wave: 1 };

      function copyPrefs() {
        var o = {};
        for (var k in PREFS_DEF) { if (SMP_HAS.call(PREFS_DEF, k)) o[k] = PREFS_DEF[k]; }
        return o;
      }
      // 读：逐键做类型/取值白名单校验 —— localStorage 是外部可写的，
      // 脏值（"yes"、999、null）一律回落到默认，绝不让坏数据把条画崩。
      function readPrefs() {
        var p = copyPrefs();
        try {
          var raw = window.localStorage.getItem(SMP_PREFS_KEY);
          if (!raw) return p;
          var o = JSON.parse(raw) || {};
          if (typeof o.lyricShow === "boolean") p.lyricShow = o.lyricShow;
          if (PREFS_FX[o.lyricFx]) p.lyricFx = o.lyricFx;
          // panelTrans 已从默认值表删除（会消费但无 UI 入口），这里不再回读；
          // 旧存档里的 false 会在下一次 writePrefs 时被丢掉，自动恢复默认外观。
          if (typeof o.specShow === "boolean") p.specShow = o.specShow;
          if (PREFS_STYLE[o.specStyle]) p.specStyle = o.specStyle;
          if (typeof o.badgeShow === "boolean") p.badgeShow = o.badgeShow;
          if (typeof o.progressShow === "boolean") p.progressShow = o.progressShow;
          if (typeof o.barBgShow === "boolean") p.barBgShow = o.barBgShow;
          if (typeof o.immersion === "number" && isFinite(o.immersion)) {
            p.immersion = Math.max(0, Math.min(100, Math.round(o.immersion)));
          }
        } catch (e1) {}
        return p;
      }
      function writePrefs(p) {
        try { window.localStorage.setItem(SMP_PREFS_KEY, JSON.stringify(p)); } catch (e2) {}
      }
      var prefs = readPrefs();

      var state = {
        mounted: false,        // 侧边栏播放器组件是否在树里
        barPos: readBarPos(),  // "dock" | "bottom"
        barHidden: readBarHidden(),
        // 播放失败的中文提示（空串 = 无错）。<audio> 的 error 事件里写入，
        // 播放条与面板主体都读它 —— 用户点 VIP 曲时后端取链 404，浏览器只会甩一句
        // 英文 "The element has no supported sources"，不许把英文摊给用户。
        playError: "",
        // ── 第⑤步 QQ 在线音乐：跨面板存活的状态 ──
        // 注意：qqQueue 是"当前播放队列"（几十首元数据），**不是**整张歌单／榜单／搜索结果
        // （417 首那类大数组留在 QQOnlinePanel 自己的 useState 里，绝不进快照）。
        qqLoggedIn: false,
        qqUin: "",
        qqNickname: "",
        qqAuthExpired: false,
        // 账号是否 VIP（三态）：null = 还没查过（放行，不当成"不是 VIP"误拦）；
        // true / false = 后端 GET /dsh-sidebar-media-player/qq/vip 的实测结果。
        qqIsVip: null,
        qqVipUin: "",
        qqFavRev: 0,
        qqLoginFrom: "",
        qqQueue: [],
        qqQueueFrom: null,
        qqQueueRev: 0,
        qqSource: "",
        // 浮层：提示 / 自绘输入框 / 自绘确认框（Electron 里 window.prompt 不可用）
        toast: null,
        prompt: null,
        confirm: null,
        isVideo: false,
        title: "",
        path: "",
        playing: false,
        time: 0,
        duration: 0,
        // 元数据时长兜底：QQ 代理流没有 Content-Length → <audio>.duration 恒 NaN/Infinity。
        // loadIndex 把 item.duration（歌单 interval）写这里，事件里真值取不到时回落到它，
        // 界面上才不会永远是「0:02 / 0:00」。
        durMeta: 0,
        volume: 1,
        muted: false,          // 静音态（真实音量在元素上，这里只供条上图标切换）
        favOn: false,          // 当前曲目是否已收藏（按 path/name 记，本地曲目没有 mid）
        rate: 1,
        loop: false,
        list: null,            // { items: [{ name, url, isVideo }], idx }
        listLen: 0,
        idx: 0,
        // S3b：条上内容用的两个轻量标量（L3 级，不进大数组快照）
        qualityLabel: "",      // 在线曲目：X-DSH-QQ-Quality 解码后的档位；本地留空走扩展名
        lyricLine: "",         // 条上单行歌词（本地同名 .lrc / 在线 /qq/lyric 行级）
        lyricFx: "slide",      // 歌词切换动效（none/slide/blur/karaoke）
        prefs: prefs,          // S6 播放设置（9 项，见 SMP_PREFS_KEY 上方）
        // ── 第 2a 步：为整段照抄 A-1 (`NowPlayingBar`) 补齐的字段 ──────────────
        // 对方的 412 行里直接读这些字段，本插件没有对应数据源 → 这里给空值，
        // 让 s.xxx 一行都不用改；将来接上数据源时只改 store 侧。
        currentId: "",         // 对方：qq:/kg:/nc:/book:/radio: 前缀的曲目 id
        currentArtists: "",    // 对方：歌手串
        isBook: false,         // 对方：是否讲书模式（本插件无）
        bookProgress: 0,       // 对方：讲书进度 0~1
        mirroring: false,      // 对方：多标签镜像导播态
        panelOpen: false,      // 对方：面板开关态
        modeMenuOpen: false,   // 对方：模式下拉是否展开
        tocOpen: false,        // 对方：章节目录是否展开
        barFloatPos: null,     // 对方：悬浮条记忆坐标
        radioCurrent: null,    // 对方：当前电台对象
        immerse: prefs.immersion,     // 名字适配：对方 s.immerse ↔ 我们 prefs.immersion
        showViz: prefs.specShow       // 名字适配：对方 s.showViz ↔ 我们 prefs.specShow
      };

      // ── 同页音频仲裁（2026-11-11）──────────────────────────────────
      // 页面里可能还挂着别的播放器的 <audio>（例如隔壁 dsh-music-player）。
      // 两个独立 bundle 物理上无法共享状态，只能靠 DOM 里现成的 <audio> 做旁路协调：
      //   ① 我起播 → 把其它正在播的 <audio> 全 pause 掉
      //   ② 别人在播（currentTime 两次采样在推进）→ 我让位 pause
      // 全部 try/catch，异常静默；也绝不因为「别人只是暂停着」就把自己关死。
      var __smpArbTimer = null;
      function smpSilenceOtherAudios(me) {
        // 只压「真在发声」的元素：A（隔壁播放器）还有一枚 preAudio 专做预加载/衔接，
        // 它可能处于 play() 但 currentTime 不推进的状态 —— 直接 pause 会毁掉它的切歌衔接。
        // 判据与 smpSomeoneElseIsPlaying 一致：120ms 内 currentTime 推进 >20ms 才算在播。
        try {
          var all = document.querySelectorAll("audio");
          for (var i = 0; i < all.length; i++) {
            var a = all[i];
            if (a === me || a.paused) continue;
            var t0 = a.currentTime || 0;
            try {
              setTimeout((function (el2, base) {
                return function () {
                  try {
                    var advanced = (el2.currentTime || 0) > base + 0.02;
                    if (!advanced) return;          // 纯预加载：不推进 → 不碰它
                    try { el2.pause(); } catch (e1) {}
                  } catch (e1) {}
                };
              })(a, t0), 120);
            } catch (e0) {}
          }
        } catch (e0) {}
      }
      function smpSomeoneElseIsPlaying(me) {
        try {
          var all = document.querySelectorAll("audio");
          for (var i = 0; i < all.length; i++) {
            var a = all[i];
            if (a === me || a.paused) continue;
            // 本插件自己的元素（data-smp=audio）绝不让位 —— 否则「切对话时新面板挂载出第二个
            // store 实例」就会互相当成「别的播放器」把自己 pause 掉（用户实测播放中断）。
            if (a.getAttribute && a.getAttribute("data-smp") === "audio") continue;
            var cur = a.currentTime || 0;
            var prev = a.__smpArbAt;
            a.__smpArbAt = cur;
            if (typeof prev === "number" && cur > prev) return true;
          }
        } catch (e0) {}
        return false;
      }
      function smpStartAudioArbitration(me) {
        if (__smpArbTimer !== null) return;
        __smpArbTimer = setInterval(function () {
          if (!me || me.paused) return;              // 自己没在播 → 什么都不做
          if (!smpSomeoneElseIsPlaying(me)) return;
          try { me.pause(); } catch (e0) {}
          try { console.info("[smp] 让位给其它播放器"); } catch (e0) {}
        }, 800);
      }

      function audioEl() {
        if (el !== null) return el;
        el = document.createElement("audio");
        el.preload = "auto";
        el.setAttribute("data-smp", "audio");
        try { el.style.display = "none"; } catch (e0) {}
        if (document.body) { try { document.body.appendChild(el); } catch (e1) {} }
        try { smpStartAudioArbitration(el); } catch (e2) {}
        // 频谱图在 store 层建（全局唯一）：面板/条/预览都从 getAnalyser() 取同一份，
        // 不再依赖"谁先建谁有"。建不成就静默降级（静止柱），绝不打扰用户。
        try { ensureGraph(); } catch (e2g) {}
        // 元数据/可播时各补试一次（不是轮询）：首发时元素往往还没有音轨。
        try {
          el.addEventListener("canplay", function () { try { ensureGraph(); } catch (e2c) {} });
          el.addEventListener("loadedmetadata", function () { try { ensureGraph(); } catch (e2m) {} });
        } catch (e2l) {}
        // S4：歌词滚动由元素 timeupdate/seeked 驱动（模块级，侧边栏关闭后依然工作）
        // S6：同时把播放态直连快照 —— 侧边栏关闭时组件不在树里，没有别的东西 publish，
        //     条上的时间/进度/播放态会一直停在旧值（用户看到「0:00 / 0:00」就是这个原因之一）。
        try {
          el.addEventListener("timeupdate", function () {
            var t = el.currentTime || 0;
            tickLyric(t);
            // duration 取真值；拿不到（代理流 NaN/Infinity）就回落元数据时长，别写死 0
            publish({ time: t, duration: smpRealDuration(el) });
          });
          el.addEventListener("seeked", function () {
            var t2 = el.currentTime || 0;
            tickLyric(t2);
            publish({ time: t2 });
          });
          el.addEventListener("durationchange", function () {
            publish({ duration: smpRealDuration(el) });
          });
          el.addEventListener("loadedmetadata", function () {
            publish({ duration: smpRealDuration(el) });
            // 自定义协议转发可能丢 Content-Length → renderer 里 el.duration = Infinity，
            // 表现就是「歌在播、总时长 0:00、进度条点不动、倍速没法对齐」（用户实测本地 + QQ 全中招）。
            // 探底一次：把 currentTime 设到极大值逼浏览器扫到文件尾拿真实 duration，
            // 再异步退回原位置。只做一次，绝不循环。
            if (!isFinite(el.duration) && !el.__smpDurProbe) {
              el.__smpDurProbe = true;
              var backTo = el.currentTime || 0;
              try { el.currentTime = 1e101; } catch (eD) {}
              setTimeout(function () { try { el.currentTime = backTo; } catch (eD2) {} }, 0);
            }
          });
          el.addEventListener("play", function () {
            publish({ playing: true });
            smpSilenceOtherAudios(el);   // 我起播 → 压掉页面里其它正在播的 <audio>
          });
          el.addEventListener("playing", function () { publish({ playing: true }); });
          el.addEventListener("pause", function () { publish({ playing: false }); });
          el.addEventListener("ended", function () { publish({ playing: false }); });
        // 播放失败：QQ 曲不许把英文甩给用户（后端取链 404 时浏览器只说
        // "The element has no supported sources"）。本地文件保留真实诊断信息，不掩盖。
        // **也不自动跳下一首** —— VIP 歌单常常整排 VIP，连着跳会连打一串 404，还可能触发风控。
        el.addEventListener("error", function () {
          var cur = "";
          try { cur = String(el.currentSrc || el.src || ""); } catch (e3) {}
          var isQQ = cur.indexOf("/dsh-sidebar-media-player/qq/play/") >= 0;
          publish({
            playing: false,
            // QQ 曲失败不再在这里报「该曲不可播放」——点歌前的 /qq/vip 预检已经给了
            // 准确中文（「该曲为 VIP 专享…」），两条叠着显示纯属噪音（用户明确嫌烦）。
            // 本地/直链失败才保留这条诊断：用户需要知道是格式问题还是文件损坏。
            playError: isQQ ? "" : "音频加载失败：格式不支持或文件不可读",
          });
        });
          el.addEventListener("volumechange", function () {
            publish({
              volume: el.volume,
              muted: el.volume === 0 || el.muted === true,
              rate: el.playbackRate, loop: el.loop
            });
          });
        } catch (e2) {}
        return el;
      }

      // <audio>.duration 的真值；拿不到（QQ 代理流没有 Content-Length → NaN/Infinity）时
      // 回落到 loadIndex 存下的元数据时长。三者都不行才 0（界面显示 --:--）。
      function smpRealDuration(el) {
        var d = el ? el.duration : NaN;
        if (typeof d === "number" && isFinite(d) && d > 0) return d;
        return (state && state.durMeta > 0) ? state.durMeta : 0;
      }

      function publish(patch) {
        var key, next = {}, changed = false;
        for (key in state) { if (SMP_HAS.call(state, key)) next[key] = state[key]; }
        if (patch) { for (key in patch) { if (SMP_HAS.call(patch, key)) next[key] = patch[key]; } }
        for (key in next) { if (next[key] !== state[key]) { changed = true; break; } }
        if (!changed) return state;
        state = next;                        // 换新对象：订阅方按引用比较
        var ls = listeners.slice();
        for (var i = 0; i < ls.length; i++) { try { ls[i](); } catch (e2) {} }
        return state;
      }

      function subscribe(fn) {
        listeners.push(fn);
        return function () { listeners = listeners.filter(function (x) { return x !== fn; }); };
      }

      function getState() { return state; }
      function setCtl(next) { ctl = next; }
      function hasCtl() { return ctl !== null; }

      // S3b：analyser 共享通道。侧边栏组件建好 Web Audio 图后把 analyser 交给 store，
      // 播放条用它画迷你频谱/音准（不另建 AudioContext，避免对同一元素重复取样）。
      var sharedAnalyser = null;
      function setAnalyser(an) { sharedAnalyser = an || null; }
      function getAnalyser() { return sharedAnalyser; }

      // ── 音频分析图（全局唯一，store 持有）──────────────────────────────
      // 面板是用户主界面，频谱不能寄生于"用户可能永远不点开的文件预览"：
      // 图在这里建一次，面板与输入框上/下那条都只来"要 analyser"，谁也不重复建。
      // 🔴 同一个元素重复 createMediaElementSource 必抛 InvalidStateError → graphEl 守卫。
      var graphCtx = null;     // 复用 AudioContext（每次 new 会泄漏）
      var graphEl = null;      // 已建图的元素
      var graphAn = null;      // 共享 analyser

      function ensureGraph() {
        var el = audioEl();
        if (!el) return null;
        if (graphAn && graphEl === el) return graphAn;        // 已建且同一元素 → 直接给
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) {
          try { console.warn("[smp] 此环境无 Web Audio，频谱/音准已静默关闭"); } catch (e0w) {}
          return null;
        }
        try {
          if (!graphCtx || graphCtx.state === "closed") graphCtx = new AC();
          var an = graphCtx.createAnalyser();
          an.fftSize = 2048;
          an.smoothingTimeConstant = 0.75;
          // 🔴 主路：媒体元素源 createMediaElementSource。SMP_STORE 的 <audio> 是全局单例，
          //    换歌只改 src、不换元素 → 同一元素只成功建一次源，之后 graphAn/graphEl 守卫直接复用。
          //    旧实现用 captureStream，在本机 Electron 上对 <audio> 取到的 MediaStream 恒无 audio track
          //    → 永远 return null → 面板永远 idle 平线（多轮"频谱不动"的根因）。
          var src2 = null;
          try { src2 = graphCtx.createMediaElementSource(el); } catch (eM) { src2 = null; }
          if (src2) {
            src2.connect(an);
            an.connect(graphCtx.destination);   // 声音经 an 透传到输出，不丢声
          } else {
            // 兜底：元素此前已被 createMediaElementSource 消费过 → 退回 captureStream（0 增益接地，不改路由）
            var stream = null;
            try {
              if (typeof el.captureStream === "function") stream = el.captureStream();
              else if (typeof el.mozCaptureStream === "function") stream = el.mozCaptureStream();
            } catch (e1s) { stream = null; }
            var tracks = null;
            try { tracks = (stream && typeof stream.getAudioTracks === "function") ? stream.getAudioTracks() : null; } catch (e2t) { tracks = null; }
            if (!stream || (tracks && tracks.length === 0)) {
              try { console.info("[smp] 频谱暂不建图：无可用音源"); } catch (e3i) {}
              return null;
            }
            graphCtx.createMediaStreamSource(stream).connect(an);
            var sink2 = graphCtx.createGain(); sink2.gain.value = 0; an.connect(sink2); sink2.connect(graphCtx.destination);
          }
          if (graphCtx.state === "suspended") { try { graphCtx.resume(); } catch (e4r) {} }
          graphAn = an;
          graphEl = el;
          sharedAnalyser = an;
          publish({ analyserRev: (state.analyserRev || 0) + 1 });
          return an;
        } catch (err) {
          // 装饰层失败一律静默（不上屏）：界面退回静止频谱
          try { console.warn("[smp] 频谱建图失败（静默降级，静止频谱顶上）", err && err.message ? err.message : err); } catch (e5w) {}
          return null;
        }
      }

      // ── S4：模块级歌词引擎 ──────────────────────────────────────────────
      // 侧边栏**关闭**时组件已卸载、updateLyricIndex 不再运行，但条上那行歌词
      // 仍必须随播放滚动 → 数据与"当前行"计算放 store，由 audio 元素 timeupdate 驱动。
      // 偏移(秒)/单句对齐({idx,delta})由侧边栏同步过来，所以「侧边栏改偏移 → 条上同步变」。
      // 计算复用模块级 lyricActiveIndex / lyricEffTime，语义与侧边栏完全一致。
      var lyricLines = null;                      // [{ t, text, section }]
      var lyricCfg = { offset: 0, align: null };  // offset=秒；align={idx,delta}|null
      var lyricCur = -2;
      var lyricFx = "slide";                      // 切换动效（none/slide/blur/karaoke）

      function setLyricLines(lines, silent) {
        lyricLines = (lines && lines.length) ? lines.slice() : null;
        lyricCur = -2;
        // silent=true：组件把自己的歌词同步给条（条要跟着滚），只换内容、不 bump rev，
        // 否则「快照 rev 变 → 组件回灌 → 组件再同步」会首尾相接变成死循环。
        if (silent === true) { publish({ lyricLine: "" }); return; }
        publish({
          lyricLine: "",
          lyricLines: lyricLines,
          lyricLinesRev: (typeof state.lyricLinesRev === "number" ? state.lyricLinesRev : 0) + 1
        });
      }
      function setLyricCfg(cfg) {
        if (!cfg) return;
        if (typeof cfg.offset === "number" && isFinite(cfg.offset)) lyricCfg.offset = cfg.offset;
        if (cfg.align === null || typeof cfg.align === "object") lyricCfg.align = cfg.align;
        if (typeof cfg.fx === "string") {
          var fx = cfg.fx;
          if (fx !== "none" && fx !== "slide" && fx !== "blur" && fx !== "karaoke" && fx !== "rainbow") fx = "slide";
          lyricFx = fx;
          publish({ lyricFx: fx });
        }
        var e2 = el;
        tickLyric(e2 ? (e2.currentTime || 0) : state.time);   // 配置一变立刻重算，不等下一个 timeupdate
      }
      function getLyricFx() { return lyricFx; }

      // 设置项写入：白名单校验 → 造新对象（引用变化才能被订阅方认到）→ 落盘 → publish。
      // 与 lyricFx 联动：改「歌词动效」时同步模块级 lyricFx，条与侧边栏都跟着变。
      function setPref(key, val) {
        if (!SMP_HAS.call(PREFS_DEF, key)) return state;
        var next = copyPrefs();
        for (var k in prefs) { if (SMP_HAS.call(prefs, k)) next[k] = prefs[k]; }
        if (key === "lyricFx") {
          if (!PREFS_FX[val]) return state;
          next.lyricFx = val;
          lyricFx = val;
        } else if (key === "specStyle") {
          if (!PREFS_STYLE[val]) return state;
          next.specStyle = val;
        } else if (key === "immersion") {
          var n = Math.round(Number(val));
          if (!isFinite(n)) return state;
          next.immersion = Math.max(0, Math.min(100, n));
        } else if (typeof val !== "boolean") {
          return state;
        } else {
          next[key] = val;
        }
        prefs = next;
        writePrefs(next);
        return publish({ prefs: next });
      }
      function getPrefs() { return prefs; }
      function resetPrefs() {
        prefs = copyPrefs();
        writePrefs(prefs);
        lyricFx = prefs.lyricFx;
        return publish({ prefs: prefs });
      }
      function tickLyric(t) {
        if (!lyricLines || lyricLines.length === 0) {
          if (lyricCur !== -1) { lyricCur = -1; publish({ lyricLine: "", lyricIdx: -1 }); }
          return;
        }
        var idx = lyricActiveIndex(lyricLines, Number(t) || 0, lyricCfg.offset, lyricCfg.align);
        if (idx === lyricCur) return;
        lyricCur = idx;
        var txt = (idx >= 0 && lyricLines[idx]) ? String(lyricLines[idx].text || "") : "";
        // 面板模式不跑 updateLyricIndex（它不绑 audio），只能靠这份快照推进高亮行：
        // 旧实现只 publish 文本不带索引 → 面板 curLyricIdx 恒 -1 → 歌词看着「不动」。
        publish({ lyricLine: txt, lyricIdx: idx });
      }

      function itemAt(idx) {
        var l = state.list;
        if (!l || !l.items || !l.items.length) return null;
        if (!(idx >= 0) || idx >= l.items.length) return null;
        return l.items[idx];
      }

      // 兜底换源：只在组件不在树里时会被调到（组件在时行为全走 ctl）。
      // ── S5 前置：本地音乐页的播放接线 ────────────────────────────────
      // 页面给的是**绝对路径**（后端 /library 返回），不是 File 对象。
      // 统一走 /media（同源、带 sessionId 围栏）取 blob 再交给元素，
      // 保持既有 blob 播放链路不变 —— 绝不把 path 直接塞 <audio src>。
      var mediaScope = null;
      function setScope(sc) { mediaScope = sc || null; }

      function ensureItemUrl(item, cb) {
        if (!item) { cb(""); return; }
        if (item.url) { cb(item.url); return; }
        if (!item.path || !mediaScope) { cb(""); return; }
        fetch(mediaUrl(mediaScope, item.path), { cache: "no-store" })
          .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.blob(); })
          .then(function (b) {
            try { item.url = URL.createObjectURL(b); } catch (e0) { item.url = ""; }
            cb(item.url || "");
          })
          .catch(function () { cb(""); });
      }

      // ── 面板 / 在线播放的歌词加载（MediaViewer 不在树里时才生效） ──────────
      // 背景：歌词加载原本只写在 MediaViewer 的 effect 里（依赖 src）。而面板播放走
      // setList → loadIndex，组件根本不在树里 → 那条 effect 不执行 → 永远「无歌词」，
      // 修之前更糟：store 里残留着上一次预览留下的句子（真机截图复现过）。
      // 这里补一个 store 侧加载器：组件在树里（ctl !== null）一律让组件加载并回灌 store，
      // 避免同一首歌被拉两次；组件不在时才由这里自己拉。
      var lyricReqPath = "";
      function loadLyricFor(path2, scope2, isVideo2) {
        var want = String(path2 || "");
        // 守卫锚：异步回来时比对，防止「上一首的晚到结果」覆盖当前曲。
        lyricReqPath = want;
        setLyricLines([]);                 // 先无条件清空，宁可闪一下「无歌词」
        if (isVideo2) return;
        if (ctl !== null) return;          // 组件在 → 组件负责，它加载完会灌 store
        if (!want || !scope2) return;
        var mine = want;
        fetch(lyricUrl(scope2, want), { cache: "no-store" })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (data) {
            if (lyricReqPath !== mine) return;   // 已经切歌，丢掉这份结果
            if (!data) { setLyricLines([]); return; }
            if (data.ok === true && data.source === "lrc" && Array.isArray(data.lines) && data.lines.length > 0) {
              setLyricLines(data.lines);
              var e2 = audioEl();
              tickLyric((e2 && e2.currentTime) || 0);
              return;
            }
            if (data.ok === true && data.source === "plain") { setLyricLines([]); return; }
            // 没有同名 .lrc → 内置歌词（按文件名关键字）；都没有就留空 =「无歌词」。
            // 只按严格同名找，不做去后缀/模糊变体：猜错一句歌比没有更糟。
            var bi = builtinLyricLines(want);
            if (bi && bi.length) {
              setLyricLines(bi);
              var e3 = audioEl();
              tickLyric((e3 && e3.currentTime) || 0);
              return;
            }
            setLyricLines([]);
          })
          .catch(function () { if (lyricReqPath === mine) setLyricLines([]); });
      }

      // QQ 在线曲：歌词不在本地，走宿主 /qq/lyric（QQ 官方接口代理）。
      // 修前 loadIndex 只调 loadLyricFor(path)，QQ 曲 path=qq:<mid> → /lyric 404 → 永远「无歌词」。
      function loadQQLLyric(mid) {
        var mine = "qq:" + String(mid || "");
        lyricReqPath = mine;
        setLyricLines([]);
        if (!mid) return;
        fetch("/dsh-sidebar-media-player/qq/lyric?songmid=" + encodeURIComponent(mid), { cache: "no-store" })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) {
            if (lyricReqPath !== mine) return;
            if (!d || d.ok !== true) { setLyricLines([]); return; }
            var ls = (Array.isArray(d.lines) && d.lines.length) ? d.lines
              : (Array.isArray(d.wordLines) ? d.wordLines : []);
            setLyricLines(ls || []);
            var e2 = audioEl();
            tickLyric((e2 && e2.currentTime) || 0);
          })
          .catch(function () { if (lyricReqPath === mine) setLyricLines([]); });
      }

      function loadIndex(idx, autoplay) {
        var item = itemAt(idx);
        if (item === null) return false;
        // 切歌立刻无条件清空歌词，再由 loadLyricFor 决定要不要重新加载：
        // setLyricLines 全文件只有 MediaViewer 的 updateLyricIndex 会调，
        // 面板 / 在线入口都不经过它 → 不清就会把上一首的句子留在这一条上。
        if (item.qqMid) loadQQLLyric(item.qqMid);
        else loadLyricFor(item.path || item.name, mediaScope, !!item.isVideo);
        var e = audioEl();
        var applySrc = function (url) {
          if (!url) return;
          try { e.src = url; } catch (e0) { return; }
          // 换歌后把当前倍速补回去：<audio> 换 src 会重置 playbackRate，
          // 不补的话「设过 1.5x、点下一首又变回 1x」，界面还显示 1.5x（用户实测）。
          if (state.rate && Number(state.rate) > 0 && Number(state.rate) !== 1) {
            try { e.playbackRate = Number(state.rate); } catch (eR) {}
          }
          if (autoplay !== false) {
            try {
              var p = e.play();
              if (p && typeof p.catch === "function") p.catch(function () {});
            } catch (e1) {}
          }
        };
        publish({
          // path 必须带完整路径：列表行按 path 比高亮、ensureItemUrl 也按它取流。
          // （早先写成 item.name，导致 store.path 只有文件名 → 列表行永远高亮不上。）
          idx: idx, title: item.name, path: item.path || item.name,
          isVideo: !!item.isVideo, time: 0, duration: 0,
          // 元数据时长（QQ 歌单 interval）。代理流拿不到 .duration 时靠它显示总时长。
          durMeta: (isFinite(item.duration) && item.duration > 0) ? item.duration : 0,
          // 换歌即清掉上一首的失败提示（否则点「下一首」成功也还挂着红字）
          playError: ""
        });
        // 本地文件的真实总时长：自定义协议/代理流下 <audio>.duration 常为 Infinity 或 0，
        // 本地文件又没有元数据 → 界面恒 0:00。改用宿主 /duration 读容器头算一次（mp3/flac）。
        (function (it) {
          try {
            if (!it.path || it.qqMid || it.url) return;
            var sc0 = mediaScope || { sessionId: "smp" };
            var du = "/dsh-sidebar-media-player/duration?sessionId=" + encodeURIComponent(sc0.sessionId || "smp") + "&path=" + encodeURIComponent(it.path);
            if (sc0.cwd) du += "&cwd=" + encodeURIComponent(sc0.cwd);
            var pr = fetch(du, { credentials: "same-origin" });
            if (!pr || typeof pr.then !== "function") return;
            pr.then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
              if (!j || !j.ok || !(j.duration > 0)) return;
              // 连点下一首时旧响应可能后到：只在仍是这首歌时写回
              if (state && state.path === (it.path || it.name)) publish({ durMeta: j.duration });
            })["catch"](function () {});
          } catch (eDur) {}
        })(item);
        if (item.url) { applySrc(item.url); return true; }
        if (item.path && mediaScope) { ensureItemUrl(item, applySrc); }
        return true;
      }

      function setList(items, autoplay, startIdx) {
        var arr = (items || []).slice();
        if (!arr.length) return false;
        var old = state.list;
        if (old && old.items) {
          for (var i = 0; i < old.items.length; i++) {
            try { if (/^blob:/.test(old.items[i].url)) URL.revokeObjectURL(old.items[i].url); } catch (e2) {}
          }
        }
        var i0 = (typeof startIdx === "number" && startIdx >= 0 && startIdx < arr.length) ? startIdx : 0;
        publish({ list: { items: arr, idx: i0 }, listLen: arr.length, idx: i0 });
        if (autoplay !== false) loadIndex(i0, true);
        return true;
      }

      function toggle() {
        if (ctl !== null) return ctl.toggle();
        var e = audioEl();
        if (!e.src) return undefined;
        if (e.paused) {
          var p = e.play();
          if (p && typeof p.catch === "function") p.catch(function () {});
        } else {
          e.pause();
        }
        return undefined;
      }

      function seek(t) {
        if (ctl !== null) return ctl.seek(t);
        var e = audioEl();
        if (!e.src) return undefined;
        var d = e.duration;
        if (!(d > 0)) return undefined;
        var target = Math.max(0, Math.min(Number(t) || 0, d - 0.05));
        e.currentTime = target;
        publish({ time: target });
        return undefined;
      }

      // 停止（对方 :5607 StopIcon → stop）：暂停 + 回到 0，并立刻把播放态推给快照。
      function stop() {
        if (ctl !== null && typeof ctl.stop === "function") return ctl.stop();
        var e = audioEl();
        try { e.pause(); } catch (e0) {}
        try { e.currentTime = 0; } catch (e1) {}
        publish({ playing: false, time: 0 });
        return undefined;
      }

      // 音量按钮：静音切换（0 ↔ 上次音量）。真实音量在元素上，元素 volumechange 会把状态同步回来。
      var lastVolume = 1;
      function toggleMute() {
        var e = audioEl();
        var v = typeof e.volume === "number" ? e.volume : 1;
        if (v > 0) { lastVolume = v; e.volume = 0; }
        else { e.volume = lastVolume > 0 ? lastVolume : 1; }
        publish({ volume: e.volume, muted: !(e.volume > 0) });
        return undefined;
      }

      // 拖动/点击调音量（0~1）。条上的滑块直接调这个，不另走组件。
      function setVolume(v) {
        var e = audioEl();
        var nv = Number(v);
        if (!isFinite(nv)) return undefined;
        nv = Math.max(0, Math.min(1, nv));
        try { e.volume = nv; } catch (e0) {}
        publish({ volume: nv, muted: !(nv > 0) });
        return undefined;
      }

      // 收藏：本地曲目没有 mid，按 path（回退 name）记，存 localStorage。
      var FAV_KEY = "smp.favs";
      var favList = (function () {
        try {
          var s = window.localStorage.getItem(FAV_KEY);
          var a = s ? JSON.parse(s) : [];
          return Array.isArray(a) ? a : [];
        } catch (e0) { return []; }
      })();
      function favKeyOf(st) {
        return (st && (st.path || st.title)) || "";
      }
      function isFaved(key) { return key ? favList.indexOf(key) >= 0 : false; }
      function toggleFav() {
        var key = favKeyOf(state);
        if (!key) return undefined;
        var i = favList.indexOf(key);
        if (i >= 0) favList.splice(i, 1); else favList.push(key);
        try { window.localStorage.setItem(FAV_KEY, JSON.stringify(favList)); } catch (e0) {}
        publish({ favOn: isFaved(key) });
        return undefined;
      }

      // 队列/播放列表按钮：组件在树里时交给组件（它持有播放列表 UI），不在时无操作。
      function openQueue() {
        if (ctl !== null && typeof ctl.openQueue === "function") return ctl.openQueue();
        // 组件不在树里也必须有反应：直接切快照里的 panelOpen，由条自己渲染队列面板。
        return publish({ panelOpen: !state.panelOpen });
      }

      function closeQueue() {
        return state.panelOpen ? publish({ panelOpen: false }) : state;
      }

      function step(delta) {
        if (ctl !== null) {
          // 组件只回填了 toggle/seek/next（我们这边没有「上一首」按钮），
          // 缺哪个回调就落到下面的兜底切歌，绝不调用 undefined。
          var fn = delta > 0 ? ctl.next : ctl.prev;
          if (typeof fn === "function") return fn();
        }
        var l = state.list;
        if (!l || !l.items || l.items.length < 2) return undefined;
        // 🔴 以 state.idx 为准：组件 publish 的 list.idx 只是镜像，兜底切歌后不会回写，
        //    只看 l.idx 会让「下一首 → 上一首」跳错位置（离线测试实测踩到）。
        var cur = (typeof state.idx === "number" && state.idx >= 0 && state.idx < l.items.length)
          ? state.idx
          : (l.idx || 0);
        var idx = (cur + delta + l.items.length) % l.items.length;
        state = (function () {
          var k, n = {};
          for (k in state) { if (SMP_HAS.call(state, k)) n[k] = state[k]; }
          n.idx = idx;
          return n;
        })();
        loadIndex(idx, true);
        return undefined;
      }

      function setBarPos(pos) {
        var p = (pos === "bottom") ? "bottom" : "dock";
        if (state.barPos === p) return state;
        try { window.localStorage.setItem(BAR_POS_KEY, p); } catch (e0) {}
        return publish({ barPos: p });
      }

      // 收起 / 展开播放条（常显按钮调它）。写 localStorage + publish 让所有注册点同步。
      function setBarHidden(v) {
        var h = !!v;
        if (state.barHidden === h) return state;
        try { window.localStorage.setItem(BAR_HIDDEN_KEY, h ? "1" : "0"); } catch (e0) {}
        return publish({ barHidden: h });
      }

      // 第⑤步 QQ 面板用到的三类浮层状态（showToast / openPrompt / openConfirm 写入，面板渲染）
      function setToast(v) { return publish({ toast: v }); }
      function setPrompt(v) { return publish({ prompt: v }); }
      function setConfirm(v) { return publish({ confirm: v }); }

      var __api = {
        barPosKey: BAR_POS_KEY, setBarPos: setBarPos,
        barHiddenKey: BAR_HIDDEN_KEY, setBarHidden: setBarHidden,
        setToast: setToast, setPrompt: setPrompt, setConfirm: setConfirm,
        audioEl: audioEl, publish: publish, subscribe: subscribe, getState: getState,
        setCtl: setCtl, hasCtl: hasCtl, itemAt: itemAt, loadIndex: loadIndex,
        setList: setList, setScope: setScope,
        setAnalyser: setAnalyser, getAnalyser: getAnalyser, ensureGraph: ensureGraph,
        setLyricLines: setLyricLines, setLyricCfg: setLyricCfg, tickLyric: tickLyric, getLyricFx: getLyricFx,
        prefsKey: SMP_PREFS_KEY, defaultPrefs: PREFS_DEF, setPref: setPref, getPrefs: getPrefs, resetPrefs: resetPrefs,
        toggle: toggle, seek: seek, stop: stop, toggleMute: toggleMute, openQueue: openQueue, closeQueue: closeQueue,
        next: function () { return step(1); },
        prev: function () { return step(-1); }
      };
      if (__g) __g.__DSH_SMP_STORE__ = __api;
      return __api;
    })();

    // 订阅 SMP_STORE 的 React hook：React 18+ 走 useSyncExternalStore（按引用比较，publish 换对象）；
    // 老版本降级 useState + subscribe（同一份快照，行为一致）。
    function useSmpStore() {
      if (typeof react.useSyncExternalStore === "function") {
        return react.useSyncExternalStore(SMP_STORE.subscribe, SMP_STORE.getState, SMP_STORE.getState);
      }
      var st = react.useState(SMP_STORE.getState());
      react.useEffect(function () {
        return SMP_STORE.subscribe(function () { st[1](SMP_STORE.getState()); });
      }, []);
      return st[0];
    }

    /* =========================================================================
     * S1.5 · 输入框上侧 / 窗口底部 播放条落位（外壳逐字照抄 dsh-music-player v1.0.4）
     *   上侧  conversation.input.dock  order 40  ← 对方 :11348-11351
     *   下侧  shell.overlay            order 19  ← 对方 :11352-11355（bottom 贴底模式）
     * 依据：基线 `D:\YuE2\_基线-对方上下条定位-只读.md`（只读抽取，逐字带行号）。
     *
     * 🔴 对方**没有** conversation.composer.dock 这个挂载点（全文件 grep 零命中）。
     *    它的「下侧」= 挂在 shell.overlay 上的贴窗口底边固定条：用 useColumnMetrics
     *    量会话列宽给内联 left/width（对方 :5208-5248 / :5541-5542），bottom:0 由 CSS
     *    负责，再用 ':root[data-dsh-music-bar-bottom] [data-composer-seat]
     *    { padding-bottom: 44px; }' 给输入区让位（对方 :11413，常量 44 于 :546）。
     *    这样做还有三个好处（对方原注释 :11344-11347）：询问弹窗不再连条一起藏掉、
     *    会话列卸载时条依然在、条不被对话滚动或列裁剪影响。
     *
     * 🔴 照抄范围与唯一偏离：
     *    - 槽名 / order / 注册形态 / 两层容器结构 / 每一个 CSS 声明值 —— 逐字照抄；
     *    - 唯一偏离 = 标识符加 `smp-` 前缀（`.dsh-music-bar*` → `.dsh-music-bar*`）。
     *      原因：宿主里对方插件仍在装，同 id 会让 register 撞名、同类名会让两边 CSS
     *      互相命中；换前缀后声明值零改动，视觉一致且互不污染。
     *    - 皮肤反制保留 id 选择器写法，但 id 与类双写（我们自己两个实例同 id）。
     * 硬约束：
     *   - 定位一律用 data-slot 属性，**不许**用 CSS-Modules 类名（那是 hash，会变）；
     *   - 第三方皮肤会用
     *     'html[data-dsh-skin] [data-phase="active"] [data-slot="conversation.input.dock"] > *'
     *     强行接管该槽子元素 → 外层容器用 id + !important 压回干净（对方 :11391-11393）；
     *   - 间距零干预：dock 模式对方**不写** margin-top/bottom、也不碰
     *     --dsh-composer-stack-gap（宿主自己给 6px），水平居中只靠 margin: 0 auto；
     *   - 原生 <audio controls> 最小高度下不去，S3 起播放控件一律自绘。
     * ========================================================================= */
    /* 本段（播放条外壳的结构与样式数值）逐字照抄自 dsh-music-player v1.0.4
       Copyright (c) kendu76 — MIT License
       https://github.com/kendu76/dsh-music-player
       上游许可要求保留本版权与许可声明；本项目在其上的修改（smp- 前缀、状态提升、
       音频改 captureStream、频谱/音准/歌词块替换）同样以 MIT 发布。 */
    // 页面底部模式给输入区底座补的下内边距（对方 :543-546 原值：≈ 条高 36px + 8px 间隙）。
    var SMP_BAR_BOTTOM_PAD = 44;

    /* A-5 里用到的三个位置常量（对方原文同名同值，见源 L538 / L542 / L546） */
    var BAR_FLOAT_W = 420;
    var BAR_FLOAT_EDGE = 16;
    var BAR_BOTTOM_PAD = 44;

    /* ═══════════════════════════════════════════════════════════════════
       第 3 批 A-5：`PLAYER_CSS` 全文（670 行）逐字照抄
       来源：dsh-music-player v1.0.4 `lib/client.js` L11381–L12050
       Copyright (c) kendu76 — MIT License
       https://github.com/kendu76/dsh-music-player
       只做了一处形式改动：`const PLAYER_CSS` → `var SMP_REF_CSS`（本文件是
       var 风格、且不导出）。CSS 内容一字未改，book/radio/float/panel/news/tts
       等本插件尚未实现的模式样式全部保留原文（代码分支也在，只是入口被
       SMP_FEATURES 挡住）。
       ═══════════════════════════════════════════════════════════════════ */
    var SMP_REF_CSS = '\n' +
      // Accent follows the host app's theme brand color (stable from the start —
      // no green-default-to-sampled-blue flash); green is only the fallback when
      // the app exposes no brand color. The alias must be declared on BODY, not
      // :root: DSH defines its --dsw-alias-* theme tokens on <body> only, and a
      // var() reference resolves against the element that declares it — on
      // :root (html) it cannot see body's tokens and would always fall back to
      // green. Declared on body, the reference resolves and children inherit
      // the theme's actual brand color.
      'body { --dsh-music-accent: var(--dsw-alias-brand-primary, #2f9e6e); --dsh-music-accent-fg: var(--dsw-alias-label-primary-foreground, #fff); }\n' +
      // 由于安装了第三方皮肤，该控件会被 'html[data-dsh-skin] [data-phase="active"]
      // [data-slot="conversation.input.dock"] > * { }' 强行接管，可能会出现背景颜色
      '#smp-music-bar-wrap { background-color: transparent !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; }\n' +
      '.dsh-music-bar-wrap { box-sizing: border-box; width: 100%; padding: 0 var(--dsh-composer-side-clearance, 16px); }\n' +
        // 常显收起按钮（2026-11-11）：不参与 hover 才滑出的控件组，永远可见
        '.dsh-music-bar-hide { flex: 0 0 auto; width: 18px; height: 18px; padding: 0; margin-left: 2px; border: 0; background: transparent; color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 13px; line-height: 18px; cursor: pointer; opacity: 1; }\n' +
        '.dsh-music-bar-hide:hover { color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
        // 收起态：只留「音符 + 歌名」，其余全隐（频谱/歌词/控件/进度/时间/徽章）
        '.dsh-music-bar-wrap.collapsed .dsh-music-bar-lyric, .dsh-music-bar-wrap.collapsed .dsh-music-bar-viz, .dsh-music-bar-wrap.collapsed .dsh-music-bar-controls, .dsh-music-bar-wrap.collapsed .dsh-music-bar-hotspot, .dsh-music-bar-wrap.collapsed .smp-music-bar-progress-hit, .dsh-music-bar-wrap.collapsed .dsh-music-bar-time, .dsh-music-bar-wrap.collapsed .smp-music-bar-badge { display: none !important; }\n' +
      '.dsh-music-bar { box-sizing: border-box; display: flex; align-items: center; gap: 8px; width: 100%; max-width: none; margin: 0 auto; flex-wrap: nowrap; padding: 4px 300px 4px 10px; font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.04)); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2)); border-radius: 8px; cursor: default; user-select: none; position: relative; overflow: visible; transition: opacity 0.3s ease; }\n' +
      // ---- 显示位置：页面底部（.bottom）----
      // 固定条贴在窗口底边：left/width 由 useColumnMetrics 内联给出（对齐会话列宽），
      // bottom 固定为 0，所以这里只负责「固定 + 悬浮层级 + 外壳配色」。z-index 900：在
      // shell.overlay 这一层（AppFrame 的 z-index 20 浮动层）内部压过对话内容，但低于
      // 插件自己的播放面板（1000 与 2000 的目录选择器/确认框）——真正的模态仍然盖住它。
      // 外层 pointer-events:none、只有条本身 auto：条左右两侧的空白带不吞掉下方点击。
      '.dsh-music-bar-wrap.bottom { position: fixed; left: 0; bottom: 0; z-index: 900; padding: 0; width: auto; pointer-events: none; }\n' +
      // 注意 :not(.bare)：外层背景/阴影的选择器比 `.dsh-music-bar.bare` 更具体，不排除
      // 「关闭背景显示」就会把它压掉（表现为配置项失效，切到这个落位后关不掉背景）。
      '.dsh-music-bar-wrap.bottom .dsh-music-bar:not(.bare) { background: var(--dsw-alias-bg-base, #fff); box-shadow: 0 -8px 20px rgba(0,0,0,0.18); }\n' +
      '.dsh-music-bar-wrap.bottom .dsh-music-bar { pointer-events: auto; border-radius: 10px 10px 0 0; }\n' +
      '.dsh-music-bar-wrap.bottom .dsh-music-bar-progress { border-radius: 0; }\n' +
      // 页面底部模式的「让位」规则：给 DSH 的输入区底座（[data-composer-seat]）补一段
      // 下内边距，输入卡片整体上移，贴底的播放条因此不覆盖输入框、也不遮住任何对话内容
      // （底座背景本来就是自上而下渐变成实色的遮罩，补出来的这条带子会是干净的底色）。
      // 标记属性只在页面底部模式下挂（见组件里的 effect），切走即摘除，不留副作用；
      // 属性不存在时这条规则完全不生效。
      ':root[data-dsh-music-bar-bottom] [data-composer-seat] { padding-bottom: ' + BAR_BOTTOM_PAD + 'px; }\n' +
      // ---- 显示位置：悬浮条（.float）----
      // 三行紧凑卡片：名称 / 歌词独占整行 / 控件常显（time 靠左、按钮靠右），进度线贴底。
      // 默认贴右下角（right/bottom）；一旦有记忆坐标，内联 left/top 会把 right/bottom 置回
      // auto（见 wrapStyle 注释），否则左右同时生效会把固定元素拉宽。
      // 整条可拖动：cursor: grab 提示可拖；交互控件（button 等）不参与拖动。
      '.dsh-music-bar-wrap.float { position: fixed; z-index: 900; padding: 0; width: auto; pointer-events: auto; right: ' + BAR_FLOAT_EDGE + 'px; bottom: ' + BAR_FLOAT_EDGE + 'px; }\n' +
      // 同上：背景/阴影只在「没关闭背景显示」时给，否则会压掉 `.dsh-music-bar.bare`。
      '.dsh-music-bar-wrap.float .dsh-music-bar { width: ' + BAR_FLOAT_W + 'px; max-width: none; margin: 0; flex-wrap: wrap; row-gap: 2px; border-radius: 12px; cursor: grab; padding-right: 10px; }\n' +
      '.dsh-music-bar-wrap.float .dsh-music-bar:not(.bare) { background: var(--dsw-alias-bg-overlay, #1e1f22); box-shadow: 0 12px 32px rgba(0,0,0,0.35); }\n' +
      // 三行固定：① 歌词独占整行（第一行）② 名称 + 频谱 ③ 控件（时长靠左、按钮靠右）。
      // 歌词之所以单独占一行：和歌名挤同一行时，歌名（含歌手/音质徽章）会把它压到只剩一小截，
      // 中文歌词几乎每句都被截断；独占一行后可用宽度 ≈ 条宽 − 20px。
      // 行高固定（min-height/line-height 都是 20px）：没有歌词时那一行由占位元素撑着，
      // 有/无歌词、空闲/播放中都不改变条的高度——悬浮条不能一边放歌一边变高变矮。
      // 名称用 flex: 0 1 auto（不伸长、只收缩）：频谱因此紧跟在歌名/徽章后面，
      // 而不是被「占满整行」的歌名推到最右边；歌名过长时自己省略，频谱始终贴着徽章。
      // max-width 预留出频谱的位置（60px 画布 + 8px 间距 + 4px 余量，避免亚像素取整后
      // 刚好超出一行宽度）：flex-wrap 换行是按各条的「理想宽度」算的、不受 flex-shrink
      // 影响，不设上限时长歌名会把频谱挤到自己独占一行，条就从三行变四行。
      '.dsh-music-bar-wrap.float .dsh-music-bar-lyric { order: 0; flex: 1 0 100%; max-width: none; min-height: 20px; line-height: 20px; }\n' +
      '.dsh-music-bar-wrap.float .dsh-music-bar-name { order: 1; flex: 0 1 auto; min-width: 0; max-width: calc(100% - 72px); }\n' +
      '.dsh-music-bar-wrap.float .dsh-music-viz { order: 2; flex: none; }\n' +
      '.dsh-music-bar-wrap.float .dsh-music-bar-lyric-empty { display: flex; align-items: center; justify-content: center; }\n' +
      '.dsh-music-bar-wrap.float .dsh-music-bar-controls { position: static; transform: none; order: 0; flex: 0 0 auto; margin-left: auto; }\n' +
      '.dsh-music-bar-wrap.float .dsh-music-bar-time, .dsh-music-bar-wrap.float .dsh-music-bar-live { margin-right: auto; }\n' +
      '.dsh-music-bar-wrap.float .dsh-music-bar-hotspot { display: none; }\n' +
      '.dsh-music-bar-wrap.float .dsh-music-bar-progress { border-radius: 0 0 12px 12px; }\n' +
      // 极简模式：输入框右侧控件区（conversation.input.right）里的音乐图标（仅播放条
      // 位置=极简时渲染，见 MiniPlayerTrigger），排在模型选择器左边——空白会话的输入框
      // 同样带着这一行控件，所以新会话也能从这里打开播放器。该行是 gap:12px 的 flex，
      // 图标只占一个 24px 的行内按钮，与模型选择器之间的间距和原生控件一致。
      // 图标本体不画背景/边框/阴影（!important 防第三方皮肤给 slot 子项套背景），颜色
      // 对齐右侧控件的二级文字色，悬停升一级。播放中只有谱号本身做流光（见 MiniMusicNote
      // 的 SMIL 渐变扫光），暂停/空闲时完全静止，不画光圈/脉冲环。
      // margin-right:-12px 抵消 standardControls 的 gap:12px，让谱号紧贴模型选择器。
      // 尺寸/背景完全照抄输入框左下角的权限选择器（PermissionSelect 的 trigger）：
      // 高 28px、图标 14px、圆角 --dsw-radius-sm、rest 无底色、hover 铺
      // --dsw-alias-interactive-bg-hover、focus-visible 用 2px 焦点环；背景区域就是这块
      // 28px 见方的圆角矩形（图标本身无背景）。
      '.dsh-music-mini-trigger { box-sizing: border-box; display: inline-flex; flex: none; align-items: center; justify-content: center; width: 28px; height: 28px; margin-right: -12px; padding: 0; border: none !important; border-radius: var(--dsw-radius-sm, 8px); background: transparent !important; box-shadow: none !important; color: var(--dsw-alias-label-secondary, #6b7280); cursor: pointer; pointer-events: auto; transition: background-color 0.15s ease; }\n' +
      '.dsh-music-mini-trigger:hover { background-color: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12)) !important; }\n' +
      '.dsh-music-mini-trigger:focus-visible { box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #2f6fed)) !important; }\n' +
      '.dsh-music-mini-note { width: 14px; height: 14px; display: block; flex: none; }\n' +
      // 流光带的颜色 = 输入框底色：浅色主题白、深色主题深色，两套主题下都是
      // 「一道底色扫过谱号」的同一效果（见 MiniMusicNote 的渐变 stop）。
      '.dsh-music-mini-flow-wipe { stop-color: var(--dsw-specific-input-major, #ffffff); }\n' +
      // 系统配置「播放条背景显示」关闭时：去掉播放条外壳的边框与背景色，只保留内容
      // （歌名/歌词/频谱/按钮等子元素自身样式独立，不受影响；内边距/圆角/布局保持不变）。
      '.dsh-music-bar.bare { background: transparent; border: none; }\n' +
      '.dsh-music-bar.dimmed { opacity: var(--dsh-music-immerse, 0.5); }\n' +
      // 播放进度细线：绝对定位在播放条底部（占满其宽度），高 1px、视觉上是一条细线；
      // 轨道用低透明度衬底色，填充部分用主题色，随 position/duration 实时前进
      // （宽度 0.12s 平滑过渡）。播放条容器已 overflow:hidden，细线两端会被裁剪到
      // 圆角形状内，不会「戳出」圆角之外；pointer-events:none 避免挡住下方交互。
      // 轨道色用「次级文字色 + 低透明度」而非 bg-layer-2：后者在深色主题是亮层级、
      // 浅色主题也是亮层级，浅色背景下几乎不可见；文字色在深色主题偏亮、浅色主题
      // 偏暗，无论深浅背景都能衬出一条可见的细线轨道。
      '.dsh-music-bar-progress { position: absolute; left: 0; right: 0; bottom: 0; height: 1px; overflow: hidden; pointer-events: none; background: color-mix(in srgb, var(--dsw-alias-label-secondary, #8a8f98) 30%, transparent); }\n' +
      '.dsh-music-bar-progress-fill { height: 100%; background: color-mix(in srgb, var(--dsh-music-accent, #2f9e6e) 55%, var(--dsw-alias-bg-base)); transition: width 0.12s linear; }\n' +
      '.dsh-music-bar-idle { color: var(--dsw-alias-label-primary, #e6e6e6); font-weight: 500; display: inline-flex; align-items: center; }\n' +
      '.dsh-music-bar-name { flex: 0 1 auto; max-width: 36%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-flex; align-items: center; min-width: 0; }\n' +
      // 名称文本（音符图标 + 歌名）内层：承载单击打开面板；参与外层 flex、可省略截断。
      '.dsh-music-bar-name-text { display: inline-flex; align-items: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }\n' +
      '.dsh-music-note { color: var(--dsh-music-accent, #2f9e6e); flex: none; margin-right: 4px; }\n' +
      // canvas 默认是 inline 级元素，会有基线留白导致在 flex 行里整体偏上；
      // display:block + margin:auto 0 + align-self:center 显式保证画布在播放条垂直居中。
      '.dsh-music-viz { flex: none; display: block; width: 60px; height: 20px; margin: auto 0; align-self: center; }\n' +
      // 歌词/字幕：夹在频谱与时长之间，吃掉剩余宽度，文本在可用空间内水平居中。
      // 三层结构：outer(定宽裁剪/遮罩/溢出标记) → run(跑马灯平移层) → fx(入场动画层)。
      // 无退场动画：上一句随 fx 重挂即时消失（data-prev 仅作「首次挂载」延迟判定）。
      // 首次出现仍延迟 0.28s（与控件组滑出 0.3s 对齐，:not([data-prev]) 只命中
      // 「无上一行」的首次挂载），行间切换立即播放过渡不额外等待。
      // 边缘渐隐（内置恒开）：两端各留 ~1em 渐变。未溢出时遮罩落在空白上，无视觉副作用。
      '.dsh-music-bar-lyric { flex: 1 1 0; min-width: 0; overflow: hidden; text-align: center; color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 14px; position: relative; -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 14px, #000 calc(100% - 14px), transparent 100%); mask-image: linear-gradient(90deg, transparent 0, #000 14px, #000 calc(100% - 14px), transparent 100%); }\n' +
      // 中层：跑马灯平移；暂停时跟随音频停住（paused 由 playing prop 下发）。
      '.dsh-music-bar-lyric-run { display: inline-block; white-space: nowrap; max-width: none; }\n' +
      // 未溢出（无 .mq）时显式复位 transform，杜绝上一句动画值残留导致的短句被平移。
      '.dsh-music-bar-lyric-run:not(.mq) { transform: none; }\n' +
      '.dsh-music-bar-lyric-run.mq { animation: dsh-lyric-mq var(--mq-dur, 8s) ease-in-out infinite alternate; }\n' +
      '.dsh-music-bar-lyric-run.paused, .dsh-music-bar-lyric-fx.fxfrozen { animation-play-state: paused; }\n' +
      '@keyframes dsh-lyric-mq { from { transform: translateX(0); } to { transform: translateX(calc(-1 * var(--mq-over, 0px))); } }\n' +
      // fx 层：内联块收缩到文本宽度，退场伪元素 inset:0 精确叠在字形上。
      '.dsh-music-bar-lyric-fx { display: inline-block; position: relative; white-space: nowrap; }\n' +
      // — 入场动画（none 无 → 选择器不命中）：
      ".dsh-music-bar-lyric-fx[data-fx='slide'] { animation: dsh-lyric-slide-in 0.32s cubic-bezier(0.2, 0.7, 0.3, 1) backwards; }\n" +
      ".dsh-music-bar-lyric-fx[data-fx='blur'] { animation: dsh-lyric-blur-in 0.42s ease-out backwards; }\n" +
      // 首次挂载（没有上一行）：推迟出现，避开按钮组收起过程（见上方注释）。
      ".dsh-music-bar-lyric-fx:not([data-prev])[data-fx='slide'], .dsh-music-bar-lyric-fx:not([data-prev])[data-fx='blur'] { animation-delay: 0.28s; }\n" +
      // （退场动画已移除：上一句随 fx 重挂即时消失，不叠映过渡；data-prev 仍保留，
      // 仅用于上方「首次挂载」的入场延迟判定。）
      // karaoke 扫色：background-clip:text 上色，--kar-dur/--kar-delay(-elapsed) 让扫描
      // 定位到行内当前进度；暂停时整体停帧。配色走「明度+色相双重反差」才够醒目：
      // 已唱 = accent 实色绿；扫描头 = 41%→42% 一窄条混白高光（发亮的边界，一眼可见）；
      // 未唱 = 主文字色降到 40% 不透明度的「暗场」（比原来的中灰对比强得多）。羽化带
      // 收窄到 3%（原 10%），扫过的是清晰边界而不是一大片渐糊。背景 250% 宽 + 位置
      // 100%→0% 平移：起末两端分别正好露出纯暗场/纯绿色段（几何上已按窗口覆盖率校准）。
      ".dsh-music-bar-lyric-fx[data-fx='karaoke'] { background-image: linear-gradient(90deg, var(--dsh-music-accent, #2f9e6e) 0%, var(--dsh-music-accent, #2f9e6e) 41%, color-mix(in srgb, var(--dsh-music-accent, #2f9e6e) 55%, #fff) 42%, color-mix(in srgb, var(--dsw-alias-label-primary, #e6e6e6) 40%, transparent) 44%, color-mix(in srgb, var(--dsw-alias-label-primary, #e6e6e6) 40%, transparent) 100%); background-size: 250% 100%; background-repeat: no-repeat; -webkit-background-clip: text; background-clip: text; color: transparent; animation: dsh-kar-sweep var(--kar-dur, 6s) linear var(--kar-delay, 0s) backwards, dsh-kar-in 0.22s ease backwards; }\n" +
      // 音频时钟驱动模式（QRC 行窗口）：停用墙钟关键帧动画与过渡——位置由
      // karaokeFrame 逐帧按精确逆映射直写（帧间增量本身很小，无需过渡平滑；
      // 过渡反而会让渲染值持续落后目标）。
      ".dsh-music-bar-lyric-fx[data-fx='karaoke'][data-audioclock] { animation: dsh-kar-in 0.22s ease backwards; transition: none; }\n" +
      '@keyframes dsh-kar-sweep { from { background-position-x: 100%; } to { background-position-x: 0%; } }\n' +
      '@keyframes dsh-kar-in { from { opacity: 0; } to { opacity: 1; } }\n' +
      // 未唱「暗场」由 250% 渐变铺满实现；若浏览器不支持 color-mix，整个 gradient 失效
      // 会退化为无背景 → 文字全透明不可见！因此无 @supports 时先给一个实色兜底：
      // 先声明 background-color 后再被支持的浏览器以 background-image 覆盖观感。
      ".dsh-music-bar-lyric-fx[data-fx='karaoke'] { background-color: transparent; }\n" +
      "@supports not (background: color-mix(in srgb, red 50%, blue)) {\n" +
      "  .dsh-music-bar-lyric-fx[data-fx='karaoke'] { color: var(--dsw-alias-label-primary, #e6e6e6); }\n" +
      "}\n" +
      // karaoke 已移除退场伪元素（上一句即时消失）。
      '@keyframes dsh-lyric-slide-in { from { opacity: 0; transform: translateY(9px); } to { opacity: 1; transform: translateY(0); } }\n' +
      '@keyframes dsh-lyric-blur-in { from { opacity: 0; filter: blur(5px); transform: translateY(3px); } to { opacity: 1; filter: blur(0); transform: translateY(0); } }\n' +
      // 减动效：全部歌词动画停用；溢出行左对齐起步（跑马灯不滚动时至少能读到行首）。
      '@media (prefers-reduced-motion: reduce) { .dsh-music-bar-lyric-run.mq, .dsh-music-bar-lyric-fx { animation: none !important; } .dsh-music-bar-lyric-fx[data-audioclock] { transition: none !important; } .dsh-music-bar-lyric-run.mq { text-align: left; } }\n' +
      '.dsh-music-bar-warn { background: transparent; border: none; color: var(--dsw-alias-state-warn-primary, #d9a441); font-size: 12px; cursor: pointer; padding: 0; white-space: nowrap; }\n' +
      '.dsh-music-bar-btn { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 24px; height: 24px; border-radius: 50%; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.05)); color: var(--dsh-music-accent, #2f9e6e); cursor: pointer; font-size: 13px; line-height: 1; padding: 0; }\n' +
      '.dsh-music-bar-btn:hover { color: var(--dsh-music-accent-fg, #fff); background: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-bar-btn.active { color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-bar-vol { position: relative; flex: none; display: inline-flex; align-self: center; }\n' +
      '.dsh-music-bar-vol-pop { position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%); display: flex; align-items: center; justify-content: center; width: 36px; height: 108px; box-sizing: border-box; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 8px; box-shadow: 0 8px 20px rgba(0,0,0,0.3); z-index: 60; }\n' +
      // 讲书时音量弹层加宽，容纳 AI 声音选择 + 音量条。
      '.dsh-music-bar-vol-pop.book { width: 136px; height: auto; padding: 10px; flex-direction: column; gap: 10px; align-items: stretch; }\n' +
      '.dsh-music-voice { display: flex; flex-direction: column; gap: 4px; }\n' +
      '.dsh-music-voice-label { font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-voice-select { width: 100%; padding: 4px 6px; font-size: 12px; color: var(--dsw-alias-label-primary, #e6e6e6); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.3)); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 6px; cursor: pointer; }\n' +
      '.dsh-music-voice-switching { font-size: 10px; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-bar-vol-pop.book .dsh-music-vol-slider { align-self: center; }\n' +
      '.dsh-music-vol-slider { position: relative; width: 24px; height: 84px; cursor: pointer; touch-action: none; }\n' +
      '.dsh-music-vol-track { position: absolute; left: 50%; top: 0; bottom: 0; width: 4px; transform: translateX(-50%); border-radius: 2px; background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.14)); }\n' +
      '.dsh-music-vol-fill { position: absolute; left: 50%; bottom: 0; width: 4px; transform: translateX(-50%); border-radius: 2px; background: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-vol-thumb { position: absolute; left: 50%; transform: translateX(-50%); width: 14px; height: 14px; border-radius: 50%; background: var(--dsh-music-accent, #2f9e6e); box-shadow: 0 1px 3px rgba(0,0,0,0.4); }\n' +
      // 时长：与按钮组同源的「从右滑入」动画——悬停时按钮组展开、时长挂载进场，
      // 二者同步从右侧滑入（translateX 16px→0 + 淡入），避免时长突兀地「直接显示」。
      '.dsh-music-bar-time { flex: 0 0 auto; white-space: nowrap; line-height: 1; font-variant-numeric: tabular-nums; animation: dsh-music-time-in 0.3s ease; }\n' +
      '@keyframes dsh-music-time-in { from { opacity: 0; transform: translateX(16px); } to { opacity: 1; transform: translateX(0); } }\n' +
      // 电台直播徽标：红色圆点 + LIVE（或暂停时灰色「电台」）。红色用错误态主色，
      // 深色浅色主题都醒目；文字不加粗（LIVE 本身信息量足够，避免抢戏）。
      '.dsh-music-bar-live { line-height: 1; font-variant-numeric: tabular-nums; animation: dsh-music-time-in 0.3s ease; color: var(--dsw-alias-state-error-primary, #e5534b); white-space: nowrap; }\n' +
      '.dsh-music-bar-hint { color: var(--dsw-alias-state-warn-primary, #d9a441); white-space: nowrap; }\n' +
      // 时长 + 控制按钮的组合：留在 flex 流中右对齐（margin-left:auto）——这样窄屏下
      // 按钮组仍可随 flex 收缩，不会被 overflow:hidden 裁掉（与改动前行为一致）。
      // min-width 保持 0：折叠态按钮 max-width:0，控件区不占宽、不挤压中间 flex:1 的
      // 歌词/字幕。右端触发由绝对定位的 .dsh-music-bar-hotspot 承接（不占流），
      // 鼠标移入右端区域才触发按钮组滑入/滑出，整个播放条其它区域不再触发。
      // position:relative + z-index:2 让按钮组盖在热区之上，保持可点击。
      '.dsh-music-bar-controls { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); z-index: 3; display: inline-flex; align-items: center; gap: 8px; flex: none; min-width: 0; }\n' +
      // 右端热区：绝对定位覆盖播放条右端一段区域（不占 flex 宽度 → 不挤压歌词/字幕），
      // 承接鼠标移入触发按钮组滑出。z-index:1 低于按钮组（z-index:2），不挡按钮点击。
      '.dsh-music-bar-hotspot { position: absolute; top: 0; bottom: 0; right: 0; width: 100px; z-index: 1; }\n' +
      // 控制按钮组：默认折叠（max-width:0 + overflow:hidden 裁剪），鼠标进入右端热区时
      // 从右向左滑入展开（translateX + opacity）。折叠时时长与按钮一并隐藏（闲置态）。
      // overflow:hidden 只用于裁剪左右滑动的按钮；三个向上弹出的弹层（音量/模式/
      // 章节目录）已改为 portal 渲染到 body，不受此裁剪影响。
      '.dsh-music-bar-btns { display: inline-flex; align-items: center; gap: 8px; flex: 0 0 auto; flex-shrink: 0; min-width: max-content; overflow: visible; max-width: none; opacity: 1; transform: none; white-space: nowrap; }\n' +
      '.dsh-music-bar-controls.on .dsh-music-bar-btns { max-width: none; opacity: 1; transform: none; }\n' +
      '.dsh-music-bar-buffering { display: inline-flex; align-items: center; gap: 5px; margin-left: 8px; color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 11px; }\n' +
      '.dsh-music-spinner { width: 12px; height: 12px; border: 2px solid var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.2)); border-top-color: var(--dsh-music-accent, #2f9e6e); border-radius: 50%; animation: dsh-music-spin 0.8s linear infinite; flex: none; }\n' +
      '@keyframes dsh-music-spin { to { transform: rotate(360deg); } }\n' +
      '.dsh-music-bar-berr { margin-left: 8px; color: var(--dsw-alias-state-error-primary, #e5534b); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px; display: inline-flex; align-items: center; gap: 4px; }\n' +
      '.dsh-music-bar-berr-text { overflow: hidden; text-overflow: ellipsis; }\n' +
      '.dsh-music-bar-btn.retry { width: auto; color: var(--dsw-alias-state-error-primary, #e5534b); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 6px; padding: 0 6px; height: 18px; flex: none; }\n' +
      '.dsh-music-bar-btn.retry:hover { background: var(--dsw-alias-state-error-primary, #e5534b); color: #fff; }\n' +
      '.dsh-music-bar .dsh-music-mode-trigger { width: 24px; height: 24px; }\n' +
      '.dsh-music-bar .dsh-music-mode-trigger svg { flex: none; }\n' +
      '.dsh-music-bar .dsh-music-mode-menu { align-self: center; }\n' +
      '.dsh-music-panel { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 600px; max-height: 72vh; display: flex; flex-direction: column; gap: 8px; padding: 12px; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,0.35); color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 13px; z-index: 1000; pointer-events: auto; overflow: hidden; }\n' +
      // 歌词/字幕面板：与播放面板同款外壳视觉（背景/边框/圆角/阴影），默认居中、
      // 宽 420px 高 40vh（无侧边栏，歌词阅读更宽裕）。position 改为 fixed 时
      // 保留 left/top 居中；拖动/拉伸后由内联 left/top/width/height 覆盖。
      '.dsh-music-lyric-panel { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 420px; height: 40vh; max-height: 80vh; display: flex; flex-direction: column; gap: 8px; padding: 12px; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsh-music-accent, #2f9e6e); border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,0.35); color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 13px; z-index: 1000; pointer-events: auto; overflow: hidden; }\n' +
      // 透明模式（ghost）：外壳完全隐身——背景透明、边框只去色（保留 1px 占位不改
      // 几何）、去掉投影，歌词像直接显示在背景页面上（歌词文字无阴影）。
      // 边框/标题栏/关闭按钮/右下角拉伸角标默认隐藏，悬停面板时才浮现
      // （拖拽/关闭/拉伸功能不受影响，隐藏只是视觉淡出，pointer-events 保持可用）。
      '.dsh-music-lyric-panel.ghost { background: transparent; border-color: transparent; box-shadow: none; transition: border-color 0.15s; }\n' +
      '.dsh-music-lyric-panel.ghost:hover, .dsh-music-lyric-panel.ghost:focus-within { border-color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-lyric-panel.ghost .dsh-music-panel-head { opacity: 0; transition: opacity 0.15s; }\n' +
      '.dsh-music-lyric-panel.ghost:hover .dsh-music-panel-head, .dsh-music-lyric-panel.ghost:focus-within .dsh-music-panel-head { opacity: 1; }\n' +
      '.dsh-music-lyric-panel.ghost .dsh-music-resize::after { opacity: 0; }\n' +
      '.dsh-music-lyric-panel.ghost:hover .dsh-music-resize::after { opacity: 0.7; }\n' +
      // 标题栏通栏强调色底：负外边距抵消面板 12px 内边距，强调色条贴满面板顶部
      // （顶角由面板 overflow:hidden + 12px 圆角裁出）。前景一律用配套令牌
      // --dsh-music-accent-fg（宿主按主题提供「强调色上的前景色」）——不能写死
      // #fff：浅色主题下 brand 强调色偏浅，白字会直接隐形。仅歌词面板生效——
      // 主播放面板标题栏保持中性（两面板共用 .dsh-music-panel-head）。
      '.dsh-music-lyric-panel .dsh-music-panel-head { background: var(--dsh-music-accent, #2f9e6e); margin: -12px -12px 0; padding: 8px 12px; }\n' +
      '.dsh-music-lyric-panel .dsh-music-panel-title { color: var(--dsh-music-accent-fg, #fff); }\n' +
      '.dsh-music-lyric-panel .dsh-music-panel-grip { color: var(--dsh-music-accent-fg, #fff); opacity: 1; }\n' +
      '.dsh-music-lyric-panel .dsh-music-panel-head .dsh-music-icon-btn { color: var(--dsh-music-accent-fg, #fff); }\n' +
      '.dsh-music-lyric-panel .dsh-music-panel-head .dsh-music-icon-btn:hover { color: var(--dsh-music-accent-fg, #fff); background: color-mix(in srgb, var(--dsh-music-accent-fg, #fff) 18%, transparent); }\n' +
      // 歌词面板正文：可滚动歌词列表，逐行显示。行（.dsh-music-lyric-line）是块级，
      // 仅承载布局与行距；文字放内联 span（.dsh-music-lyric-line-text）承载字号与颜色。
      // 当前行（.active）高亮为「强调色 + 放大到 18px + 加粗（font-weight:700）」，并带
      // 0.18s 的字号平滑过渡（放大/回缩都动画），突出正在朗读/演唱的行；无背景框——
      // 颜色与字号随活动行即时跟随主题 accent。
      // 面板本身保持 13px（标题/按钮等控件字号不变）。
      // 滚动条悬浮化：自定义 6px 细滚动条，滑块默认全透明——换行自动滚动时不再闪出
      // 原生滚动条；悬停面板时滑块才浮现（与 ghost 模式标题栏同一交互语言）。
      // scrollbar-gutter: stable 保留：滑块/轨道占位恒定（webkit 自定义滚动条恒占
      // 6px，Firefox thin + stable 双保险），换行居中的 scrollTop 计算不受宽度抖动影响。
      '.dsh-music-lyric-panel-body { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; padding: 4px 8px; scrollbar-gutter: stable; scrollbar-width: thin; scrollbar-color: transparent transparent; }\n' +
      '.dsh-music-lyric-panel:hover .dsh-music-lyric-panel-body { scrollbar-color: rgba(128,128,128,0.45) transparent; }\n' +
      '.dsh-music-lyric-panel-body::-webkit-scrollbar { width: 6px; }\n' +
      '.dsh-music-lyric-panel-body::-webkit-scrollbar-track { background: transparent; }\n' +
      '.dsh-music-lyric-panel-body::-webkit-scrollbar-thumb { background: transparent; border-radius: 3px; }\n' +
      '.dsh-music-lyric-panel:hover .dsh-music-lyric-panel-body::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.45); }\n' +
      '.dsh-music-lyric-line { padding: 3px 0; }\n' +
      '.dsh-music-lyric-line-text { font-size: 16px; line-height: 1.6; color: var(--dsw-alias-label-secondary, #8a8f98); white-space: pre-wrap; word-break: break-word; transition: font-size 0.18s ease; }\n' +
      '.dsh-music-lyric-line.active .dsh-music-lyric-line-text { color: var(--dsh-music-accent, #2f9e6e); font-weight: 700; font-size: 18px; }\n' +
      '.dsh-music-resize { position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize; touch-action: none; z-index: 5; }\n' +
      '.dsh-music-resize::after { content: ""; position: absolute; right: 4px; bottom: 4px; width: 5px; height: 5px; border-right: 2px solid var(--dsw-alias-label-secondary, #8a8f98); border-bottom: 2px solid var(--dsw-alias-label-secondary, #8a8f98); opacity: 0.7; }\n' +
      '.dsh-music-resize:hover::after { opacity: 1; }\n' +
      '.dsh-music-panel-head { display: flex; align-items: center; gap: 6px; }\n' +
      // 面板主体：左右布局——左侧 Tab 侧边栏，右侧内容区。两侧紧贴（gap:0），
      // 选中 tab 就能与内容区无缝连成整体。
      // 播放器弹窗顶部的播放条：任何落位模式下都在（极简模式下它是页面上唯一的播放条）。
      // 去掉输入区的左右留白与最大宽度限制，让它铺满弹窗内容宽度。
      '.dsh-music-panel-bar { flex: none; }\n' +
      '.dsh-music-panel-bar .dsh-music-bar-wrap { padding: 0; }\n' +
      '.dsh-music-panel-bar .dsh-music-bar { width: 100%; max-width: none; }\n' +
      '.dsh-music-panel-body { display: flex; flex-direction: row; gap: 0; flex: 1; min-height: 0; }\n' +
      // 内容区：不设背景，透出面板自然底色；与左侧深色侧边栏靠明暗对比区分。
      '.dsh-music-panel-content { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; min-height: 0; padding-left: 12px; }\n' +
      // Tab 标签竖排在窗口左侧（侧边栏）：背景比右侧略深。左右无内边距保证
      // 选中项撑满整列并与内容区无缝连接；上下内边距加大，让标签组与上方标题、
      // 下方边缘留出呼吸空间。
      '.dsh-music-tabs { display: flex; flex-direction: column; gap: 4px; flex: none; width: 88px; padding: 48px 0; background: rgba(0,0,0,0.28); }\n' +
      '.dsh-music-tab { flex: none; width: 100%; padding: 16px 8px; border: none; background: transparent; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 12px; }\n' +
      // 选中的 tab：用面板底色填充，与右侧透明内容区同色、右缘直通（无缝隙）连成整体；
      // 左缘一条强调色竖条 + 加粗，指示当前所在项。
      '.dsh-music-tab.active { background: var(--dsw-alias-bg-overlay, #1e1f22); color: var(--dsw-alias-label-primary, #e6e6e6); font-weight: 600; box-shadow: inset 3px 0 0 var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-panel-drag { cursor: move; touch-action: none; user-select: none; }\n' +
      '.dsh-music-panel-grip { color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 12px; letter-spacing: -1px; opacity: 0.7; }\n' +
      '.dsh-music-panel-title { font-weight: 600; margin-right: auto; }\n' +
      '.dsh-music-icon-btn { background: transparent; border: none; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 14px; padding: 2px 6px; border-radius: 6px; }\n' +
      '.dsh-music-icon-btn:hover { color: var(--dsw-alias-label-primary, #e6e6e6); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-panel-root { font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-mode-menu { position: relative; flex: none; }\n' +
      '.dsh-music-mode-menu.right { margin-left: auto; }\n' +
      '.dsh-music-mode-trigger { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 50%; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.05)); color: var(--dsh-music-accent, #2f9e6e); cursor: pointer; }\n' +
      '.dsh-music-mode-trigger:hover, .dsh-music-mode-trigger.active { background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); }\n' +
      '.dsh-music-mode-pop { position: absolute; left: 50%; transform: translateX(-50%); bottom: calc(100% + 6px); z-index: 60; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 6px; height: 108px; box-sizing: border-box; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.3); }\n' +
      '.dsh-music-mode-item { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border: none; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; }\n' +
      '.dsh-music-mode-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-mode-item.active { background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); }\n' +
      '.dsh-music-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; min-height: 60px; max-height: 42vh; }\n' +
      // pane 层的包裹 div：改成 flex 列容器（否则它是块级元素，QQ pane 的 flex:1
      // 不生效、没有确定高度，导致 .dsh-music-qq-body 不滚动、整棵被 .dsh-music-list
      // 滚走 → 滚动条会盖住固定的 head）。设为 flex:1+min-height:0 撑满列表区高度：
      // QQ pane 内的 .dsh-music-qq-body 成为唯一滚动容器，滚动条只出现在 head 下方。
      // 本地音乐/讲书 pane 因 min-height:auto 不会被压缩、仍超高溢出、由列表滚动，行为不变。
      '.dsh-music-list-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }\n' +
      '.dsh-music-track { display: flex; align-items: center; gap: 8px; width: 100%; max-width: 100%; box-sizing: border-box; text-align: left; padding: 6px 8px; border: none; background: transparent; border-radius: 6px; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 12px; }\n' +
      '.dsh-music-track:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      // 正在播放/选中的条目：填充强调色底 + 强调色文字，让当前条目一眼可见（选中态）。
      '.dsh-music-track.active { color: var(--dsh-music-accent, #2f9e6e); background: color-mix(in srgb, var(--dsh-music-accent, #2f9e6e) 14%, transparent); }\n' +
      '.dsh-music-track.active .dsh-music-track-name { font-weight: 600; }\n' +
      '.dsh-music-track-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      // 在线 QQ 歌曲行：歌名 + 内嵌 VIP 徽标并排，歌名省略、VIP 徽标不省略。
      '.dsh-music-track-name.qq { display: inline-flex; align-items: center; gap: 5px; overflow: hidden; }\n' +
      '.dsh-music-track-name.qq .dsh-music-track-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-track-name.qq .dsh-music-online-tag { flex: 0 0 auto; margin-left: 0; }\n' +
      // 歌单卡片：封面图 + 名称 + 元信息，网格排布。
      '.dsh-music-playlist-card { display: flex; flex-direction: column; align-items: stretch; gap: 5px; width: 100%; min-width: 0; text-align: left; padding: 6px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.06)); border-radius: 10px; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 12px; }\n' +
      '.dsh-music-playlist-card:hover { border-color: var(--dsh-music-accent, #2f9e6e); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.05)); }\n' +
      '.dsh-music-playlist-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 5px; padding: 3px; align-items: start; }\n' +
      // 「我的歌单」卡片：外层相对定位，右上角删除按钮悬浮。
      '.dsh-music-qq-mine-card { position: relative; }\n' +
      '.dsh-music-qq-mine-del { position: absolute; top: 6px; right: 6px; z-index: 2; width: 20px; height: 20px; line-height: 18px; padding: 0; text-align: center; border-radius: 50%; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.35)); background: var(--dsw-alias-bg-overlay, rgba(0,0,0,0.55)); color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 11px; opacity: 0; transition: opacity 0.15s; }\n' +
      '.dsh-music-qq-mine-card:hover .dsh-music-qq-mine-del { opacity: 1; }\n' +
      '.dsh-music-qq-mine-del:hover { color: #fff; background: #c9352c; border-color: #c9352c; }\n' +
      // 「取消收藏」用星标图标，悬停金色以区分于删除。
      '.dsh-music-qq-mine-del.uncollect:hover { color: #fff; background: #d9a441; border-color: #d9a441; }\n' +
      '.dsh-music-playlist-cover { width: 56px; height: 56px; border-radius: 8px; object-fit: cover; flex: 0 0 auto; background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      // 图标网格内的封面：方形填满卡片宽度，圆角小图（歌单/歌曲同款）。
      '.dsh-music-playlist-grid .dsh-music-playlist-cover { width: 100%; height: auto; aspect-ratio: 1 / 1; flex: none; }\n' +
      // 无封面（酷狗「默认收藏」等系统歌单接口不返回 pic）时的音符占位块。
      '.dsh-music-playlist-cover.empty { display: flex; align-items: center; justify-content: center; color: var(--dsw-alias-label-tertiary, rgba(255,255,255,0.45)); }\n' +
      '.dsh-music-playlist-cover.empty .dsh-music-note { width: 24px; height: 24px; }\n' +
      '.dsh-music-playlist-info { display: flex; flex-direction: column; gap: 4px; min-width: 0; }\n' +
      '.dsh-music-playlist-name-row { display: flex; align-items: center; gap: 6px; min-width: 0; }\n' +
      '.dsh-music-playlist-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }\n' +
      '.dsh-music-playlist-meta { font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-qq-topdetail-head { display: flex; align-items: center; gap: 10px; margin: 8px 0 6px; }\n' +
      // 榜单详情头（返回 + 榜名/封面）固定在滚动容器 .dsh-music-qq-body 之外：头部不被滚走，
      // 滚动条从头部下方开始、高度与歌曲列表对齐（不再被固定头遮挡）。
      '.dsh-music-qq-tophead-fixed { flex: none; }\n' +
      // 「加载更多」：水平居中 + 圆角胶囊按钮。
      '.dsh-music-qq-loadmore { display: flex; justify-content: center; margin: 14px 0 6px; }\n' +
      '.dsh-music-qq-loadmore-btn { padding: 7px 22px; border-radius: 20px; border: 1px solid var(--dsh-music-accent, #2f9e6e); background: transparent; color: var(--dsh-music-accent, #2f9e6e); cursor: pointer; font-size: 12px; transition: background 0.15s, color 0.15s; }\n' +
      '.dsh-music-qq-loadmore-btn:hover { background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); }\n' +
      // 公开歌单详情页「收藏」按钮：头部标题行下方一条胶囊按钮；已收藏置灰不可点。
      '.dsh-music-qq-collect-pl { align-self: flex-start; margin: 2px 0 6px; padding: 5px 14px; border-radius: 14px; border: 1px solid var(--dsh-music-accent, #2f9e6e); background: transparent; color: var(--dsh-music-accent, #2f9e6e); cursor: pointer; font-size: 12px; transition: background 0.15s, color 0.15s; }\n' +
      '.dsh-music-qq-collect-pl:hover:not(:disabled) { background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); }\n' +
      '.dsh-music-qq-collect-pl:disabled { cursor: default; border-color: var(--dsw-alias-border-l1, rgba(128,128,128,0.35)); color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      // 「播放全部」：主操作按钮，实心强调色胶囊（歌单详情/榜单详情头）。
      '.dsh-music-qq-playall { flex: none; display: inline-flex; align-items: center; gap: 4px; padding: 5px 14px; border-radius: 14px; border: none; background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); cursor: pointer; font-size: 12px; transition: opacity 0.15s; }\n' +
      '.dsh-music-qq-playall:hover { opacity: 0.85; }\n' +
      // 歌单详情操作行（播放全部 + 收藏）：放在简介下方、歌曲列表上方，横向排列。
      '.dsh-music-qq-pl-actions { display: flex; align-items: center; gap: 8px; margin: 2px 0 6px; }\n' +
      '.dsh-music-qq-pl-actions .dsh-music-qq-collect-pl { margin: 0; }\n' +
      '.dsh-music-track-size { font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-empty { padding: 12px; text-align: center; color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 12px; }\n' +
      '.dsh-music-error { color: var(--dsw-alias-state-error-primary, #e5534b); font-size: 12px; }\n' +
      // 新闻失败提示行：文本 + 右侧「✕」清除按钮（flex 布局，文本可换行、按钮固定右侧）。
      '.dsh-music-news-failure { display: flex; align-items: flex-start; gap: 6px; color: var(--dsw-alias-state-error-primary, #e5534b); font-size: 12px; line-height: 1.5; }\n' +
      '.dsh-music-news-failure-text { flex: 1; min-width: 0; word-break: break-word; }\n' +
      '.dsh-music-news-failure-close { flex: none; padding: 0 4px; background: none; border: none; color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 12px; cursor: pointer; line-height: 1.5; border-radius: 4px; }\n' +
      '.dsh-music-news-failure-close:hover { color: var(--dsw-alias-state-error-primary, #e5534b); background: rgba(229, 83, 75, 0.12); }\n' +
      '.dsh-music-loading { color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 12px; }\n' +
      // 系统配置面板：开关行（标签 + 描述 + 右侧开关）。
      '.dsh-music-config { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 3px; padding: 3px; align-items: stretch; grid-auto-rows: min-content; }\n' +
      // 分组卡片：整体一个外框（无标题），卡片内行之间用细分隔线（不各自带边框）。
      '.dsh-music-config-card { display: contents; }\n' +
      // 卡片内行：去掉独立边框/背景/圆角，只留上下内边距；相邻行之间画一条细分隔线。
      '.dsh-music-config-card .dsh-music-config-row { padding-top: 3px; padding-bottom: 3px; }\n' +
      '.dsh-music-config-card .dsh-music-config-row + .dsh-music-config-row { border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.18)); }\n' +
      '.dsh-music-config-row { display: flex; align-items: center; gap: 4px; padding: 3px 5px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.18)); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.03)); }\n' +
      '.dsh-music-config-info { flex: 0 0 auto; max-width: 66px; min-width: 0; display: flex; flex-direction: column; gap: 2px; }\n' +
      '.dsh-music-config-label { width: auto; color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 11px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n' +
      '.dsh-music-config-desc { display: none; }\n' +
      // 开关：右侧胶囊。用固定强调色而非随主题反转的 brand-primary，
      // 让深/浅主题下都读作「绿色=开、灰=关」；旋钮恒白保证两种主题下对比清晰。
      '.dsh-music-toggle { position: relative; flex: none; width: 34px; height: 19px; padding: 0; border: none; border-radius: 19px; background: var(--dsw-alias-border-l1, rgba(128,128,128,0.35)); cursor: pointer; transition: background 0.15s; }\n' +
      '.dsh-music-toggle .dsh-music-toggle-knob { position: absolute; top: 2px; left: 2px; width: 15px; height: 15px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,0.35); transition: left 0.15s; }\n' +
      // 开启：固定绿色强调色（不随主题反转），旋钮右移。
      '.dsh-music-toggle.on { background: #2f9e6e; }\n' +
      '.dsh-music-toggle.on .dsh-music-toggle-knob { left: 17px; }\n' +
      // 沉浸感滑块行：右侧 range + 百分比数值。
      '.dsh-music-config-slider { flex: none; display: flex; align-items: center; gap: 6px; }\n' +
      '.dsh-music-config-range { width: 72px; accent-color: #2f9e6e; cursor: pointer; }\n' +
      // 歌词动效分段选择器：一组互斥小按钮，选中项用主题色描边+填充。
      '.dsh-music-config-seg { flex: none; display: flex; gap: 3px; flex-wrap: wrap; }\n' +
      '.dsh-music-config-seg-btn { padding: 1px 4px; font-size: 9px; line-height: 1.5; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.35)); background: transparent; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; white-space: nowrap; transition: background 0.15s, color 0.15s, border-color 0.15s; }\n' +
      '.dsh-music-config-seg-btn:hover { color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      // 一行 4~5 项：带分段按钮 / 滑块的项跨两列，其余各占一格。
      '.dsh-music-config-row:has(.dsh-music-config-seg), .dsh-music-config-row:has(.dsh-music-config-slider) { grid-column: span 2; }\n' +
      // 选中态与配置面板其它控件（开关/滑块）同款实心主色绿，保证同一面板内视觉统一。
      '.dsh-music-config-seg-btn.on { background: #2f9e6e; border-color: #2f9e6e; color: #fff; font-weight: 600; }\n' +
      // 配置行右侧的小按钮（目前只有「重置位置」）：与分段按钮同款描边风格。
      '.dsh-music-config-btn { padding: 4px 10px; font-size: 11px; line-height: 1.5; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.35)); background: transparent; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; white-space: nowrap; transition: background 0.15s, color 0.15s, border-color 0.15s; }\n' +
      '.dsh-music-config-btn:hover:not(:disabled) { color: var(--dsw-alias-label-primary, #e6e6e6); border-color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-config-btn:disabled { opacity: 0.45; cursor: default; }\n' +
      '.dsh-music-config-val { min-width: 34px; text-align: right; font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); font-variant-numeric: tabular-nums; }\n' +
      // 关于页：头部（插件名称 + 版本徽章 + 简介）渲染在滚动列表之外（panel-content
      // 顶层），始终固定不动；下方卡片组在 .dsh-music-list 内滚动，滚动条只出现在
      // 卡片区、高度与该区域一致。与「选择音乐目录」设置块同款固定方式，最可靠。
      // 与系统配置面板同款卡片外观（同边框/底色/细分隔线），保证同一面板内视觉统一。
      '.dsh-music-about-top { display: flex; flex-direction: column; gap: 8px; }\n' +
      '.dsh-music-about-head { display: flex; align-items: center; gap: 10px; }\n' +
      // 音符图标：与版本更新弹窗图标（.dsh-music-whatsnew-logo）同款样式——
      // 强调色块 + 音符用成对主题变量（--dsh-music-accent 底 / --dsh-music-accent-fg
      // 前景随底色自适应，深浅主题下对比度都有保证），跟随 DSH 主题强调色；
      // 尺寸保持关于页头部的 42px 比例。♪ 字形笔画纤细且多数字体无粗体变体，
      // 用 font-weight 合成粗体 + 细描边（-webkit-text-stroke，Chromium 生效）
      // 让音符视觉上加粗。
      '.dsh-music-about-logo { flex: none; width: 42px; height: 42px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); font-size: 20px; font-weight: 700; -webkit-text-stroke: 0.6px currentColor; }\n' +
      '.dsh-music-about-title { font-size: 15px; font-weight: 700; display: flex; align-items: center; }\n' +
      '.dsh-music-about-ver { font-size: 11px; color: var(--dsh-music-accent, #2f9e6e); border: 1px solid var(--dsh-music-accent, #2f9e6e); border-radius: 10px; padding: 1px 8px; margin-left: 8px; font-weight: 600; }\n' +
      '.dsh-music-about-desc { font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); line-height: 1.7; }\n' +
      // 卡片区：普通流式块，超高时由外层 .dsh-music-list 滚动。
      '.dsh-music-about { display: flex; flex-direction: column; gap: 12px; }\n' +
      '.dsh-music-about-card { border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.04)); overflow: hidden; }\n' +
      '.dsh-music-about-card-title { padding: 8px 12px; font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary, #8a8f98); letter-spacing: 0.5px; }\n' +
      '.dsh-music-about-row { display: flex; align-items: center; gap: 8px; padding: 7px 12px; font-size: 12px; }\n' +
      '.dsh-music-about-row + .dsh-music-about-row { border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.14)); }\n' +
      '.dsh-music-about-k { flex: none; width: 110px; white-space: nowrap; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-about-v { flex: 1; min-width: 0; text-align: right; color: var(--dsw-alias-label-primary, #e6e6e6); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      // 状态值着色：就绪/已登录用强调色（绿），未就绪/未登录用警示色（黄）。
      '.dsh-music-about-v.ok { color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-about-v.err { color: var(--dsw-alias-state-warning-primary, #d9a441); }\n' +
      // 仓库地址：可点击外链（强调色 + 悬停下划线，与 DSH 外链样式一致）。
      '.dsh-music-about-link { flex: 1; min-width: 0; text-align: right; color: var(--dsh-music-accent, #2f9e6e); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-decoration: none; }\n' +
      // 站内动作行内按钮（复用 about-link 配色）与可点击版本徽章：button/span 重置。
      '.dsh-music-about-btn { background: none; border: none; padding: 0; cursor: pointer; font: inherit; }\n' +
      '.dsh-music-about-ver-btn { cursor: pointer; }\n' +
      '.dsh-music-about-link:hover { text-decoration: underline; }\n' +
      '.dsh-music-settings { display: flex; flex-direction: column; gap: 10px; }\n' +
      '.dsh-music-settings-row { display: flex; gap: 8px; align-items: center; }\n' +
      '.dsh-music-settings-cur { flex: 1; min-width: 0; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.04)); color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-settings-btn { padding: 6px 12px; border-radius: 8px; border: none; background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); cursor: pointer; font-size: 13px; white-space: nowrap; }\n' +
      '.dsh-music-settings-btn.ghost { background: transparent; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-settings-btn.danger { background: #c9352c; color: #fff; }\n' +
      '.dsh-music-picker-overlay { position: fixed; inset: 0; z-index: 2000; display: flex; overflow: auto; padding: 16px; background: rgba(0,0,0,0.45); }\n' +
      // 版本更新弹窗（What's New）：居中固定面板（同 .dsh-music-panel 的居中方式），
      // 叠在 picker-overlay 遮罩上；正文区独立滚动，历史折叠后整体高度可控。
      '.dsh-music-whatsnew { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); box-sizing: border-box; width: 460px; max-width: calc(100vw - 32px); max-height: 78vh; display: flex; flex-direction: column; gap: 8px; padding: 16px; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,0.35); color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 13px; pointer-events: auto; }\n' +
      '.dsh-music-whatsnew-head { display: flex; align-items: center; gap: 8px; }\n' +
      '.dsh-music-whatsnew-head-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }\n' +
      '.dsh-music-whatsnew-app { font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-whatsnew-logo { flex: none; width: 26px; height: 26px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); font-size: 15px; }\n' +
      '.dsh-music-whatsnew-title { min-width: 0; font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-whatsnew-badge { flex: none; padding: 1px 7px; border-radius: 999px; font-size: 10px; font-weight: 700; letter-spacing: 0.5px; background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); }\n' +
      '.dsh-music-whatsnew-sub { font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-whatsnew-body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 10px; padding-right: 2px; }\n' +
      '.dsh-music-whatsnew-sec { display: flex; flex-direction: column; gap: 4px; }\n' +
      '.dsh-music-whatsnew-sec-title { font-size: 12px; font-weight: 600; color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-whatsnew-item { font-size: 12.5px; line-height: 1.55; color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      '.dsh-music-whatsnew-item::before { content: "· "; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-whatsnew-hist-toggle { align-self: flex-start; font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; user-select: none; padding: 2px 0; }\n' +
      '.dsh-music-whatsnew-hist-toggle:hover { color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      '.dsh-music-whatsnew-hist { border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2)); padding-top: 8px; display: flex; flex-direction: column; gap: 6px; }\n' +
      '.dsh-music-whatsnew-hist-head { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-whatsnew-hist-head.clickable { cursor: pointer; user-select: none; }\n' +
      '.dsh-music-whatsnew-hist-head.clickable:hover { color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      '.dsh-music-whatsnew-hist-head.open { color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-whatsnew-foot { display: flex; justify-content: center; padding-top: 2px; }\n' +
      '.dsh-music-picker { box-sizing: border-box; width: 88%; max-width: 640px; max-height: 100%; margin: auto; display: flex; flex-direction: column; gap: 8px; padding: 12px; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 12px; color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      '.dsh-music-picker-head { display: flex; align-items: center; flex: none; }\n' +
      '.dsh-music-picker-title { font-weight: 600; margin-right: auto; }\n' +
      '.dsh-music-picker-cur { flex: none; font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); padding-bottom: 2px; display: flex; align-items: center; gap: 4px; }\n' +
      '.dsh-music-picker-cur-left { flex: 1; min-width: 0; display: flex; align-items: center; overflow-x: auto; overflow-y: hidden; white-space: nowrap; }\n' +
      '.dsh-music-picker-cur-left::-webkit-scrollbar { height: 4px; }\n' +
      '.dsh-music-picker-cur-left::-webkit-scrollbar-thumb { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.14)); border-radius: 4px; }\n' +
      '.dsh-music-picker-cur-up { flex: none; }\n' +
      '.dsh-music-crumb { display: inline-block; padding: 1px 4px; border: none; background: transparent; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 12px; border-radius: 4px; }\n' +
      '.dsh-music-crumb:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.08)); color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      '.dsh-music-crumb.cur { color: var(--dsw-alias-label-primary, #e6e6e6); font-weight: 600; cursor: default; }\n' +
      '.dsh-music-crumb-sep { margin: 0 2px; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-crumb-plain { color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-picker-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }\n' +
      '.dsh-music-picker-item { text-align: left; padding: 6px 8px; border: none; background: transparent; border-radius: 6px; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 13px; }\n' +
      '.dsh-music-picker-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      // 文件条目：仅作展示，不可点击（无 hover 高亮，光标为默认）。
      '.dsh-music-picker-item.file { color: var(--dsw-alias-label-secondary, #8a8f98); cursor: default; }\n' +
      '.dsh-music-picker-foot { display: flex; gap: 8px; justify-content: flex-end; flex: none; }\n' +
      // 自定义输入弹窗（新建/重命名歌单）的输入框。
      '.dsh-music-prompt-input { box-sizing: border-box; width: 100%; padding: 8px 10px; font-size: 13px; color: var(--dsw-alias-label-primary, #e6e6e6); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 8px; outline: none; }\n' +
      '.dsh-music-prompt-input:focus { border-color: var(--dsh-music-accent, #2f9e6e); }\n' +
      // 新建/重命名/删除/清空弹窗较窄，不用居中列表那种 640px 宽。
      '.dsh-music-picker.prompt, .dsh-music-picker.confirm { width: 300px; max-width: 90vw; }\n' +
      '.dsh-music-hint { font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      // AI 讲书 / 新闻播报底部固定的 xiaomi 语音提示（吸底、与列表区上方内容分隔）。
      '.dsh-music-tts-hint { flex: none; margin-top: auto; padding: 6px 8px 2px; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary, #8a8f98); border-top: 1px solid rgba(128,128,128,0.15); }\n' +
      // ---- 在线 QQ 音乐 ----
      '.dsh-music-qq { display: flex; flex-direction: column; gap: 10px; }\n' +
      '.dsh-music-settings-row.qq-account { gap: 6px; }\n' +
      '.dsh-music-qq-search { display: flex; gap: 8px; position: relative; }\n' +
      // 搜索输入框内部的「一键清除」×：包裹层相对定位，清除钮绝对定位在输入框右内侧，
      // 且始终渲染（空时 .hidden 仅隐藏、不改变布局），输入框宽度与 UI 位置恒定不抖。
      '.dsh-music-qq-inputwrap { position: relative; flex: 1; min-width: 0; display: flex; align-items: center; }\n' +
      '.dsh-music-qq-inputwrap .dsh-music-qq-input { flex: 1; padding-right: 26px; }\n' +
      '.dsh-music-qq-clear { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); width: 18px; height: 18px; line-height: 16px; padding: 0; text-align: center; border-radius: 50%; border: none; background: transparent; color: var(--dsw-alias-label-tertiary, rgba(255,255,255,0.45)); cursor: pointer; font-size: 12px; visibility: visible; }\n' +
      '.dsh-music-qq-clear.hidden { visibility: hidden; }\n' +
      '.dsh-music-qq-clear:hover { color: #fff; background: rgba(128,128,128,0.3); }\n' +
      '.dsh-music-qq-hist { position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 20; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 8px; padding: 4px; max-height: 240px; overflow-y: auto; box-shadow: 0 8px 20px rgba(0,0,0,0.3); }\n' +
      '.dsh-music-qq-hist-head { display: flex; align-items: center; justify-content: space-between; padding: 2px 6px 4px; }\n' +
      '.dsh-music-qq-hist-clear { border: none; background: transparent; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 11px; padding: 2px 4px; border-radius: 4px; }\n' +
      '.dsh-music-qq-hist-clear:hover { color: var(--dsw-alias-state-error-primary, #e5534b); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-qq-hist-item { display: block; width: 100%; text-align: left; padding: 6px 8px; border: none; background: transparent; border-radius: 6px; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 12px; }\n' +
      '.dsh-music-qq-hist-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-qq-input { flex: 1; min-width: 0; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.04)); color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 13px; }\n' +
      '.dsh-music-online-tag { flex: 0 0 auto; font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); border-radius: 6px; padding: 0 6px; line-height: 16px; margin-left: 6px; }\n' +
      '.dsh-music-online-tag.vip { color: #e6a23c; border-color: #e6a23c; }\n' +
      '.dsh-music-online-tag.collect { color: #d9a441; border-color: #d9a441; }\n' +
      // QQ「我喜欢」等系统默认歌单的标签（主题色，区别于自建的灰色）。
      '.dsh-music-online-tag.default { color: var(--dsh-music-accent, #2f9e6e); border-color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-picker.qq-login { max-width: 340px; }\n' +
      '.dsh-music-qq-login-body { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 12px 4px; }\n' +
      '.dsh-music-qq-qr { width: 280px; height: 280px; max-width: 70vw; image-rendering: pixelated; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 8px; object-fit: contain; }\n' +
      '.dsh-music-qq-login-status { font-size: 14px; color: var(--dsw-alias-label-primary, #e6e6e6); text-align: center; }\n' +
      '.dsh-music-qq-login-actions { display: flex; gap: 8px; }\n' +
      '.dsh-music-qq-viewtabs { display: flex; gap: 6px; }\n' +
      '.dsh-music-qq-viewtab { flex: none; white-space: nowrap; padding: 5px 12px; border-radius: 8px; border: none; background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 13px; }\n' +
      '.dsh-music-qq-viewtab.active { background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); }\n' +
      // 搜索结果内的「歌曲 / 相关歌单」切换 tab：与上方「我的歌单/推荐/分类/…」的
      // 填充式胶囊（viewtab）刻意区分——采用经典下划线式次级 tab（透明底 + 底部
      // 强调色指示条），一眼可辨这是「结果内二级切换」，而不是上层浏览入口。
      '.dsh-music-qq-resulttabs { display: flex; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); margin: 4px 0 8px; }\n' +
      // 搜索框行与「歌曲/相关歌单」子tab行固定在滚动容器(.dsh-music-qq-body)之外，
      // 滚动条只作用于其下方的结果内容，搜索结果出现竖向滚动条时输入框所在行不再左右偏移。
      '.dsh-music-qq-searchrow { flex: none; }\n' +
      '.dsh-music-qq-resulttabs.fixed { margin: 0; }\n' +
      '.dsh-music-qq-resulttab { flex: none; white-space: nowrap; padding: 6px 14px; border: none; background: transparent; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 13px; border-bottom: 2px solid transparent; margin-bottom: -1px; }\n' +
      '.dsh-music-qq-resulttab:hover { color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      '.dsh-music-qq-resulttab.active { color: var(--dsh-music-accent, #2f9e6e); border-bottom-color: var(--dsh-music-accent, #2f9e6e); font-weight: 600; }\n' +
      '.dsh-music-qq-cats { display: flex; flex-wrap: wrap; gap: 6px; }\n' +
      // 酷狗分类：一级与二级分类之间的分隔线（负 margin 会导致横向溢出出现滚动条，故用 0 边距）。
      '.dsh-music-cat-divider { border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); margin: 10px 0 0; }\n' +
      '.dsh-music-qq-cat { padding: 4px 10px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: transparent; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 12px; }\n' +
      '.dsh-music-qq-cat.active { border-color: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent, #2f9e6e); }\n' +
      // 分类折叠/展开切换按钮：小号、次要色、无边框。
      '.dsh-music-qq-cat-toggle { display: block; margin: 8px auto 0; padding: 3px 12px; border: none; background: transparent; color: var(--dsh-music-accent, #2f9e6e); cursor: pointer; font-size: 12px; }\n' +
      '.dsh-music-qq-cat-toggle:hover { text-decoration: underline; }\n' +
      '.dsh-music-qq-topgroup { margin-bottom: 8px; }\n' +
      '.dsh-music-qq-topitem { display: flex; justify-content: space-between; align-items: center; width: 100%; padding: 7px 10px; margin: 3px 0; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: transparent; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 13px; text-align: left; }\n' +
      '.dsh-music-qq-topitem:hover { border-color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-qq-topname { font-weight: 600; }\n' +
      '.dsh-music-qq-topmeta { font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-qq-detail-head { display: flex; gap: 8px; align-items: center; margin: 6px 0; }\n' +
      '.dsh-music-qq { display: flex; flex-direction: column; flex: 1; min-height: 0; height: 100%; }\n' +
      // QQ 面板所在 pane 不设 overflow:hidden（否则它自身会成为一个滚动容器，把
      // sticky 的 head 困在内部、无法吸附到真正滚动的 .dsh-music-list）。pane 保持
      // 普通流式布局，滚动交给 head 下方的 .dsh-music-list / .dsh-music-qq-body。
      '.dsh-music-qq-pane { flex: 1; min-height: 0; overflow: visible; display: flex; flex-direction: column; }\n' +
      // head 用 sticky 固定在滚动区顶部：无论实际滚动容器是 .dsh-music-list
      // 还是 .dsh-music-qq-body，返回按钮行 / 子tab 行都不会被列表滚走（内容在其下方滑动）。
      '.dsh-music-qq-login-tip { margin-bottom: 10px; padding: 6px 10px; border-radius: 6px; background: rgba(229, 83, 75, 0.12); color: var(--dsw-alias-state-error-primary, #e5534b); font-size: 12px; line-height: 1.5; text-align: center; }\n' +
      '.dsh-music-qq-head { flex: none; position: sticky; top: 0; z-index: 3; background: var(--dsw-alias-bg-overlay, #1e1f22); padding-bottom: 4px; }\n' +
      '.dsh-music-qq-body { flex: 1; overflow-y: auto; min-height: 0; }\n' +
      '.dsh-music-qq-section { font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); margin: 10px 0 4px; font-weight: 600; }\n' +
      '.dsh-music-qq-now { display: flex; align-items: center; gap: 4px; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.04)); font-size: 12px; color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      '.dsh-music-qq-now-name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-qq-now-artist { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary, #8a8f98); margin-left: 4px; }\n' +
      '.dsh-music-qq-now-src { flex: 0 0 auto; color: var(--dsw-alias-label-secondary, #8a8f98); margin-left: auto; }\n' +
      '.dsh-music-qq-toolbar { display: flex; justify-content: space-between; gap: 8px; align-items: center; margin-bottom: 12px; }\n' +
      // ---- 网络电台（radio）station 行：与在线歌单行同宽的 flex 布局 ----
      // 行 = [播放钮] [名称+meta 信息区（点击即播）] [收藏钮]。active 行用主题色描边。
      '.dsh-music-qq-station { display: flex; align-items: center; gap: 6px; width: 100%; box-sizing: border-box; padding: 2px; border-radius: 8px; }\n' +
      // 整行点播主体（复用 .dsh-music-track 透明 button 语义）：电台行内改为纵向两行布局。
      '.dsh-music-qq-station .dsh-music-track { flex: 1; min-width: 0; flex-direction: column; align-items: flex-start; gap: 1px; padding: 6px 8px; border-radius: 6px; }\n' +
      '.dsh-music-qq-station:hover { background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.04)); }\n' +
      '.dsh-music-qq-station.active { background: color-mix(in srgb, var(--dsh-music-accent, #2f9e6e) 12%, transparent); }\n' +
      '.dsh-music-qq-station.active .dsh-music-track { background: transparent; }\n' +
      '.dsh-music-qq-station-name { display: inline-flex; align-items: center; gap: 4px; min-width: 0; max-width: 100%; font-size: 13px; color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      '.dsh-music-qq-station.active .dsh-music-qq-station-name { color: var(--dsh-music-accent, #2f9e6e); font-weight: 600; }\n' +
      // 名字前缀状态图标（active 行）：播放中=❚❚ 暂停=▶ 的 SVG 版，与行高亮同色，恒定尺寸。
      '.dsh-music-qq-station-state { flex: none; display: inline-flex; align-items: center; }\n' +
      '.dsh-music-qq-station-state svg { display: block; width: 12px; height: 12px; }\n' +
      '.dsh-music-qq-station-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-qq-station-meta { font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }\n' +
      '.dsh-music-qq-station-tag { flex: none; font-size: 10px; padding: 0 4px; margin-left: 6px; border-radius: 4px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.35)); color: var(--dsw-alias-label-secondary, #8a8f98); vertical-align: 1px; }\n' +
      // HLS 格式徽章：可播（Host 转流），用 accent 信息色而非警告黄。
      '.dsh-music-qq-station-tag.hls { color: var(--dsh-music-accent, #2f9e6e); border-color: color-mix(in srgb, var(--dsh-music-accent, #2f9e6e) 45%, transparent); }\n' +
      '.dsh-music-qq-station-tag.bad { color: var(--dsw-alias-state-error-primary, #e5534b); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5534b) 45%, transparent); }\n' +
      '.dsh-music-qq-station-fav { flex: none; display: inline-flex; align-items: center; justify-content: center; border: none; background: transparent; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; padding: 2px 4px; }\n' +
      '.dsh-music-qq-station-fav svg { display: block; }\n' +
      '.dsh-music-qq-station-fav:hover { color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-qq-station-fav.on { color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-qq-login { flex: 1; min-height: 200px; display: flex; align-items: center; justify-content: center; }\n' +
      '.dsh-music-qq-login-center { display: flex; flex-direction: column; gap: 12px; align-items: center; max-width: 320px; }\n' +
      '.dsh-music-qq-login-dead { width: 100%; max-width: 300px; padding: 8px 10px; box-sizing: border-box; border: 1px solid var(--dsw-alias-state-error-border, rgba(216, 82, 80, 0.5)); border-radius: 6px; background: var(--dsw-alias-state-error-bg, rgba(216, 82, 80, 0.08)); color: var(--dsw-alias-state-error-primary, #d85250); font-size: 13px; line-height: 1.5; text-align: center; }\n' +
      '.dsh-music-qq-login-btn { width: 200px; padding: 10px 16px; font-size: 15px; }\n' +
      // 免责声明：居中块内的左对齐编号列表，阅读更清晰。
      '.dsh-music-qq-login-warn { display: flex; flex-direction: column; gap: 4px; width: 100%; max-width: 300px; margin-top: 4px; font-size: 12px; color: var(--dsw-alias-state-warn-primary, #d9a441); line-height: 1.5; text-align: left; box-sizing: border-box; max-height: 30vh; overflow-y: auto; }\n' +
      '.dsh-music-qq-login-warn-title { font-weight: 600; margin-bottom: 2px; }\n' +
      '.dsh-music-qq-login-warn-p { margin: 0; }\n' +
      '.dsh-music-qq-login-warn-item { display: flex; gap: 6px; align-items: flex-start; }\n' +
      '.dsh-music-qq-login-warn-num { flex: none; }\n' +
      // 讲书时章节名拼接在小说名后（复用 .dsh-music-bar-artist 样式），名称容器用默认
      // max-width:36%（与音乐「歌名 - 歌手」一致），不再单独给书名 24% 让空间。
      '.dsh-music-bar-src { margin-left: 6px; flex: 0 0 auto; white-space: nowrap; color: var(--dsh-music-accent, #2f9e6e); font-size: 11px; border: 1px solid var(--dsh-music-accent, #2f9e6e); border-radius: 6px; padding: 0 6px; line-height: 16px; }\n' +
      // 多标签页统一播放器：「此页静音」徽标——中性色，避免与音质/来源徽标（主题色）混淆。
      '.dsh-music-bar-xout { color: var(--dsw-alias-label-secondary, #8a8f98); border-color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-bar-artist { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 12px; margin-left: 6px; }\n' +
      '.dsh-music-bar-artist-name { margin-left: 6px; }\n' +
      '.dsh-music-toc-trigger { position: relative; flex: none; display: inline-flex; align-self: center; }\n' +
      // 章节目录弹层：与音量/播放模式弹窗同款定位观感——portal 到 body 后由
      // tocAnchorAbove 以内联 fixed + bottom 锚定（底边贴按钮上方 6px、高度限制在
      // 视口可用空间内）。这里仅保留结构样式与 CSS 兜底定位。
      '.dsh-music-toc { position: absolute; left: 50%; transform: translateX(-50%); bottom: calc(100% + 6px); width: 380px; max-height: 60vh; display: flex; flex-direction: column; gap: 8px; padding: 12px; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,0.35); color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 13px; z-index: 60; box-sizing: border-box; }\n' +
      '.dsh-music-toc-head { display: flex; align-items: center; gap: 6px; }\n' +
      '.dsh-music-toc-title { font-weight: 600; margin-right: auto; }\n' +
      '.dsh-music-toc-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }\n' +
      '.dsh-music-toc-item { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; padding: 5px 8px; border: none; background: transparent; border-radius: 6px; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 12px; }\n' +
      '.dsh-music-toc-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-toc-item.active { color: var(--dsh-music-accent, #2f9e6e); background: color-mix(in srgb, var(--dsh-music-accent, #2f9e6e) 14%, transparent); }\n' +
      '.dsh-music-toc-item.active .dsh-music-toc-heading { font-weight: 600; }\n' +
      '.dsh-music-toc-type { flex: none; font-size: 10px; padding: 1px 5px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.08)); color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-toc-item.active .dsh-music-toc-type { background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); }\n' +
      '.dsh-music-toc-heading { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      // 自建歌单：音乐页子标签 / 歌单详情 / 文件多选 / 播放条收藏
      '.dsh-music-subtabs { display: flex; gap: 4px; flex-wrap: wrap; }\n' +
      '.dsh-music-subtab { flex: none; padding: 4px 10px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: transparent; border-radius: 16px; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 12px; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-subtab:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-subtab.active { background: var(--dsh-music-accent, #2f9e6e); border-color: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); }\n' +
      '.dsh-music-subtab.add { width: 30px; padding: 4px 0; text-align: center; color: var(--dsh-music-accent, #2f9e6e); }\n' +
      // 每日新闻播报：定时任务卡片（时间/类别/开关/操作按钮）
      '.dsh-music-news-toolbar { flex: none; padding: 6px 10px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); }\n' +
      '.dsh-music-news-card-list { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px 10px; }\n' +
      '.dsh-music-news-card { box-sizing: border-box; width: 100%; max-width: 100%; display: flex; align-items: center; gap: 10px; padding: 8px 10px; background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.04)); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); border-radius: 10px; cursor: pointer; }\n' +
      '.dsh-music-news-card:hover { border-color: var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); }\n' +
      '.dsh-music-news-card.current { border-color: color-mix(in srgb, var(--dsh-music-accent, #2f9e6e) 55%, transparent); background: color-mix(in srgb, var(--dsh-music-accent, #2f9e6e) 8%, transparent); }\n' +
      '.dsh-music-news-card-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }\n' +
      '.dsh-music-news-card-title { display: flex; align-items: center; gap: 6px; min-width: 0; }\n' +
      '.dsh-music-news-card-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; font-weight: 600; color: var(--dsw-alias-label-primary, #e6e6e6); }\n' +
      '.dsh-music-news-card-meta { font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }\n' +
      '.dsh-music-news-card-badge { flex: none; font-size: 10px; line-height: 1; padding: 2px 5px; border-radius: 4px; color: var(--dsw-alias-label-secondary, #8a8f98); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); }\n' +
      '.dsh-music-news-card-badge.live { color: var(--dsh-music-accent, #2f9e6e); border-color: color-mix(in srgb, var(--dsh-music-accent, #2f9e6e) 55%, transparent); }\n' +
      '.dsh-music-news-card-actions { display: flex; align-items: center; gap: 4px; flex: none; }\n' +
      '.dsh-music-news-shift-card { box-sizing: border-box; width: 100%; max-width: 100%; display: flex; align-items: center; gap: 10px; padding: 8px 10px; background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.04)); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); border-radius: 10px; }\n' +
      '.dsh-music-news-shift-card:hover { border-color: var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); }\n' +
      '.dsh-music-news-shift-time { flex: none; font-size: 15px; font-weight: 600; color: var(--dsh-music-accent, #2f9e6e); font-variant-numeric: tabular-nums; }\n' +
      '.dsh-music-news-shift-badge { flex: none; font-size: 10px; line-height: 1; padding: 2px 5px; border-radius: 4px; color: var(--dsh-music-accent, #2f9e6e); border: 1px solid color-mix(in srgb, var(--dsh-music-accent, #2f9e6e) 55%, transparent); white-space: nowrap; }\n' +
      '.dsh-music-news-shift-scope { flex: 1; min-width: 0; font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      '.dsh-music-news-shift-actions { flex: none; display: flex; align-items: center; gap: 2px; }\n' +
      '.dsh-music-news-shift-toggle { flex: none; display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; white-space: nowrap; padding: 0 6px; }\n' +
      '.dsh-music-news-shift-empty { padding: 10px; text-align: center; font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); border: 1px dashed var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 10px; }\n' +
      '.dsh-music-news-shift-modal { width: 360px; max-width: 90vw; overflow-y: auto; }\n' +
      '.dsh-music-news-field-label { font-size: 12px; font-weight: 600; margin-bottom: 4px; }\n' +
      '.dsh-music-news-field { display: flex; flex-direction: column; }\n' +
      '.dsh-music-news-time-input { box-sizing: border-box; width: 120px; padding: 4px 6px; font-size: 13px; color: var(--dsw-alias-label-primary, #e6e6e6); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 8px; outline: none; }\n' +
      '.dsh-music-news-time-input:focus { border-color: var(--dsh-music-accent, #2f9e6e); }\n' +
      // 新闻播报 pane：撑满列表区、纵向滚动只作用于下方内容（头部/操作栏固定不滚）。
      '.dsh-music-news-pane { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }\n' +
      '.dsh-music-news-pane-inner { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }\n' +
      '.dsh-music-news-head { flex: none; }\n' +
      '.dsh-music-news-body { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; }\n' +
      '.dsh-music-playlist { display: flex; flex-direction: column; flex: 1; }\n' +
      '.dsh-music-playlist-empty { flex: 1; display: flex; align-items: center; justify-content: center; }\n' +
      '.dsh-music-playlist-head { display: flex; align-items: center; gap: 6px; padding: 2px 2px 0; }\n' +
      '.dsh-music-playlist-btn { flex: none; background: transparent; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); border-radius: 6px; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 11px; padding: 2px 8px; }\n' +
      '.dsh-music-playlist-btn:hover { color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-playlist-missing { flex: none; margin-left: auto; font-size: 11px; color: var(--dsw-alias-state-warn-primary, #d9a441); }\n' +
      '.dsh-music-playlist-row { display: flex; align-items: center; gap: 4px; }\n' +
      '.dsh-music-playlist-row .dsh-music-track { flex: 1; min-width: 0; }\n' +
      '.dsh-music-playlist-row.active { border-radius: 6px; background: color-mix(in srgb, var(--dsh-music-accent, #2f9e6e) 14%, transparent); }\n' +
      '.dsh-music-playlist-row.active .dsh-music-track { color: var(--dsh-music-accent, #2f9e6e); background: transparent; }\n' +
      '.dsh-music-playlist-row.active .dsh-music-track-name { font-weight: 600; }\n' +
      '.dsh-music-playlist-mini { flex: none; width: 20px; height: 20px; padding: 0; border: none; background: transparent; border-radius: 4px; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; font-size: 12px; line-height: 1; }\n' +
      '.dsh-music-playlist-mini:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-playlist-mini.del:hover { color: var(--dsw-alias-state-error-primary, #e5534b); }\n' +
      '.dsh-music-file-item { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; padding: 6px 8px; border: none; background: transparent; border-radius: 6px; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 12px; }\n' +
      '.dsh-music-file-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }\n' +
      '.dsh-music-file-item.checked { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.1)); color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-file-check { flex: none; width: 14px; height: 14px; border-radius: 3px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.4)); display: inline-flex; align-items: center; justify-content: center; font-size: 10px; }\n' +
      '.dsh-music-file-item.checked .dsh-music-file-check { background: var(--dsh-music-accent, #2f9e6e); border-color: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); }\n' +
      '.dsh-music-file-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n' +
      // 曲库每行：track 按钮 + 行尾「＋」（加入歌单）
      '.dsh-music-track-row { display: flex; align-items: center; gap: 4px; }\n' +
      '.dsh-music-track-row .dsh-music-track { flex: 1; min-width: 0; }\n' +
      '.dsh-music-track-row.active { border-radius: 6px; background: color-mix(in srgb, var(--dsh-music-accent, #2f9e6e) 14%, transparent); }\n' +
      '.dsh-music-track-row.active .dsh-music-track { color: var(--dsh-music-accent, #2f9e6e); background: transparent; }\n' +
      '.dsh-music-track-row.active .dsh-music-track-name { font-weight: 600; }\n' +
      '.dsh-music-playlist-mini.add { color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-playlist-mini.remove { color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-playlist-mini.remove:hover { color: var(--dsw-alias-state-error-primary, #e5534b); }\n' +
      '.dsh-music-add-pop { position: fixed; z-index: 1200; min-width: 150px; max-width: 210px; display: flex; flex-direction: column; gap: 2px; padding: 6px; background: var(--dsw-alias-bg-overlay, #1e1f22); border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35)); border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.3); }\n' +
      '.dsh-music-add-pop-item { display: block; width: 100%; text-align: left; padding: 5px 8px; border: none; background: transparent; border-radius: 6px; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n' +
      '.dsh-music-add-pop-item:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-add-pop-item.new { color: var(--dsh-music-accent, #2f9e6e); border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2)); margin-top: 2px; padding-top: 6px; }\n' +
      // 「加入歌单」成功/失败提示：面板窗口内绝对居中，颜色跟随 DSH 主题
      // （成功 = 主题强调色 --dsh-music-accent；失败 = 主题错误色），2s 自动消失。
      '.dsh-music-panel-toast { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 20; padding: 8px 18px; border-radius: 8px; font-size: 13px; font-weight: 500; color: var(--dsh-music-accent-fg, #fff); background: rgba(30,31,34,0.92); box-shadow: 0 6px 20px rgba(0,0,0,0.35); pointer-events: none; white-space: nowrap; max-width: 90%; text-align: center; animation: dsh-music-toast-in 0.18s ease; }\n' +
      '.dsh-music-panel-toast.ok { background: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-panel-toast.err { background: var(--dsw-alias-state-error-primary, #e5534b); }\n' +
      '@keyframes dsh-music-toast-in { from { opacity: 0; transform: translate(-50%, -50%) scale(0.94); } to { opacity: 1; transform: translate(-50%, -50%) scale(1); } }\n' +
      '.dsh-music-bar-btn.fav { color: var(--dsw-alias-label-secondary, #8a8f98); }\n' +
      '.dsh-music-bar-btn.fav:hover { color: var(--dsh-music-accent-fg, #fff); }\n' +
      '.dsh-music-bar-btn.fav.on { color: var(--dsh-music-accent, #2f9e6e); }\n' +
      '.dsh-music-bar-btn.fav.on:hover { color: var(--dsh-music-accent-fg, #fff); }\n';

    var DOCK_CSS = [
      // DSH 只在 <body> 定义 --dsw-alias-*，:root 上引用会退化 → 照抄对方 :11390 声明在 body。
      // 皮肤反制（对方 :11391-11393 原文，含注释里的成因）。
      // ---- 显示位置：页面底部（.bottom）—— 对方 :11396-11413 ----
      // 让位规则：标记属性只在 bottom 模式挂，切走即摘，不留副作用（对方 :11408-11413）。
      ":root[data-smp-music-bar-bottom] [data-composer-seat] { padding-bottom: " + SMP_BAR_BOTTOM_PAD + "px; }",
      // ---- S3b 内容块：只**新增**类，上方照抄声明一个字不改 ----
      // 封面（迷你黑胶/封面图）
      ".smp-music-bar-cover { width: 20px; height: 20px; border-radius: 3px; flex: 0 0 auto; display: block; object-fit: cover; background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.06)); }",
      ".smp-music-bar-cover-ph { width: 20px; height: 20px; border-radius: 3px; flex: 0 0 auto; display: flex; align-items: center; justify-content: center; font-size: 11px; line-height: 1; background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.06)); }",
      // 曲名 + 品质徽章
      ".smp-music-bar-badge { flex: 0 0 auto; padding: 0 6px; border: 1px solid rgba(255,255,255,0.35); border-radius: 999px; font-size: 10px; line-height: 16px; white-space: nowrap; opacity: 0.85; }",
      // 音频块（我们侧边栏那套缩放：频谱 60×20 + 音准 chip，总宽 ≤180px）
      ".smp-music-bar-viz { width: 60px; height: 20px; flex: 0 0 auto; display: block; }",
      // 音准 chip 的 CSS 已随节点一起删除（用户要求条上不显示音准）。
      // 单行歌词（本地同名 .lrc / 在线 /qq/lyric 行级；无歌词显示占位文案）
      ".dsh-music-bar-lyric.empty { opacity: 0.45; }",
      // 控件区（照抄对方 :11560 / :11548 / :11530-11531；按钮 24×24 圆形）
      // 音量：容器/按钮/竖排弹层 + 自绘滑杆 —— 全部照抄对方（client.js L11533–L11545）
      // 播放列表按钮：类名与 A-5 对齐（.dsh-music-mode-trigger），基础尺寸、悬停、
      // 打开态（.active = accent 绿底）全部由 A-5 提供，这里只补 svg 尺寸。
      // （原先自造的 .smp-music-mode-trigger.hl 常亮白底已删除 —— 那是假状态，A-5 里没有。）
      ".dsh-music-mode-trigger > svg { width: 14px; height: 14px; display: block; fill: currentColor; }",
      // 底部进度线（照抄对方 :11471-11472：1px 绝对定位 + pointer-events:none）
      // 🔴 唯一加法：透明命中区（视觉 0 像素，只负责 seek）
      // 窄宽度必需：A-5 原文的 .dsh-music-bar 没有 min-width:0，flex 子项不给就会把歌名/歌词撑溢出。
      // 这是我们在「照抄」之外唯一的补充声明（属性值层面，不改任何原数值）。
      ".dsh-music-bar { min-width: 0; }",
      // 条高 34 → 46（2026-11-11 用户要求）。**不改 A-5 原文**，只在它后面追加同特异性覆盖：
      // 注入顺序是 SMP_REF_CSS + "\n" + DOCK_CSS，同特异性下后者胜。
      // 46 = 6(padTop) + 30(封面/频谱上限) + 6(padBottom) + 2(上下边框) + 2(余量)。
      ".dsh-music-bar { min-height: 46px; padding: 6px 300px 6px 12px; font-size: 13px; }",
      ".dsh-music-bar-wrap.float .dsh-music-bar { padding: 6px 12px; }",
      ".smp-music-bar-cover, .smp-music-bar-cover-ph { width: 30px; height: 30px; }",
      ".smp-music-bar-cover-ph { font-size: 13px; }",
      ".smp-music-bar-progress-hit { position: absolute; left: 0; right: 0; bottom: 0; height: 13px; z-index: 3; cursor: pointer; touch-action: none; pointer-events: auto; }",
      // 迷你黑胶已撤（用户要求换成标题左侧音符图标 MusicNote），连带 spinning 动画一并删除。
      // ---- S4b 窄宽度自适应 + 歌词切换动效 ----
      // 极窄按优先级隐藏：先藏音准 chip（<360px），再藏频谱（<300px）；歌名与歌词永不隐藏。
      // 极窄按优先级隐藏：只剩频谱一档（<300px 藏频谱）；歌名与歌词永不隐藏。
      ".dsh-music-bar-wrap[data-narrow=\"2\"] .smp-music-bar-viz { width: 40px; }",
      ".dsh-music-bar-lyric { transition: opacity 0.25s ease, transform 0.25s ease; }",
      ".smp-lyric-fx-slide { animation: smp-lyric-slide 0.26s ease; }",
      "@keyframes smp-lyric-slide { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }",
      ".smp-lyric-fx-blur { animation: smp-lyric-blur 0.30s ease; }",
      "@keyframes smp-lyric-blur { from { opacity: 0; filter: blur(4px); } to { opacity: 1; filter: blur(0); } }",
      // 卡拉OK档（用户当前选的档）：做成彩色呼吸 + 光晕。不依赖 background-clip:text，
      // 任何环境都可见；旧实现只挂 smp-lyric-slide，和「上滑淡入」一模一样，所以用户会觉得「炫彩没了」。
      ".smp-lyric-fx-karaoke { color: #7ad4ff; text-shadow: 0 0 10px rgba(76,141,255,0.50), 0 0 20px rgba(180,140,255,0.28); animation: smp-lyric-karaoke-glow 2.4s ease-in-out infinite alternate; }",
      "@keyframes smp-lyric-karaoke-glow { 0% { color: #7ad4ff; text-shadow: 0 0 9px rgba(76,141,255,0.42), 0 0 18px rgba(180,140,255,0.22); } 50% { color: #b48cff; text-shadow: 0 0 13px rgba(180,140,255,0.55), 0 0 24px rgba(76,141,255,0.30); } 100% { color: #35d0a8; text-shadow: 0 0 9px rgba(53,208,168,0.45), 0 0 18px rgba(240,169,74,0.22); } }",
      ".smp-lyric-fx-none { animation: none; }",
      // 播放失败：歌词位改显中文提示，颜色吃主题的危险色（不写死红值，浅色主题下也读得清）
      ".dsh-music-bar-lyric.err { color: var(--dsw-alias-label-danger, var(--dsw-alias-label-primary, #e6e6e6)); font-weight: 600; }",
      // 面板主体同一提示（不吃写死颜色，浅色主题下也读得清）
      ".smp-play-err { margin: 6px 0 0; padding: 6px 10px; border-radius: 6px; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-danger, var(--dsw-alias-label-primary, #e6e6e6)); background: color-mix(in srgb, currentColor 12%, transparent); border: 1px solid color-mix(in srgb, currentColor 28%, transparent); }",
      // 第 5 档「炫彩」：纯 CSS 渐变扫光（不给每个字加节点），色标与频谱同一套四段色。
      // 兜底：不支持 background-clip:text 的环境由渲染层退回 slide（见 smpPickLyricFx），
      //       绝不靠 color:transparent 硬撑 —— 那样会变成"字看不见"。
      ".smp-lyric-fx-rainbow { background-image: linear-gradient(90deg, #35d0a8, #4c8dff, #b48cff, #f0a94a, #35d0a8); background-size: 300% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; -webkit-text-fill-color: transparent; animation: smp-lyric-rainbow 6s linear infinite; }",
      "@keyframes smp-lyric-rainbow { 0% { background-position: 0% 50%; } 100% { background-position: 300% 50%; } }",
      // ---- S5 前置：本地音乐页（页签注册待 Lead 接口结论后再接）----
      ".smp-lib { display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 6px; font-size: 12px; }",
      ".smp-lib-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; flex: 0 0 auto; }",
      ".smp-lib-root { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.75; font-size: 11px; }",
      ".smp-lib-btn { flex: 0 0 auto; height: 24px; padding: 0 10px; border-radius: 6px; cursor: pointer; font-size: 12px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.03)); color: var(--dsw-alias-label-primary, #222); }",
      ".smp-lib-btn:hover { background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.07)); }",
      ".smp-lib-hint { flex: 0 0 auto; font-size: 11px; opacity: 0.65; }",
      ".smp-lib-body { flex: 0 0 auto; min-height: 0; overflow: visible; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.18)); border-radius: 8px; }",
      ".smp-lib-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 6px; padding: 6px; }",
      ".smp-lib-row { display: flex; flex-direction: column; align-items: stretch; gap: 3px; padding: 7px 9px; cursor: pointer; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.14)); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.02)); min-width: 0; }",
      ".smp-lib-row:hover { background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.06)); border-color: rgba(128,128,128,0.3); }",
      ".smp-lib-row.active { background: var(--dsw-alias-bg-layer-3, rgba(0,0,0,0.10)); border-color: var(--dsh-music-accent, #2f9e6e); }",
      ".smp-lib-grid .smp-lib-name { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; white-space: normal; word-break: break-all; line-height: 1.35; flex: none; }",
      ".smp-qq-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 5px; padding: 5px; }",
      ".smp-qq-card { position: relative; display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.14)); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.02)); cursor: pointer; min-width: 0; }",
      ".smp-qq-card:hover { background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,0.06)); border-color: rgba(128,128,128,0.3); }",
      ".smp-qq-card.active { background: var(--dsw-alias-bg-layer-3, rgba(0,0,0,0.10)); border-color: var(--dsh-music-accent, #2f9e6e); }",
      ".smp-qq-card-top { display: flex; align-items: center; gap: 4px; }",
      ".smp-qq-card-play { font-size: 11px; opacity: 0.7; }",
      ".smp-qq-card-title { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; white-space: normal; word-break: break-all; font-size: 12px; line-height: 1.35; }",
      ".smp-qq-card-artist { font-size: 10px; opacity: 0.6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
      ".smp-qq-card .dsh-music-playlist-mini { position: absolute; top: 4px; right: 4px; opacity: 0.45; }",
      ".smp-qq-card:hover .dsh-music-playlist-mini { opacity: 1; }",
      ".smp-lib-idx { flex: 0 0 auto; width: 28px; text-align: right; opacity: 0.45; font-variant-numeric: tabular-nums; }",
      ".smp-lib-name { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
      ".smp-lib-tag { flex: 0 0 auto; font-size: 10px; line-height: 14px; padding: 0 5px; border-radius: 3px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); opacity: 0.75; }",
      // 行内播放键（不占宽度预算：小圆点，hover 才亮）
      ".smp-lib-play { flex: 0 0 auto; width: 18px; height: 18px; padding: 0; border: none; border-radius: 50%; background: transparent; color: var(--dsh-music-accent, #2f9e6e); font-size: 10px; line-height: 18px; cursor: pointer; opacity: 0.55; }",
      ".smp-lib-play:hover { opacity: 1; background: rgba(47,158,110,0.14); }",
      // 403 围栏提示条（列表保留，只在上面挂一条）
      ".smp-lib-forbidden { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; padding: 8px 10px; border: 1px solid var(--dsw-alias-state-warning-primary, #d9a441); border-radius: 8px; background: rgba(217,164,65,0.10); }",
      ".smp-lib-403-t { font-size: 12px; font-weight: 600; color: var(--dsw-alias-state-warning-primary, #d9a441); }",
      ".smp-lib-403-h { font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); }",
      ".smp-lib-403-raw { font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); white-space: pre-wrap; word-break: break-all; opacity: 0.85; }",
      ".smp-lib-size { flex: 0 0 auto; width: 68px; text-align: right; opacity: 0.55; font-variant-numeric: tabular-nums; font-size: 11px; }",
      ".smp-lib-meta { display: flex; align-items: center; gap: 5px; flex: none; margin-top: 1px; }",
      ".smp-lib-meta .smp-lib-tag { font-size: 9px; line-height: 12px; padding: 0 4px; opacity: 0.7; }",
      ".smp-lib-meta .smp-lib-size { width: auto; flex: 0 0 auto; text-align: left; font-size: 9px; line-height: 12px; opacity: 0.62; }",
      ".smp-lib-empty, .smp-lib-err { padding: 18px 10px; text-align: center; opacity: 0.7; }",
      ".smp-lib-err { color: #c0392b; }",
      ".smp-lib-foot { flex: 0 0 auto; font-size: 11px; opacity: 0.6; }",
      // ── 自绘目录浏览器（P0；遮罩 fixed + 高层级，避开父级 overflow:hidden）──
      ".smp-pick-mask { position: fixed; inset: 0; z-index: 9999; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.45); }",
      ".smp-pick-panel { display: flex; flex-direction: column; width: min(560px, 92vw); max-height: min(70vh, 620px); min-height: 0; background: var(--dsw-alias-bg-layer-1, #1f1f1f); color: var(--dsw-alias-label-primary, #e6e6e6); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,0.45); overflow: hidden; }",
      ".smp-pick-head { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.18)); }",
      ".smp-pick-title { font-size: 13px; font-weight: 600; }",
      ".smp-pick-x { margin-left: auto; width: 24px; height: 24px; border-radius: 50%; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); background: transparent; color: inherit; cursor: pointer; line-height: 1; padding: 0; }",
      ".smp-pick-bar { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; padding: 8px 12px; }",
      ".smp-pick-btn { flex: 0 0 auto; height: 24px; padding: 0 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.28)); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); color: inherit; font-size: 12px; cursor: pointer; }",
      ".smp-pick-btn.primary { border-color: transparent; background: var(--dsh-music-accent, #2f9e6e); color: #fff; }",
      ".smp-pick-path { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; opacity: 0.7; }",
      ".smp-pick-body { flex: 1 1 0; min-height: 0; overflow: auto; padding: 4px 8px 8px; }",
      ".smp-pick-row { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 6px; cursor: pointer; font-size: 12px; }",
      ".smp-pick-row:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.07)); }",
      ".smp-pick-row.file { opacity: 0.85; }",
      ".smp-pick-ico { flex: 0 0 auto; width: 16px; text-align: center; }",
      ".smp-pick-name { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
      ".smp-pick-foot { flex: 0 0 auto; display: flex; justify-content: flex-end; padding: 8px 12px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.18)); }",
      ".smp-pick-empty { padding: 18px 8px; text-align: center; font-size: 12px; opacity: 0.55; }",
      ".smp-pick-err { padding: 14px 10px; font-size: 12px; color: #c0392b; word-break: break-all; }",
      ".smp-pick-note { flex: 0 0 auto; padding: 0 12px 8px; font-size: 11px; opacity: 0.7; }",
      // ── 目录浏览器：面包屑 / 403 提示 / 文件元信息 / 禁用态 ──
      ".smp-pick-crumbs { flex: 0 0 auto; display: flex; flex-wrap: wrap; align-items: center; gap: 2px; padding: 0 12px 6px; font-size: 11px; }",
      ".smp-pick-crumb { padding: 1px 5px; border-radius: 4px; cursor: pointer; color: var(--dsw-alias-label-secondary, #8a8f98); white-space: nowrap; }",
      ".smp-pick-crumb:hover { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); color: var(--dsw-alias-label-primary, #e6e6e6); }",
      ".smp-pick-crumb.cur { color: var(--dsw-alias-label-primary, #e6e6e6); cursor: default; }",
      ".smp-pick-crumb + .smp-pick-crumb::before { content: '\\203A'; margin-right: 5px; opacity: 0.45; }",
      ".smp-pick-meta { flex: 0 0 auto; margin-left: auto; padding-left: 8px; font-size: 10.5px; opacity: 0.55; white-space: nowrap; }",
      ".smp-pick-btn.disabled, .smp-pick-btn:disabled { opacity: 0.4; cursor: not-allowed; }",
      ".smp-pick-403 { padding: 14px 12px; font-size: 12px; line-height: 1.6; }",
      // ── 侧边栏主面板「播放器」（第①步：骨架 + 空态） ──
      ".smp-pp { display: flex; flex-direction: column; height: 100%; min-height: 0; box-sizing: border-box; color: var(--dsw-alias-label-primary, #e6e6e6); }",
      ".smp-pp-bar { flex: 0 0 auto; padding: 8px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2)); }",
      ".smp-pp-player { flex: 0 0 auto; padding: 6px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2)); }",
      // 面板主体：高度由内容撑（真高度已在内联 style 里按 mode 分开写，这里只做优先级兜底 ——
      //  内联 style 优先级高于本文件任何选择器，光靠这条 CSS 改不动内联的 height:100%）。
      // ⚠️ 内联 style 优先于任何选择器：height/overflow 由 SmpPlayerBody 根节点内联按模式给出，
      //    写在这条里不生效（上一轮加的 height:auto 就是死代码，已删）。只保留内联给不了的 padding/gap。
      ".smp-pp-player .smp-player-body.panel { padding: 0; gap: 8px; }",
      ".smp-pp-placeholder { font-size: 12px; color: var(--dsw-alias-label-secondary, #8a8f98); }",
      ".smp-pp-tabs { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2)); }",
      ".smp-pp-tab { height: 24px; padding: 0 10px; border-radius: 999px; border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 12px; cursor: pointer; }",
      ".smp-pp-tab.active { color: var(--dsw-alias-label-primary, #e6e6e6); border-color: var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06)); }",
      ".smp-pp-body { flex: 1 1 0; min-height: 240px; overflow-y: auto; padding: 12px; }",
    // ── 第⑤步：QQ 面板的浮层（提示 / 自绘输入框 / 自绘确认框）──
    // 一律 position:fixed：即使 qqPortal 拿不到 react-dom 退回"原地渲染"，
    // 也不会被 .smp-pp-body 的 overflow:auto 裁掉。
    ".smp-ov-layer { position: fixed; inset: 0; z-index: 60; pointer-events: none; }",
    ".smp-ov-toast { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); max-width: 320px; padding: 8px 14px; border-radius: 8px; font-size: 13px; line-height: 1.4; text-align: center; box-shadow: 0 6px 24px rgba(0,0,0,.28); pointer-events: none; background: var(--dsw-alias-bg-elevated, #2a2d33); color: var(--dsw-alias-label-primary, #f2f3f5); }",
    ".smp-ov-toast.ok { background: var(--dsw-alias-state-success, #2f9e6e); color: #fff; }",
    ".smp-ov-toast.err { background: var(--dsw-alias-state-danger, #d9534f); color: #fff; }",
    ".smp-ov-card { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 320px; max-height: 70vh; overflow: auto; padding: 14px; border-radius: 10px; pointer-events: auto; background: var(--dsw-alias-bg-elevated, #2a2d33); color: var(--dsw-alias-label-primary, #f2f3f5); box-shadow: 0 10px 40px rgba(0,0,0,.38); }",
    ".smp-ov-title { font-size: 13px; font-weight: 600; margin-bottom: 10px; }",
    ".smp-ov-msg { font-size: 12px; line-height: 1.5; opacity: .85; margin-bottom: 12px; white-space: pre-wrap; }",
    ".smp-ov-input { width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 6px; font-size: 13px; background: var(--dsw-alias-bg-base, #1e2024); color: inherit; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35)); outline: none; }",
    ".smp-ov-btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }",
    ".smp-ov-btn { padding: 5px 14px; border-radius: 6px; font-size: 12px; cursor: pointer; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35)); background: transparent; color: inherit; }",
    ".smp-ov-btn.primary { background: var(--dsh-music-accent, #2f9e6e); color: var(--dsh-music-accent-fg, #fff); border-color: transparent; }",
    ".smp-ov-btn.danger { background: var(--dsw-alias-state-danger, #d9534f); color: #fff; border-color: transparent; }",
      ".smp-pp-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; min-height: 160px; text-align: center; color: var(--dsw-alias-label-secondary, #8a8f98); font-size: 12px; }",
      ".smp-pp-empty-t { font-size: 13px; color: var(--dsw-alias-label-primary, #e6e6e6); }",
      ".smp-pick-403-t { font-weight: 600; color: var(--dsw-alias-label-primary, #e6e6e6); margin-bottom: 4px; }",
      ".smp-pick-403-h { color: var(--dsw-alias-label-secondary, #8a8f98); }",
      ".smp-pick-403-raw { margin-top: 8px; padding: 6px 8px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.05)); font-size: 11px; opacity: 0.75; word-break: break-all; white-space: pre-wrap; }",
      // 队列面板：壳复用 A-5 的 .dsh-music-lyric-panel，行复用 lyric-line + active，
      // 这里只把字号压小（面板行 16px 太大）并给可点态一点反馈。
      ".smp-queue-row { cursor: pointer; }",
      ".smp-queue-row .dsh-music-lyric-line-text { font-size: 13px; line-height: 1.5; }",
      ".smp-queue-row.active .dsh-music-lyric-line-text { font-size: 13px; }",
      ".smp-queue-row:hover .dsh-music-lyric-line-text { color: var(--dsw-alias-label-primary, #e6e6e6); }",
      ".smp-queue-empty { padding: 20px 14px; text-align: center; font-size: 12px; line-height: 1.7; color: var(--dsw-alias-label-secondary, #8a8f98); }"
    ].join("\n");

    /* =========================================================================
     * S4 · 在线歌词（QQ）加载与归一
     *   回落链：/qq/lyric-words（hasWords）→ /qq/lyric 的 wordLines（行级）
     *           → /qq/lyric 的 lines → lrc(+trans) → 都没有则"无歌词"
     *   两处实测坑（Lead 3+1 转达）：
     *     ① 逐字时间轴会「卡字」：相邻字间隔 > 3s（实测有 30.9s 的）→ 该行按 {t,end} 均分回退
     *     ② 头几行是署名行（"作词人：xxx" / "作曲人：xxx"）→ 过滤，不参与显示
     * 🔴 只在本块生效；照抄面板吃它自己的行级 wordLines，不受影响。
     * ========================================================================= */
    var SMP_LYRIC_META_RE = /^(作词|作曲|编曲|制作人|制作|演唱|原唱|出品|监制|混音|母带|统筹|发行)(人|家|者)?\s*[:：]/;

    function smpIsMetaLyric(text) {
      return SMP_LYRIC_META_RE.test(String(text || "").replace(/^\s+|\s+$/g, ""));
    }

    /** wordLines → [{t, end, text, words}]；卡字行均分、署名行剔除。 */
    function smpNormalizeWordLines(wordLines) {
      var out = [];
      if (!wordLines || !wordLines.length) return out;
      for (var i = 0; i < wordLines.length; i++) {
        var ln = wordLines[i] || {};
        var text = String(ln.text || "");
        if (!text) continue;
        if (smpIsMetaLyric(text)) continue;
        var t = Number(ln.t);
        if (!isFinite(t) || t < 0) continue;
        var end = Number(ln.end);
        if (!isFinite(end) || end <= t) end = t;
        var words = null;
        if (ln.words && ln.words.length) {
          var prev = null, stuck = false, ws = [];
          for (var j = 0; j < ln.words.length; j++) {
            var w = ln.words[j] || {};
            var wt = Number(w.t);
            if (!isFinite(wt)) continue;
            if (prev !== null && (wt - prev) > 3) stuck = true;
            prev = wt;
            ws.push({ t: wt, dur: Number(w.dur) || 0, text: String(w.text || "") });
          }
          if (ws.length) {
            if (stuck) {
              // 均分回退：把 [t, end] 平均分给每个字。
              // 若均分后每字仍 > 3s（整行横跨太久，实测 39.42s / 4 字），说明上游逐字轴
              // 已经不可挽救 → 干脆放弃逐字（words=null），由歌块走行级高亮，绝不卡字。
              var span = (end > t) ? (end - t) : Math.max(1, ws.length * 0.35);
              var stepW = span / ws.length;
              if (stepW > 3) {
                words = null;
              } else {
                for (var k = 0; k < ws.length; k++) { ws[k].t = t + k * stepW; ws[k].dur = stepW; }
                words = ws;
              }
            } else {
              words = ws;
            }
          }
        }
        out.push({ t: t, end: end, text: text, words: words });
      }
      return out;
    }

    /** lrc / lines（秒制 {t,text} 或 {t,end,text}）→ 同构行列表。 */
    function smpNormalizeLrcLines(lrc) {
      var out = [];
      if (!lrc || !lrc.length) return out;
      for (var i = 0; i < lrc.length; i++) {
        var ln = lrc[i] || {};
        var text = String(ln.text || "");
        if (!text) continue;
        if (smpIsMetaLyric(text)) continue;
        var t = Number(ln.t);
        if (!isFinite(t) || t < 0) continue;
        var end = Number(ln.end);
        out.push({ t: t, end: (isFinite(end) && end > t) ? end : 0, text: text, words: null });
      }
      return out;
    }

    /** 拉在线歌词。base 一律根相对路径（绝不拼宿主 origin）。cb(null) 表示 songmid 无效。 */
    function smpFetchQQLLyric(songmid, cb) {
      var mid = String(songmid || "");
      var done = function (res) { try { cb(res); } catch (e0) {} };
      if (!mid) { done(null); return; }
      var base = "/dsh-sidebar-media-player/qq";
      var toLines = function (arr) {
        var ls = [];
        for (var i = 0; i < arr.length; i++) ls.push({ t: arr[i].t, text: arr[i].text });
        return ls;
      };
      var none = { ok: true, source: "none", lines: [], wordLines: [] };
      fetch(base + "/lyric-words?songmid=" + encodeURIComponent(mid), { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var wl = (d && d.ok && d.hasWords && d.wordLines) ? smpNormalizeWordLines(d.wordLines) : null;
          if (wl && wl.length) { done({ ok: true, source: "qq-words", lines: toLines(wl), wordLines: wl }); return null; }
          return fetch(base + "/lyric?songmid=" + encodeURIComponent(mid), { cache: "no-store" })
            .then(function (r2) { return r2.json(); })
            .then(function (d2) {
              if (!d2 || d2.ok !== true) { done(none); return; }
              var wl2 = d2.wordLines ? smpNormalizeWordLines(d2.wordLines) : null;
              if (wl2 && wl2.length) { done({ ok: true, source: "qq-lines", lines: toLines(wl2), wordLines: wl2 }); return; }
              var ls2 = smpNormalizeLrcLines(d2.lines);
              if (ls2.length) { done({ ok: true, source: "qq-lines", lines: toLines(ls2), wordLines: [] }); return; }
              var lrc = smpNormalizeLrcLines(d2.lrc);
              if (lrc.length) { done({ ok: true, source: "qq-lrc", lines: toLines(lrc), wordLines: [] }); return; }
              done(none);
            });
        })
        .catch(function () { done({ ok: false, source: "none", lines: [], wordLines: [] }); });
    }

    /* =========================================================================
     * S3b · 条内容工具（外壳照抄不变，内容用我们侧边栏那套缩放进来）
     *
     * 🔴 迷你频谱**独立绘制**，不改侧边栏的 drawSpectrum：那个函数共用模块级
     *    __specState（bins/峰值包络），侧边栏与播放条同时画会互相重置柱数而抖。
     *    这里复用同一套**画法工具**（specFitCanvas / specRampColor / specRgba /
     *    specLighten / specColumnPath）与同一组频段常量，所以视觉一致（四段色相
     *    渐变 + 顶部 1px 高光 + 峰值保持线），但状态自持。
     * ========================================================================= */
    var SMP_VIZ_W = 60;
    var SMP_VIZ_H = 26;
    var SMP_VIZ_MIN_BARS = 8;
    var SMP_VIZ_MAX_BARS = 18;
    var __smpMini = { bars: 0, env: null, peak: null };
    // __smpChip（条上音准读数的时域缓冲）已随「条上删音准 chip」一起删除；面板主体用的是自己那份。
    var __smpFreq = null;

    /** 条上复用同一 analyser 的频域缓冲（复用数组，避免每帧分配）。 */
    function __smpFreqBuf(an) {
      if (!__smpFreq || __smpFreq.length !== an.frequencyBinCount) {
        __smpFreq = new Uint8Array(an.frequencyBinCount);
      }
      // 这一句以前漏了：只分配缓冲不读数 → 条上 60×20 频谱恒空白。
      an.getByteFrequencyData(__smpFreq);
      return __smpFreq;
    }

    function smpMiniSlot(bars) {
      if (__smpMini.bars === bars) return;
      __smpMini.bars = bars;
      __smpMini.env = new Float32Array(bars);
      __smpMini.peak = new Float32Array(bars);
    }

    /** 在 60×20 的小 canvas 上画频谱；bins 为空则画静音残桩。 */
    function smpDrawMiniViz(canvas, bins, sampleRate, fftSize) {
      var c2d = canvas.getContext && canvas.getContext("2d");
      if (!c2d) return;
      var dims = specFitCanvas(canvas);
      var w = dims.w, h = dims.h, dpr = dims.dpr;
      c2d.clearRect(0, 0, w, h);
      var pad = 1 * dpr;
      var innerW = w - pad * 2;
      var innerH = h - pad * 2;
      if (innerW <= 4 || innerH <= 4) return;

      var bars = Math.floor(innerW / (4 * dpr));
      if (bars < SMP_VIZ_MIN_BARS) bars = SMP_VIZ_MIN_BARS;
      if (bars > SMP_VIZ_MAX_BARS) bars = SMP_VIZ_MAX_BARS;
      smpMiniSlot(bars);
      var env = __smpMini.env, peak = __smpMini.peak;
      var slot = innerW / bars;
      var gap = slot * 0.28;
      var barW = Math.max(1, slot - gap);
      var botW = Math.max(1, barW * 0.55);

      var binHz = (sampleRate > 0 && fftSize > 0) ? (sampleRate / fftSize) : 0;
      var maxBin = (bins && bins.length) ? bins.length : 0;
      var f0 = SPECTRUM_MIN_HZ;
      var step = Math.pow(SPECTRUM_MAX_HZ / SPECTRUM_MIN_HZ, 1 / bars);
      for (var i = 0; i < bars; i++) {
        var f1 = f0 * step;
        var v = 0;
        if (bins && binHz > 0 && maxBin > 0) {
          var b0 = Math.max(0, Math.floor(f0 / binHz));
          var b1 = Math.min(maxBin - 1, Math.ceil(f1 / binHz));
          var sum = 0, n = 0;
          for (var b = b0; b <= b1; b++) { sum += bins[b]; n += 1; }
          if (n > 0) {
            v = (sum / n) / 255;
            v = Math.pow(v, 0.85) * 1.12;
            if (v > 1) v = 1;
          }
        }
        env[i] = v > env[i] ? v : env[i] * 0.78;
        peak[i] = env[i] > peak[i] ? env[i] : Math.max(0, peak[i] - 0.02);
        f0 = f1;
      }

      var baseline = h - pad;

      // 频谱样式（第 5 项）：wave = 折线波形。
      // 复用同一份包络（不另接时域通道），所以切样式只是换画法、不改取样口径；
      // 颜色仍走 specRampColor 的同一套色相渐变，和柱状保持同一个视觉家族。
      if (SMP_STORE.getPrefs().specStyle === "wave") {
        c2d.beginPath();
        for (var wI = 0; wI < bars; wI++) {
          var wX = pad + wI * slot + slot * 0.5;
          var wY = baseline - Math.max(1.5 * dpr, env[wI] * innerH);
          if (wI === 0) c2d.moveTo(wX, wY); else c2d.lineTo(wX, wY);
        }
        var wGrad = c2d.createLinearGradient(0, baseline, 0, pad);
        wGrad.addColorStop(0, specRgba(specRampColor(0), 0.32));
        wGrad.addColorStop(0.55, specRgba(specRampColor(0.55), 0.80));
        wGrad.addColorStop(1, specRgba(specLighten(specRampColor(1), 0.30), 0.98));
        c2d.strokeStyle = wGrad;
        c2d.lineWidth = Math.max(1.2 * dpr, 1.2);
        c2d.lineJoin = "round";
        c2d.lineCap = "round";
        c2d.stroke();
        // 峰值折线（比主波形更淡、更细）
        c2d.beginPath();
        for (var pI = 0; pI < bars; pI++) {
          var pX = pad + pI * slot + slot * 0.5;
          var pY = baseline - Math.max(1.5 * dpr, peak[pI] * innerH);
          if (pI === 0) c2d.moveTo(pX, pY); else c2d.lineTo(pX, pY);
        }
        c2d.strokeStyle = "rgba(255,255,255,0.26)";
        c2d.lineWidth = Math.max(1, 1 * dpr);
        c2d.stroke();
        return;
      }

      for (var j = 0; j < bars; j++) {
        var t = bars <= 1 ? 0 : j / (bars - 1);
        var col = specRampColor(t);
        var cx = pad + j * slot + slot * 0.5;
        var bh = Math.max(1.5 * dpr, env[j] * innerH);
        var topY = baseline - bh;
        var grad = c2d.createLinearGradient(0, baseline, 0, topY);
        grad.addColorStop(0, specRgba(col, 0.30));
        grad.addColorStop(0.5, specRgba(col, 0.74));
        grad.addColorStop(1, specRgba(specLighten(col, 0.30), 0.98));
        c2d.fillStyle = grad;
        specColumnPath(c2d, cx, topY, baseline, barW, botW);
        c2d.fill();
        if (env[j] > 0.02) {
          c2d.fillStyle = "rgba(255,255,255,0.42)";
          c2d.fillRect(cx - barW * 0.5, topY, barW, Math.max(1, dpr * 0.8));
        }
        var pv = peak[j];
        if (pv > 0.03) {
          c2d.fillStyle = specRgba(specLighten(col, 0.45), 0.9);
          c2d.fillRect(cx - barW * 0.5, baseline - pv * innerH - dpr, barW, Math.max(1, dpr * 0.8));
        }
      }
    }

    /**
     * 迷你音准读数的实现（smpMiniPitch / __smpChip）已按用户要求删除：
     * 「胶囊就不要显示音准了」—— 条上不再算音名与频率，音准只保留在面板主体的 pitchChip 里。
     */

    /* ── 歌词动效第 5 档「炫彩」的环境探测与回落 ─────────────────────────
       炫彩靠 background-clip:text + color:transparent 实现，环境不支持时会变成
       「字完全看不见」—— 那比没有动效糟得多。所以：不支持就退回 slide，并只打一次 console.info。
       探测结果缓存（不会每帧调 CSS.supports）。 */
    var __smpRainbowOk = null;
    function smpRainbowSupported() {
      if (__smpRainbowOk !== null) return __smpRainbowOk;
      try {
        var css = window.CSS;
        __smpRainbowOk = !!(css && typeof css.supports === "function" &&
          (css.supports("-webkit-background-clip", "text") || css.supports("background-clip", "text")));
      } catch (e0) {
        __smpRainbowOk = false;
      }
      if (!__smpRainbowOk) console.info("[smp] background-clip:text 不受支持 → 炫彩歌词退回「上滑淡入」");
      return __smpRainbowOk;
    }
    function smpPickLyricFx(fx) {
      var v = (typeof fx === "string" && fx) ? fx : "slide";
      if (v === "rainbow" && !smpRainbowSupported()) return "slide";
      return v;
    }

    /** 品质徽章：在线读 store.qualityLabel（音质档位，如 高音质/SQ/FLAC）；本地只给容器/编码名，不拼码率。 */
    var SMP_LOSSLESS = { flac: 1, wav: 1, wave: 1, ape: 1, aif: 1, aiff: 1, caf: 1, mka: 1 };
    function smpQualityText(snap) {
      if (snap && snap.qualityLabel) return String(snap.qualityLabel);
      var ex = extOf(snap && snap.path ? snap.path : "");
      if (!ex) return "";
      return ex.toUpperCase();
    }
    /** 歌名显示去扩展名（只动显示；path / mediaUrl 仍用完整文件名）。 */
    function smpStripExt(name) {
      var s = String(name || "");
      var i = s.lastIndexOf(".");
      if (i <= 0) return s;
      var ex = s.slice(i + 1).toLowerCase();
      if (MEDIA_SET && MEDIA_SET[ex] === true) return s.slice(0, i);
      return s;
    }

    // S1.5 占位组件：外壳 = 照抄对方 NowPlayingBar 的容器结构（两层），内容先留占位，
    // S3 起把「音频可视化 + 歌词」两块换成我们侧边栏的格式，外壳不动。
    // ═══════════════════════════════════════════════════════════════════════
    // 以下 4 段移植自 dsh-music-player v1.0.4
    //   Copyright (c) kendu76 — MIT License
    //   https://github.com/kendu76/dsh-music-player
    // 本项目的改动仅限 store 接线三处（Lead 批准的可改范围）：
    //   useStore() → useSmpStore()、changeVolume() → SMP_STORE.setVolume()、
    //   store.volume → 快照 volume。
    // 其余（滚轮常量 / 注释 / SVG path / 几何数值）逐字未动。
    // ═══════════════════════════════════════════════════════════════════════

    /* ═══════════════════════════════════════════════════════════════════════
       第 2a 步：整段照抄 A-1 (`NowPlayingBar`) 所需的地基
       ─────────────────────────────────────────────────────────────────────
       对方专有数据源，本插件没有 —— 这些开关恒 false，仅用于隐藏入口，
       对应代码分支一律保留原文，将来接上数据源时只改这里。
       ═══════════════════════════════════════════════════════════════════════ */
    var SMP_FEATURES = {
      book: false,      /* 讲书 */
      radio: false,     /* 电台 */
      mirror: false,    /* 多标签镜像 */
      floatDrag: false, /* 悬浮可拖动 */
      modeMenu: false,  /* 模式菜单 */
      toc: false        /* 章节目录 */
    };

    /* ---- 对方专有依赖的桩（保留原签名，返回明确空值，绝不静默 throw） ---- */
    /* 页面底部模式：量出「会话列」的 {left, width}，让固定条对齐输入框而不是贴窗口左边缘。
       照抄参照 dsh-music-player v1.0.4 :5208-5248（MIT，kendu76）。
       锚点 = [data-composer-seat] 的 parentElement（会话列）。
       测不到（切到设置/插件面板时会话列整个卸载）→ 回退「视口宽」，
       再由内层 .dsh-music-bar 的 max-width:780px + margin:0 auto 居中 —— 宁居中不贴边。
       1s 兜底轮询只处理「锚点出现/消失」，且只在 bottom 模式跑（一次 rect 读取）。
       用 useEffect（不是 useLayoutEffect）：首帧 metrics===null 不画，避免先画错再跳。 */
    function useColumnMetrics(enabled) {
      var mPair = react.useState(null);
      var metrics = mPair[0];
      var setMetrics = mPair[1];
      react.useEffect(function () {
        if (!enabled || typeof document === "undefined") return undefined;
        var anchor = null;
        var ro = null;
        // measure 只「读 + setMetrics」，绝不在 ResizeObserver 回调里 observe —— 回调内 observe/改布局
        // 会触发 "ResizeObserver loop completed with undelivered notifications"，把 renderer 拖进
        // 无限 layout（切换对话/点开面板时卡死的元凶之二）。observe 全部收进 syncAnchor。
        var measure = function () {
          var next = { left: 0, width: window.innerWidth };
          var band = null;
          try {
            var seat = document.querySelector("[data-composer-seat]");
            band = seat === null ? null : seat.parentElement;
            if (band !== null) {
              var r = band.getBoundingClientRect();
              if (r.width > 0) { next.left = Math.round(r.left); next.width = Math.round(r.width); }
            }
          } catch (e) { /* 测量失败即用回退值 */ }
          // 只在真的变了才 set：否则每秒一次轮询会白白触发 React 渲染。
          setMetrics(function (prev) {
            return (prev !== null && prev.left === next.left && prev.width === next.width) ? prev : next;
          });
        };
        var syncAnchor = function () {
          var band = null;
          try {
            var seat = document.querySelector("[data-composer-seat]");
            band = seat === null ? null : seat.parentElement;
          } catch (e) {}
          if (band === anchor) return;
          if (anchor !== null && ro !== null) { try { ro.disconnect(); } catch (e0) {} }
          anchor = band;
          if (anchor !== null && ro !== null) { try { ro.observe(anchor); } catch (e1) {} }
        };
        try { if (typeof ResizeObserver === "function") ro = new ResizeObserver(measure); } catch (e2) { ro = null; }
        syncAnchor();
        measure();
        window.addEventListener("resize", measure);
        var timer = setInterval(function () { syncAnchor(); measure(); }, 1000);
        return function () {
          window.removeEventListener("resize", measure);
          clearInterval(timer);
          if (ro !== null) { try { ro.disconnect(); } catch (e3) {} }
        };
      }, [enabled]);
      return metrics;
    }
    /* 对方专有：bar 上 canvas 槽位登记（避免多实例抢同一 canvas） */
    var barCanvasSlots = new Set();
    /* 对方专有：窗口顶部安全区（悬浮条避让） */
    function frameSafeTop() { return 0; }
    /* 对方专有：悬浮条坐标 clamp（floatDrag） */
    function clampFloat(pos) { return null; }
    /* 对方专有：对方的频谱绘制（我们用自己的 smpDrawMiniViz / drawSpectrum） */
    function drawViz() { return undefined; }
    /* 对方专有：按 currentId 判断收藏（我们按 path，走 SMP_STORE.favOn） */
    function isCurrentFaved() { return false; }
    /* 对方专有：对方的收藏切换签名；(songId, faved) —— 我们的收藏走 SMP_STORE.toggleFav */
    function toggleFav() { return undefined; }
    /* 对方专有：面板开合（对方是浮层面板，我们没有）→ 等价映射到我们的播放队列开关 */
    function togglePanel() { try { return SMP_STORE.openQueue(); } catch (e0) { return undefined; } }
    /* 对方的 store 写入入口 set(patch) → 转我们的 publish（保留签名） */
    function set(patch) { return SMP_STORE.publish(patch || {}); }
    /* 对方的 store 只读引用（只有 volume/prefs 被 412 行直接碰） */
    var store = {
      get volume() { return SMP_STORE.getState().volume; },
      get prefs() { return SMP_STORE.getState().prefs; }
    };
    /* 对方专有：模式下拉（dock/float/minimal 切换） */
    function ModeDropdown() { return null; }
    /* 对方专有：章节目录下拉（讲书） */
    function TocDropdown() { return null; }
    /* 对方专有：讲书章节目录面板 */
    function BookTocPanel() { return null; }
    /* 对方专有：讲书 AI 声音选择 */
    function VoicePicker() { return null; }
    /* 对方：portal 到 body；我们没有 react-dom，退回原节点（fixed 定位已由 anchorAbove 负责） */
    function portalToBody(node) { return node; }
    /* 对方：讲书音量弹层的锚定器（book 分支）→ 复用 anchorAbove */
    function anchorPopAbove(el, maxW, estH) { return anchorAbove(el, maxW, estH); }
    /* 对方：useStore 别名 → 我们的 useSmpStore（412 行据此零改动） */
    function useStore() { return useSmpStore(); }

    // ---- 音量滚轮调速参数 ----
    // 在音量条上滚动滚轮即可调音量，步进按滚动快慢分两档：慢速 1%、快速 5%。
    // 「快慢」同时看两个信号——连续两次滚轮事件的间隔、以及单次滚动量——这样鼠标
    // 滚轮和触控板都能得到符合直觉的结果：
    //   - 鼠标滚轮：一格约 100（像素模式），慢慢拨 → 间隔大 → 慢速 1%；快速连拨 → 5%。
    //   - 触控板：轻推是每帧 1~5 的细碎增量，即使事件密集（间隔很小）也判为慢速（1%）；
    //     用力快滑时单次增量明显变大 → 5%。
    //   - 归一化后单次滚动量达到 VOL_WHEEL_FAST_DELTA（多行/惯性滑动）直接算快速。
    // 要改手感只调下面这几个数即可。
    const VOL_WHEEL_STEP_SLOW = 0.01;  // 慢速滚动：每次 1%
    const VOL_WHEEL_STEP_FAST = 0.05;  // 快速滚动：每次 5%
    const VOL_WHEEL_FAST_GAP_MS = 80;  // 两次滚轮事件间隔小于此值算「连续快速」
    const VOL_WHEEL_MIN_DELTA = 20;    // 判为快速所需的单次最小滚动量（滤掉触控板细碎滚动）
    const VOL_WHEEL_FAST_DELTA = 200;  // 单次滚动量达到此值直接算快速（多行/惯性滑动）

    // 把弹层锚定在某个按钮/容器正上方（fixed 定位，居中于其水平中心）。
    // 用于音量/模式/章节目录等从播放条上弹出的弹层：这些弹层所在的按钮组
    // 在折叠（overflow:hidden）容器内，弹层需 portal 到 body 并以 fixed 定位
    // 才能不被裁剪。maxW 为弹层的最大宽度，用于水平 clamp 防止宽弹层溢出视口。
    // estH 为弹层预估高度：上方放不下时（锚点离视口顶只有几像素）自动翻到锚点**下方**，
    // 否则弹层会顶出视口被裁掉（例如播放条被移到很靠上的位置时）。
    // 无目标元素时回退到视口底部中央。
    const anchorAbove = (el, maxW = 380, estH = 0) => {
      const vw = window.innerWidth, vh = window.innerHeight;
      const r = (el && typeof el.getBoundingClientRect === 'function') ? el.getBoundingClientRect() : null;
      const cx = (r && r.width > 0) ? r.left + r.width / 2 : vw / 2;
      const margin = 8;
      const clampLeft = Math.max(margin, Math.min(vw - margin, cx));
      // 居中后 clamp 左边缘，让最大 maxW 宽的弹层完整落在视口内。
      const half = Math.min(maxW / 2, vw / 2 - margin);
      const left = Math.max(margin + half, Math.min(vw - margin - half, clampLeft));
      if (estH > 0 && r && r.height > 0 && r.top - 6 - estH < margin) {
        // 翻到锚点下方时必须**显式 bottom:'auto'**：弹层基础 CSS 里还留着
        // `bottom: calc(100% + 6px)`（它们当年是 bar 内部的 absolute 弹层）。固定高度的弹层
        // 靠「over-constrained 忽略 bottom」侥幸正常，而 height:auto 的弹层（讲书音量弹窗）
        // 会把 top 与 bottom 一起算 → 高度算成负值 → 盒子塌成 0、背景卡片消失、内容溢出。
        // 显式清掉后由内联 top 独占定位。
        return { position: 'fixed', left: Math.round(left), top: Math.round(r.bottom + 6), bottom: 'auto', transform: 'translate(-50%, 0)' };
      }
      const top = (r && r.height > 0) ? Math.max(0, r.top - 6) : vh - 40;
      return { position: 'fixed', left: Math.round(left), top: Math.round(top), transform: 'translate(-50%, -100%)' };
    };

    // ---- 图标 ----
    function MusicNote(props) {
      const cls = props.className || '';
      return h('svg', { className: cls, width: 12, height: 12, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true },
        h('path', { d: 'M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z' }));
    }
    // 歌单卡片封面：有图显示图，无图显示音符占位块。酷狗「默认收藏」等系统默认歌单
    // 在云歌单接口（v7/get_all_list）里不返回 pic 封面字段，直接 <img src=""> 只会渲染
    // 一个空白方框（onError 后甚至整块消失）；「我喜欢」的爱心封面由酷狗后端内嵌返回，
    // 这里用音符占位兜底其余无封面场景，保证卡片始终有 56x56 封面视觉。
    function plCoverEl(item, cls = 'dsh-music-playlist-cover') {
      const cover = String((item && item.cover) || '').trim();
      if (cover) return h('img', { className: cls, src: cover, alt: '', loading: 'lazy', onError: (e) => { e.currentTarget.style.display = 'none'; } });
      return h('span', { className: cls + ' empty' }, h(MusicNote, { className: 'dsh-music-note' }));
    }
    // 讲书（AI 听书）时名称前的话筒图标，贴合「朗读/播讲」功能，
    // 与音乐的音符图标区分。
    function MicIcon(props) {
      const cls = props.className || '';
      return h('svg', { className: cls, width: 12, height: 12, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true },
        h('path', { d: 'M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z' }));
    }
    // 报纸图标（新闻播报模式的名称前缀，与音符/话筒同尺寸同色系）。
    function NewsIcon(props) {
      const cls = props.className || '';
      return h('svg', { className: cls, width: 12, height: 12, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true },
        h('path', { d: 'M4 5h13v14H5a2 2 0 0 1-2-2V5a1 1 0 0 1 1-1zm15 2h1a1 1 0 0 1 1 1v9.5a2.5 2.5 0 0 1-2.5 2.5H19V7zM6.5 8h8a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-.5.5h-8a.5.5 0 0 1-.5-.5v-2a.5.5 0 0 1 .5-.5zm.5 5h3v1.5H7V13zm4.5 0h3.5v1.5H11.5V13zM7 15.5h3V17H7v-1.5zm4.5 0h3.5V17H11.5v-1.5z' }));
    }
    // 收音机图标（网络电台直播的名称前缀，与音符/话筒/报纸同尺寸同色系）：
    // 一台带天线的收音机，一眼区别于「本地/在线点播」的音符——电台是直播流不是曲库。
    function RadioIcon(props) {
      const cls = props.className || '';
      return h('svg', { className: cls, width: 12, height: 12, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true },
        h('path', { d: 'M3.24 6.15C2.51 6.43 2 7.17 2 8v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8c0-1.11-.89-2-2-2H8.3l8.26-3.34L15.88 1 3.24 6.15zM7 20c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm13-8h-2v-2h-2v2H4V8h16v4z' }));
    }
    // 爱心图标（收藏钮通用）：收藏=实心(currentColor)、未收藏=空心描边。播放条与电台行
    // 收藏钮共用，替代 ♥/♡ 文本字形——字符宽度/基线随字体变化，SVG 恒定尺寸、颜色精确可控。
    function HeartIcon({ className = '', filled = false, size = 16 }) {
      return h('svg', {
        className: className, width: size, height: size, viewBox: '0 0 24 24',
        fill: filled ? 'currentColor' : 'none', stroke: 'currentColor', strokeWidth: 2, 'aria-hidden': true,
      }, h('path', { d: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z' }));
    }
    // 播放控制图标（上一首/播放/暂停/下一首/停止）：用
    // Google 官方 Material Icons 的 24dp 路径，viewBox 0 0 24 24、单条 path、currentColor 上色。
    // 统一走 iconSvg 工厂，尺寸只在调用处给一次，避免每个图标各自写 width/height 后大小不一。
    function iconSvg(path, size = 16) {
      return h('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'currentColor', 'aria-hidden': true },
        h('path', { d: path }));
    }
    const PrevIcon = (size = 16) => iconSvg('M6 6h2v12H6zm3.5 6l8.5 6V6z', size);
    const PlayIcon = (size = 16) => iconSvg('M8 5v14l11-7z', size);
    const PauseIcon = (size = 16) => iconSvg('M6 19h4V5H6v14zm8-14v14h4V5h-4z', size);
    const NextIcon = (size = 16) => iconSvg('M6 18l8.5-6L6 6v12zM16 6h2v12h-2z', size);
    const StopIcon = (size = 16) => iconSvg('M6 6h12v12H6z', size);

    // Custom vertical volume slider. The native <input type=range> cannot be
    // fully restyled in current Chrome (track keeps gray border lines and the
    // thumb ignores width/height once appearance:none is set), so the slider is
    // drawn with plain divs and driven by pointer events: click to jump, drag
    // the thumb to scrub. Value runs bottom (0) to top (1).
    function VolumeSlider() {
      const s = useSmpStore();
      const trackRef = react.useRef(null);
      const draggingRef = react.useRef(false);
      // 上一次滚轮事件的时刻，用于判断两次滚动是否「连续快速」。
      const wheelAtRef = react.useRef(0);
      const valueFor = (clientY) => {
        const el = trackRef.current;
        if (el === null) return s.volume;
        const r = el.getBoundingClientRect();
        if (r.height <= 0) return s.volume;
        const ratio = 1 - (clientY - r.top) / r.height;
        return Math.min(1, Math.max(0, ratio));
      };
      const onPointerDown = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        draggingRef.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        SMP_STORE.setVolume(valueFor(e.clientY));
      };
      const onPointerMove = (e) => {
        if (!draggingRef.current) return;
        SMP_STORE.setVolume(valueFor(e.clientY));
      };
      const onPointerUp = (e) => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      };
      // 滚轮调音量。必须用原生监听器注册（passive: false）：React 的 onWheel 走被动
      // 监听，在被动监听里 preventDefault 无效，滚轮会连带把外层对话/面板一起滚走。
      react.useEffect(() => {
        const el = trackRef.current;
        if (el === null) return undefined;
        const onWheel = (e) => {
          // deltaMode: 0=像素 1=行 2=页，先统一折算成像素量再比较快慢。
          const unit = e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? 100 : 1);
          const d = e.deltaY * unit;
          if (d === 0) return;
          e.preventDefault(); // 这一次滚轮由音量条消费，不再冒泡去滚动页面
          if (draggingRef.current) return; // 拖拽中音量由指针位置决定，忽略滚轮
          const now = Date.now();
          const gap = now - wheelAtRef.current;
          wheelAtRef.current = now;
          const fast = (gap < VOL_WHEEL_FAST_GAP_MS && Math.abs(d) >= VOL_WHEEL_MIN_DELTA)
            || Math.abs(d) >= VOL_WHEEL_FAST_DELTA;
          const step = fast ? VOL_WHEEL_STEP_FAST : VOL_WHEEL_STEP_SLOW;
          // 上滚（deltaY < 0）加音量、下滚减音量。先钳位再交给 setVolume：
          // 它转发给「出声页」的是钳位前的原值，钳位放在这里可避免越界值被广播出去。
          // 结果按 0.1% 取整，防止浮点累加出 0.8300000000000001 这类脏值落进 prefs。
          const raw = SMP_STORE.getState().volume + (d < 0 ? step : -step);
          const next = Math.round(Math.min(1, Math.max(0, raw)) * 1000) / 1000;
          SMP_STORE.setVolume(next);
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
      }, []);
      const pct = Math.round(s.volume * 100);
      return h('div',
        { className: 'dsh-music-vol-slider', ref: trackRef,
          onPointerDown, onPointerMove, onPointerUp,
          title: '音量 ' + pct + '%' },
        h('div', { className: 'dsh-music-vol-track' }),
        h('div', { className: 'dsh-music-vol-fill', style: { height: pct + '%' } }),
        h('div', { className: 'dsh-music-vol-thumb', style: { bottom: 'calc(' + pct + '% - 7px)' } }),
      );
    }

    // ── 播放队列面板 ────────────────────────────────────────────────────────
    // 对方是 shell.overlay 的独立面板（music-player-panel / order 20）；我们不开第二个
    // overlay 实例（离屏、裁剪、与面板内页签互相打架），直接把面板挂进条自己的 fragment。
    // 壳层复用 A-5 的 .dsh-music-lyric-panel（fixed 居中 / width 420 / height 40vh / 内滚），
    // 不用 anchorAbove 贴条放 —— 两三百首的列表贴条铺必然顶出屏幕外。
    // 开关态住在 store.panelOpen：条上「播放列表」按钮的 active 态与面板渲染读同一个字段。
    function SmpQueuePanel() {
      // 🔴 本函数在模块作用域、早于 SmpMusicBar，闭包里够不到 SmpMusicBar 内那个 React 视图对象
      //    （模块级只有小写 `react` 与 `h`）；"use strict" 下裸用 React.createElement 必抛
      //    ReferenceError: React is not defined → 整棵树不渲染（宿主日志抓到的第二个崩溃）。
      var React = { createElement: h };
      var snap = useSmpStore();
      if (!snap.panelOpen) return null;
      var items = (snap.list && snap.list.items) || [];
      var cur = snap.idx;
      var rows = items.length
        ? items.map(function (it, i) {
            var nm = (it && it.name) ? smpStripExt(it.name) : ('第 ' + (i + 1) + ' 首');
            return React.createElement('div', {
              key: 'q-' + i,
              className: 'dsh-music-lyric-line smp-queue-row' + (i === cur ? ' active' : ''),
              title: nm,
              onClick: function () { try { SMP_STORE.loadIndex(i, true); } catch (e0) {} }
            }, React.createElement('span', { className: 'dsh-music-lyric-line-text' }, nm));
          })
        : null;
      return React.createElement('div', {
        className: 'dsh-music-lyric-panel',
        'data-smp': 'queue-panel'
      },
        React.createElement('div', { className: 'dsh-music-panel-head' },
          React.createElement('span', { className: 'dsh-music-panel-title' },
            '播放队列' + (items.length ? '（' + items.length + ' 首）' : '')),
          React.createElement('button', {
            className: 'dsh-music-icon-btn', title: '关闭队列',
            onClick: function () { try { SMP_STORE.closeQueue(); } catch (e1) {} }
          }, '×')),
        items.length
          ? React.createElement('div', { className: 'dsh-music-lyric-panel-body' }, rows)
          : React.createElement('div', { className: 'smp-queue-empty' },
              '播放队列是空的 —— 去「本地音乐」选个目录，或登录 QQ 音乐后再点歌。'));
    }

    function SmpMusicBar(props) {
      var isOverlay = props.placement === "overlay";
      // panel = 侧边栏播放器面板顶部那条。同形态、同一份 store，但不参与
      // 「输入框上方 / 下方二选一」的互斥（面板里始终要有一条在）。
      var isPanel = props.placement === "panel";
      var snap = useSmpStore();
      // 照抄互斥（Lead m00314 ③）：同一时刻只渲染一条。位置由 SMP_STORE.barPos 决定，
      // 默认 "dock"（输入框上侧），与对方默认模式一致。切换入口放侧边栏（S6），不改条壳。
      var wantsBottom = snap.barPos === "bottom";
      // 让位标记：bottom 时才挂到 <html>，切走立即摘掉，不留副作用。
      react.useEffect(function () {
        if (!isOverlay) return undefined;
        var root = document.documentElement;
        if (!root) return undefined;
        root.setAttribute("data-dsh-music-bar-bottom", "");
        return function () { try { root.removeAttribute("data-dsh-music-bar-bottom"); } catch (e0) {} };
      }, [isOverlay]);

      // hooks 必须无条件调用 → 一律放在互斥 return 之前。
      var vizRef = react.useRef(null);
      // 音量滑杆的展开态（点喇叭 → 内联滑杆；移开 700ms 收起）。
      var volOpenState = react.useState(false);
      var volOpen = volOpenState[0];
      var setVolOpen = volOpenState[1];
      var volTimerRef = react.useRef(null);
      // 音量按钮 + 弹层锚点（anchorAbove 需要按钮的 getBoundingClientRect）
      var volBtnRef = react.useRef(null);
      // 收起按钮组的延迟定时器（参照 :5441-5442 同款，初值 null）
      var hoverTimerRef = react.useRef(null);
      var volPopRef = react.useRef(null);
      function cancelVolClose() {
        if (volTimerRef.current !== null) { clearTimeout(volTimerRef.current); volTimerRef.current = null; }
      }
      function closeVolSoon() {
        cancelVolClose();
        volTimerRef.current = setTimeout(function () { volTimerRef.current = null; setVolOpen(false); }, 700);
      }
      var wrapRef = react.useRef(null);
      // 第 2b 步：悬停展开按钮组（对方用 active = 热区/悬停复合态，我们取悬停 + 音量展开）
      var hoverPair = react.useState(false);
      var hovered = hoverPair[0], setHovered = hoverPair[1];
      // 音准 chip 已按用户要求从条上删掉（只保留在面板主体的 pitchChip 里）——
      // 它的文字长短会变（A#6 1857Hz -74 ↔ --）挤压同一行，是歌词抖动的头号原因。
      // 条宽自适应因此只剩「<300 藏频谱」这一条；歌名与歌词永不隐藏。
      var narrowPair = react.useState(0);
      var narrow = narrowPair[0], setNarrow = narrowPair[1];

      // 迷你频谱 + 音准 chip：同一条 rAF 读共享 analyser（只读，不另建 AudioContext）。
      react.useEffect(function () {
        var raf = 0;
        var frame = 0;
        var tick = function () {
          raf = window.requestAnimationFrame(tick);
          var cv = vizRef.current;
          if (!cv) return;
          // 每 2 帧取一次（≈30fps）：条上只是 60×20 的小图，降一档给侧边栏主频谱让路。
          // getByteFrequencyData / getFloatTimeDomainData 都是"读当前分析结果"、幂等，
          // 两侧各自读取不会互相变差；这里只为省一份绘制开销。
          frame = (frame + 1) % 2;
          if (frame !== 0) return;
          var an = SMP_STORE.getAnalyser ? SMP_STORE.getAnalyser() : null;
          if (!an) { smpDrawMiniViz(cv, null, 0, 0); return; }
          smpDrawMiniViz(cv, __smpFreqBuf(an), an.context.sampleRate, an.fftSize);
        };
        raf = window.requestAnimationFrame(tick);
        return function () { window.cancelAnimationFrame(raf); };
      }, []);

      // 悬停收起定时器：卸载时清掉，别让定时器在组件卸载后 setState
      react.useEffect(function () {
        return function () {
          if (hoverTimerRef.current !== null) clearTimeout(hoverTimerRef.current);
          hoverTimerRef.current = null;
        };
      }, []);

      // S4b：量条宽做分级隐藏（ResizeObserver 不可用则保持全显）
      react.useEffect(function () {
        var node = wrapRef.current;
        if (!node || typeof ResizeObserver !== "function") return undefined;
        var apply = function (w) {
          var lv = w < 300 ? 2 : (w < 360 ? 1 : 0);
          setNarrow(function (prev) { return prev === lv ? prev : lv; });
        };
        var ro = new ResizeObserver(function (entries) {
          if (entries && entries.length) apply(entries[0].contentRect.width);
          else if (typeof node.getBoundingClientRect === "function") apply(node.getBoundingClientRect().width);
        });
        try { ro.observe(node); } catch (e0) {}
        if (typeof node.getBoundingClientRect === "function") apply(node.getBoundingClientRect().width);
        return function () { try { ro.disconnect(); } catch (e1) {} };
      }, []);

      // 会话列度量（hooks 必须停在早退之前，顺序才稳定）。只有页面底部模式需要。
      var columnMetrics = useColumnMetrics(isOverlay);

      if (!isPanel && isOverlay !== wantsBottom) return null;

      var titleText = snap.title ? smpStripExt(snap.title) : "未在播放";
      var playing = !!snap.playing;
      var cur = Number(snap.time);
      if (!isFinite(cur) || cur < 0) cur = NaN;
      // duration 保留 NaN（未知）→ fmtTime 走 --:--。0 也算未知：元数据没到时是 0，
      // 显示成 0:00 会让人以为歌长 0 秒（对方那个 bug 就是存了 0 又永不刷新）。
      var dur = Number(snap.duration);
      if (!isFinite(dur) || dur <= 0) dur = NaN;
      // 兜底：store 的 duration 还没推上来（NaN/0）时，直接读共享 audio 元素的实时 duration。
      // 否则 onProgressDown 的 `if (!isFinite(dur) || dur <= 0) return` 会让整条进度热区点了没反应
      // —— 这就是用户说的「不能快进」。
      if (isNaN(dur)) {
        try {
          var ael = SMP_STORE.audioEl ? SMP_STORE.audioEl() : null;
          var ad = ael ? Number(ael.duration) : NaN;
          if (isFinite(ad) && ad > 0) dur = ad;
        } catch (eDur) {}
      }
      // 钳制：当前时间不可能大于总长（对方 1:00 / 0:00 就是没钳制 + 存了 0）。
      if (isFinite(dur) && dur > 0 && isFinite(cur)) cur = Math.min(cur, dur);
      var pct = dur > 0 ? Math.max(0, Math.min(100, (cur / dur) * 100)) : 0;
      var badge = smpQualityText(snap);
      var lyricText = String(snap.lyricLine || "");
      var lyricFx = smpPickLyricFx(snap.lyricFx);
      // S6 播放设置：条上每一项都**真生效**（不是只存值）。
      var prefs = snap.prefs || PREFS_DEF;
      // 背景：默认（barBgShow=true 且 immersion=50）不加内联 style —— 与改造前逐字一致；
      // 只有用户动过设置才覆盖，避免默认态和 CSS 主题色打架。
      var barStyle = null;
      if (prefs.barBgShow === false) {
        barStyle = { background: "transparent" };
      } else if (typeof prefs.immersion === "number" && prefs.immersion !== 50) {
        var immAlpha = 0.04 * (prefs.immersion / 50);
        if (!isFinite(immAlpha) || immAlpha < 0) immAlpha = 0.04;
        barStyle = { background: "rgba(0,0,0," + Math.min(1, immAlpha).toFixed(3) + ")" };
      }
      // 有曲目 = 快照里有曲名（loadIndex 时会 publish）。空态照 Lead 要求显示固定文案。
      var hasTrack = !!(snap.title || "");

      // 图标：全部走模块级 iconSvg 工厂（移植自对方；24dp Material 路径，渲染 14×14）
      var ICON_PLAY = PlayIcon(14);
      var ICON_PAUSE = PauseIcon(14);
      var ICON_PREV = PrevIcon(14);
      var ICON_NEXT = NextIcon(14);
      var ICON_STOP = StopIcon(14);
      // 收藏两态：未收藏 = 空心描边，已收藏 = 实心（对方同款）
      function heartIcon(on) {
        return h(HeartIcon, { filled: !!on, size: 14 });
      }
      // 音量 / 静音
      var ICON_VOL = iconSvg("M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z", 14);
      var ICON_MUTE = iconSvg("M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z", 14);
      // 队列 = 三横线 + 三角（Material playlist_play）；歌单 = 三横线 + 音符（Material queue_music）
      // 队列按钮：参照 btns 无独立「队列」按钮，其「顺序播放」菜单项（L5673）用此 path —— 借它作图（非自造）
    var ICON_QUEUE = iconSvg("M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zm14-10v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z", 14);
      // 列表/最右面板按钮：逐字符照抄参照渲染段 L5638 的 view_list path（此前误用 queue_music，已改正）
    var ICON_PLAYLIST = iconSvg("M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z", 14);

      var wrapClassName = "dsh-music-bar-wrap" + (isOverlay ? " bottom" : "")
        + (snap.barHidden && !isPanel ? " collapsed" : "");

      /* ═══════════════════════════════════════════════════════════════════════
         第 2b 步：A-1 (`NowPlayingBar`) 渲染段所需的局部符号
         ─────────────────────────────────────────────────────────────────────
         `s` 直接指向我们的快照 → 412 行里的 s.xxx 一个都不用改（字段已在 store 侧补齐）。
         `React.createElement` 逐字保留 → 这里给一个薄的 React 视图对象，渲染段零改动。
         ═══════════════════════════════════════════════════════════════════════ */
      var s = snap;
      var React = { createElement: h };
      var isBottom = isOverlay;
      var isFloat = false;
      var isPanelMount = false;
      // 页面底部模式：内联给出 left/width 对齐会话列（贴底由 CSS 的 bottom:0 负责）。
      // 量不到时**不退回 left:0 贴窗口边**，而是占满视口宽 + 内层 max-width:780px + margin:0 auto 居中。
      var wrapStyle = isBottom
        ? (columnMetrics === null
          ? { left: 0, width: "100%" }
          : { left: columnMetrics.left + "px", width: columnMetrics.width + "px" })
        : undefined;
      var barDimmed = false;
      // 对方专有语境（讲书/电台）恒 false —— 分支保留原文，入口由 SMP_FEATURES 隐藏
      var isBook = SMP_FEATURES.book;
      var isRadio = SMP_FEATURES.radio;
      var displayName = titleText;
      // 标题左侧的模式前缀图标：照抄参照（dsh-music-player L4902 / 渲染 L…,note 位于 displayName 之前）。
      // 参照是按 isNews/isBook/isRadio 三选一，我们是纯音乐播放器 → 恒用 MusicNote（12×12，与参照同尺寸同 path）。
      var note = React.createElement(MusicNote, { className: "dsh-music-note", key: "note" });
      var artistText = "";
      var artistEl = null;
      var sourceBadge = null;
      var localQualityBadge = (prefs.badgeShow !== false && badge) ? h("span", { className: "smp-music-bar-badge" }, badge) : null;
      var chapterEl = null;
      var afterName = null;
      var mirrorBadge = null;
      var vizMounted = prefs.specShow !== false;
      var canvasSlotRef = vizRef;
      var lyricVisible = true;
      var progressPct = pct;
      // 打开态照抄对方：靠 A-5 的 .dsh-music-mode-trigger.active 吃主题色
      // （--dsh-music-accent → --dsw-alias-brand-primary，深色近白 / 浅色近黑）。
      // 🔴 不许写死 #ffffff 或 #2f9e6e —— 浅色主题下会跟参照正好相反。
      var panelCls = "dsh-music-mode-trigger" + (s.panelOpen ? " active" : "");
      var showHint = false;
      var timeVisible = true;
      var active = hovered || volOpen;
      var togglePanelOnName = togglePanel;
      var onBarLeave = closeVolSoon;
      var openToc = function () { return undefined; };
      var stepBook = function () { return undefined; };
      var step = function (delta) {
        try { if (delta < 0) SMP_STORE.prev(); else SMP_STORE.next(); } catch (eStep) {}
      };
      var togglePlay = function () { try { SMP_STORE.toggle(); } catch (eTog) {} };
      // ── 悬停收起：逐字照抄参照的 leaveHotspot 机制 ─────────────────────────
      // 参照原文（dsh-music-player :5439-5451）两处关键，我们第 2b 步只搬了渲染段
      // （5540-5667），把这两处落在渲染段**之外**的机制漏了，自己写成「立刻
      // setHovered(false)」→ 热区与按钮组是兄弟元素，鼠标从热区移到展开的按钮上
      // 必然触发热区 mouseleave → 立刻收起 → 指针下又变回热区 → 再次 mouseenter
      // → 展开 …… 无限循环 = 用户看到的「爆闪 + 抖动」。
      //   ① 收起走 1s 延迟（鼠标离开右端控件区后暂不收起，期间重新进入则取消）
      //   ② 热区 mouseleave 时若 relatedTarget 仍在 .dsh-music-bar-controls 内，
      //      直接不安排收起（防止移到按钮上误收起）
      var hideBarBtns = function () {
        if (hoverTimerRef.current !== null) clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = setTimeout(function () {
          hoverTimerRef.current = null;
          setHovered(false);
        }, 1000);
      };
      var showBarBtns = function () { setHovered(true); };
      var leaveHotspot = function (e) {
        var rt = e && e.relatedTarget;
        if (rt && typeof rt.closest === "function" && rt.closest(".dsh-music-bar-controls")) return;
        hideBarBtns();
      };
      var onWrapPointerDown = function () { return undefined; };
      var onWrapPointerMove = function () { return undefined; };
      var onWrapPointerUp = function () { return undefined; };
      var onWrapClickCapture = function () { return undefined; };
      var onWrapEnter = function () { setHovered(true); };
      var onWrapLeave = function () { closeVolSoon(); hideBarBtns(); };
      var heartBtn = hasTrack ? h("button", {
        className: "dsh-music-bar-btn fav" + (snap.favOn ? " on" : ""),
        title: snap.favOn ? "取消收藏" : "收藏",
        onClick: function () { try { SMP_STORE.toggleFav(); } catch (eFav) {} }
      }, h(HeartIcon, { filled: !!snap.favOn, size: 14 })) : null;
      // 进度条命中区（唯一加法）：对方视觉是 1px + pointer-events:none，外面套 13px 透明层负责 seek
      var onProgressDown = function (ev) {
        var hit = ev && ev.currentTarget;
        if (!hit || !isFinite(dur) || dur <= 0) return;
        try { if (hit.setPointerCapture && ev.pointerId !== undefined) hit.setPointerCapture(ev.pointerId); } catch (e0) {}
        var seekTo = function (e2) {
          var r = hit.getBoundingClientRect();
          if (!r || !(r.width > 0)) return;
          var ratio = (e2.clientX - r.left) / r.width;
          if (!isFinite(ratio)) return;
          ratio = Math.max(0, Math.min(1, ratio));
          try { SMP_STORE.seek(ratio * dur); } catch (e3) {}
        };
        seekTo(ev);
      };
      var onProgressMove = function (ev) {
        if (!ev) return;
        if (ev.buttons !== undefined && ev.buttons === 0) return;
        var hit = ev.currentTarget;
        if (!hit || !isFinite(dur) || dur <= 0) return;
        var r = hit.getBoundingClientRect();
        if (!r || !(r.width > 0)) return;
        var ratio = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
        try { SMP_STORE.seek(ratio * dur); } catch (e4) {}
      };

      var barEl = React.createElement('div', {
        id: 'smp-music-bar-wrap',
        className: wrapClassName,
        style: wrapStyle,
        ref: wrapRef,
        "data-smp": isOverlay ? "bar-bottom" : "bar-dock",
        "data-narrow": narrow > 0 ? String(narrow) : undefined,
        onPointerDown: onWrapPointerDown,
        onPointerMove: onWrapPointerMove,
        onPointerUp: onWrapPointerUp,
        onPointerCancel: onWrapPointerUp,
        onClickCapture: onWrapClickCapture,
        onMouseEnter: onWrapEnter,
        onMouseLeave: onWrapLeave
      },
        React.createElement('div',
          { className: 'dsh-music-bar' + (isBook ? ' book' : '') + (barDimmed ? ' dimmed' : '') + (prefs.barBgShow === false ? ' bare' : ''), style: barStyle || undefined },
          React.createElement('span', { className: 'dsh-music-bar-name' + (hasTrack ? '' : ' idle'), title: hasTrack ? (displayName + (artistText ? ' - ' + artistText : '') + '\n（单击打开播放列表）') : '单击打开播放器面板', onClick: togglePanelOnName },
            React.createElement('span', { className: 'dsh-music-bar-name-text' }, note, ' ', displayName || '未在播放'),
            hasTrack ? artistEl : null, hasTrack ? sourceBadge : null, hasTrack ? localQualityBadge : null, hasTrack ? chapterEl : null, hasTrack ? afterName : null, hasTrack ? mirrorBadge : null),
          // ── 音频块：只剩我们的迷你频谱（频谱 60×20，字面量固定，绝不量容器）；音准 chip 已删 ──
          // 迷你黑胶已按用户要求撤掉（改成标题左侧的音符图标 MusicNote，见上方 note）。
          vizMounted ? React.createElement('canvas', { className: 'smp-music-bar-viz', width: SMP_VIZ_W, height: SMP_VIZ_H, ref: function (el) { canvasSlotRef.current = el; } }) : null,
          // ── 歌词：我们的单行歌词（空态显示「无歌词」，不留空白）──
          //     播放失败时**借这一位**显示中文提示：QQ 曲 VIP/版权受限 → 后端取链 404，
          //     浏览器只会甩一句英文 "The element has no supported sources"，不许摊给用户。
          //     用 playError 覆盖时不再挂动效类（红字还在做滑入动画会很怪）。
          (prefs.lyricShow === false && !s.playError) ? null : React.createElement('span', {
            key: s.playError ? ('err-' + s.playError) : ('lyr-' + lyricText),
            className: 'dsh-music-bar-lyric ' + (s.playError ? 'err' : ('smp-lyric-fx-' + lyricFx + (lyricText ? '' : ' empty'))),
            title: s.playError || lyricText || '无歌词'
          }, s.playError || lyricText || '无歌词'),
          React.createElement('div', { className: 'dsh-music-bar-controls' + (active ? ' on' : ''), onMouseLeave: isFloat ? undefined : onBarLeave },
            (hasTrack && showHint)
              ? React.createElement('span', { className: 'dsh-music-bar-hint' }, '⚠ 自动播放被拦截，点击▶解锁')
              : (timeVisible ? React.createElement('span', { className: 'dsh-music-bar-time' }, fmtTime(cur) + ' / ' + fmtTime(dur)) : null),
            React.createElement('div', { className: 'dsh-music-bar-btns' },
              heartBtn,
              React.createElement('button', { className: 'dsh-music-bar-btn', title: '上一首', disabled: !hasTrack, onClick: function () { step(-1); } }, ICON_PREV),
              React.createElement('button', { className: 'dsh-music-bar-btn', title: '播放/暂停', onClick: function () { if (!hasTrack) { togglePanel(); return; } togglePlay(); } }, (s.playing ? ICON_PAUSE : ICON_PLAY)),
              React.createElement('button', { className: 'dsh-music-bar-btn', title: '下一首', disabled: !hasTrack, onClick: function () { step(1); } }, ICON_NEXT),
              React.createElement('button', { className: 'dsh-music-bar-btn', title: '停止', disabled: !hasTrack, onClick: function () { try { SMP_STORE.stop(); } catch (eStop) {} } }, ICON_STOP),
              // 对方专有入口：讲书章节目录（SMP_FEATURES.toc 恒 false → 不渲染可点元素，分支保留原文）
              SMP_FEATURES.toc ? React.createElement('button', {
                className: 'dsh-music-mode-trigger' + (s.tocOpen ? ' active' : ''),
                title: '章节目录',
                onClick: openToc
              }, iconSvg('M4 6h16v2H4V6zm0 5h16v2H4v-2zm0 5h10v2H4v-2z', 16)) : null,
              // 对方专有入口：播放模式下拉（SMP_FEATURES.modeMenu 恒 false）
              SMP_FEATURES.modeMenu && !isBook ? React.createElement(ModeDropdown, null) : null,
              React.createElement('button', { className: 'dsh-music-bar-btn', title: '播放队列', onClick: function () { if (!hasTrack) { togglePanel(); return; } try { SMP_STORE.openQueue(); } catch (eQ) {} } }, iconSvg("M3 10h11v2H3zM3 6h11v2H3zM3 14h7v2H3zM16 13v8l6-4z", 14)),
              React.createElement('div', { className: 'dsh-music-bar-vol', ref: volBtnRef, onMouseEnter: cancelVolClose, onMouseLeave: closeVolSoon },
                React.createElement('button', {
                  className: 'dsh-music-mode-trigger' + (volOpen ? ' active' : ''),
                  title: '音量',
                  onClick: function () { setVolOpen(function (o) { return !o; }); }
                }, React.createElement('svg', {
                  viewBox: '0 0 24 24', width: 16, height: 16, fill: 'currentColor', 'aria-hidden': true
                }, React.createElement('path', { d: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z' })))
              ),
              React.createElement('button', { className: panelCls, title: '播放列表', onClick: togglePanel }, iconSvg("M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z", 14))
            ),
            // 音量弹层：对方 createPortal 到 body；我们无 react-dom → fixed + anchorAbove（视觉一致）
            volOpen ? React.createElement('div', { className: 'dsh-music-bar-vol-pop', style: anchorAbove(volBtnRef.current, 36, 108), ref: volPopRef }, React.createElement(VolumeSlider, null)) : null,
            // 常显收起按钮（2026-11-11 用户报「找不到关闭按钮」）：不参与 hover 才滑出的
            // `.dsh-music-bar-controls.on` 逻辑，永远 opacity:1。面板里那条不需要（面板能直接关）。
            isPanel ? null : React.createElement('button', {
              className: 'dsh-music-bar-hide',
              title: s.barHidden ? '展开播放条' : '收起播放条',
              onClick: function (ev) {
                if (ev && ev.stopPropagation) ev.stopPropagation();
                try { SMP_STORE.setBarHidden(!s.barHidden); } catch (e9) {}
              }
            }, s.barHidden ? '\u2303' : '\u00d7')
          ),
          React.createElement('div', { className: 'dsh-music-bar-hotspot', onMouseEnter: showBarBtns, onMouseLeave: leaveHotspot }),
          // 播放进度细线：视觉逐字照抄（1px + pointer-events:none），外面套 13px 透明命中区负责 seek
          (prefs.progressShow !== false)
            ? React.createElement('div', { className: 'smp-music-bar-progress-hit', onPointerDown: onProgressDown, onPointerMove: onProgressMove },
                React.createElement('div', { className: 'dsh-music-bar-progress' },
                  React.createElement('div', { className: 'dsh-music-bar-progress-fill', style: { width: progressPct + '%' } })))
            : null,
          // 队列面板：fixed 定位，父级 overflow:hidden 裁不到 fixed 元素
          // （前提是无 transform 祖先；dock 模式下 wrap 的 style 是 undefined）。
          // 放 children 里而不是另起一层 fragment，是为了让 render 的返回值仍是
          // div#smp-music-bar-wrap —— 三套回归测试都按「首节点即条根」断言。
          React.createElement(SmpQueuePanel)
        )
      );
      return barEl;
    }


    // slots 是宿主的官方插槽服务。取不到时**不抛错、不阻断** —— 本插件的
    // 侧边栏 file viewer 是主功能，不能因为拿不到插槽服务就整体失效。
    function resolveSlots(ctx) {
      var s = null;
      try { if (ctx && typeof ctx.get === "function") s = ctx.get("slots"); } catch (e) { s = null; }
      if (s === undefined || s === null) { try { s = ctx.slots; } catch (e2) { s = null; } }
      return (s === undefined || s === null) ? null : s;
    }

    // 两条播放条的实际注册：位置 / order / 容器结构 / CSS 全部照抄对方
    // （dsh-music-player v1.0.4），见本文件头顶 S1.5 注释块与
    // `D:\YuE2\_对照表-播放条定位-待裁决.md`。
    // 注册必须包 ctx.effect —— 宿主契约要求，否则停用再启用会抛 "already registered"。
    // 幂等：立即路径与有界重试路径都调它，靠 smpDockMounted 去重，绝不重复注册。
    // 🔴 同 SMP_STORE：挂载守卫也必须跨实例生效，否则第二个模块实例会再注册一套 dock/overlay 条。
    var smpDockMounted = !!(typeof globalThis !== "undefined" && globalThis.__DSH_SMP_BAR_MOUNTED__);
    // ── S5 前置：本地音乐页 ─────────────────────────────────────────────
    // 数据源 GET /dsh-sidebar-media-player/library?dir=&depth=
    //   → { ok, root, count, truncated, tracks:[{name,path,ext,size,mtimeMs,isVideo}] }
    //   错误体是本插件既有形状 { ok:false, error:{ code, message } }
    //   （QQ 区才是 {ok:false,error:"字符串"}，两边别混）
    // 播放：列表只给绝对路径，url 留空 → store.ensureItemUrl 走 /media 取 blob，
    //       保持既有 blob 播放链路，绝不把 path 直接塞 <audio src>。
    var SMP_LIB_DEFAULT_DEPTH = 8;
    var smpLibCache = { dir: null, data: null };
    /* ── 自绘目录浏览器 ────────────────────────────────────────────────
       宿主（Electron webview）里 <input type=file> 弹不出系统对话框 ——
       参照 dsh-music-player 的做法：后端列目录 + 前端点选。
       路由：GET /dsh-sidebar-media-player/dir?path=（path="__drives__" 枚举盘符） */
    function smpDirUrl(dir) {
      return "/dsh-sidebar-media-player/dir?path=" + encodeURIComponent(dir || "__drives__");
    }
    function smpJoinPath(dir, name) {
      if (!dir || dir === "__drives__") return name;
      return String(dir).replace(/[\\/]+$/, "") + "\\" + name;
    }
    /* 选中目录后：/library?dir= 拿曲目 → 直接给 url（同源 /media 代理，带 Range 可 seek）
       不再走 blob。focusName 用于「点某个文件直接播」。 */
    function smpPlayLibraryDir(dir, focusName, scope) {
      var q = "/dsh-sidebar-media-player/library?dir=" + encodeURIComponent(dir) + "&depth=8";
      return fetch(q, { cache: "no-store" })
        .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
        .then(function (d) {
          if (!d || d.ok === false) {
            var e = d && d.error;
            return { ok: false, count: 0, err: (e && (e.message || e.code)) || "曲库读取失败" };
          }
          var tracks = d.tracks || [];
          if (!tracks.length) return { ok: true, count: 0, err: "" };
          var root = d.root || dir;
          // sessionId 必须非空（后端 400 校验）；baseParams 还有一道收口兜底。
          var sc = { sessionId: (scope && scope.sessionId) || "smp", cwd: root };
          SMP_STORE.setScope(sc);
          var items = [];
          var focus = -1;
          for (var i = 0; i < tracks.length; i++) {
            var t = tracks[i];
            items.push({ name: t.name, path: t.path, isVideo: !!t.isVideo, url: mediaUrl(sc, t.path) });
            if (focusName && focus < 0 && t.name === focusName) focus = i;
          }
          SMP_STORE.setList(items, true, focus >= 0 ? focus : 0);
          return { ok: true, count: items.length, err: "" };
        })
        .catch(function (e2) { return { ok: false, count: 0, err: "网络错误：" + errText(e2) }; });
    }
    /* ── 侧边栏主面板「播放器」──────────────────────────────────────────────
       用户定案（原话）：「可以把我的播放器单独弄一个侧边栏面板进来就是播放器得样子
       也能看视频得，本质上叫侧边栏播放器拥有qq音乐平台登录，本地，播放，看视频等功能
       这样同时也可以再输入框上方或者下方播放这种」
       → 唯一侧边栏面板 = 本组件；内部自带「本地音乐 / QQ音乐 / 系统配置」三个**面板内**页签；
         输入框上/下侧那条是同一 store 的另一入口，两处联动。
       第①步只做骨架 + 空态；页签内容与外观在②③步接。 */
    // ── 第③步：系统配置页（9 项，逐项都接了真消费点；样式全套复用 A-5 的
    //    .dsh-music-config* / .dsh-music-toggle*，不新造外观） ──
    function SmpPrefsPanel() {
      var snap = useSmpStore();
      var prefs = (snap && snap.prefs) || SMP_STORE.defaultPrefs;

      var put = function (k, v) {
        try {
          // 位置是另一个键（smp.barPos），不走 prefs
          if (k === "barPos") SMP_STORE.setBarPos(v);
          else SMP_STORE.setPref(k, v);
        } catch (e0) { /* 写盘失败不影响本次会话 */ }
      };

      // 每满 30 分钟自动再跑一轮「看广告」并叠加 30 分钟 —— 按**真实时间**循环。
      // 旧实现是「等 freeMinutes 涨到比基线多 30 再触发」，而 freeMinutes 只由用户手动
      // 点按钮增长 → 自动模式实际上永远不会自己启动。改成记 freeAutoAt 时间戳：
      //   挂载时若距上次已满 30 分钟（或从未跑过），补跑一轮；之后每分钟检查一次是否到期。
      // 重挂组件（切页签）不会重复跑，因为到期判断看的是持久化时间戳。
      react.useEffect(function () {
        if (prefs.freeAuto === false) return undefined;
        var stopped = false;
        var runIfDue = function () {
          if (stopped) return;
          try {
            var st = SMP_STORE.getState().prefs || {};
            var last = Number(st.freeAutoAt) || 0;
            var now = Date.now();
            if (last && (now - last) < 30 * 60 * 1000) return;
            var cur = Number(st.freeMinutes) || 0;
            SMP_STORE.setPref("freeMinutes", cur + 30);
            SMP_STORE.setPref("freeAutoAt", now);
            fetch("/dsh-sidebar-media-player/qq/free/open", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ url: "https://y.qq.com/", seconds: 15, count: 1 })
            }).catch(function () {});
          } catch (eA) { /* 定时任务失败不打扰 UI */ }
        };
        runIfDue();
        var iv = setInterval(runIfDue, 60000);
        return function () { stopped = true; clearInterval(iv); };
      }, [prefs.freeAuto]);

      var row = function (key, label, desc, ctrl) {
        return h("div", { key: key, className: "dsh-music-config-row" }, [
          h("div", { key: "i", className: "dsh-music-config-info" }, [
            h("div", { key: "l", className: "dsh-music-config-label" }, label),
            desc ? h("div", { key: "d", className: "dsh-music-config-desc" }, desc) : null
          ]),
          ctrl
        ]);
      };

      var toggle = function (key, on) {
        return h("button", {
          key: "t", type: "button", role: "switch",
          "aria-checked": on ? "true" : "false",
          className: "dsh-music-toggle" + (on ? " on" : ""),
          onClick: function () { put(key, !on); }
        }, h("span", { key: "k", className: "dsh-music-toggle-knob" }));
      };

      var seg = function (key, cur, opts) {
        return h("div", { key: "s", className: "dsh-music-config-seg" }, opts.map(function (o) {
          return h("button", {
            key: o.v, type: "button",
            className: "dsh-music-config-seg-btn" + (cur === o.v ? " on" : ""),
            onClick: function () { put(key, o.v); }
          }, o.t);
        }));
      };

      var card = function (key, children) {
        return h("div", { key: key, className: "dsh-music-config-card" }, children);
      };

      var FX = [
        { v: "none", t: "无" },
        { v: "slide", t: "上滑淡入" },
        { v: "blur", t: "模糊浮入" },
        { v: "karaoke", t: "卡拉OK" },
        { v: "rainbow", t: "炫彩" }
      ];
      var STYLE = [{ v: "bar", t: "柱状" }, { v: "wave", t: "波形" }];
      var POS = [{ v: "dock", t: "输入框上方" }, { v: "bottom", t: "页面底部" }];

      var imm = typeof prefs.immersion === "number" ? prefs.immersion : 50;
      var specOn = prefs.specShow !== false;
      var lyricOn = prefs.lyricShow !== false;

      return h("div", { className: "dsh-music-config", "data-smp": "prefs" }, [
        card("lyric", [
          row("lyricShow", "🎤 歌词显示", "播放条单行歌词与面板歌词块", toggle("lyricShow", lyricOn)),
          lyricOn ? row("lyricFx", "✨ 动效", "切句时的过渡", seg("lyricFx", prefs.lyricFx || "slide", FX)) : null
        ]),
        card("spec", [
          row("specShow", "📊 频谱显示", "播放条与侧边栏的频谱柱", toggle("specShow", specOn)),
          specOn ? row("specStyle", "〰️ 样式", "柱状 / 波形", seg("specStyle", prefs.specStyle || "bar", STYLE)) : null
        ]),
        card("bar", [
          row("progressShow", "▬ 进度条", "播放条细线与面板主体进度条", toggle("progressShow", prefs.progressShow !== false))
        ]),
        card("barLook", [
          row("badgeShow", "💎 徽章", "", toggle("badgeShow", prefs.badgeShow !== false)),
          row("barBgShow", "🎨 背景", "", toggle("barBgShow", prefs.barBgShow !== false)),
          row("immersion", "🌫️ 沉浸感", "", h("div", { key: "v", className: "dsh-music-config-slider" }, [
            h("input", {
              key: "r", type: "range", min: 0, max: 100, step: 5,
              className: "dsh-music-config-range", value: imm,
              onChange: function (ev) { put("immersion", ev && ev.target ? ev.target.value : 50); }
            }),
            h("span", { key: "n", className: "dsh-music-config-val" }, String(imm))
          ]))
        ]),
        card("free", [
          row("freeMinutes", "🎁 免费时长", "已累计 " + (Number(prefs.freeMinutes) || 0) + " 分钟 · 每满 30 分钟自动再叠加", h("div", { key: "f", style: { display: "flex", alignItems: "center", gap: "4px" } }, [
            h("button", {
              key: "go", type: "button", className: "dsh-music-config-seg-btn on",
              title: "打开一个独立浏览器窗口停留 15 秒后自动关闭（可连点多次 = 多开）",
              onClick: function () {
                var next = (Number(prefs.freeMinutes) || 0) + 5;
                put("freeMinutes", next);
                try {
                  fetch("/dsh-sidebar-media-player/qq/free/open", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ url: "https://y.qq.com/", seconds: 15, count: 1 })
                  }).catch(function () {});
                } catch (eF) {}
              }
            }, "看广告 +5"),
            h("button", {
              key: "multi", type: "button", className: "dsh-music-config-seg-btn",
              title: "一次开 3 个独立窗口，15 秒后全部自动关闭",
              onClick: function () {
                put("freeMinutes", (Number(prefs.freeMinutes) || 0) + 15);
                try {
                  fetch("/dsh-sidebar-media-player/qq/free/open", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ url: "https://y.qq.com/", seconds: 15, count: 3 })
                  }).catch(function () {});
                } catch (eF2) {}
              }
            }, "多开 ×3")
          ])),
          row("freeAuto", "⏱ 每 30 分钟自动叠加", "开启：累计到 30 分钟自动再跑一轮并 +30", toggle("freeAuto", prefs.freeAuto !== false))
        ]),
        card("pos", [
          row("barPos", "📍 位置", "", seg("barPos", snap.barPos === "bottom" ? "bottom" : "dock", POS))
        ])
      ]);
    }

/* ══════════════════════════════════════════════════════════════════════
       第⑤步：QQ 在线音乐面板 —— 搬运自 dsh-music-player（MIT License）
       Copyright (c) kendu76 — https://github.com/kendu76/dsh-music-player
       修改说明（本项目）：
         · 路由前缀 /dsh-music/qq/* → /dsh-sidebar-media-player/qq/*（26 处字面量替换，
           不抽常量是为了让每处 URL 仍可原样 grep；后端只提供后者）
         · useStore() → useSmpStore()（共用我们的模块级单例 SMP_STORE）
         · portalToBody() → qqPortal()（本文件原桩是"返回原节点"，弹层会被 overflow 裁）
         · startQQPlayback() → smpQQStartPlayback()（走 SMP_STORE，不另起 audio）
       本段之后紧接原函数的完整实现，未改任何 UI 结构。
       ══════════════════════════════════════════════════════════════════════ */
    var __smpReactDom = null;
    try { __smpReactDom = require("react-dom"); } catch (e0) { __smpReactDom = null; }

    var __smpPortalLogged = false;
    // 「面板层级/歌单位置」是否已从 PREF_QQ_UI 恢复过一次（A 同名模块级 flag）。
    // 面板重挂载（切页签再切回、宿主 keepMounted 释放）时不能重复覆盖用户手动调好的层级。
    var qqUiRestored = false;

    function qqPortal(node) {
      if (__smpReactDom && typeof __smpReactDom.createPortal === "function") {
        try {
          var out = __smpReactDom.createPortal(node, document.body);
          if (!__smpPortalLogged) {
            __smpPortalLogged = true;
            try { console.info("[smp] qqPortal route=createPortal(document.body)"); } catch (e9) {}
          }
          return out;
        } catch (e0) {}
      }
      if (!__smpPortalLogged) {
        __smpPortalLogged = true;
        try { console.info("[smp] qqPortal route=fallback(return-node) —— 弹层已全部改用 fixed 定位，不会被 overflow 裁"); } catch (e9) {}
      }
      return node;      // 兜底：拿不到 react-dom 就原地渲染（fixed 定位保证不被裁，且不崩）
    }

    // 搜索历史 / 在线播放进度 / 面板 UI 位置的偏好键（与 A 的键名不撞，各存各的）
    var PREF_QQ_HISTORY = "smp.qq.history";
    var PREF_PLAYBACK_QQ = "smp.qq.playback";
    var PREF_QQ_UI = "smp.qq.ui";
    var QQP_KEYS = { "smp.qq.history": 1, "smp.qq.playback": 1, "smp.qq.ui": 1 };
    // 语义与 A 的 loadPref 一致：**返回原始字符串**，调用方自己 JSON.parse
    // （段内是 `JSON.parse(loadPref(k))` + `savePref(k, JSON.stringify(v))`，返回对象会二次 parse 失败）
    function loadPref(k) {
      if (!QQP_KEYS[k]) return null;
      try { return localStorage.getItem(k); } catch (e0) { return null; }
    }
    function savePref(k, v) {
      if (!QQP_KEYS[k]) return;
      try { localStorage.setItem(k, String(v)); } catch (e0) {}
    }
    function clearPref(k) {
      if (!QQP_KEYS[k]) return;
      try { localStorage.removeItem(k); } catch (e0) {}
    }

    var jsonGet = function (url) {
      return fetch(url, { cache: "no-store" }).then(function (r) { return r.json(); });
    };
    var jsonPost = function (url, body) {
      return fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      }).then(function (r) { return r.json(); });
    };

    // 搜索历史下拉专用：锚定在搜索框正下方（fixed，左边缘对齐、宽度一致）
    function anchorBelow(el, maxW) {
      maxW = maxW || 420;
      var vw = window.innerWidth;
      var r = (el && typeof el.getBoundingClientRect === "function") ? el.getBoundingClientRect() : null;
      var margin = 8;
      var width = Math.min((r && r.width > 0) ? r.width : 380, maxW, vw - margin * 2);
      var left = (r && r.width > 0)
        ? Math.max(margin, Math.min(vw - margin - width, r.left))
        : Math.max(margin, Math.round((vw - width) / 2));
      var top = (r && r.height > 0) ? Math.round(r.bottom + 4) : margin;
      return { position: "fixed", left: Math.round(left), top: top, width: Math.round(width), maxHeight: 240 };
    }

    // 以面板中心为基准的固定定位（面板可拖拽，弹窗随其居中）
    function panelCenterStyle(panelRef, on, halfW, maxH) {
      if (!on) return null;
      var pr = (panelRef && panelRef.current) ? panelRef.current.getBoundingClientRect() : null;
      var vw = window.innerWidth, vh = window.innerHeight;
      var cx = (pr && pr.width > 0) ? pr.left + pr.width / 2 : vw / 2;
      var cy = (pr && pr.height > 0) ? pr.top + pr.height / 2 : vh / 2;
      var clampC = function (v, lo, hi) { return lo <= hi ? Math.max(lo, Math.min(v, hi)) : v; };
      var halfWm = Math.min(halfW, vw / 2);
      var halfHm = Math.min(maxH / 2, vh / 2);
      return {
        position: "fixed",
        left: clampC(cx, halfWm, vw - halfWm),
        top: clampC(cy, halfHm, vh - halfHm),
        transform: "translate(-50%, -50%)",
        maxHeight: maxH + "px",
        margin: 0,
      };
    }

    // 浮层提示 / 自绘输入框 / 自绘确认框 —— 全部走 SMP_STORE，面板内渲染
    // （Electron 里 window.prompt / confirm 不可用，必须自绘）
    var __smpToastSeq = 0;
    var __smpToastTimer = null;
    function showToast(text, ok) {
      var id = ++__smpToastSeq;
      SMP_STORE.setToast({ text: String(text == null ? "" : text), ok: !!ok, id: id });
      if (__smpToastTimer !== null) clearTimeout(__smpToastTimer);
      __smpToastTimer = setTimeout(function () {
        __smpToastTimer = null;
        var t = SMP_STORE.getState().toast;
        if (t && t.id === id) SMP_STORE.setToast(null);
      }, 2000);
    }
    var __smpPromptSeq = 0;
    function openPrompt(title, initial, onOk) {
      SMP_STORE.setPrompt({ id: ++__smpPromptSeq, title: String(title || ""), initial: String(initial || ""), onOk: onOk });
    }
    function closePrompt() { SMP_STORE.setPrompt(null); }
    function openConfirm(title, message, onOk, okText, danger) {
      SMP_STORE.setConfirm({ title: String(title || ""), message: String(message || ""), onOk: onOk, okText: okText || "确定", danger: !!danger });
    }
    function closeConfirm() { SMP_STORE.setConfirm(null); }

    // ── 第⑤步：QQ 面板依赖的 A 顶层函数（原在 QQOnlinePanel 段之外，漏剪会 ReferenceError）──
    // 1) 收藏集合：A 的实现要打 /qq/fav-ids（本机后端未提供该路由），这里给"空集合 + 已拉标记"
    //    的诚实实现 —— 不崩、不假装已收藏；换成真接口时只改这一个函数。
    var __smpQqFavFetched = false;
    function ensureQQFavIds() {
      if (__smpQqFavFetched) return Promise.resolve({ ids: [], mids: [] });
      __smpQqFavFetched = true;
      return Promise.resolve({ ids: [], mids: [] });
    }
    function refreshQQFavIds() {
      __smpQqFavFetched = false;
      return ensureQQFavIds();
    }
    // 2) 「登录已过期」标记复位（发 `s.qqAuthExpired` 消费）
    function resetQQAuthExpired() {
      if (SMP_STORE.getState().qqAuthExpired) SMP_STORE.publish({ qqAuthExpired: false });
    }
    // 2b) 账号 VIP 状态：后端 GET /dsh-sidebar-media-player/qq/vip
    //     返回 { ok, isVip, uin, loggedIn }。**未登录也回 200**（ok:true / isVip:false /
    //     loggedIn:false），所以只有 isVip 不够 —— 结论要配 loggedIn 一起看。
    //     写进快照是**三态**：null = 还没查过（放行，避免查不到就把所有 VIP 曲全禁掉）；
    //     true / false = 实测结果。登录成功后必刷一次，面板挂载时若已登录也刷一次。
    var __smpVipReq = null;
    function refreshQQVip() {
      try {
        if (__smpVipReq) return __smpVipReq;
        __smpVipReq = fetch("/dsh-sidebar-media-player/qq/vip", { credentials: "same-origin" })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) {
            __smpVipReq = null;
            if (!d || d.ok !== true) return;
            SMP_STORE.publish({ qqIsVip: d.isVip === true, qqVipUin: d.uin || "" });
          })
          .catch(function () { __smpVipReq = null; });
      } catch (e0) {}
      return __smpVipReq;
    }
    // 3) 读回持久化的在线播放队列（PREF_PLAYBACK_QQ 存的是 JSON 字符串，需 p.id 是 string）
    function loadQQPlayback() {
      var raw = loadPref(PREF_PLAYBACK_QQ);
      if (raw === null) return null;
      try {
        var p = JSON.parse(raw);
        if (p && typeof p.id === "string") return p;
      } catch (e0) {}
      return null;
    }

    // 点歌 → 走 SMP_STORE（不另起 audio）。签名与 A 的 startQQPlayback 一致，调用点不改。
    // QQ 的音频由后端 /qq/play/<mid> 同源代理（带 Range + Referer），直接给 <audio src>。
    function smpQQStartPlayback(song, queue, sourceLabel, from) {
      try {
        var arr = (queue && queue.length) ? queue : [song];
        var target = String((song && (song.songmid || song.id)) || "");
        var items = [];
        var idx = 0;
        for (var i = 0; i < arr.length; i++) {
          var it = arr[i] || {};
          var mid = String(it.songmid || it.id || "");
          if (!mid) continue;
          if (mid === target) idx = items.length;
          var tname = String(it.name || it.title || mid);
          var artist = "";
          try {
            if (it.singer && it.singer.length) {
              artist = it.singer.map(function (x2) { return String((x2 && (x2.name || x2.title)) || ""); }).filter(Boolean).join("/");
            }
          } catch (e1) {}
          items.push({
            name: artist ? (tname + " - " + artist) : tname,
            trackName: tname,
            artist: artist,
            url: "/dsh-sidebar-media-player/qq/play/" + encodeURIComponent(mid),
            isVideo: false,
            qqMid: mid,
            // QQ 歌单自带 interval（秒）。代理流没有 Content-Length → <audio>.duration 恒为
            // NaN/Infinity，界面上时间就只剩「/ 0:00」。带一份元数据时长做兜底（loadIndex 存进
            // state.durMeta，事件里 duration 取不到时回落到它）。
            duration: (function () {
              var iv = Number(it.interval);
              return isFinite(iv) && iv > 0 ? iv : 0;
            })(),
          });
        }
        if (!items.length) return;
        // 队列进快照，但**截断 200 首**：整张歌单/榜单（几百首）留在面板自己的 useState 里
        SMP_STORE.publish({
          qqQueue: arr.slice(0, 200),
          qqQueueFrom: from || null,
          qqQueueRev: (SMP_STORE.getState().qqQueueRev || 0) + 1,
          qqSource: sourceLabel || "在线",
        });
        SMP_STORE.setList(items, true, idx);
      } catch (e0) {
        try { console.warn("[smp] QQ 点歌失败", e0); } catch (e1) {}
      }
    }

function QQOnlinePanel({ panelRef }) {
      // 本项目新增：模块作用域没有 React，用 h 桥接（与 SmpQueuePanel 同款做法）
      var React = { createElement: h };
      const s = useSmpStore();
      const [loggedIn, setLoggedIn] = useState(s.qqLoggedIn || false);
      const [uin, setUin] = useState(s.qqUin || '');
      const [nickname, setNickname] = useState(s.qqNickname || '');
      // 挂载时若已登录，补一次 VIP 状态（登录路径里已经刷过；这里管"重开面板/重载插件"）
      useEffect(function () { if (s.qqLoggedIn) refreshQQVip(); }, [s.qqLoggedIn]);
      // 两层 UI：layer='main' 主UI（登录/搜索/推荐/分类）；layer='playlist' 播放列表UI（当前队列或某歌单）。
      const [layer, setLayer] = useState('main');
      const [activePl, setActivePl] = useState(null); // { id?, name, creator?, songs, source }
      const [plLoading, setPlLoading] = useState(false); // 播放列表歌曲加载中
      const [browseTab, setBrowseTab] = useState('mine'); // mine | recommend | category | tops | new | search
      // 搜索（统一：歌曲 + 歌单）。
      const [q, setQ] = useState('');
      const [searched, setSearched] = useState(false);
      const [searching, setSearching] = useState(false);
      const [results, setResults] = useState([]);
      const [plResults, setPlResults] = useState([]);
      const [qError, setQError] = useState('');
      const [resultTab, setResultTab] = useState('songs'); // 搜索结果内：songs | playlists
      // 搜索分页：每页即接口单请求上限（歌曲 60、歌单 50）。「是否还有下一页」：
      // 歌曲搜索用接口 total（totalnum 可靠，实测热门词 600+）；歌单搜索既无 totalnum
      // 也没有可用 total（sum 是虚高展示数），且每页返回数不固定（49/46/44/35），只能
      // 用「最近一页返回较满(≥20)」判定还有更多。
      const QQ_PL_PAGE = 20;
      const [searchPage, setSearchPage] = useState(1);
      const [searchLastLen, setSearchLastLen] = useState(0);
      const [searchTotal, setSearchTotal] = useState(0);
      const [searchingMore, setSearchingMore] = useState(false);
      const [plSearchPage, setPlSearchPage] = useState(1);
      const [plSearchLastLen, setPlSearchLastLen] = useState(0);
      const [plSearchTotal, setPlSearchTotal] = useState(0);
      const [plSearchingMore, setPlSearchingMore] = useState(false);
      // 搜索历史（Host 持久化，最近在前）。
      const [hist, setHist] = useState([]);
      const [histOpen, setHistOpen] = useState(false);
      const histRef = useRef(null);
      const histPopRef = useRef(null); // portal 到 body 的历史下拉（点击内部不关闭）
      // 恢复「在线播放列表」层：prefsReady 早于 restorePlayback 灌 qqQueue，队列就绪前
      // 先标记待恢复，等 qqQueue 非空后由下方 effect 补上（避免刷新后直接显示「暂无歌曲」）。
      const queueRestorePending = useRef(false);
      // 浏览。
      const [minePlays, setMinePlays] = useState([]);
      const [mineLoaded, setMineLoaded] = useState(false);
      const [recommended, setRecommended] = useState([]);
      const [categories, setCategories] = useState([]);
      const [catPlays, setCatPlays] = useState([]);
      const [curCategory, setCurCategory] = useState(null);
      const [browseErr, setBrowseErr] = useState('');
      const [browseLoading, setBrowseLoading] = useState(false);
      // 「加入歌单」弹窗：{ song, x, y }（锚点=「＋」按钮的视口坐标），点击弹出我的歌单列表。
      const [qqJoin, setQqJoin] = useState(null);
      const qqJoinRef = useRef(null);
      // 点击弹窗外关闭「加入歌单」弹窗。
      useEffect(() => {
        if (qqJoin === null) return;
        const onDown = (e) => { if (qqJoinRef.current !== null && !qqJoinRef.current.contains(e.target)) setQqJoin(null); };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
      }, [qqJoin]);
      // QQ 播放列表层：进入或切换播放曲目时，把正在播放的那一行滚动到可见位置。
      useEffect(() => {
        const list = qqPlRef.current;
        if (list === null) return;
        const active = list.querySelector('.dsh-music-track-row.active');
        if (active !== null && typeof active.scrollIntoView === 'function') {
          active.scrollIntoView({ block: 'nearest' });
        }
      }, [layer, s.currentId, activePl]);
      // 推荐歌单加载更多：热门推荐 12 条后用「全部分类」分页续载。
      const [recPage, setRecPage] = useState(1);
      const [recLoadingMore, setRecLoadingMore] = useState(false);
      const [recHasMore, setRecHasMore] = useState(true);
      // 分类歌单加载更多：每页 20 条，可翻页续载。
      const [catPage, setCatPage] = useState(1);
      const [catLoadingMore, setCatLoadingMore] = useState(false);
      const [catHasMore, setCatHasMore] = useState(true);
      // 分类 chips 折叠/展开：默认折叠只显示少量，展开显示全部。
      const [catExpanded, setCatExpanded] = useState(false);
      // 排行榜 + 新歌（发现页签）。
      const [topGroups, setTopGroups] = useState([]);
      const [topLoaded, setTopLoaded] = useState(false);
      const [topDetail, setTopDetail] = useState(null); // { id, name, songs }
      const [topLoading, setTopLoading] = useState(false);
      // 榜单详情分页：已加载歌曲总数 / 是否还有下一页 / 加载更多进行中。
      const [topTotal, setTopTotal] = useState(0);
      const [topHasMore, setTopHasMore] = useState(false);
      const [topLoadingMore, setTopLoadingMore] = useState(false);
      const [newSongs, setNewSongs] = useState([]);
      const [newLoaded, setNewLoaded] = useState(false);
      // 登录。
      const [loginMode, setLoginMode] = useState(null);
      const [qrImage, setQrImage] = useState('');
      const [loginStatus, setLoginStatus] = useState('');
      const [loginBusy, setLoginBusy] = useState(false);
      const [playingId, setPlayingId] = useState('');
      const pollRef = useRef(null);
      const qrKeyRef = useRef('');
      const loginModeRef = useRef(null);
      // QQ 播放列表层（layer='playlist'）的滚动容器（.dsh-music-qq-body）引用，
      // 用于进入/切歌时把正在播放的曲目滚动到可见位置。
      const qqPlRef = useRef(null);

      const json = (url) => jsonGet(url).catch(() => ({ ok: false, error: '网络错误' }));
      // 搜索历史（Host 持久化，最近在前，最多 10 条）。
      const loadHist = () => { try { const a = JSON.parse(loadPref(PREF_QQ_HISTORY)); return Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x.trim()) : []; } catch { return []; } };
      const saveHist = (kw) => {
        kw = (kw || '').trim();
        if (!kw) return;
        const next = [kw, ...loadHist().filter((x) => x !== kw)].slice(0, 10);
        savePref(PREF_QQ_HISTORY, JSON.stringify(next));
        setHist(next);
      };
      const clearHist = () => { clearPref(PREF_QQ_HISTORY); setHist([]); };
      const clearPoll = () => { if (pollRef.current !== null) { try { clearInterval(pollRef.current); } catch {} try { clearTimeout(pollRef.current); } catch {} pollRef.current = null; } };
      // 记住当前操作所在层（主UI / 播放列表UI），下次弹窗恢复。
      const saveUi = (layer2, plId, plName) => { savePref(PREF_QQ_UI, JSON.stringify({ layer: layer2, plId: plId || '', plName: plName || '' })); };
      const loadUi = () => { try { return JSON.parse(loadPref(PREF_QQ_UI)); } catch { return null } };
      const restoreUi = (ui) => {
        if (!ui || ui.layer !== 'playlist') return;
        setLayer('playlist');
        if (ui.plId) {
          // 与 openPlaylist 同款加载态：先显示「加载中…」而不是空列表。QQ 歌单详情
          // 接口（fcg_ucc_getcdinfo_byids）在页面刚加载时首次请求常返回空 songlist
          // （冷缓存/会话未就绪），单次请求就会停在「暂无歌曲」——这正是「刷新后
          // 播放列表为空、返回重进才出来」的原因。这里对空结果/失败自动重试几次。
          setPlLoading(true);
          void loadPlaylistForRestore(ui.plId, ui.plName);
        } else {
          // 「在线播放列表」（openQueue 保存的 plId=''）：prefsReady 置位早于
          // restorePlayback 把 qqQueue 灌好，直接快照 s.qqQueue 会拿到空数组导致
          // 「暂无歌曲」。这里标记待恢复，由下方 [s.qqQueue] effect 在队列就绪后补上。
          queueRestorePending.current = true;
          setActivePl({ name: store.qqSource || '在线播放列表', songs: store.qqQueue || [], source: store.qqSource || '在线' });
        }
      };
      // 恢复的「在线播放列表」：等 restorePlayback 把 qqQueue 灌好后应用（修复刷新后
      // 该层显示为空的问题）；用户手动离开该层（返回/进入歌单）时取消待恢复。
      useEffect(() => {
        if (queueRestorePending.current && store.qqQueue && store.qqQueue.length > 0) {
          queueRestorePending.current = false;
          setActivePl({ name: store.qqSource || '在线播放列表', songs: store.qqQueue, source: store.qqSource || '在线' });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [s.qqQueue]);
      // 恢复歌单层：拉取歌单详情，空结果/失败自动重试（退避递增），成功后置入 activePl。
      const loadPlaylistForRestore = async (plId, plName, attempts = 3) => {
        let d = null;
        for (let i = 0; i < attempts; i++) {
          d = await json('/dsh-sidebar-media-player/qq/playlist/' + encodeURIComponent(plId));
          if (d && d.ok && d.playlist && Array.isArray(d.playlist.songs) && d.playlist.songs.length > 0) break;
          if (i + 1 < attempts) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
        }
        if (d && d.ok && d.playlist) setActivePl({ ...d.playlist, source: plName || '歌单' });
        setPlLoading(false);
      };
      // ① 挂载时只做本地初始化：读搜索历史（Host 持久化）+ 查登录态（status 由
      // host 读本地 cookie 文件，不发任何外部网络请求）。外部数据（分类/推荐/我的
      // 歌单）一律延后到登录后（见下方 [loggedIn] effect），未登录零外部请求——
      // 本插件 QQ 在线功能以「登录」为门槛。
      useEffect(() => {
        setHist(loadHist());
        jsonGet('/dsh-sidebar-media-player/qq/status').then((d) => {
          if (!d) return;
          // status 只反映「cookie 是否存在」（Host 不做主动探测）。「疑似登录失效」的标记
          // 由**播放失败**置位（见 onError → markOnlineAuthFailed），这里不主动清它，
          // 否则刚播失败切回登录 UI、一拉 status 又被清掉。
          setLoggedIn(!!d.loggedIn); setUin(d.uin || ''); setNickname(d.nickname || '');
          // 只在 status 真的给了登录方式时才覆盖 store（无脑写空会把 manifest 下发的
          // 「已登录（微信）」抹成「已登录」——关于页就是这么被弄花的）。
          if (d.loginFrom) set({ qqLoginFrom: d.loginFrom });
        }).catch(() => {});
        // 点击搜索框外时关闭历史下拉（含 portal 到 body 的下拉本身）。
        const onDocClick = (e) => {
          if (histRef.current !== null && histRef.current.contains(e.target)) return;
          if (histPopRef.current !== null && histPopRef.current.contains(e.target)) return;
          setHistOpen(false);
        };
        document.addEventListener('mousedown', onDocClick);
        return () => { clearPoll(); document.removeEventListener('mousedown', onDocClick); };
      }, []);
      // Host 预置快照异步到达：一旦就绪，重读搜索历史并恢复上次所在层（面板可能
      // 先于 Host 快照挂载，挂载时读到的历史/层可能还是空的）。
      useEffect(() => {
        if (!s.prefsReady) return;
        setHist(loadHist());
        if (!qqUiRestored && loggedIn) { qqUiRestored = true; restoreUi(loadUi()); }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [s.prefsReady, loggedIn]);
      // 引擎侧检出登录过期（播放中取链失败复查 / Host 状态）→ 面板立即回到登录 UI：
      // 不让用户停在「看着已登录、VIP 却播不了」的界面里；登录方式由他在登录页自己选。
      useEffect(() => {
        if (!s.qqAuthExpired) return;
        setLoggedIn(false); setLayer('main'); setActivePl(null); setPlLoading(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [s.qqAuthExpired]);
      // ② 登录态变化时才加载在线数据：未登录（loggedIn=false）一个外部请求都不发；
      // 登录成功（setLoggedIn(true)）或已登录刷新页面（status 返回 true）时自动加载
      // 分类 / 我的歌单 / 推荐，并恢复上次所在层。登出后不再加载。
      useEffect(() => {
        if (!loggedIn) return;
        json('/dsh-sidebar-media-player/qq/playlist-categories').then((d) => { if (d && d.ok) setCategories(d.categories || []); });
        // 默认落在「我的歌单」tab：登录态下加载我的歌单；未登录时主 UI 不显示。
        loadMine();
        loadRecommended();
        // 仅当 Host 预置就绪且本会话尚未恢复时，恢复上次所在层；之后切 tab 重挂
        // 不再拉回旧层。若此刻预置还没到（面板先挂载），留给上方 [prefsReady]
        // effect 在快照到达后恢复。
        if (!qqUiRestored && s.prefsReady) { qqUiRestored = true; restoreUi(loadUi()); }
      }, [loggedIn]);
      // ③ 收藏/取消收藏「我喜欢」后刷新「我的歌单」，让「我喜欢」歌单数目随之更新。
      useEffect(() => {
        if (s.qqFavRev > 0 && loggedIn) loadMine();
      }, [s.qqFavRev]);

      async function loadRecommended() {
        setBrowseLoading(true); setBrowseErr('');
        const d = await json('/dsh-sidebar-media-player/qq/playlists');
        if (d && d.ok) setRecommended(d.playlists || []); else setBrowseErr((d && d.error) || '加载失败');
        setBrowseLoading(false);
      }
      // 加载更多推荐歌单：热门推荐固定 12 条，续载「全部分类」的分页歌单并去重。
      async function loadMoreRecommended() {
        if (recLoadingMore || !recHasMore) return;
        setRecLoadingMore(true); setBrowseErr('');
        const nextPage = recPage + 1;
        const d = await json('/dsh-sidebar-media-player/qq/playlists?category=10000000&page=' + nextPage);
        if (d && d.ok && Array.isArray(d.playlists)) {
          const existing = new Set(recommended.map((p) => String(p.id)));
          const fresh = d.playlists.filter((p) => !existing.has(String(p.id)));
          setRecommended((prev) => [...prev, ...fresh]);
          setRecPage(nextPage);
          if (fresh.length === 0 || d.playlists.length < 20) setRecHasMore(false);
        } else {
          setBrowseErr((d && d.error) || '加载更多失败');
          setRecHasMore(false);
        }
        setRecLoadingMore(false);
      }
      async function loadMine() {
        setBrowseLoading(true); setBrowseErr('');
        const d = await json('/dsh-sidebar-media-player/qq/my-playlists');
        if (d && d.ok) setMinePlays(d.playlists || []); else setBrowseErr((d && d.error) || '加载失败');
        setMineLoaded(true);
        setBrowseLoading(false);
      }
      // 删除自建歌单（DelPlaylist / PlaylistBaseWrite）。二次确认后调 Host，成功后本地移除。
      async function deleteMinePlaylist(pl) {
        const dirId = Number(pl && (pl.dirId || pl.tid || pl.id)) || 0;
        if (!dirId) { setBrowseErr('缺少歌单 dirId，无法删除'); return; }
        openConfirm('删除歌单', '确定删除 QQ 歌单「' + (pl.name || '') + '」？删除后不可恢复。', async () => {
          setBrowseLoading(true); setBrowseErr('');
          try {
            const d = await jsonPost('/dsh-sidebar-media-player/qq/playlist-delete', { dirId });
            if (!d || !d.ok) throw new Error((d && d.error) || '删除歌单失败');
            setMinePlays((prev) => prev.filter((p) => String(p.id) !== String(pl.id)));
          } catch (err) {
            setBrowseErr(String((err && err.message) || err));
          }
          setBrowseLoading(false);
        }, '删除', true);
      }
      async function loadCategory(cat) {
        setCurCategory(cat); setCatPlays([]); setBrowseLoading(true); setBrowseErr('');
        setCatPage(1); setCatHasMore(true);
        const d = await json('/dsh-sidebar-media-player/qq/playlists?category=' + encodeURIComponent(cat.id) + '&page=1');
        if (d && d.ok) setCatPlays(d.playlists || []); else setBrowseErr((d && d.error) || '加载失败');
        setBrowseLoading(false);
      }
      // 分类歌单加载更多：同分类翻页续载并去重。
      async function loadMoreCategory() {
        if (!curCategory || catLoadingMore || !catHasMore) return;
        setCatLoadingMore(true); setBrowseErr('');
        const nextPage = catPage + 1;
        const d = await json('/dsh-sidebar-media-player/qq/playlists?category=' + encodeURIComponent(curCategory.id) + '&page=' + nextPage);
        if (d && d.ok && Array.isArray(d.playlists)) {
          const existing = new Set(catPlays.map((p) => String(p.id)));
          const fresh = d.playlists.filter((p) => !existing.has(String(p.id)));
          setCatPlays((prev) => [...prev, ...fresh]);
          setCatPage(nextPage);
          if (fresh.length === 0 || d.playlists.length < 20) setCatHasMore(false);
        } else {
          setBrowseErr((d && d.error) || '加载更多失败');
          setCatHasMore(false);
        }
        setCatLoadingMore(false);
      }
      async function loadTopLists() {
        if (topLoaded) return;
        setBrowseLoading(true); setBrowseErr('');
        const d = await json('/dsh-sidebar-media-player/qq/top-lists');
        if (d && d.ok) setTopGroups(d.groups || []); else setBrowseErr((d && d.error) || '加载排行榜失败');
        setTopLoaded(true);
        setBrowseLoading(false);
      }
      const TOP_PAGE = 300;
      async function loadTopSongs(top) {
        setTopDetail(null); setTopLoading(true); setBrowseErr('');
        setTopTotal(0); setTopHasMore(false);
        const d = await json('/dsh-sidebar-media-player/qq/top-songs?topId=' + encodeURIComponent(top.id) + '&offset=0&num=' + TOP_PAGE);
        if (d && d.ok) {
          const t = d.toplist || {};
          setTopDetail({ ...t, id: top.id, name: t.name || top.name, cover: t.cover || top.cover || '' });
          setTopTotal(Number(t.total) || (t.songs || []).length);
          setTopHasMore(!!t.hasMore);
        } else setBrowseErr((d && d.error) || '加载榜单失败');
        setTopLoading(false);
      }
      // 榜单「加载更多」：从当前已加载数量继续取下一页并追加，更新 total/hasMore。
      async function loadMoreTopSongs() {
        if (topLoadingMore || !topDetail) return;
        setTopLoadingMore(true); setBrowseErr('');
        const offset = (topDetail.songs || []).length;
        const d = await json('/dsh-sidebar-media-player/qq/top-songs?topId=' + encodeURIComponent(topDetail.id || topDetail.topId) + '&offset=' + offset + '&num=' + TOP_PAGE);
        if (d && d.ok) {
          const t = d.toplist || {};
          setTopDetail((cur) => (cur ? { ...cur, songs: [...(cur.songs || []), ...((t.songs || []))] } : cur));
          setTopTotal(Number(t.total) || offset + (t.songs || []).length);
          setTopHasMore(!!t.hasMore);
        } else setBrowseErr((d && d.error) || '加载更多失败');
        setTopLoadingMore(false);
      }
      async function loadNewSongs() {
        if (newLoaded) return;
        setBrowseLoading(true); setBrowseErr('');
        const d = await json('/dsh-sidebar-media-player/qq/new-songs?type=5');
        if (d && d.ok) setNewSongs((d.result && d.result.songs) || []); else setBrowseErr((d && d.error) || '加载新歌失败');
        setNewLoaded(true);
        setBrowseLoading(false);
      }
      function backToTops() { setTopDetail(null); setTopTotal(0); setTopHasMore(false); }
      // 「播放全部」：把歌单/榜单整列表作为播放队列，从第一首开始播。
      function playAllQQSongs() {
        const pl = activePl;
        if (!pl || !Array.isArray(pl.songs) || pl.songs.length === 0) return;
        // 与歌曲行一致的队列来源：我的歌单详情记该歌单，公开/其它为快照（不跟随）。
        const from = (pl.mine && pl.id) ? { kind: 'mine', id: String(pl.id), dirId: Number(pl._dirId) || 0 } : null;
        playSong(pl.songs[0], pl.songs, pl.name || 'QQ歌单', from);
      }
      function playAllQQTops() {
        const t = topDetail;
        if (!t || !Array.isArray(t.songs) || t.songs.length === 0) return;
        playSong(t.songs[0], t.songs, t.name || '排行榜', null);
      }
      function playAllQQNewSongs() {
        if (!Array.isArray(newSongs) || newSongs.length === 0) return;
        playSong(newSongs[0], newSongs, '新歌速递', null);
      }
      async function openPlaylist(pl, mine) {
        queueRestorePending.current = false; // 手动进入歌单，取消「在线播放列表」待恢复
        setActivePl(null); setLayer('playlist'); setPlLoading(true); saveUi('playlist', pl.id, pl.name);
        // _dirId：从歌单移除歌曲需要 QQ 歌单的目录 id（「我的歌单」卡片带 dirId）；
        // mine 标记这是「我自己的歌单」（含「我喜欢」），详情里才允许用「−」从该歌单移除。
        const _dirId = Number((pl && (pl.dirId || pl.tid || pl.id))) || 0;
        const d = await json('/dsh-sidebar-media-player/qq/playlist/' + encodeURIComponent(pl.id));
        if (d && d.ok) setActivePl({ ...d.playlist, source: pl.name || '歌单', mine: !!mine, _dirId });
        else setBrowseErr((d && d.error) || '加载失败');
        setPlLoading(false);
      }
      // 按队列来源（我的歌单）拉最新内容，替换播放队列；返回新队列（或 null 未刷新）。
      // 保留当前播放曲目：若它已被移出歌单，插到队首继续播，播完「下一首」接新歌单第一首。
      // from 可显式传入（openQueue 从持久化恢复时，闭包里的 s.qqQueueFrom 可能还是旧的）。
      async function refreshQqQueueFromSource(from) {
        from = from || s.qqQueueFrom;
        if (!from || from.kind !== 'mine' || !from.id) return null;
        const d = await json('/dsh-sidebar-media-player/qq/playlist/' + encodeURIComponent(from.id));
        if (!d || !d.ok || !Array.isArray(d.playlist.songs)) return null;
        const fresh = d.playlist.songs;
        const curMid = String(store.currentId || '').startsWith('qq:') ? String(store.currentId).slice(3) : null;
        let newQueue = fresh;
        if (curMid && !fresh.some((t) => String(t.songmid || t.id) === curMid)) {
          const cur = (s.qqQueue || []).find((t) => String(t.songmid || t.id) === curMid) || null;
          if (cur) newQueue = [cur, ...fresh];
        }
        set({ qqQueue: newQueue });
        return newQueue;
      }
      async function openQueue() {
        let songs = s.qqQueue || [];
        let src = s.qqSource;
        let from = s.qqQueueFrom;
        // 当前内存队列为空时，回退到持久化的在线队列：例如上次播的是本地音乐、
        // 刷新后 restoreLatest 只恢复了本地，但 QQ 队列仍单独保存在 PREF_PLAYBACK_QQ，
        // 打开「在线播放列表」应仍能看到它（本地/在线互不影响）。
        if (songs.length === 0) {
          const saved = loadQQPlayback();
          if (saved && Array.isArray(saved.queue) && saved.queue.length > 0) {
            songs = saved.queue;
            src = saved.source || src;
            if (saved.queueFrom && typeof saved.queueFrom === 'object') from = saved.queueFrom;
            // 加载进内存，便于「下一首」等后续操作直接使用；恢复来源歌单信息。
            set({ qqQueue: songs, qqSource: src || '', qqQueueFrom: from });
          }
        }
        // 队列来自「我的歌单」→ 拉最新内容（跟随外部/跨会话增删）。
        const fresh = await refreshQqQueueFromSource(from);
        if (fresh) songs = fresh;
        setActivePl({ name: src || '在线播放列表', songs, source: src || '播放中' });
        setLayer('playlist'); saveUi('playlist', '', '');
      }
      // 实时跟随：来源是「我的歌单」且其内容发生过增删（收藏/加歌/移除）→ 重拉队列；
      // 若正展示播放列表视图则同步可见列表。恢复带来源的队列时也会触发一次（rev 被 +1）。
      useEffect(() => {
        const from = s.qqQueueFrom;
        if (!from || from.kind !== 'mine' || (s.qqQueueRev || 0) === 0) return;
        let cancelled = false;
        refreshQqQueueFromSource().then((newQueue) => {
          if (cancelled || !newQueue) return;
          // 当前展示的是播放列表视图（activePl 无 id）→ 同步可见列表。
          if (layer === 'playlist' && activePl && activePl.id === undefined) {
            setActivePl((cur) => (cur ? { ...cur, songs: newQueue } : cur));
          }
        });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [s.qqQueueRev, s.qqQueueFrom]);
      function backToMain() { queueRestorePending.current = false; setLayer('main'); setActivePl(null); saveUi('main', '', ''); }
      async function doSearch(kwOverride) {
        const kw = (kwOverride !== undefined ? String(kwOverride) : q).trim();
        if (kw === '') { setSearched(false); setQError(''); return; }
        setHistOpen(false);
        saveHist(kw);
        setSearching(true); setQError(''); setResults([]); setPlResults([]); setSearched(true); setCurCategory(null);
        setSearchPage(1); setSearchLastLen(0); setSearchTotal(0); setPlSearchPage(1); setPlSearchLastLen(0); setPlSearchTotal(0);
        const [songs, pls] = await Promise.all([
          json('/dsh-sidebar-media-player/qq/search?w=' + encodeURIComponent(kw) + '&page=1'),
          json('/dsh-sidebar-media-player/qq/playlist-search?w=' + encodeURIComponent(kw) + '&page=1'),
        ]);
        if (songs && songs.ok) { setResults(songs.results || []); setSearchLastLen((songs.results || []).length); setSearchTotal(Number(songs.total) || (songs.results || []).length); setSearchPage(songs.page || 1); }
        else setQError((songs && songs.error) || '歌曲搜索失败');
        if (pls && pls.ok) { setPlResults(pls.playlists || []); setPlSearchLastLen((pls.playlists || []).length); setPlSearchTotal(Number(pls.total) || (pls.playlists || []).length); setPlSearchPage(pls.page || 1); }
        // 默认打开「有结果」的那个 tab（歌曲优先）。
        const sLen = (songs && songs.ok && (songs.results || []).length) || 0;
        const pLen = (pls && pls.ok && (pls.playlists || []).length) || 0;
        if (sLen > 0) setResultTab('songs');
        else if (pLen > 0) setResultTab('playlists');
        setSearching(false);
      }
      // 搜索结果「加载更多」：追加下一页（共用当前关键词 q）。
      async function loadMoreSongs() {
        const kw = q.trim();
        if (kw === '' || searchingMore) return;
        const next = searchPage + 1;
        setSearchingMore(true);
        try {
          const d = await json('/dsh-sidebar-media-player/qq/search?w=' + encodeURIComponent(kw) + '&page=' + next);
          if (d && d.ok) {
            setResults((cur) => cur.concat(d.results || []));
            setSearchLastLen((d.results || []).length);
            setSearchTotal(Number(d.total) || (d.results || []).length);
            setSearchPage(d.page || next);
          }
        } catch {}
        setSearchingMore(false);
      }
      async function loadMorePls() {
        const kw = q.trim();
        if (kw === '' || plSearchingMore) return;
        const next = plSearchPage + 1;
        setPlSearchingMore(true);
        try {
          const d = await json('/dsh-sidebar-media-player/qq/playlist-search?w=' + encodeURIComponent(kw) + '&page=' + next);
          if (d && d.ok) {
            setPlResults((cur) => cur.concat(d.playlists || []));
            setPlSearchLastLen((d.playlists || []).length);
            setPlSearchTotal(Number(d.total) || (d.playlists || []).length);
            setPlSearchPage(d.page || next);
          }
        } catch {}
        setPlSearchingMore(false);
      }
      function playSong(song, queue, sourceLabel, from) {
        // 未登录（或登录已过期）时点击 VIP 歌曲：不启动注定失败的播放（否则播放条会误报
        // 「频谱不可用/音频加载失败」，重试也无济于事），只提示。**不替用户选择登录方式**——
        // 此时面板本就停在登录 UI（QQ / 微信两个按钮都在），用户自己点哪个都可以。
        const isVip = song.payplay === 1 || (song.pay && song.pay.payplay === 1);
        if (isVip && (!loggedIn || s.qqAuthExpired)) {
          setQError(s.qqAuthExpired ? 'QQ 音乐登录已过期，VIP 歌曲需重新登录' : 'VIP 歌曲需先登录才能播放');
          return;
        }
        // 三档第三档：**登录了、账号不是 VIP**。后端取链对这类曲返回 404，
        // 不拦的话用户只会看到「该曲不可播放（VIP 专享或版权受限）」这种含糊话。
        // 只在 `=== false` 时拦 —— null（还没查到 / 后端没通）一律放行，宁可试一次也别误禁。
        // 不置灰、不禁用列表：用户要看到歌单原样，只在他的点击上拦并说清原因。
        if (isVip && s.qqIsVip === false) {
          setQError('该曲为 VIP 专享，当前账号不是 VIP，无法播放');
          return;
        }
        setPlayingId(String(song.songmid || song.id)); smpQQStartPlayback(song, queue, sourceLabel, from);
      }

      // ---- 登录（扫码/轮询/退出）----
      async function startLogin(mode) {
        clearPoll();
        loginModeRef.current = mode; qrKeyRef.current = '';
        setLoginMode(mode); setLoginStatus('正在生成二维码…'); setLoginBusy(true); setQrImage('');
        try {
          const d = await jsonPost('/dsh-sidebar-media-player/qq/login/start', { mode });
          if (!d || !d.ok) throw new Error((d && d.error) || '二维码创建失败');
          qrKeyRef.current = d.key || '';
          setQrImage(d.image || '');
          setLoginStatus(mode === 'qq' ? '请用 QQ App 扫码' : '请用微信 App 扫码');
          setLoginBusy(false);
          schedulePoll();
        } catch (e) { setLoginStatus(String((e && e.message) || e)); setLoginBusy(false); }
      }
      function schedulePoll() { if (loginModeRef.current === null || qrKeyRef.current === '') return; clearPoll(); pollRef.current = setTimeout(pollLogin, 1500); }
      async function pollLogin() {
        const key = qrKeyRef.current;
        if (!key) return;
        try {
          const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
          const timer = ctrl ? setTimeout(() => ctrl.abort(), 30000) : null;
          let d;
          try {
            d = await fetch('/dsh-sidebar-media-player/qq/login/check?key=' + encodeURIComponent(key), { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined }).then((r) => r.json());
          } finally { if (timer) clearTimeout(timer); }
          if (!d || !d.ok) { setLoginStatus((d && d.error) || '查询失败，正在重试…'); schedulePoll(); return; }
          if (d.status === 'success') { clearPoll(); setLoggedIn(true); setUin(d.uin || ''); setNickname(d.nickname || ''); setLayer('main'); setActivePl(null); saveUi('main', '', ''); closeLogin(); refreshQQFavIds(); refreshQQVip(); resetQQAuthExpired(); set({ qqLoggedIn: true, qqLoginFrom: d.loginFrom || '', error: null }); }
          else if (d.status === 'scanned') { setLoginStatus('已扫码，请在手机上确认'); schedulePoll(); }
          else if (d.status === 'expired') { clearPoll(); setLoginStatus('二维码已过期'); }
          else if (d.status === 'failed') { clearPoll(); setLoginStatus(d.message || '登录失败'); }
          else if (d.status === 'waiting') { schedulePoll(); }
          else { schedulePoll(); }
        } catch (e) { setLoginStatus('获取登录状态超时，正在自动重试…'); schedulePoll(); }
      }
      function closeLogin() { clearPoll(); loginModeRef.current = null; qrKeyRef.current = ''; setLoginMode(null); setLoginStatus(''); setQrImage(''); }
      async function logout() {
        try { await jsonPost('/dsh-sidebar-media-player/qq/login/logout', {}); } catch {}
        setLoggedIn(false); setUin(''); setNickname('');
        resetQQAuthExpired(); // 主动登出：清掉「已过期」提示，回到正常登录页
        set({ qqLoggedIn: false, qqLoginFrom: '' });
        // 彻底清空所有 QQ 音乐浏览数据，避免换账号登录后看到上一个账号的歌单/搜索/浏览数据。
        setLayer('main'); setActivePl(null); setPlLoading(false); setBrowseTab('mine');
        setQ(''); setSearched(false); setSearching(false); setResults([]); setPlResults([]);
        setQError(''); setResultTab('songs'); setSearchPage(1); setSearchLastLen(0);
        setSearchingMore(false); setPlSearchPage(1); setPlSearchLastLen(0); setPlSearchingMore(false);
        setHist([]); setHistOpen(false);
        setMinePlays([]); setMineLoaded(false); setRecommended([]);
        setCategories([]); setCatPlays([]); setCurCategory(null); setBrowseErr(''); setBrowseLoading(false);
        setRecPage(1); setRecLoadingMore(false); setRecHasMore(true);
        setCatPage(1); setCatLoadingMore(false); setCatHasMore(true); setCatExpanded(false);
        setTopGroups([]); setTopLoaded(false); setTopDetail(null); setTopLoading(false);
        setTopTotal(0); setTopHasMore(false); setTopLoadingMore(false);
        setNewSongs([]); setNewLoaded(false);
        saveUi('main', '', '');
        // 清空在线播放队列与当前曲目（否则退出后播放条仍可「下一首」见上一账号的歌）。
        const isQQPlaying = String(store.currentId || '').startsWith('qq:') || store.scope?.kind === 'qq';
        if (isQQPlaying) {
          // 当前播的是 QQ 在线曲目 → 真正停止播放（pause + 清 src）并清空在线队列。
          // 用 stop() 而不是只 set state，否则音频仍在播，播放条仍显示/残留上一账号的曲目。
          stop();
          // 退出登录必须彻底清掉上一账号的在线队列持久化，否则刷新后仍会恢复出来。
          clearPref(PREF_PLAYBACK_QQ);
          set({ qqQueue: [], qqSource: '', qqQueueFrom: null, qqQueueRev: 0, qqFaved: false });
        } else {
          // 当前播的是本地/讲书 → 只清空在线队列（含持久化记录），保留当前播放。
          clearPref(PREF_PLAYBACK_QQ);
          set({ qqQueue: [], qqSource: '', qqQueueFrom: null, qqQueueRev: 0, qqFaved: false });
        }
      }

      // ---- 渲染辅助 ----
      const fmtCount = (n) => { const v = Number(n) || 0; if (v >= 1e8) return (v / 1e8).toFixed(1).replace(/\.0$/, '') + '亿'; if (v >= 1e4) return (v / 1e4).toFixed(1).replace(/\.0$/, '') + '万'; return String(v); };
      const songRow = (song, queue, sourceLabel, inMine) => {
        const id = String(song.songmid || song.id);
        const active = s.currentId === 'qq:' + id;
        const playing = active && s.playing;
        const vip = song.payplay === 1;
        const artists = (song.artists || []).join('/');
        // 播放队列来源（供「播放列表跟随歌单更新」）：
        //  - 我的歌单详情（activePl.mine，含我喜欢 dirId=201/自建）→ 记该歌单；
        //  - 播放列表视图（activePl 无 id）→ 沿用现有来源（同一队列内点歌）；
        //  - 公开歌单/搜索/榜单等 → null（快照，不跟随）。
        const queueFrom = (activePl && activePl.mine && activePl.id)
          ? { kind: 'mine', id: String(activePl.id), dirId: Number(activePl._dirId) || 0 }
          : (activePl && activePl.id === undefined ? (s.qqQueueFrom || null) : null);
        return React.createElement('div', {
          key: id,
          className: 'smp-qq-card' + (active ? ' active' : ''),
          title: song.title + ' - ' + artists,
          // 专辑封面当卡片底图：压暗渐变保证白字可读；没有封面时退回纯色卡片。
          style: song.cover ? {
            backgroundImage: 'linear-gradient(rgba(0,0,0,0.52), rgba(0,0,0,0.78)), url("' + String(song.cover).replace(/"/g, '') + '")',
            backgroundSize: 'cover',
            backgroundPosition: 'center',
          } : undefined,
          onClick: () => { if (active) togglePlay(); else playSong(song, queue, sourceLabel, queueFrom); },
        },
          React.createElement('div', { key: 'top', className: 'smp-qq-card-top' }, [
            React.createElement('span', { key: 'p', className: 'smp-qq-card-play' }, playing ? '⏸' : '▶'),
            vip ? React.createElement('span', { key: 'v', className: 'dsh-music-online-tag vip' }, 'VIP') : null
          ]),
          React.createElement('div', { key: 't', className: 'smp-qq-card-title' }, song.title),
          React.createElement('div', { key: 'a', className: 'smp-qq-card-artist' }, artists || 'QQ音乐'),
          inMine
            ? React.createElement('button', {
              key: 'm', className: 'dsh-music-playlist-mini remove',
              title: '从「' + ((activePl && activePl.name) || '当前歌单') + '」移除',
              onClick: (e) => { e.stopPropagation(); removeFromActivePlaylist(song); },
            }, '−')
            : React.createElement('button', {
              key: 'm', className: 'dsh-music-playlist-mini add',
              title: '加入我的歌单',
              onClick: (e) => { e.stopPropagation(); openQqJoin(song, e); },
            }, '＋'));
      };
      // 从「我的歌单」当前歌单移除歌曲（DelSonglist）；「我喜欢」(dirId=201) 等同取消收藏。
      async function removeFromActivePlaylist(song) {
        const pl = activePl;
        if (!pl) return;
        const id = String(song.songmid || song.id);
        const dirId = Number(pl._dirId || pl.dirId || pl.id) || 0;
        try {
          const d = await jsonPost('/dsh-sidebar-media-player/qq/playlist-remove', { song, dirId, tid: 0 });
          if (!d || !d.ok) throw new Error((d && d.error) || '从歌单移除失败');
          // 就地移除该行，并刷新「我的歌单」数目。
          setActivePl((cur) => (cur ? { ...cur, songs: (cur.songs || []).filter((t) => String(t.songmid || t.id) !== id) } : cur));
          loadMine();
          // 我的歌单内容变了 → 播放列表跟随刷新。
          set({ qqQueueRev: (store.qqQueueRev || 0) + 1 });
          // 「我喜欢」：同步收藏集合并把当前播放的这首歌标记为未收藏。
          if (dirId === 201) {
            refreshQQFavIds();
            if (String(s.currentId) === 'qq:' + id) set({ qqFaved: false });
          }
        } catch (err) { setQError(String((err && err.message) || err)); }
      }
      // 「加入歌单」：打开弹窗（列出我的歌单），并把歌曲加入所选歌单 / 新建歌单。
      // 成功/失败统一走面板居中的 toast 提示（成功关闭弹窗；失败保留弹窗可重试）。
      function openQqJoin(song, e) {
        const r = e.currentTarget.getBoundingClientRect();
        if (minePlays.length === 0 && !mineLoaded) loadMine();
        setQqJoin({ song, x: r.right, y: r.top });
      }
      async function qqJoinAddTo(pl) {
        const song = qqJoin && qqJoin.song;
        if (!song) return;
        const name = (pl && pl.name) || '歌单';
        try {
          // dirId 用歌单的权威 dirId（dirid），tid 固定 0（「我喜欢」dirId=201,tid=0 的可用模式）。
          const d = await jsonPost('/dsh-sidebar-media-player/qq/playlist-add', { song, dirId: (pl && (pl.dirId || pl.tid || pl.id)) || 0, tid: 0 });
          if (!d || !d.ok) throw new Error((d && d.error) || '加入歌单失败');
          // 本地乐观 +1，并异步刷新「我的歌单」，让数目与实际一致。
          if (pl) {
            const pid = String(pl.id);
            setMinePlays((cur) => cur.map((p) => (String(p.id) === pid ? { ...p, trackCount: (Number(p.trackCount) || 0) + 1 } : p)));
            loadMine();
          }
          setQqJoin(null);
          showToast('添加到' + name + '成功', true);
          // 我的歌单内容变了 → 播放列表跟随刷新。
          set({ qqQueueRev: (store.qqQueueRev || 0) + 1 });
        } catch (err) { showToast('添加到' + name + '失败', false); }
      }
      async function qqJoinCreate() {
        const song = qqJoin && qqJoin.song;
        openPrompt('新建歌单名称', '', async (trimmed) => {
          if (!trimmed) return;
          try {
            const d = await jsonPost('/dsh-sidebar-media-player/qq/playlist-create', { name: trimmed });
            if (!d || !d.ok || !d.playlist) throw new Error((d && d.error) || '创建歌单失败');
            const created = d.playlist;
            // AddPlaylist 返回的 id 即新歌单 dirid；AddSonglist 用该 dirid + tid=0 加歌。
            if (song) {
              const add = await jsonPost('/dsh-sidebar-media-player/qq/playlist-add', { song, dirId: Number(created.id) || 0, tid: 0 });
              if (!add || !add.ok) throw new Error((add && add.error) || '加入新歌单失败');
            }
            loadMine();
            setQqJoin(null);
            showToast('添加到' + ((created && created.name) || trimmed) + '成功', true);
          } catch (err) { showToast('添加到' + trimmed + '失败', false); }
        });
      }
      const qqJoinMenu = qqJoin ? qqPortal((() => {
        const openUp = (qqJoin.y || 0) > ((window.innerHeight || 0) - 240);
        const style = {
          left: Math.max(8, (qqJoin.x || 0) - 150),
          top: openUp ? (qqJoin.y || 0) - 6 : (qqJoin.y || 0) + 8,
          transform: openUp ? 'translateY(-100%)' : 'none',
        };
        return React.createElement('div', { className: 'dsh-music-add-pop', ref: qqJoinRef, style },
          minePlays.length > 0 ? minePlays.map((p) => React.createElement('button', {
            key: p.id, className: 'dsh-music-add-pop-item',
            title: '加入「' + p.name + '」',
            onClick: () => qqJoinAddTo(p),
          }, p.name + (p.trackCount ? '（' + p.trackCount + '）' : ''))) : React.createElement('div', { className: 'dsh-music-hint', style: { padding: '2px 8px' } }, '暂无我的歌单，请先创建。'),
          React.createElement('button', { className: 'dsh-music-add-pop-item new', onClick: qqJoinCreate }, '＋ 新建歌单'),
        );
      })()) : null;
      const playRow = (pl, mine) => {
        // 注意：map((pl) => playRow(pl)) 会把数组下标作为第二个参数传入（Array#map 传
        // (element, index, array)）。这里必须用严格 true 判断「我的歌单」，否则推荐/分类/
        // 搜索等来源里除第一项外的卡片会把下标当真值，误显示删除按钮。
        const isMine = mine === true;
        const meta = (pl.trackCount > 0 ? pl.trackCount + ' 首' : '')
          + (pl.playCount ? ' · 播放 ' + fmtCount(pl.playCount) : '');
        // 「我的歌单」卡片类别标签：QQ 的「我喜欢」（dirId=201）是系统默认歌单，
        // 其余为本账号自建歌单（酷狗同款标识）。
        const isDefault = Number(pl && (pl.dirId || pl.tid || pl.id)) === 201;
        const kindTag = isMine ? React.createElement('span', {
          className: 'dsh-music-online-tag' + (isDefault ? ' default' : ''),
          title: isDefault ? '系统默认歌单（我喜欢）' : '自己创建的歌单',
        }, isDefault ? '默认' : '自建') : null;
        const card = React.createElement('button', {
          key: pl.id, className: 'dsh-music-playlist-card', title: pl.name + ' - ' + (pl.creator || ''),
          onClick: () => openPlaylist(pl, isMine),
        },
          plCoverEl(pl),
          React.createElement('span', { className: 'dsh-music-playlist-info' },
            React.createElement('span', { className: 'dsh-music-playlist-name-row' },
              React.createElement('span', { className: 'dsh-music-playlist-name' }, pl.name),
              kindTag),
            React.createElement('span', { className: 'dsh-music-playlist-meta' },
              (pl.creator ? pl.creator + ' · ' : '') + meta)));
        // 「我的歌单」卡片：右上角提供删除按钮（仅本人创建的歌单，「我喜欢」dirId=201 除外）。
        if (!isMine) return card;
        const dirId = Number(pl && (pl.dirId || pl.tid || pl.id)) || 0;
        const deletable = dirId !== 0 && dirId !== 201;
        return React.createElement('div', { key: pl.id, className: 'dsh-music-qq-mine-card' },
          card,
          deletable ? React.createElement('button', {
            className: 'dsh-music-qq-mine-del', title: '删除歌单「' + pl.name + '」',
            onClick: (e) => { e.stopPropagation(); deleteMinePlaylist(pl); },
          }, '✕') : null);
      };
      const catTab = (cat) => React.createElement('button', {
        key: cat.id, className: 'dsh-music-qq-cat' + (curCategory && curCategory.id === cat.id ? ' active' : ''),
        onClick: () => loadCategory(cat),
      }, cat.name);
      const browseTabBtn = (key, label) => React.createElement('button', {
        className: 'dsh-music-qq-viewtab' + (browseTab === key ? ' active' : ''),
        onClick: () => {
          setBrowseTab(key);
          if (key === 'recommend' && recommended.length === 0) loadRecommended();
          else if (key === 'mine' && minePlays.length === 0) loadMine();
          else if (key === 'tops' && !topLoaded) loadTopLists();
          else if (key === 'new' && !newLoaded) loadNewSongs();
        },
      }, label);
      // 搜索结果内的「歌曲 / 相关歌单」切换 tab。
      const resultTabBtn = (key, label) => React.createElement('button', {
        className: 'dsh-music-qq-resulttab' + (resultTab === key ? ' active' : ''),
        onClick: () => setResultTab(key),
      }, label);

      // 搜索框（放在「搜索」子tab内容里）。点击聚焦显示历史下拉，可直接输入或选历史。
      const searchBox = React.createElement('div', { className: 'dsh-music-qq-search', ref: histRef },
        React.createElement('div', { className: 'dsh-music-qq-inputwrap' },
          React.createElement('input', {
            className: 'dsh-music-qq-input', type: 'text', placeholder: '搜索 QQ 音乐（歌曲 / 歌单）',
            value: q,
            onChange: (e) => { setQ(e.target.value); if (e.target.value === '') setSearched(false); },
            onKeyDown: (e) => { if (e.key === 'Enter') doSearch(); },
            onFocus: () => { if (hist.length > 0) setHistOpen(true); },
          }),
          // 清除钮始终渲染、用 visibility 控制显隐，避免「有无 ×」导致输入框/UI 宽度抖动。
          React.createElement('button', {
            className: 'dsh-music-qq-clear' + (q === '' ? ' hidden' : ''),
            type: 'button', title: '清空输入',
            onClick: () => { setQ(''); setSearched(false); },
          }, '✕')),
        React.createElement('button', { className: 'dsh-music-settings-btn', onClick: () => doSearch() }, searching ? '搜索中…' : '搜索'));
      // 历史下拉 portal 到 body：搜索框在 .dsh-music-panel(overflow:hidden)/.dsh-music-qq-body
      // (overflow-y:auto) 内，绝对定位子元素会被裁剪不可见；portaled + fixed 锚定
      // 在搜索框正下方（与音量/模式/章节目录弹层同款逃逸方案）。
      const histPop = (histOpen && hist.length > 0)
        ? qqPortal(React.createElement('div', { className: 'dsh-music-qq-hist', style: anchorBelow(histRef.current, 420), ref: histPopRef },
          React.createElement('div', { className: 'dsh-music-qq-hist-head' },
            React.createElement('span', { className: 'dsh-music-hint' }, '搜索历史'),
            React.createElement('button', { className: 'dsh-music-qq-hist-clear', title: '清空历史', onClick: clearHist }, '清空')),
          hist.map((kw, idx) => React.createElement('button', {
            key: idx, className: 'dsh-music-qq-hist-item',
            onClick: () => { setQ(kw); doSearch(kw); },
          }, kw))))
        : null;

      // 扫码框以面板中心为基准居中（面板可拖拽），贴边时 clamp 不被裁掉。
      const qqLoginStyle = panelCenterStyle(panelRef, loginMode !== null, 170, 460);
      const loginModal = loginMode !== null ? qqPortal(React.createElement('div', { className: 'dsh-music-picker-overlay' },
        React.createElement('div', { className: 'dsh-music-picker qq-login', style: qqLoginStyle },
          React.createElement('div', { className: 'dsh-music-picker-head' },
            React.createElement('span', { className: 'dsh-music-picker-title' }, 'QQ 音乐登录'),
            React.createElement('button', { className: 'dsh-music-icon-btn', title: '关闭', onClick: closeLogin }, '✕')),
          React.createElement('div', { className: 'dsh-music-qq-login-body' },
            loginBusy && qrImage === '' ? React.createElement('div', { className: 'dsh-music-loading' }, '生成二维码…')
              : qrImage ? React.createElement('img', { className: 'dsh-music-qq-qr', src: qrImage, alt: '二维码' }) : null,
            React.createElement('div', { className: 'dsh-music-qq-login-status' }, loginStatus || ''),
            loginStatus !== '登录成功' ? React.createElement('div', { className: 'dsh-music-qq-login-actions' },
              React.createElement('button', { className: 'dsh-music-settings-btn', onClick: () => startLogin(loginMode) }, '刷新二维码'),
              React.createElement('button', { className: 'dsh-music-settings-btn', onClick: closeLogin }, '取消')) : null,
          )))) : null;

      // ---- 未登录 / 登录已过期：只显示居中两个登录按钮（QQ 登录 / 微信登录，分两行）+ 风险提示 ----
      // 过期与从未登录走同一个入口：**绝不替用户预设登录方式**（Host 的 loginFrom 只用来
      // 提示「上次用哪种」，按钮仍然两个都给）。
      if (!loggedIn) {
        return React.createElement('div', { className: 'dsh-music-qq dsh-music-qq-login' },
          React.createElement('div', { className: 'dsh-music-qq-login-center' },
            s.qqAuthExpired
              ? React.createElement('div', { className: 'dsh-music-qq-login-tip' },
                  '登录可能已失效，请重新登录' + (s.qqLoginFrom === 'qq' ? '（上次使用 QQ 登录）' : s.qqLoginFrom === 'wx' ? '（上次使用微信登录）' : ''))
              : null,
            React.createElement('button', { className: 'dsh-music-qq-login-btn', onClick: () => startLogin('qq') }, 'QQ 登录'),
            React.createElement('button', { className: 'dsh-music-qq-login-btn', onClick: () => startLogin('wx') }, '微信登录'),
            React.createElement('div', { className: 'dsh-music-qq-login-warn' },
              React.createElement('div', { className: 'dsh-music-qq-login-warn-title' }, '使用声明（重要）'),
              React.createElement('div', { className: 'dsh-music-qq-login-warn-p' },
                '在线 QQ 音乐功能通过非官方接口访问 QQ 音乐资源，所播放/收藏的内容版权归版权方及 QQ 音乐平台所有。本功能仅供个人学习、技术研究、日常试听使用，严禁用于任何商业用途、公开传播、二次分发或盈利行为。使用本功能即表示您已知悉并同意：'),
              React.createElement('div', { className: 'dsh-music-qq-login-warn-item' },
                React.createElement('span', { className: 'dsh-music-qq-login-warn-num' }, '1'),
                React.createElement('span', null, '您应对自己的使用行为及其后果负责。')),
              React.createElement('div', { className: 'dsh-music-qq-login-warn-item' },
                React.createElement('span', { className: 'dsh-music-qq-login-warn-num' }, '2'),
                React.createElement('span', null, '因使用非官方接口登录/播放导致的账号风控、封禁、限流，以及可能引发的法律、版权纠纷，均由使用者自行承担。')),
              React.createElement('div', { className: 'dsh-music-qq-login-warn-item' },
                React.createElement('span', { className: 'dsh-music-qq-login-warn-num' }, '3'),
                React.createElement('span', null, '本项目作者不承担任何因此产生的直接或间接责任。')),
              React.createElement('div', { className: 'dsh-music-qq-login-warn-p' },
                '如您不同意以上条款，请勿使用本功能。'))),
          loginModal,
          qqJoinMenu);
      }

      // ---- 播放列表UI（第 2 层）：返回 + 可滚动歌曲列表 ----
      if (layer === 'playlist') {
        const pl = activePl || { name: '在线播放列表', songs: [], source: '在线' };
        return React.createElement('div', { className: 'dsh-music-qq' },
          React.createElement('div', { className: 'dsh-music-qq-head' },
            React.createElement('div', { className: 'dsh-music-qq-detail-head' },
              React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: backToMain }, '← 返回'),
              React.createElement('span', { className: 'dsh-music-settings-cur', title: pl.name }, pl.source === '歌单' ? '▸ 歌单：' + pl.name : pl.name),
              React.createElement('span', { className: 'dsh-music-hint' }, (pl.creator ? (pl.creator + ' · ') : '') + ((pl.songs || []).length + ' 首'))),
            pl.description ? React.createElement('p', { className: 'dsh-music-hint' }, pl.description) : null,
            (pl.songs && pl.songs.length)
              ? React.createElement('div', { className: 'dsh-music-qq-pl-actions' },
                React.createElement('button', { className: 'dsh-music-qq-playall', onClick: playAllQQSongs }, '▶ 播放全部'))
              : null),
          React.createElement('div', { className: 'dsh-music-qq-body', ref: qqPlRef },
            plLoading
              ? React.createElement('div', { className: 'dsh-music-hint' }, '加载中…')
              : (pl.songs && pl.songs.length
                ? React.createElement('div', { className: 'smp-qq-grid' }, pl.songs.map((song) => songRow(song, pl.songs, pl.name, pl.mine)))
                : React.createElement('div', { className: 'dsh-music-hint' }, '暂无歌曲。'))),
          loginModal,
          qqJoinMenu);
      }

      // ---- 主UI（第 1 层）：顶部工具栏 + 4 个子tab，只滚动子tab内容区 ----
      let body;
      // 搜索 tab 的固定行（在滚动容器 .dsh-music-qq-body 之外）：搜索框行 + 「歌曲/
      // 相关歌单」子tab 行，与 head 一样固定，滚动条只作用于其下方的结果内容。
      let searchRow = null;
      let resultTabsRow = null;
      if (browseTab === 'search') {
        const hasSongs = results.length > 0;
        const hasPls = plResults.length > 0;
        let resultContent = null;
        // 搜索分页「加载更多」：歌曲用接口 total（可靠）；歌单 total 缺失，用「最近一页较满(≥20)」。
        const songMoreBtn = (searchTotal > results.length)
          ? React.createElement('div', { className: 'dsh-music-qq-loadmore' },
            React.createElement('button', { className: 'dsh-music-qq-loadmore-btn', onClick: loadMoreSongs },
              searchingMore ? '加载中…' : '加载更多'))
          : null;
        const plMoreBtn = (plSearchLastLen >= QQ_PL_PAGE)
          ? React.createElement('div', { className: 'dsh-music-qq-loadmore' },
            React.createElement('button', { className: 'dsh-music-qq-loadmore-btn', onClick: loadMorePls },
              plSearchingMore ? '加载中…' : '加载更多'))
          : null;
        // 「歌曲 / 相关歌单」子tab 行固定在搜索框下方，不随结果滚动。
        if (hasSongs && hasPls) {
          resultTabsRow = React.createElement('div', { className: 'dsh-music-qq-resulttabs fixed' },
            resultTabBtn('songs', '歌曲'),
            resultTabBtn('playlists', '相关歌单'));
        }
        if (searching) {
          resultContent = React.createElement('div', { className: 'dsh-music-hint' }, '搜索中…');
        } else if (qError || !(hasSongs || hasPls)) {
          resultContent = React.createElement('div', { className: 'dsh-music-error' }, qError || '未找到相关结果。');
        } else if (resultTab === 'playlists' && hasPls) {
          resultContent = React.createElement('div', null, React.createElement('div', { className: 'dsh-music-playlist-grid' }, plResults.map((p) => playRow(p))), plMoreBtn);
        } else {
          resultContent = React.createElement('div', null, [React.createElement('div', { key: 'g', className: 'smp-qq-grid' }, results.map((song) => songRow(song, results, '搜索结果'))), songMoreBtn]);
        }
        searchRow = React.createElement('div', { className: 'dsh-music-qq-searchrow' }, searchBox, histPop);
        // body 只放结果内容（在 .dsh-music-qq-body 滚动容器内）。
        body = searched ? React.createElement('div', null, resultContent) : null;
      } else {
        let content;
        if (browseTab === 'mine') {
          const listEl = !mineLoaded
            ? React.createElement('div', { className: 'dsh-music-hint' }, '加载我的歌单…')
            : (minePlays.length > 0
              ? React.createElement('div', { className: 'dsh-music-playlist-grid' }, minePlays.map((p) => playRow(p, true)))
              : React.createElement('div', { className: 'dsh-music-hint' }, '暂无歌单。可到 QQ 音乐 App 创建或收藏歌单后再来查看。'));
          content = React.createElement('div', null, listEl);
          body = React.createElement('div', null, content,
            browseErr ? React.createElement('div', { className: 'dsh-music-error' }, browseErr) : null,
            browseLoading ? React.createElement('div', { className: 'dsh-music-loading' }, '加载中…') : null);
        } else if (browseTab === 'category') {
          const catMoreBtn = curCategory && catPlays.length > 0 && catHasMore
            ? React.createElement('div', { className: 'dsh-music-qq-loadmore' },
              React.createElement('button', { className: 'dsh-music-qq-loadmore-btn', onClick: loadMoreCategory },
                catLoadingMore ? '加载中…' : '加载更多'))
            : null;
          const CAT_COLLAPSED_COUNT = 8;
          const shownCats = catExpanded ? categories : categories.slice(0, CAT_COLLAPSED_COUNT);
          const catToggle = categories.length > CAT_COLLAPSED_COUNT
            ? React.createElement('button', { className: 'dsh-music-qq-cat-toggle', onClick: () => setCatExpanded((v) => !v) },
              catExpanded ? '收起' : '展开全部分类（' + categories.length + '）')
            : null;
          content = React.createElement('div', null,
            React.createElement('div', { className: 'dsh-music-qq-cats' }, shownCats.length ? shownCats.map(catTab) : React.createElement('span', { className: 'dsh-music-hint' }, '加载分类中…')),
            catToggle,
            curCategory ? React.createElement('div', null,
              (catPlays.length ? React.createElement('div', { className: 'dsh-music-playlist-grid' }, catPlays.map((p) => playRow(p))) : React.createElement('div', { className: 'dsh-music-hint' }, '该分类暂无歌单。')),
              catMoreBtn) : null);
          body = React.createElement('div', null, content,
            browseErr ? React.createElement('div', { className: 'dsh-music-error' }, browseErr) : null,
            browseLoading ? React.createElement('div', { className: 'dsh-music-loading' }, '加载中…') : null);
        } else if (browseTab === 'tops') {
          let content;
          if (topDetail) {
            // 榜单详情：返回 + 歌曲列表（支持「加载更多」分页续载）。
            const rows = topDetail.songs && topDetail.songs.length
              ? React.createElement('div', { className: 'smp-qq-grid' }, topDetail.songs.map((song) => songRow(song, topDetail.songs, topDetail.name)))
              : React.createElement('div', { className: 'dsh-music-hint' }, '该榜单暂无歌曲。');
            const moreBtn = topHasMore
              ? React.createElement('div', { className: 'dsh-music-qq-loadmore' },
                React.createElement('button', { className: 'dsh-music-qq-loadmore-btn', onClick: loadMoreTopSongs },
                  topLoadingMore ? '加载中…' : '加载更多'))
              : null;
            content = React.createElement('div', null,
              rows,
              moreBtn);
          } else {
            const topCards = (tl) => tl.map((t) => {
              const meta = t.listenNum ? ((t.listenNum / 1e4).toFixed(0) + '万收听') : (t.totalNum ? t.totalNum + ' 首' : '');
              return React.createElement('button', {
                key: t.id, className: 'dsh-music-playlist-card',
                onClick: () => loadTopSongs(t),
                title: t.intro || '',
              },
                plCoverEl(t),
                React.createElement('span', { className: 'dsh-music-playlist-info' },
                  React.createElement('span', { className: 'dsh-music-playlist-name' }, t.name),
                  React.createElement('span', { className: 'dsh-music-playlist-meta' }, meta)));
            });
            const rows = topGroups.map((g) =>
              React.createElement('div', { key: g.id || g.name, className: 'dsh-music-qq-topgroup' },
                React.createElement('div', { className: 'dsh-music-hint' }, g.name),
                React.createElement('div', { className: 'dsh-music-playlist-grid' }, topCards(g.toplists))));
            content = React.createElement('div', null,
              topGroups.length ? rows : React.createElement('div', { className: 'dsh-music-hint' }, '加载排行榜…'),
              topLoading ? React.createElement('div', { className: 'dsh-music-loading' }, '加载榜单中…') : null);
          }
          body = React.createElement('div', null, content,
            browseErr ? React.createElement('div', { className: 'dsh-music-error' }, browseErr) : null,
            browseLoading ? React.createElement('div', { className: 'dsh-music-loading' }, '加载中…') : null);
        } else if (browseTab === 'new') {
          const rows = newSongs.length
            ? React.createElement('div', { className: 'smp-qq-grid' }, newSongs.map((song) => songRow(song, newSongs, '新歌速递')))
            : React.createElement('div', { className: 'dsh-music-hint' }, '加载新歌速递…');
          body = React.createElement('div', null, rows,
            browseErr ? React.createElement('div', { className: 'dsh-music-error' }, browseErr) : null,
            browseLoading ? React.createElement('div', { className: 'dsh-music-loading' }, '加载中…') : null);
        } else {
          const recCards = recommended.length > 0 ? React.createElement('div', { className: 'dsh-music-playlist-grid' }, recommended.map((p) => playRow(p))) : React.createElement('div', { className: 'dsh-music-hint' }, '加载推荐歌单…');
          const moreBtn = recommended.length > 0 && recHasMore
            ? React.createElement('div', { className: 'dsh-music-qq-loadmore' },
              React.createElement('button', { className: 'dsh-music-qq-loadmore-btn', onClick: loadMoreRecommended },
                recLoadingMore ? '加载中…' : '加载更多'))
            : null;
          content = React.createElement('div', null, recCards, moreBtn);
          body = React.createElement('div', null, content,
            browseErr ? React.createElement('div', { className: 'dsh-music-error' }, browseErr) : null,
            browseLoading ? React.createElement('div', { className: 'dsh-music-loading' }, '加载中…') : null);
        }
      }

      // 榜单详情头（返回 + 榜名/封面）放在滚动容器 .dsh-music-qq-body 之外：
      // 头部不会被滚走，滚动条从头部下方开始、高度与歌曲列表对齐（不被头遮挡）。
      const topHeadRow = (browseTab === 'tops' && topDetail)
        ? React.createElement('div', { className: 'dsh-music-qq-tophead-fixed' },
            React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: backToTops }, '← 返回'),
            React.createElement('div', { className: 'dsh-music-qq-topdetail-head' },
              topDetail.cover ? React.createElement('img', {
                className: 'dsh-music-playlist-cover', src: topDetail.cover, alt: '', loading: 'lazy',
                onError: (e) => { e.currentTarget.style.display = 'none'; },
              }) : null,
              React.createElement('div', null,
                React.createElement('div', { className: 'dsh-music-playlist-name' }, topDetail.name),
                React.createElement('div', { className: 'dsh-music-hint' },
                  (topDetail.updateTime ? '更新于 ' + topDetail.updateTime + ' · ' : '')
                  + (topTotal ? (topDetail.songs || []).length + ' / ' + topTotal + ' 首' : '')))),
            (topDetail.songs && topDetail.songs.length)
              ? React.createElement('button', { className: 'dsh-music-qq-playall', onClick: playAllQQTops }, '▶ 播放全部')
              : null)
        : null;
      // 新歌速递固定头（「播放全部」按钮，位于滚动容器之外，与榜单头一致）。
      const newHeadRow = (browseTab === 'new' && newSongs.length)
        ? React.createElement('div', { className: 'dsh-music-qq-tophead-fixed' },
            React.createElement('button', { className: 'dsh-music-qq-playall', onClick: playAllQQNewSongs }, '▶ 播放全部'))
        : null;
      const head = React.createElement('div', { className: 'dsh-music-qq-head' },
        React.createElement('div', { className: 'dsh-music-qq-toolbar' },
          React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: openQueue }, '播放列表'),
          React.createElement('button', { className: 'dsh-music-settings-btn ghost', onClick: logout }, '退出登录')),
        React.createElement('div', { className: 'dsh-music-qq-viewtabs' },
          browseTabBtn('mine', '我的歌单'),
          browseTabBtn('recommend', '推荐歌单'),
          browseTabBtn('category', '分类歌单'),
          browseTabBtn('tops', '排行榜'),
          browseTabBtn('new', '新歌'),
          browseTabBtn('search', '搜索')));

      return React.createElement('div', { className: 'dsh-music-qq' },
        head,
        searchRow,
        resultTabsRow,
        newHeadRow,
        topHeadRow,
        React.createElement('div', { className: 'dsh-music-qq-body' }, body),
        loginModal,
        qqJoinMenu,
      );
    }

    function SmpPromptBox(props) {
      var req = props.req || {};
      var st = react.useState(req.initial || "");
      var val = st[0], setVal = st[1];
      react.useEffect(function () {
        try {
          var el = document.querySelector(".smp-ov-input");
          if (el) { el.focus(); el.select(); }
        } catch (e0) {}
      }, [req.id]);
      function commit() {
        var v = String(val == null ? "" : val).trim();
        try { if (typeof req.onOk === "function") req.onOk(v); } catch (e0) {}
        SMP_STORE.setPrompt(null);
      }
      return h("div", { className: "smp-ov-card", "data-smp": "prompt" }, [
        h("div", { key: "t", className: "smp-ov-title" }, req.title || "输入"),
        h("input", {
          key: "i",
          className: "smp-ov-input",
          type: "text",
          value: val,
          onChange: function (e) { setVal(e.target.value); },
          onKeyDown: function (e) {
            if (e.key === "Enter") { e.preventDefault(); commit(); }
            else if (e.key === "Escape") { SMP_STORE.setPrompt(null); }
          }
        }),
        h("div", { key: "b", className: "smp-ov-btns" }, [
          h("button", { key: "c", type: "button", className: "smp-ov-btn", onClick: function () { SMP_STORE.setPrompt(null); } }, "取消"),
          h("button", { key: "o", type: "button", className: "smp-ov-btn primary", onClick: commit }, "确定")
        ])
      ]);
    }

    function SmpConfirmBox(props) {
      var req = props.req || {};
      function commit() {
        try { if (typeof req.onOk === "function") req.onOk(); } catch (e0) {}
        SMP_STORE.setConfirm(null);
      }
      return h("div", { className: "smp-ov-card", "data-smp": "confirm" }, [
        h("div", { key: "t", className: "smp-ov-title" }, req.title || "确认"),
        h("div", { key: "m", className: "smp-ov-msg" }, req.message || ""),
        h("div", { key: "b", className: "smp-ov-btns" }, [
          h("button", { key: "c", type: "button", className: "smp-ov-btn", onClick: function () { SMP_STORE.setConfirm(null); } }, "取消"),
          h("button", {
            key: "o",
            type: "button",
            className: "smp-ov-btn " + (req.danger ? "danger" : "primary"),
            onClick: commit
          }, req.okText || "确定")
        ])
      ]);
    }

    // 浮层总入口：toast / prompt / confirm 三件都从 SMP_STORE 快照读，事件写回 store
    function SmpOverlays(props) {
      var s = props.snap || {};
      var kids = [];
      if (s.prompt) kids.push(h(SmpPromptBox, { key: "p", req: s.prompt }));
      if (s.confirm) kids.push(h(SmpConfirmBox, { key: "c", req: s.confirm }));
      if (s.toast) {
        kids.push(h("div", {
          key: "t",
          className: "smp-ov-toast" + (s.toast.ok ? " ok" : " err"),
          "data-smp": "toast"
        }, s.toast.text));
      }
      if (!kids.length) return null;
      return h("div", { className: "smp-ov-layer", "data-smp": "overlays" }, kids);
    }

    function SmpPlayerPanel(props) {
      var scope = props && props.scope;
      var tabState = react.useState("local");
      var tab = tabState[0], setTab = tabState[1];
      // QQ 面板的弹层（搜索历史 / 歌单选择器）以面板中心定位，需要面板根的 ref
      var qqPanelRef = react.useRef(null);
      var snapQQ = useSmpStore();
      var TABS = [
        { id: "local", label: "本地音乐" },
        { id: "qq", label: "QQ音乐" },
        { id: "prefs", label: "系统配置" }
      ];
      return h("div", {
        ref: qqPanelRef,
        className: "smp-pp",
        "data-smp": "player-panel",
        "data-scope": (scope && scope.sessionId) || ""
      }, [
        // 面板顶部 = 我们自己的完整播放器界面（封面 / 进度 / 文件夹 / 下载 / 大频谱 /
        // 音准 / 唱盘 / 歌词双模式 / 四个歌词功能）。与 MediaViewer 共用同一实现。
        h("div", { key: "player", className: "smp-pp-player" }, [
          h(SmpPlayerBody, { key: "body", mode: "panel", scope: scope })
        ]),
        h("div", { key: "tabs", className: "smp-pp-tabs", style: { display: "flex", alignItems: "center" } }, [
          h("div", { key: "tabs-inner", style: { display: "flex", alignItems: "center", gap: "2px" } }, TABS.map(function (t) {
            return h("button", {
              key: t.id,
              type: "button",
              className: "smp-pp-tab" + (tab === t.id ? " active" : ""),
              onClick: function () { setTab(t.id); }
            }, t.label);
          })),
          // 0.2.4 — 页签行右侧 ⟳ 检查更新（复用技能浏览器全局委托 window.__dshUpdClick）
          h("button", {
            key: "upd",
            type: "button",
            className: "smp-pp-tab",
            "data-dsh-upd": "dsh-sidebar-media-player",
            title: "检查更新（有新版可一键安装到 desktop profile，装完需彻底退出 DSH 再启动）",
            style: { marginLeft: "auto" },
            onClick: function (ev) {
              try {
                if (window.__dshUpdClick) window.__dshUpdClick(ev.currentTarget, "dsh-sidebar-media-player");
              } catch (e) {}
            }
          }, "⟳")
        ]),
        h("div", { key: "body", className: "smp-pp-body" }, [
          tab === "local"
            ? h(SmpLocalLibrary, { key: "local", scope: scope, ctx: props && props.ctx })
            : (tab === "qq"
              ? h(QQOnlinePanel, { key: "qq", panelRef: qqPanelRef })
              : h(SmpPrefsPanel, { key: "prefs" }))
        ]),
        // 浮层（toast / 自绘输入框 / 自绘确认框）：fixed 定位，不吃 overflow 裁剪
        h(SmpOverlays, { key: "ov", snap: snapQQ })
      ]);
    }

    function SmpDirPicker(props) {
      var s0 = react.useState(null), data = s0[0], setData = s0[1];
      var s1 = react.useState("__drives__"), cur = s1[0], setCur = s1[1];
      var s2 = react.useState(true), loading = s2[0], setLoading = s2[1];
      var s3 = react.useState(""), err = s3[0], setErr = s3[1];
      var s4 = react.useState(""), note = s4[0], setNote = s4[1];
      // 403（不在可访问范围）单独一个状态：它**不清空 data**，面包屑要保持原路可退。
      var s5 = react.useState(""), forbidden = s5[0], setForbidden = s5[1];

      function browse(p) {
        // up 可能是 null（盘符根自己）—— 绝不当路径发请求，否则后端 400。
        if (p === null || p === undefined || p === "") return;
        setCur(p); setLoading(true); setErr(""); setForbidden(""); setNote("");
        fetch(smpDirUrl(p), { cache: "no-store" })
          .then(function (r) {
            return r.json().catch(function () { return { ok: false }; })
              .then(function (d) { return { status: r.status, data: d }; });
          })
          .then(function (res) {
            var d = res.data;
            if (!d || d.ok === false) {
              var e = d && d.error;
              var code = (e && e.code) || "";
              var msg = (e && e.message) || "";
              setLoading(false);
              // 403 = 不在可访问范围内。**故意不清空 data**：面包屑与「上一级」
              // 必须还在，用户要能原路退回去；错误文案由渲染层给中文说明 + 原文。
              if (res.status === 403 || code === 403 || code === "forbidden") {
                setForbidden(msg || "forbidden");
                return;
              }
              setData(null);
              setErr(msg || ("目录读取失败（" + (code || res.status || "?") + "）"));
              return;
            }
            setData(d); setLoading(false);
            if (d.path) setCur(d.path);
            try { window.localStorage.setItem("smp.lastDir", d.path); } catch (e0) {}
          })
          .catch(function (e2) { setData(null); setLoading(false); setErr("网络错误：" + errText(e2)); });
      }
      react.useEffect(function () {
        // 诊断：picker 打开时现场有哪些 webkitdirectory 输入框（0 = 可能跑的是旧 bundle）
        try { console.info("[smp] dir picker opened, webkitdirInputs=" + document.querySelectorAll("input[webkitdirectory]").length); } catch (eD) {}
        // 首屏不直接进盘符根：先用上次浏览目录，其次取音乐库根（/library 的 root），
        // 都拿不到才退 __drives__。用户 99% 只想换到另一个音乐目录。
        var last = "";
        try { last = window.localStorage.getItem("smp.lastDir") || ""; } catch (e0) {}
        if (last) { browse(last); return; }
        fetch("/dsh-sidebar-media-player/library?depth=1", { cache: "no-store" })
          .then(function (r) { return r.json().catch(function () { return null; }); })
          .then(function (d) { browse((d && d.ok && d.root) ? d.root : "__drives__"); })
          .catch(function () { browse("__drives__"); });
      }, []);

      var rows = [];
      if (data) {
        var dirs = data.dirs || [], files = data.files || [];
        for (var i = 0; i < dirs.length; i++) {
          (function (it) {
            // 目录项直接用后端给的绝对 path —— 别再自己拼：
            // 盘符项的 name 是 "C:\\"（带反斜杠），拼会拼出 "C:\\\\"。
            rows.push(h("div", {
              key: "d" + i, className: "smp-pick-row",
              onClick: function () { browse(it.path); }
            }, h("span", { className: "smp-pick-ico" }, "\uD83D\uDCC1"),
               h("span", { className: "smp-pick-name", title: it.path }, it.name || it.path)));
          })(dirs[i]);
        }
        for (var j = 0; j < files.length; j++) {
          (function (it) {
            // size 可能为 0（后端 statSync 失败兜底）→ 为 0 就不显示大小；
            // 图标/形态一律用后端 isVideo，不从扩展名重推（免得两边口径打架）。
            var meta = [];
            if (it.isVideo) meta.push("视频");
            if (it.size > 0) meta.push(smpSizeText(it.size));
            rows.push(h("div", {
              key: "f" + j, className: "smp-pick-row file",
              onClick: function () {
                setNote("正在载入 " + it.name + " …");
                props.onPickFile(data.path, it.name).then(function (res) {
                  if (res && res.ok && res.count) { setNote(""); props.onClose(); }
                  else setNote((res && res.err) || "这个目录里没有可播放的文件");
                });
              }
            }, h("span", { className: "smp-pick-ico" }, "\u266A"),
               h("span", { className: "smp-pick-name", title: it.path }, it.name),
               meta.length ? h("span", { className: "smp-pick-meta" }, meta.join(" \u00b7 ")) : null));
          })(files[j]);
        }
      }
      return h("div", {
        className: "smp-pick-mask",
        onClick: function (ev) { if (ev.target === ev.currentTarget) props.onClose(); }
      },
        h("div", { className: "smp-pick-panel" },
          h("div", { className: "smp-pick-head" },
            h("span", { className: "smp-pick-title" }, "选择目录"),
            h("button", { className: "smp-pick-x", title: "关闭", onClick: props.onClose }, "\u2715")),
          h("div", { className: "smp-pick-bar" },
            h("button", { className: "smp-pick-btn", onClick: function () { browse("__drives__"); } }, "本机磁盘"),
            // up 为 null（盘符根自己）→ **禁用**而不是隐藏，用户能看出「到底了」；
            // 绝不把 null 当路径发请求（后端会 400）。
            h("button", {
              className: "smp-pick-btn" + ((data && data.up) ? "" : " disabled"),
              disabled: !(data && data.up),
              onClick: function () { if (data && data.up) browse(data.up); }
            }, "上一级"),
            h("span", { className: "smp-pick-path", title: cur }, cur)),
          // 面包屑：点任意一段用它自己的 path 重拉；最后一段是不可点的当前项。
          // 403 时 data 不清空，所以这条面包屑仍在 —— 原路可退。
          (data && data.crumbs && data.crumbs.length)
            ? h("div", { className: "smp-pick-crumbs" }, data.crumbs.map(function (c, ci) {
              var isLast = ci === data.crumbs.length - 1;
              return h("span", {
                key: "c" + ci,
                className: "smp-pick-crumb" + (isLast ? " cur" : ""),
                title: c.path,
                onClick: isLast ? undefined : function () { browse(c.path); }
              }, c.name);
            }))
            : null,
          h("div", { className: "smp-pick-body" },
            loading ? h("div", { className: "smp-pick-empty" }, "正在读取…")
              : forbidden
                ? h("div", { className: "smp-pick-403" }, [
                  h("div", { key: "t", className: "smp-pick-403-t" }, "这个目录不在可访问范围内"),
                  h("div", { key: "h", className: "smp-pick-403-h" },
                    "可以换成 ~/Music 或音乐库根；或把该目录加进 DSH_SIDEBAR_MEDIA_ROOTS 后重启 DSH。"),
                  // 后端 403 原文（含 allowed roots 那行）原样展示，那是用户自查的唯一线索
                  h("div", { key: "r", className: "smp-pick-403-raw" },
                    forbidden === "forbidden" ? "403 forbidden" : forbidden)
                ])
                : err ? h("div", { className: "smp-pick-err" }, err)
                  : (rows.length ? rows : h("div", { className: "smp-pick-empty" }, "这个目录是空的"))),
          h("div", { className: "smp-pick-foot" },
            h("button", {
              className: "smp-pick-btn primary",
              onClick: function () {
                setNote("正在扫描 " + cur + " …");
                props.onPickDir(cur).then(function (res) {
                  if (res && res.ok && res.count) { setNote(""); props.onClose(); }
                  else setNote((res && res.err) || "这个目录里没有可播放的文件");
                });
              }
            }, "用这个目录播放")),
          note ? h("div", { className: "smp-pick-note" }, note) : null));
    }

    function smpLibraryUrl(dir) {
      return "/dsh-sidebar-media-player/library" + (dir ? ("?dir=" + encodeURIComponent(dir)) : "");
    }
    function smpLibraryErrorText(d, status) {
      var e = (d && d.error) || null;
      var code = (e && e.code) || status || 0;
      if (code === 403) return "目录越界（403）：只允许扫描音乐库目录与会话目录";
      if (code === 404) return "目录不存在（404）";
      if (code === 400) return "路径必须是绝对路径（400）";
      if (code === 405) return "请求方式不对（405）";
      var msg = (e && e.message) || "";
      return msg ? (msg + "（" + code + "）") : ("扫描失败（" + (code || "?") + "）");
    }
    function smpSizeText(n) {
      if (typeof n !== "number" || !isFinite(n) || n < 0) return "";
      if (n < 1024) return n + " B";
      if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
      if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
      return (n / 1073741824).toFixed(2) + " GB";
    }

    function SmpLocalLibrary(props) {
      var scope = (props && props.scope) || null;
      var s0 = react.useState({
        phase: "idle", root: "", tracks: [], count: 0,
        truncated: false, err: "", playingPath: ""
      });
      var st = s0[0];
      var setSt = s0[1];
      var dirRef = react.useRef("");
      var fileInputRef = react.useRef(null);
      // 自绘目录抽屉开关：复用模块级 SmpDirPicker（position:fixed 全屏遮罩，在侧边栏里也能盖住）。
      // 「选目录」主入口走它；下面那个 webkitdirectory input 保留当"万一弹得出"的兜底。
      var pickPair = react.useState(false);
      var pickOpen = pickPair[0], setPickOpen = pickPair[1];
      // 当前正在播的那首：以 store 为准（条上切歌、下一首也同步高亮），
      // 本组件自己 patch 的 playingPath 只作点击瞬间的乐观值。
      var snap = useSmpStore();

      var patch = function (p) {
        setSt(function (prev) {
          var n = {}, k;
          for (k in prev) { if (Object.prototype.hasOwnProperty.call(prev, k)) n[k] = prev[k]; }
          for (k in p) { if (Object.prototype.hasOwnProperty.call(p, k)) n[k] = p[k]; }
          return n;
        });
      };
      var applyData = function (d, useDir) {
        patch({
          phase: "ready",
          root: d.root || useDir || "",
          tracks: Array.isArray(d.tracks) ? d.tracks : [],
          count: typeof d.count === "number" ? d.count : 0,
          truncated: d.truncated === true,
          err: ""
        });
      };
      var load = function (dir, force) {
        var useDir = dir || "";
        dirRef.current = useDir;
        if (!force && smpLibCache.data && smpLibCache.dir === useDir) {
          applyData(smpLibCache.data, useDir);
          return Promise.resolve({ ok: true, count: (smpLibCache.data.tracks || []).length });
        }
        patch({ phase: "loading", err: "" });
        // 返回 Promise：抽屉（SmpDirPicker 的 onPickDir）会 .then 等它跑完再关自己
        return fetch(smpLibraryUrl(useDir) + (useDir ? "&depth=" + SMP_LIB_DEFAULT_DEPTH : "?depth=" + SMP_LIB_DEFAULT_DEPTH), { cache: "no-store" })
          .then(function (r) {
            return r.json().then(function (d) { return { d: d, status: r.status }; });
          })
          .then(function (x) {
            var d = x.d;
            if (!d || d.ok !== true) {
              var code403 = d && d.error && d.error.code;
              // 403 = 围栏拒绝：**不清空当前列表**（用户要能原路退回），只挂一条中文提示 + 后端原文。
              if (x.status === 403 || code403 === 403 || code403 === "forbidden") {
                patch({ phase: "forbidden", err: smpLibraryErrorText(d, x.status) });
                return;
              }
              patch({ phase: "error", err: smpLibraryErrorText(d, x.status), tracks: [], count: 0 });
              return;
            }
            smpLibCache = { dir: useDir, data: d };
            applyData(d, useDir);
          })
          .catch(function (err) {
            patch({ phase: "error", err: "请求失败：" + String(err && err.message ? err.message : err) });
          });
      };

      react.useEffect(function () { load(""); }, []);

      var playIndex = function (idx) {
        var t = st.tracks[idx];
        if (!t) return;
        // 🔴 scope 兜底：props.scope 可能 undefined（registerTab 不保证注入）。旧写法
        // `if (scope) setScope` 在缺 scope 时不设 → mediaScope 为 null → ensureItemUrl 被跳过
        // → audio 无 src → 「no supported sources」。这里无条件构造可用 scope，并把每项 url
        // 直接算成根相对 /media 地址（与 smpPlayLibraryDir 一致），loadIndex 走 item.url 分支，
        // 彻底不依赖 mediaScope。
        var sc = { sessionId: (scope && scope.sessionId) || "smp", cwd: (scope && scope.cwd) || undefined };
        SMP_STORE.setScope(sc);
        // 音量兜底：历史持久化可能为 0（旧滑块无效时拖到底），点歌先确保能听见。
        try { var eV0 = SMP_STORE.audioEl(); if (eV0 && !(eV0.volume > 0)) eV0.volume = 0.8; } catch (eV) {}
        var items = [], i, x;
        for (i = 0; i < st.tracks.length; i++) {
          x = st.tracks[i];
          items.push({ name: x.name || x.path, path: x.path, isVideo: !!x.isVideo, url: mediaUrl(sc, x.path) });
        }
        SMP_STORE.setList(items, true, idx);
        patch({ playingPath: t.path });
        // 点列表项 → 顺带把播放器面板切到前台（openTab 才创建，activateTab 只切已存在的）。
        // 🔴 不传 path / url：传了会走 native surface 的文件打开分支、绕开我们自己的 store。
        try {
          var bs = props && props.ctx && props.ctx.betterSidebar;
          if (bs && typeof bs.openTab === "function") bs.openTab({ type: "dsh-sidebar-media-player" });
        } catch (eTab) {}
      };

      // 「选目录」保留浏览器扫描这条路（浏览器拿不到绝对路径）→ 与 /library 那条并存
      var onDirPicked = function (ev) {
        var files = ev && ev.target && ev.target.files;
        if (!files || !files.length) return;
        var items = [], i, f, ex;
        for (i = 0; i < files.length; i++) {
          f = files[i];
          ex = extOf(f.name || "");
          if (MEDIA_SET[ex] !== true) continue;
          items.push({
            url: URL.createObjectURL(f),
            name: f.name,
            path: f.name,
            isVideo: VIDEO_SET[ex] === true
          });
        }
        try { ev.target.value = ""; } catch (e0) {}
        if (!items.length) {
          patch({ phase: "error", err: "选中的目录里没有可播放的媒体文件" });
          return;
        }
        SMP_STORE.setList(items, true, 0);
        patch({
          phase: "ready", root: "浏览器选择的目录", tracks: [],
          count: items.length, truncated: false, err: "", playingPath: ""
        });
      };

      // 当前行高亮：以 store 的 path 为准（条上切歌 / 下一首也跟着亮），
      // 点击瞬间 state 还没回到，才用 playingPath 兜一下。
      var curPath = (snap && snap.path) || st.playingPath || "";
      var rows = [], i, tk;
      for (i = 0; i < st.tracks.length; i++) {
        tk = st.tracks[i];
        var tkExt = String(tk.ext || "").toUpperCase();
        if (!tkExt && tk.name) {
          var dot = String(tk.name).lastIndexOf(".");
          tkExt = dot > 0 ? String(tk.name).slice(dot + 1).toUpperCase() : "";
        }
        rows.push(h("div", {
          key: "tr-" + i + "-" + (tk.path || tk.name || ""),
          className: "smp-lib-row" + (curPath && curPath === tk.path ? " active" : ""),
          title: tk.path || tk.name || "",
          "data-path": tk.path || "",
          onClick: (function (k) { return function () { playIndex(k); }; })(i),
          onDoubleClick: (function (k) { return function () { playIndex(k); }; })(i)
        }, [
          h("button", {
            key: "p", type: "button", className: "smp-lib-play", title: "播放",
            onClick: (function (k) {
              return function (ev) {
                if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
                playIndex(k);
              };
            })(i)
          }, "▶"),
          h("span", { key: "n", className: "smp-lib-name" }, tk.name || tk.path || "(未命名)"),
          h("span", { key: "meta", className: "smp-lib-meta" }, [
            tkExt ? h("span", { key: "e", className: "smp-lib-tag" }, tkExt) : null,
            (typeof tk.size === "number" && tk.size > 0)
              ? h("span", { key: "s", className: "smp-lib-size" }, smpSizeText(tk.size))
              : null
          ])
        ]));
      }
      // 三种空态分开写，不搞一句"暂无文件"糊过去
      var idleText = "还没选目录。点上面的「选目录」，或直接扫描音乐库根目录。";
      var emptyText = "这个目录里没有可播放的媒体文件（mp3 / flac / wav / m4a / ogg / opus / aac / webm）。";
      var forbidText = "这个目录不在可访问范围内";
      var forbidHint = "换成 ~/Music 或音乐库根目录；或把该目录加进 DSH_SIDEBAR_MEDIA_ROOTS 后重启 DSH。";
      var forbidBar = (st.phase === "forbidden")
        ? h("div", { key: "fb", className: "smp-lib-forbidden" }, [
          h("div", { key: "t", className: "smp-lib-403-t" }, forbidText),
          h("div", { key: "h", className: "smp-lib-403-h" }, forbidHint),
          st.err ? h("div", { key: "r", className: "smp-lib-403-raw" }, st.err) : null
        ])
        : null;
      var body;
      if (st.phase === "loading" && !rows.length) body = h("div", { key: "ld", className: "smp-lib-empty" }, "正在扫描…");
      else if (st.phase === "error") body = h("div", { key: "er", className: "smp-lib-err" }, st.err || "扫描失败");
      else if (!rows.length) body = h("div", { key: "em", className: "smp-lib-empty" }, st.phase === "idle" ? idleText : emptyText);
      else body = rows;

      return h("div", { className: "smp-lib", "data-smp": "local-lib" }, [
        h("div", { key: "head", className: "smp-lib-head" }, [
          h("span", { key: "r", className: "smp-lib-root", title: st.root || "" }, st.root || "（音乐库根目录）"),
          st.count ? h("span", { key: "c", className: "smp-lib-hint" }, "共 " + st.count + " 首") : null,
          st.truncated ? h("span", { key: "t", className: "smp-lib-hint" }, "只显示了前 2 万条（真实上限 20000）") : null,
          h("button", { key: "re", className: "smp-lib-btn", onClick: function () { load(dirRef.current, true); } }, "重新扫描"),
          h("button", { key: "pk", className: "smp-lib-btn", onClick: function () { setPickOpen(true); } }, "选目录"),
          h("input", {
            key: "fi", ref: fileInputRef, type: "file", multiple: true,
            webkitdirectory: "", directory: "",
            style: { display: "none" }, onChange: onDirPicked
          })
        ]),
        h("div", { key: "body", className: "smp-lib-body" }, forbidBar
          ? [forbidBar, h("div", { key: "grid", className: "smp-lib-grid" }, body)]
          : h("div", { key: "grid", className: "smp-lib-grid" }, body)),
        h("div", { key: "foot", className: "smp-lib-foot" }, "支持 mp3/m4a/flac/wav/ogg/opus/aac/webm 等格式，自动递归扫描子目录。"),
        // 自绘目录抽屉：全屏遮罩，盖在侧边栏之上；选中目录 → load(dir,true) → /library?dir=&depth=8
        pickOpen ? h(SmpDirPicker, {
          key: "picker",
          onClose: function () { setPickOpen(false); },
          onPickDir: function (d) { return load(d, true); },
          onPickFile: function (d, nm) { return smpPlayLibraryDir(d, nm, scope); }
        }) : null
      ]);
    }

    function mountDockBars(ctx, slots) {
      if (smpDockMounted) return;
      smpDockMounted = true;
      if (typeof globalThis !== "undefined") globalThis.__DSH_SMP_BAR_MOUNTED__ = true;
      // ── 上侧：conversation.input.dock，order 40 ──
      ctx.effect(function () {
        return slots.inject("conversation.input.dock", function () {
          return slots.register({ name: "conversation.input.dock", id: "dsh-music-bar", order: 40 },
            function () { return h(SmpMusicBar, { placement: "dock" }); });
        });
      });
      // ── 下侧：shell.overlay，order 19，贴窗口底边 ──
      // 不是 conversation.composer.dock —— 对方从没用过那个槽（见文件头 S1.5 注释）。
      ctx.effect(function () {
        return slots.inject("shell.overlay", function () {
          return slots.register({ name: "shell.overlay", id: "smp-music-bar-floating", order: 19 },
            function () { return h(SmpMusicBar, { placement: "overlay" }); });
        });
      });
    }

    // ── 注册 ───────────────────────────────────────────────────────────────
    // 2026-11-12 崩溃修复：原来这里是硬依赖 ["betterSidebar"]，宿主侧服务没就绪时
    // client-module loader 会让本 entry 永久停在 "loading"，整个 web boot 判定
    // "1 entry did not activate" 并触发 renderer recovery 循环（12:00 崩溃实录）。
    // 组件本身已有 `if (sidebar === undefined) return;` 的兜底，故改为软依赖：
    // 服务在就激活面板，不在就静默跳过，不再拖住启动。
    var inject = [];

    // 官方扩展点写法（与 dsh-univer-office 一致）：服务晚到时用响应式注入，
    // cordis 会在 betterSidebar 就绪后自行运行回调；不再写进 exports.inject，
    // 否则服务慢就绪会让本 entry 永远 pending，整个 web boot 超时（11-12 崩溃）。
    // 诊断探针（临时）：把激活进度回写宿主文件，定位「页签不出现」的静默失败。
    function __smpDiag(msg) {
      try { fetch("/dsh-sidebar-media-player/diag?m=" + encodeURIComponent(String(msg)), { cache: "no-store" }).catch(function () {}); } catch (e) {}
    }

    function apply(ctx) {
      __smpDiag("apply-enter");
      ctx.inject(["betterSidebar"], function (__sbCtx) {
        __smpDiag("inject-fired");
        try { __applyReal(__sbCtx); }
        catch (e) { var __em = (e && e.message) || String(e); try { console.warn("[smp] activate failed:", __em); } catch (e2) {} __smpDiag("ERR " + __em); }
        try {
          var __sb = __sbCtx.betterSidebar;
          console.log("[smp] after apply: tabs=" + __sb.getTabs().map(function (t) { return t.id; }).join(",") +
            " | viewers=" + __sb.getFileViewers().map(function (v) { return v.id; }).join(","));
        } catch (e3) { try { console.warn("[smp] post-check failed:", (e3 && e3.message) || e3); } catch (e4) {} }
      });
    }

    function __applyReal(ctx) {
      // 服务访问必须 try/catch：cordis 在服务未就绪时读取 ctx.<service> 会抛，
      // 直接裸读会让本 entry 判 "failed"。取不到就退化成空，绝不影响启动。
      function __getSidebar() { try { return ctx.betterSidebar; } catch (e) { return undefined; } }
      var sidebar = __getSidebar();
      __smpDiag("applyReal start sidebar=" + (sidebar ? "yes" : "no") + " registerTab=" + (sidebar && typeof sidebar.registerTab) + " registerFileViewer=" + (sidebar && typeof sidebar.registerFileViewer));
      if (sidebar === undefined) {
        // 软依赖：服务晚到时最多等 30s 再挂；等不到就静默跳过（面板不出现，
        // 但不拖住 web boot —— 2026-11-12 崩溃实录）。
        var __tries = 0;
        var __timer = setInterval(function () {
          var s2 = __getSidebar();
          if (s2 === undefined && (++__tries) < 60) return;
          try { clearInterval(__timer); } catch (e) {}
          if (s2 !== undefined) { try { apply(ctx); } catch (e) {} }
        }, 500);
        return;
      }
      // 必须包 ctx.effect：fiber teardown / HMR / 插件停用时把 disposer 跑掉，
      // 否则再次激活会抛 "already registered"。
      // 注意这里**只传一个参数**（execute）—— 客户端半边保持与 dsh-video-preview
      // 生产实现一致的调用形态，label 只在宿主半边用（宿主侧由 cordis 直接消费）。
      __smpDiag("before-registerFileViewer");
      // 2026-11-12 适配 better-sidebar 0.31.1：它对重复 id 直接抛
      // `file viewer "media" already registered`，抛错会中断 __applyReal，
      // 后面 registerTab 全不执行 → 侧边栏整个不显示（14:27 实测 diag 日志就是这么记的）。
      // 改为「先查已有 + 兜住异常」：同 id 已存在就跳过，失败只记日志，绝不再连带后面的 tab。
      try {
        var __haveViewer = false;
        try {
          var __vs = sidebar.getFileViewers();
          __haveViewer = !!(__vs && __vs.some(function (v) { return v && v.id === "media"; }));
        } catch (eV0) {}
        __smpDiag("viewer-have=" + __haveViewer);
        if (!__haveViewer) {
          ctx.effect(function () {
            return sidebar.registerFileViewer({
              id: "media",
              title: "Media",
              icon: function (size) { return IconMedia(size); },
              exts: MEDIA_EXTS,
              // 优先级高于 dsh-video-preview / @huanlin audio（默认 50），
              // 这样音视频都落到本 viewer，方便一次测全 seek + 频谱 + 音准。
              priority: 60,
              // 字节由本 viewer 自己拼 /dsh-sidebar-media-player/media 取（Range 路由），
              // 不让宿主先读一遍文件。
              fetchStrategy: "none",
              component: MediaViewer
            });
          });
        }
      } catch (eV) { __smpDiag("ERR registerFileViewer " + ((eV && eV.message) || eV)); }

      // ── 批 2：「本地音乐」页签 ────────────────────────────────────────────
      // SmpLocalLibrary 只要 props.scope 一个入参；播放链路
      // setScope → setList → loadIndex → ensureItemUrl → /media 已通。
      // 四条硬约束（都有实证）：
      //   ① 正文属性是 component（不是 render）—— 写 render 会注册成功但页签空白；
      //   ② 必须包 ctx.effect，否则停用/重载后二次激活抛 "already registered"；
      //   ③ id 撞名会 throw —— 用带插件名的 id；
      //   ④ 宿主对 tabBody 一律保挂载，切走切回不卸载，别自己加卸载逻辑。
      // 滚动自备：SmpLocalLibrary 内部 .smp-lib-body 是 overflow:auto + flex:1 1 0
      // （宿主容器 overflow:hidden，不给滚动）。
      // 用户定案：**不再单独挂「本地音乐」页签** —— 播放器是一个整体面板，
      // 内部自带「本地音乐 / QQ音乐 / 系统配置」三个**面板内**页签（不是侧边栏页签）。
      __smpDiag("before-registerTab viewers=" + (sidebar && sidebar.getFileViewers().map(function (v) { return v.id; }).join("|")));
      // 同上：tab id 撞名也抛，且抛错会让整个 activate 判失败。先查再注册，失败兜住。
      try {
        var __haveTab = false;
        try {
          var __ts = sidebar.getTabs();
          __haveTab = !!(__ts && __ts.some(function (t) { return t && t.id === "dsh-sidebar-media-player"; }));
        } catch (eT0) {}
        __smpDiag("tab-have=" + __haveTab);
        if (!__haveTab) {
          ctx.effect(function () {
            if (!sidebar || typeof sidebar.registerTab !== "function") return undefined;
            return sidebar.registerTab({
              id: "dsh-sidebar-media-player",
              title: "播放器",
              description: "侧边栏播放器：本地 / QQ 音乐 / 视频 / 设置",
              icon: function (size) { return IconMedia(size); },
              order: 30,
              single: true,
              component: function (props) {
                return h(SmpPlayerPanel, {
                  scope: props && props.scope,
                  ctx: props && props.ctx,
                  visible: !!(props && props.visible)
                });
              }
            });
          });
        }
      } catch (eT) { __smpDiag("ERR registerTab " + ((eT && eT.message) || eT)); }

      __smpDiag("after-registerTab tabs=" + (sidebar && sidebar.getTabs().map(function (t) { return t.id; }).join("|")));

      // ── S1：输入框上/下侧播放条落位 ──────────────────────────────────────
      // 样式一次性注入 document.head，包 ctx.effect 以便停用/HMR 时移除。
      ctx.effect(function () {
        var styleEl = document.createElement("style");
        styleEl.setAttribute("data-plugin", "dsh-sidebar-media-player");
        styleEl.setAttribute("data-smp", "dock-css");
        styleEl.textContent = SMP_REF_CSS + "\n" + DOCK_CSS;
        document.head.appendChild(styleEl);
        return function () { if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl); };
      });

      var slots = resolveSlots(ctx);
      // 🕐 槽服务可能晚于 apply 就绪 → 有界重试（≤2 s，20 × 100 ms）：
      //    当下取到就直接注册；取不到先挂轮询，成功后再注册；20 次仍未就绪才告警。
      if (slots === null) {
        var smpTries = 0;
        var smpTimer = setInterval(function () {
          smpTries += 1;
          var s2 = resolveSlots(ctx);
          if (s2 !== null) { clearInterval(smpTimer); mountDockBars(ctx, s2); return; }
          if (smpTries >= 20) {
            clearInterval(smpTimer);
            console.warn("[smp] slots service unavailable — dock bar not mounted | 输入框上/下侧播放条未挂载；侧边栏播放器不受影响");
          }
        }, 100);
        ctx.effect(function () { return function () { clearInterval(smpTimer); }; });
      } else {
        // ── 上侧：conversation.input.dock，order 40（对方 :11348-11351 原文）──
        // 两条注册已抽到 mountDockBars()（幂等：立即路径与重试路径共用）
        mountDockBars(ctx, slots);
        // ── 下侧：shell.overlay，order 19，贴窗口底边（对方 :11352-11355 原文）──
        // 不是 conversation.composer.dock —— 对方从没用过那个槽（见文件头 S1.5 注释）。
        // （下侧 shell.overlay 的注册同上，已在 mountDockBars() 内一并完成）
      }
    }

    module.exports = {
      inject: inject,
      apply: apply,
      version: VERSION
    };
    return module.exports;
  }
});
