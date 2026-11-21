# Changelog

## 0.2.38 (2026-11-21) — 胶囊「最初少柱」档去掉独立底色，背景与播放条一致

- 问题：0.2.37 抄 GitHub v0.2.21 时把玻璃底纹一起带回来了 —— 画布自带一层 `rgba(255,255,255,0.045) → rgba(0,0,0,0.055)` 渐变底，在胶囊条上看是「块异色底」。
- 修法：mini 档给 `drawSpectrum` 传 `glass: false`（0.2.32 就留好的开关）→ 不画玻璃渐变与能量基线底色；柱子、倒影、峰值保持不动；canvas CSS 恒 `background: transparent`。
- 结果：少柱频谱直接坐在胶囊条自身的背景上，没有独立底色块。

## 0.2.37 (2026-11-21) — 胶囊「最初少柱」档抄成 GitHub 最新发布版（v0.2.21）原样

- 问题：0.2.36 抄的是本地仓库 0.2.7 的私有小柱实现（13 根圆顶柱），不是用户要的「GitHub 最新版本」效果。
- 修法：从 `origin/main`（v0.2.21，commit 065d015）原样取胶囊频谱口径 —— `SMP_VIZ_W=60 / SMP_VIZ_H=26 / MIN_BARS=8 / MAX_BARS=18`、绘制 `drawSpectrum(..., { safePx: 2, barSlotPx: 3.5, st: __smpMiniState })`（玻璃底纹、倒影、峰值保持全开）、canvas CSS `60×20`（窄宽档 75%）。
- 实现：`--smp-viz-w/--smp-viz-h` 两个 CSS 变量驱动画布尺寸，mini 档 60×20 / full 档 96×36，切换即时生效。
- full 档不变（96×36、柱数 24~72、槽宽 1.5px），侧边栏面板频谱恒为完整柱。

## 0.2.36 (2026-11-21) — 胶囊「最初少柱」档抄回 0.2.7 原始小柱画法

- 问题：0.2.34 的 mini 档走 `drawSpectrum(simple:true)`，画出来是细长锥形柱，太丑。
- 修法：mini 档改回直接调 `smpDrawMiniViz`（0.2.7 的原始画法：圆顶柱 + 柱身色带渐变 + 峰值帽 + 顶部高光），slot=7 → 约 13 根，与最初版本一致。
- `smpDrawMiniViz` 增加可选 slotPx 参数（默认沿用 SMP_VIZ_SLOT_PX），仅在胶囊 mini 档传入 7。

## 0.2.35 (2026-11-21) — 唱盘更精致 + 音准行贴住卡片下边缘

- 唱盘高级感升级：底盘改金属斜向渐变 + 内外双环，唱片加镜面光泽弧（随唱片旋转）、外缘提亮，中心标签加亮环 + 金属轴心。
- 唱盘尺寸 60 → 64px，hero 卡下内边距 10px → 4px，左列 `justifyContent: space-between`，让「音准 G2 97.6 Hz」行正好贴住卡片下边缘。
- 全部为视觉优化，无行为变更。

## 0.2.34 (2026-11-21) — 频谱样式语义纠正：侧边栏恒全柱，只切胶囊两档

- 按用户澄清重做 0.2.32 引入的「四档频谱样式」：**侧边栏大频谱永远完整柱**，样式开关只切胶囊。
- 新增偏好 `capsuleStyle`（设置面板「〰️ 胶囊形式」+ 控件行按钮）：
  - `full` 全柱密集（约 60 根，与侧边栏同款画法）；
  - `mini` 最初形式（约 13 根粗柱、无倒影/峰值/玻璃底纹）。
- 删除 `line`（线条）与 `wave`（波形）两种样式（用户认为太 low）；`specStyle` 键保留仅为旧档兼容，实际面板恒为完整柱。
- `drawSpectrum` 简化档改由 `opt.simple` 触发（只胶囊 mini 档用），不再读全局 specStyle。

## 0.2.33 (2026-11-21) — 修复「柱子消失」

- 0.2.32 引入的回归：把玻璃底纹改成可关时，只给空的 `glass` 判断包了 `fillRect`，但前两条 `glass.addColorStop(...)` 漏在 `if (glass)` 之外 → 胶囊传 `glass:false` 时 `glass` 为 null，`addColorStop` 抛 TypeError，**整个 drawSpectrum 中断，柱子一根都画不出来**。
- 修复：三条 addColorStop + fillStyle + fillRect 全部收进 `if (glass) { ... }`。
- 已用 Node 仿真跑通四档绘制调用（full/simple 各 62 次 fill、line/wave 各 1 次 stroke，无异常）。
## 0.2.32 (2026-11-21) — 胶囊频谱底色去掉 + 频谱样式扩为四档

- 胶囊频谱「背景弄消失、和背景一样（浅色主题下就是白）」：canvas 不再自带 background/border/box-shadow，且给胶囊传 `glass:false`，不画那层半透明白黑渐变；底色完全随播放条背景。
- 频谱样式由「柱状/波形」两种扩为四种，面板与胶囊共用同一偏好（设置面板「〰️ 样式」与控件行按钮都可切）：
  - **完整柱** full：现版本（主柱 + 倒影 + 峰值线 + 光晕 + 玻璃底 + 能量基线）
  - **简化柱** simple：最初的形式（只有柱本身，不倒影/不峰值/不光晕/不玻璃/不基线）
  - **线条** line：单条折线（比波形稍亮、无峰值虚线）
  - **波形** wave：折线 + 峰值虚线
- 旧存档里的 `specStyle:"bar"` 按「完整柱」兼容读取。
## 0.2.31 (2026-11-21) — 胶囊柱数拉到与面板齐平（约 60 根）

- 用户第三次纠正：「这个有 50-70 个柱子，胶囊才十三个，我让你柱数齐平」—— 要的是**同样的柱子数量**，不是同样的柱宽。
- 面板约 702px 宽 / barSlotPx=7 → 上限 72 根（实际 50~70）；胶囊 96px 宽要出同量级 ⇒ 每根约 1.5px。
- 胶囊两条绘制路径统一 `barSlotPx: 1.5`、`safePx: 1`；`SMP_VIZ_MIN_BARS/MAX_BARS` 8/13 → 24/72（与面板同上下限）。
## 0.2.30 (2026-11-21) — 胶囊迷你频谱柱数与面板一致

- 用户反馈「柱子得数量明显不一样」。
- 根因：胶囊调用 drawSpectrum 时 barSlotPx=3.5 → 96px 宽算出 18 根（撞 maxBars），比面板（72 宽 702px，barSlotPx=7）密一倍多。
- 修正：barSlotPx 3.5 → 7（与面板同值）、safePx 3 → 2（小画布上 8px 安全边会吃掉柱区）、maxBars 14 → 13，96px 宽稳定出 13 根，柱宽/缝隙比例与面板完全同源。

## 0.2.29 (2026-11-21) — 胶囊迷你频谱参数向面板看齐（底色/安全边/柱宽）

- 底色改为与面板 canvas 同源（品牌色 10% → transparent），去掉额外深色层。
- safePx 2→3、barSlotPx 3.5→7、maxBars 18→14。

## 0.2.28 (2026-11-21) — 胶囊迷你频谱改成与侧边栏面板频谱同款（原来太短）

- 用户要求（带图）：「这个和侧边栏展开完全一模一样试试，现在比较短」—— 指胶囊条上的迷你频谱。
- 尺寸：CSS 60×20 → **96×36**；逻辑画布 `SMP_VIZ_W/H` 60×26 → 96×36（按面板 84px 高等比缩小），窄宽降级档 40px → 72px。
- 柱数算法与面板同一节奏：槽宽 4px → **6px**（96 宽 → 16 根柱），上下限仍 8~18；整体 `barW/gap/倒影` 都由槽宽派生，粗细与面板一致。
- 外观同源：胶囊画布补上面板同款圆角 8px、品牌渐变底、1px 边框、内阴影；内边距 1px→2px 给倒影留空间。
- 画法本身一直是同一套 `drawSpectrum` 派生（渐变/峰值保持/倒影/竹节收窄），本次只把尺寸与柱密度对齐。

## 0.2.27 (2026-11-21) — 播放进度「0:42 / 4:10」挪到唱片旁原 `audio · 4:10` 的位置

- 用户要求（带图）：「播放得进度显示 0:42 / 4:10 挪到原来 audio 4:10 得位置」—— 即唱片机右侧、歌曲标题下面那一行的位置。
- 实现：封面卡副行由「audio · 时长」改为实时进度 `fmtTime(time) + " / " + fmtTime(duration)`，与底部时间行同源、同一格式，随播放实时更新。
- 底部进度条下面那行时间仍在（若也想去掉，说一声即可一并删除）。

## 0.2.26 (2026-11-21) — 删掉唱片旁「audio · 4:10」的时长，时长只在底部时间行

- 用户要求：唱片机右侧标题下面那行 `audio · 4:10` 里的 `4:10` 去掉，时长统一由底部时间行（`0:08 / 4:10`，紧挨进度条下面右端贴齐）显示。
- 实现：封面卡文本列的副行只在有副标题扩展名（如 `.flac`）时才渲染、内容只显示扩展名；没有扩展名时整行不出现（标题下方不再重复时长）。

## 0.2.25 (2026-11-21) — 时间行定稿：紧挨进度条下面、右端贴齐；按钮照旧随宽度拐行

- 用户定稿口径（带图）：「时间进度始终在最后紧挨进度条下面得最右边，按钮还是随着宽度拐行」。按此把 0.2.23/0.2.24 的时间行位置一次改到位。
- 控件区改为纵向两层：第一层按钮行（`flexWrap: wrap`，窄宽时自动折行，**不再挤压时间**），第二层时间行。
- 时间行独占一行、`width: 100%` + `justify-content: space-between`：起点时间贴左，右侧组（时长 + 拖动中提示）用 `margin-left: auto` 贴**进度条末端的最右端**，与进度条同宽对齐。
- `whiteSpace: nowrap` 保证时间永不折行；进度条关闭（`progressShow=false`）时时间行才回到控件块外单独显示。

## 0.2.24 (2026-11-21) — 中间态（已被 0.2.25 取代）

- 曾把时间行内联进控件行末尾并让控件行 `nowrap`（靠 `--smp-ctrl-k` 缩放塞进一行）。用户随后明确「按钮还是随宽度拐行」，故 0.2.25 回退为按钮可换行 + 时间单独一行贴右。

## 0.2.23 (2026-11-21) — 面板布局重排：唱片放大 / 音准贴底 / 时间挪到控件行下 / 删下载 / 窄宽不裁按钮

- 用户要求（带 5 张截图）：① 唱片机加大，让音准标记正好挨到底侧；② 播放时间格式照图（`0:07 / 4:29`）但挪到控件行**下面**；③ 按钮重排；④ 下载按钮删除；⑤ 侧边栏拖窄时按钮不被裁掉。全部落地。
- 唱片 `Turntable` 由 44px 放大到 60px（`size:60` + 容器 60×60），音准 chip 视觉重量跟唱片同级。
- 音准行不再被裁：去掉 `maxWidth:100% / overflow:hidden` 的硬裁剪，chip 改 `flex:0 0 auto; minWidth:72px`，整行 `white-space:nowrap` 按内容撑宽。
- hero 左列宽度**不再是固定 px 或百分比**：新增测量 effect（`ResizeObserver` 观察音准行 `scrollWidth`）把实测宽写进 CSS 变量 `--smp-hero-left`，左列 `width: var(--smp-hero-left, 240px)`；歌词列 `flex:1 1 120px`，hero 容器 `flexWrap: wrap` —— 窄到放不下时歌词列自动换到下一行，任何宽度都不裁内容。
- 播放时间行从进度条下移到**控件行下面**，改为 `flex-start` 左对齐 + `/` 分隔（`0:07 / 4:29`），拖动中提示仍跟在后面。
- 删除下载按钮：控件行与「⋯ 更多设置」面板两处的 `downloadLink` 引用一并移除，`⋯` 的 tooltip 也去掉「下载」（节点留作死代码 `__smpDlUnused`，后续可清）。
- 控件行容器由「`flex:0 0 auto` + 横向滚动」改为「`flex:1 1 auto` + `flexWrap:wrap` + 行间距 4px」：窄宽时按钮自动折到第二行，不再有按钮被横向滚出可视区或被裁断。

## 0.2.22 (2026-11-21) — 面板歌词不再消失 + 空列表点播放直进「我喜欢」

- 修 bug（用户现场：胶囊有歌词、侧边栏面板却显示「无歌词」）：面板歌词汇总通道只认 `lyricLinesRev`，而 QQ 行级/纯文本歌词只更新 store 的 `lyricLine`（行数组恒空、rev 不再增），面板一旦落到 `source:"none"` 就永不刷新。新增「单行歌词」回灌通道（`panelLyricOneRef` 比对 `lyricLine` 变化 → 合成 `plain` 歌词），并把 `lyricLine` 加进 effect 依赖，面板从此与胶囊同源、始终有词。
- 新功能（用户要求）：胶囊**在没有播放列表**（无当前曲）时点播放，不再只是打开面板 —— 自动切到「我的歌单」、打开「我喜欢」、从第一首开始播。实现走 store 信号：`SMP_STORE.openMineFirst()` 自增 `mineFirstRev`，面板 `QQOnlinePanel` 用 effect（rev 去重）拉 `/qq/my-playlists` → 按 `dirId===201`（兜底名字含「喜欢」）定位歌单 → 拉详情 → `playSong(songs[0], songs, ...)`，并同步面板层与选中歌单。
- 未登录时只切到「我的歌单」页签、不擅自选登录方式（面板本就停在登录 UI）。

## 0.2.21 (2026-11-20) — 歌词在剩余空白区居中

- 用户要求：胶囊条左侧的歌词/「无歌词」文字不再贴左，要在**剩余空白区域的中间**显示；悬停展开播放按钮时也随剩余空间自动居中、按钮移开后回正。
- 实现：.dsh-music-bar-lyric 由 text-align:left 改为 display:flex; align-items:center; justify-content:safe center（Chromium 支持 safe：歌词放不下时自动回退起点对齐，只从右端裁、开头永远可见）。
- 市场效果图换新：深色主题实拍 3 张（播放器面板全貌 + 贴底胶囊两种状态），替换旧效果图。

## 0.2.20 (2026-11-20) — 胶囊条不再显示版本号

- 用户要求：条上连 `v0.2.20` 小字也不要。删掉 `dsh-music-bar-ver` 那颗 span 与对应 CSS 规则，胶囊条上不再出现任何版本字样。
- 版本号仍然可以从插件详情/CHANGELOG 查到，不再占条上空间；布局与宽度机制（`--smp-card-x/--smp-card-w` 变量跟随输入框）保持 0.2.19 原样。

## 0.2.19 (2026-11-20) — 清掉条上调试数字与临时诊断（功能不变）

- 用户验收：「现在宽度是一样的，也可以拉着动，修好了」→ 去掉条上那行 `v0.2.18 · 条977/卡977/槽1478` 调试数字，只保留 9px 淡版本号徽章（原有设计）。
- 同时整段删除这两轮加的临时诊断：`[smp-layout]` 的 JSON 日志块（含 `hit`/`anc`/`barZ` 等重字段）与 `[smp-diag]` 一次性 effect —— 它们只在排障期有用，留着会每 5 秒污染 renderer console。
- 说明：布局机制一字未动 —— 外壳仍 `position: relative; z-index: 900; height: 0`，条本体仍 `position: fixed; left: var(--smp-card-x); width: var(--smp-card-w)`，变量仍由 findCard() 每 500ms + ResizeObserver 从输入框卡片 rect 写入（宽度仍是变量、不是固定值）。

## 0.2.18 (2026-11-20) — 修「贴底条 rect 全对但肉眼整条空白」：z-index 对 static 无效

- **根因**：`.dsh-music-bar-wrap.bottom` 写的是 `position: static; z-index: 900` —— CSS 里 z-index 只对非 static 元素生效，所以贴底条一直以 `z-index: auto` 参与绘制，被宿主 `[data-composer-seat]` / shell 那层正值层级整片盖住。表现就是最迷惑人的那一组证据：`[smp-layout]` 日志里 `card=[520,623,712,98]`、`bar=[520,749,712,46]`、`cardVar=712px`，**卡宽=条宽完全对齐**，肉眼却什么都没有。
- 改法：外壳 `position: relative`（`height: 0` 仍不吃布局）让 `z-index: 900` 真正生效，条本体再自带 `z-index: 900`，在 wrap 的层叠上下文里压住宿主内容。
- 宽度仍然**不是固定值**：条本体 `left: var(--smp-card-x)` + `width: var(--smp-card-w)`，两个变量由每 500ms + ResizeObserver 重读的输入框卡片 rect 写入，输入框拖宽即跟随。
- 诊断再加三组硬证据：`hit`（条中心点 `elementsFromPoint` 前 5 层，带 rect/class/z-index/position，命中自己会标 `<== 条自己`）、`barZ`（条自己的 zIndex/position/visibility/opacity/backgroundColor）、`inView` / `clientH` / `wrapZ` / `barTextLen` / `cardXVar`。以后「看不见」直接看 hit 第一行是谁。

26-11-20) — 修「贴底条 rect 全对但肉眼整条空白」：z-index 对 static 无效

- **根因**：`.dsh-music-bar-wrap.bottom` 写的是 `position: static; z-index: 900` —— CSS 里 z-index 只对非 static 元素生效，所以贴底条一直以 `z-index: auto` 参与绘制，被宿主 `[data-composer-seat]` / shell 那层正值层级整片盖住。表现就是最迷惑人的那一组证据：`[smp-layout]` 日志里 `card=[520,623,712,98]`、`bar=[520,749,712,46]`、`cardVar=712px`，**卡宽=条宽完全对齐**，肉眼却什么都没有。
- 改法：外壳 `position: relative`（`height: 0` 仍不吃布局）让 `z-index: 900` 真正生效，条本体再自带 `z-index: 900`，在 wrap 的层叠上下文里压住宿主内容。
- 宽度仍然**不是固定值**：条本体 `left: var(--smp-card-x)` + `width: var(--smp-card-w)`，两个变量由每 500ms + ResizeObserver 重读的输入框卡片 rect 写入，输入框拖宽即跟随。
- 诊断再加三组硬证据：`hit`（条中心点 `elementsFromPoint` 前 5 层，带 rect/class/z-index/position，命中自己会标 `<== 条自己`）、`barZ`（条自己的 zIndex/position/visibility/opacity/backgroundColor）、`inView` / `clientH` / `wrapZ` / `barTextLen` / `cardXVar`。以后「看不见」直接看 hit 第一行是谁。

## 0.2.17 (2026-11-20) — 修「底部整条空白」+ 布局数字持续上报

- **修 0.2.15/0.2.16 引入的空白 bug**：上一版把 `.dsh-music-bar-wrap.bottom` 设成 `width: 0; height: 0`，而条本体靠 `width: var(--smp-card-w, 100%)` —— 卡片 rect 没读到的那一帧 `--smp-card-w` 缺失 → `100%` 相对 0 宽的壳 = **0 像素，整条看不见**。现在壳保持满宽（`width: 100%; height: 0`，绝对不占位），条宽兜底改成 `calc(100vw - 2 * var(--dsh-composer-side-clearance, 16px))`，只有读不到视口时才会是 0。
- 卡片查找加兜底：主选择器 `[data-composer-card]` 找不到时，扫 `[data-composer-seat]` 子树里「宽度 ≥ 座位宽 90%、面积最大」的元素，两条路都失败才留空。
- 诊断从「启动 2 秒打一次」改为**每 5 秒持续打一行** `[smp-layout] {...}`：模式、视口/clientWidth、wrap 壳 rect、所在槽 rect 及类名、`[data-composer-card]` rect 及类名、`[data-composer-seat]` rect 及类名、条本体 rect 与 computed width/maxWidth、`--dsh-composer-card-max-width` 实际取值、我们写入的 `--smp-card-w` / `--smp-card-x`。DSH 桌面端会把 renderer console 转发进 `~/.dsh/logs/desktop-next.log`，读日志即可核验，不必截图。
- 宽度不是固定值：所有数字都来自每 500ms + ResizeObserver + resize 重读的输入框卡片 rect，拖动输入框即跟随。
- 版本：`package.json` 与 `lib/client.js` 同步到 0.2.17，`SMP_BUILD` 2026-11-20 13:58。
## 0.2.16 (2026-11-20) — 布局实测数字上报到 DSH 日志（[smp-layout]）

- 每 5 秒往 renderer console 打一行 `[smp-layout] {...}`，内容包括：模式（bottom/dock）、视口宽高、wrap 壳的 rect 与所在槽（slot）的 rect 及其类名、**输入框卡片 `[data-composer-card]` 的 rect 与类名**、条本体 rect、条的 computed `max-width`、`--dsh-composer-card-max-width` 的实际取值、以及我们写入的 `--smp-card-w`。
- DSH 桌面端会把 renderer console 全量转发进 `~/.dsh/logs/desktop-next.log`（日志中 `[renderer] console` 行即证），所以这些数字作者可以直接读日志核对，**不需要用户再截图、也不需要互相猜「是不是没生效」**。
- 这一版不改布局逻辑（0.2.15 的 `[data-composer-card]` 锚点保持不变），只是把判据交出来。
- 版本：`package.json` 与 `lib/client.js` 的 `VERSION` 同步到 0.2.16，`SMP_BUILD` 更新为 2026-11-20 13:52。
## 0.2.15 (2026-11-20) — 宽度锚点改用 DSH 自己的输入框卡片 [data-composer-card]

- **实测证据（用户截图，条上自报数字）**：`v0.2.14 · 780/1478` —— 条宽 780、所在槽宽 1478。780 正是 `max-width: var(--dsh-composer-card-max-width, 780px)` 的**兜底值**：该变量定义在 composer 卡片自己的祖先链上，我们的条挂在 `conversation.input.dock` 槽里，读不到它 → 每次都退化成 780px 居中。前四版（0.2.9 座位宽 / 0.2.10 子树最宽 / 0.2.11 写死变量 / 0.2.12 槽宽）全部错在同一处：**拿的不是输入框那条边**。
- 锚点换成宿主自己的输入框卡片：`[data-composer-card]`（DSH 源码 `dsh-client-ui-conversation/lib/client.js:22018` 里 `"data-composer-card": true`）。每 500ms + ResizeObserver + resize 读它的真实 rect，写进 `--smp-card-x` / `--smp-card-w`。
- 贴底条改为 `position: fixed; left: var(--smp-card-x); width: var(--smp-card-w); max-width: none`，直接落到卡片同一组坐标上 → 左右边界逐像素重合，拖动输入框宽度自动跟随；外壳 wrap 去掉 `transform`（有 transform 的祖先会让子元素 fixed 相对它定位）并不再占位。
- 基础 `.dsh-music-bar` 的 `max-width` 去掉 780px 兜底，改 `var(--smp-card-w, none)`，顶部模式同样受益。
- 版本戳改成 `v0.2.15 · 条1326/卡1326/槽1478`，三个宽度同时在线，一眼看出是哪一层没对齐。
- 版本：`package.json` 与 `lib/client.js` 的 `VERSION` 同步到 0.2.15，`SMP_BUILD` 更新为 2026-11-20 13:40。
## 0.2.14 (2026-11-20) — 版本戳实时显示「条宽/槽宽」，把测量值交出来

- 条右侧的版本戳不再只写版本号，而是 **`v0.2.14 · 613/645`**（条宽 / 所在槽宽，实测值，每 500ms 刷新一次）。鼠标悬停还能看到 `seat宽`（`[data-composer-seat]` 的宽度）、`视口宽`、以及槽元素的 `tag#id.class`。
- 目的：前几轮一直在「是不是没刷新 / 改的是不是那份文件 / 宽度是不是没取对」之间打转，缺的是现场数字。现在顶部模式（用户认可的、对齐正确的那一态）和底部模式各自把实测宽度印在条上，两张截图一对比就能确定差异出在哪一层容器。
- 版本：`package.json` 与 `lib/client.js` 的 `VERSION` 同步到 0.2.14，`SMP_BUILD` 更新为 2026-11-20 13:15。
## 0.2.13 (2026-11-20) — 底部条删除全部宽度声明；加可见版本戳

- **「你参考胶囊处于上部时候的代码」**：这次把 `.dsh-music-bar-wrap.bottom` 里**所有**与宽度有关的声明删干净了（`box-sizing` / `width` / `padding` 三条全部移除）。贴底模式现在只剩四个属性：`position: relative`、`height/margin-bottom`（互相抵消，不占位）、`transform: translateY(--smp-shift)`、`pointer-events: none`。宽度、左右内缩、`max-width`、居中全部 100% 来自与顶部共用的那两条 base 规则（`.dsh-music-bar-wrap` 与 `.dsh-music-bar`），底部没有第二条宽度规则可执行。
- **加可见版本戳 `v0.2.13`**（条最右侧、9px 半透明小字，hover 显示 `SMP 0.2.13 · 2026-11-20 13:05`）：此前多轮「改了但看起来没变」无法区分是代码没生效还是浏览器没刷新，现在截图即可定版。
- 版本：`package.json` 与 `lib/client.js` 的 `VERSION` 同步到 0.2.13，`SMP_BUILD` 更新为 2026-11-20 13:05。
## 0.2.12 (2026-11-20) — 贴底条 = 顶部条平移，宽度零差异（采用用户方案）

- **「你直接把顶部胶囊的代码挪动坐标和底部一样高不就行了」**——按这个思路重做。0.2.9/0.2.10/0.2.11 三次都在「另造一套宽度」：换测量源、换 CSS 变量、换定位基准，结果始终差一截。0.2.12 不再造第二套：贴底模式下 wrap **仍在 composer 槽内**、宽度仍是 `100%`、内层 `.dsh-music-bar` 仍是 `width:100% + max-width + margin:auto`（与顶部逐字符相同的那几条规则），唯一的变化是整块 `transform: translateY(var(--smp-shift))` 平移到窗口底边。宽度由 composer 槽决定 → 输入框拖宽自动跟随、与顶部同宽同边。
- `--smp-shift` 由组件 effect 计算：`视口底 − wrap 自然底边`（用「读回上次写下的变量值」反推自然底边，平移生效后不会累积漂移），轮询 500ms + resize 跟随，统计栏/输入框高度变化时自动重新贴底。
- `height: 46px` + `margin-bottom: -46px` 成对抵消：贴底模式不会在输入框上方多留一块空白。
- 版本：`package.json` 与 `lib/client.js` 的 `VERSION` 同步到 0.2.12，`SMP_BUILD` 更新为 2026-11-20 12:45。

## 0.2.11 (2026-11-20) — 贴底条与上方条同源同宽（宽度不再靠猜）

- **「页面底部」胶囊宽度仍然不等于输入框**（用户第五次反馈，原话：「输入框的宽度是可以拖动的，你参考输入框顶部时候胶囊的代码不行吗，只不过他们两者的上下位置不一样」）。0.2.9/0.2.10 两次都在换着法儿「量出一个宽度」（座位 1014 / 卡片 1326 / 子树最宽者），结果不是窄 312px 就是随窗口抖动。这次改成**单一宽度来源**：条自身 `position: fixed; left:0; right:0; bottom:0; margin:0 auto; width: var(--smp-bar-w)`，`--smp-bar-w` 由 `useColumnMetrics` 测到的输入框卡片宽写入；外壳 `.dsh-music-bar-wrap.bottom` 只负责层级与点击穿透，不再参与宽度。输入框可以拖动调宽 → 每 1 秒重测一次自动跟随，纵向位置仍贴窗口底（与「输入框上方」只差上下位置，宽度域左右边界齐平）。
- 兜底：测量尚未就绪的首帧退化为 `width:100%`，另加 `max-width: calc(100% - clearance*2)` 保证任何窗口宽度下都不溢出。
- 版本：`package.json` 与 `lib/client.js` 的 `VERSION` 同步到 0.2.11，`SMP_BUILD` 更新为 2026-11-20 10:48。

## 0.2.10 (2026-11-20) — 底部宽度与上方逐像素一致 + 人名零遮挡

- **「页面底部」胶囊仍然比「输入框上方」短一截**（用户第四次反馈）：0.2.9 改用 `[data-composer-seat]` 实测值当内联 `left/width`，但该座位实测就是 1014px（= 会话列），真正的输入框卡片是 1326px 且**溢出座位**，钉死实测值只会继续窄 312px。现在贴底模式**不再写任何内联 left/width**，交给 CSS：`.dsh-music-bar-wrap.bottom` 为 `left:0; right:0`，内层 `.dsh-music-bar` 沿用与上方条完全相同的 `width:100%; max-width: var(--dsh-composer-card-max-width); margin:0 auto`。两条走同一套约束 → 逐像素同宽，输入框宽度一变自动跟随。
- **歌名/歌手被署名挤掉、看不见**（用户：「歌词名称怎么被挡住了」）：`.dsh-music-bar-name` 这一个 span 里塞了音符 + 歌名 + 歌手 + 各类徽标 + 章节 + 署名，而它带 `max-width:30%` + `overflow:hidden`。署名一变完整就把歌名推出可视区。现在歌名、歌手、徽标、章节、署名全部升为 `.dsh-music-bar` 的同级 flex 项，各自完整显示；名称容器去掉 overflow/ellipsis（超长歌名由内层 `.name-text` 收）。
- **歌手名不再被省略号截断**：`.dsh-music-bar-artist` 去掉 `overflow:hidden` + `text-overflow:ellipsis`，改 `flex: 0 0 auto` 按内容全宽；作词 / 作曲 / 编曲一项不少、一个人名都不省。
- **歌词紧跟署名之后**：`.dsh-music-bar-lyric` 由居中改为左对齐（频谱仍紧接署名，歌词紧随频谱），不再把文字推到条形中间。
- 版本：`package.json` 与 `lib/client.js` 的 `VERSION` 同步到 0.2.10，`SMP_BUILD` 更新为 2026-11-20 10:35。

## 0.2.9 (2026-11-20) — 底部胶囊宽度对齐 + 署名完整显示

- **「页面底部」胶囊比「输入框上方」短一截**（用户连说三遍的问题）：贴底条的 `left/width` 取自 `[data-composer-seat].parentElement`（会话列，实测 1014px），而上方条跟着输入框卡片走（实测 1324px），两者差 300 多像素。现在 `useColumnMetrics` 直接量「输入框底座」`[data-composer-seat]` 自身，并在该来源下把外壳左右 padding 归零（外框宽已等于输入框宽，再叠 32px 内缩就又窄了）；CSS 侧给 `.dsh-music-bar-wrap.bottom` 补 `right: 0`，即使测量缺失也不会退化成「内容撑开的窄条」。
- **署名行只显示到「编曲 臧…」**（用户：「要把人的名称显示完整不要出现 。。。」）：`.dsh-music-bar-credits` 旧版 `max-width: 190px` + `text-overflow: ellipsis` 必然截断。现在改为按内容全宽、不收缩不裁切（`flex: 0 0 auto`、`white-space: nowrap`），空间由歌名（上限 36%→30%）与歌手名（120px→96px）让出；作词 / 作曲 / 编曲三项均由歌词首部 credit 行解析，齐全时整行完整显示。
- 版本：`package.json` 与 `lib/client.js` 的 `VERSION` 同步到 0.2.9，`SMP_BUILD` 更新为 2026-11-20 10:22。

## 0.2.8 (2026-11-20) — 播放链路三处修复 + 停止改为暂停保留位置

- **面板/胶囊播完不自动下一首**（用户实测：不管哪种播放模式都停住不动）：面板模式组件既不绑 `<audio>` 事件、也不注册控制面，`SMP_STORE` 的 `ended` 旧版只把 `playing` 置 false，播完无人推进。现在 `ended` 在无组件接管（`ctl === null`）时按 `loopMode` 三态自行推进（单曲重播 / 随机下一首 / 顺序播到末尾停）；组件在树里时仍由组件 `onEnded` 处理，避免双触发跳两首。
- **QQ 曲点歌后播放失败、点播放没声音、误报「格式不支持或文件不可读」**：面板 body 的换源 effect 旧版没有面板模式早退，会用 `mediaUrl(scope, snap.path)`（QQ 曲的 `path` 是中文歌名 → 404）覆盖掉 store 刚设好的 `/qq/play/<mid>` 代理流。现在面板模式不再改源（store 是唯一权威）；错误监听也以 store 状态判定是否 QQ 曲，不再把它误报成本地文件格式问题。
- **胶囊迷你频谱上方的浅白糊块**（用户：「第二张图的背面有白色的东西」）：`drawSpectrum` 空闲态的「待播放」文案在 60×20 的小画布上放不下，被裁到画布顶端糊成一排浅灰白块。现在只在 ≥120×44 的画布上绘制该文案，小画布只留玻璃底与能量基线。
- **停止按钮改为暂停并保留位置**（用户：「点击这个暂停按钮歌曲会重头播放，要接着播」）：`SMP_STORE.stop()` 不再把 `currentTime` 归零，改为暂停并把当前位置写回快照，再点播放即续播；胶囊条与侧边栏面板该按钮 `title` 由「停止」改为「暂停」。
- 版本：`package.json` 与 `lib/client.js` 的 `VERSION` 同步到 0.2.8，`SMP_BUILD` 更新为 2026-11-20 10:12。

## 0.2.7 (2026-11-18) — 效果图更新 + 官方规范合规修订

- **效果图更新**：README 中英双版截图段与 `screenshots.json` 换成新的三张实机图（侧边栏播放器面板整体界面 / 胶囊播放条落在输入框上方 / 面板另一状态）；过时旧图（视频字幕面板、音频歌词频谱）已移除。
- **市场条目**：首次提交到 awesome-dsh-plugin 市场（`data/plugins/loyalchiiina__dsh-sidebar-media-player.yml`），描述与本 README 的功能口径逐条对齐。
- **安装口径**：README 安装段改为官方方式（插件市场 / 宿主 `plugin_manager` 的 `install_bundle`）；桌面端 `desktop` profile 由 Electron 独占，保留手动挂载流程并明确标注为绕行方案。
- **资源可清理**（官方规范）：客户端注入的两处 `<style>`（唱盘样式、歌词动效样式）登记到全局表，并在 `ctx.effect` disposer 里移除；同页音频仲裁的 800ms 轮询定时器补停止入口，停用 / HMR 时不再泄漏。
- **诊断路由默认关闭**：宿主 `/dsh-sidebar-media-player/diag` 写盘路由改为需环境变量 `DSH_SMP_DIAG=1` 才开启，发布包不再留常开的写盘后门。
- **manifest**：`dsh.client.immediately` 补齐（对齐官方模板）。
- 版本：`package.json` 与 `lib/client.js` 的 `VERSION` 同步到 0.2.7。

## 0.2.6 (2026-11-18) — 多轮返修收口 + 默认外观定稿

> 更正：0.2.5 条目里写的「修正 lib/client.js 的 VERSION」当版并未真正落地（0.2.5 包里仍是 0.2.0），实际在 0.2.6 完成。历史条目不回改。

- **免责申明**：README 中英双版新增免责段——本插件为第三方爱好者工具，非 QQ 音乐官方产品、与腾讯无隶属关系；仅用于播放用户自己账号的 QQ 音乐列表，不支持也不参与任何官方活动；内容版权归腾讯 / QQ 音乐；收到侵权通知即删库（含 npm 包与 Release）。
- **来源声明**：README 中英双版新增「来源与致谢」段——胶囊播放条的 UI 设计与落位方式、QQ 音乐接口层（`lib/qq.js` / `lib/qrc.js`）照抄第三方原作者（上游 MIT，`dsh-music-player v1.0.4`，kendu76）；把播放器整体搬进侧边栏、胶囊按钮、界面改造与主要功能为本人设计与实现。
- **默认外观定稿**：胶囊在输入框上方、列表 10 列、歌词炫彩、顺序播放、频谱开、两句歌词、柱状。新增一次性迁移（localStorage `smp.appearanceRev2`）让老存档也落到默认值，之后手动设置不再被覆盖。
- **胶囊位置三态**：输入框上方 / 页面底部 / 隐藏（隐藏 = 完全不渲染胶囊条，侧边栏面板顶部播放器不受影响）。
- **面板页签行**：新增「隐藏列表」按钮（只留上方播放器）；点页签自动展开列表；`⟲` 刷新 QQ 数据（不重载页面、不中断播放）；`⟳` 检查更新。
- **控件行统一**：原「系统配置」独立页下线，设置项并入控件行 18 枚同风格按钮（收藏 / 上一首 / 播放暂停 / 下一首 / 停止 / 音量 / 倍速 / 循环 / 频谱开关 / 频谱样式 / 字幕 / 歌词 / 歌词模式 / 歌词动效 / 胶囊位置 / 列数 / 精简条 / 下载），单行不折行。
- **本地音乐可拖动 seek**：音频项改走整文件 Blob（视频与 >250MB 大文件仍走 `/media` 直链），修复「本地曲不能快进拖动」；seek 另加 300ms 复核重试。
- **收藏与 QQ 音乐「我喜欢」同源**：胶囊 / 面板 / 卡片三处读写同一集合（宿主 `GET /qq/liked`、`POST /qq/fav`），不再是本地假标记。
- **播放 / 切歌 / 循环三态**：单曲循环与随机播放对手动「下一首」同样生效；胶囊与面板按钮统一走 `SMP_STORE`，一一对应。
- **倍速**：QQ 曲不再假禁用（去 `not-allowed` / `opacity` 锁），选择后无条件写回 `audioEl().playbackRate` 并同步 store。
- **歌词**：5 档动效真正落到面板与胶囊（此前只有 slide 生效）；两句 / 歌词板切换；无歌词时有兜底文案不再空白。
- **界面**：QQ 卡片封面 1:1 `contain` 自适应、无封面统一用唱片图标占位、翻页与「播放全部」同行、320px 窄宽不折行不横滚。
- **移除**：自动弹 QQ 音乐网页版「看广告」整条链路（客户端 effect / 免费时长卡片 / 宿主 `/qq/free/open` 路由与 `findBrowserExecutable()`）。
- 文档：README 重写为中英双语并覆盖当前全部能力与默认值；`lib/client.js` 的 `VERSION` 同步到 0.2.6。

## 0.2.5 (2026-11-13)

- 状态标注：README、package.json description 与 locale/*.json 的 meta.description 明确写出「当前 0.2.x 版本 bug 较多，正在重做中」，避免用户误以为这是稳定版。
- 修正 lib/client.js 的 VERSION（此前一直停在 0.2.0，与 package.json 不一致）。
- 补 icon.svg + exports 的 ./icon 与 ./locale/*.json + files 收录，符合官方 dsh-doc 图标与 locale 规范。
- 功能代码未改动，已知缺陷仍在。

## 0.2.4 (2026-11-12) — 播放器页签行新增 ⟳ 检查更新

- 播放器面板页签行（本地库 / 系统配置 …）右侧新增 ⟳：查 npm 最新版 → 有新版变蓝「更新到 vX」→ 再点一键安装到 desktop profile。
- 复用技能浏览器的全局更新委托（window.__dshUpdClick）。
- 纯客户端改动：Ctrl+Shift+R 硬刷新生效。

## 0.2.3
- 修复「启动正常但侧边栏功能失效」：上一版用 setInterval 轮询后重入 apply，而 apply 已经在 fiber 激活完成后才调用，注册被静默吞掉。现改用 cordis 官方响应式注入 ctx.inject(["betterSidebar"], cb)，服务就绪时自行执行注册。

## 0.2.2
- 启动稳定性：服务从 declared inject 移除（避免 pending 卡住 web boot），改为安全取值器 __safeSvc 加最多 30s 轮询。

## 0.2.1
- 修复启动崩溃：client half 把 `betterSidebar` 写成硬依赖 `inject = ["betterSidebar"]`，
  better-sidebar 升级到 0.31.1 后宿主侧服务未就绪，client-module loader 让本 entry
  永久停在 loading，整个 web boot 报「1 entry did not activate」→ renderer recovery
  循环（2026-11-12 12:00 崩溃实录）。改为软依赖，服务不在时静默跳过，不再拖住启动。

所有值得注意的变更都会记录在此文件。

## 0.2.0 — 2026-11-10（改名版本）

- **插件全链路改名**：`dsh-media-player` → `dsh-sidebar-media-player`。npm 包名、GitHub 仓库 slug、宿主路由前缀（`/dsh-sidebar-media-player/media|lyric|subtitle`）、client bundle id、localStorage 偏好 key、profile 挂载项（deps + bundles + junction）一并变更。
- **历史版本保留旧名**：0.1.1 / 0.1.2 仍以 `dsh-media-player` 名义发布，内容不变；旧包名将在 npm 上 deprecate 指向 `dsh-sidebar-media-player`。
- 升级方式：卸载旧包名 → 安装 `dsh-sidebar-media-player`（本地 profile 挂载同理改 `dependencies` 与 `dsh.profile.bundles`）。
## 0.1.2 — 2026-11-09

- 截图更新：换为两张真实界面效果图（视频+字幕设置面板、音频+歌词+频谱+音准），移除旧图。
- 无功能变更，仅发布素材更新。

## 0.1.1 — 2026-11-09

首个正式发布版本（首发）。

### 功能

- 侧边栏统一音视频播放器（接管 dsh-better-sidebar 的文件预览）
- 支持 mp4/webm/mov/m4v/ogv 视频与 mp3/wav/flac/ogg/opus/m4a/aac 音频
- 拖动进度条（HTTP Range 206 流式），含 Blob 救援修复「桌面端 content-length 被剥离导致时长未知、进度条不可拖」（音频与视频统一生效，>300MB 不整文件入内存）
- 实时频谱柱 + 音准（Hz + 音名）
- 视频字幕：自动加载同目录同名 `.srt/.vtt/.ass`（服务端转 VTT），自绘字幕层，支持开关 / 字号 4 档 / 位置 3 档（设置本地记忆）
- 音频歌词：自动加载同目录同名 `.lrc`（含内嵌歌词），滚动高亮，支持开关
- 修复图标尺寸 bug（图标函数被当组件调用导致 SVG 撑到 300×150 并遮挡进度条）
