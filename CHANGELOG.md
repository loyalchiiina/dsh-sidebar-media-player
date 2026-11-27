## 1.0.7 — 2026-11-27

**适配内核 `0.2.3-alpha.2`（本机官方实测，最低 0.2.2-rc.1）· 插件 `1.0.7`**

按用户两轮口径修掉胶囊条展开时的挤压：第一轮「当胶囊弹出播放切歌等按键的时候歌词会出现被挤压成很丑的样子」，第二轮澄清「按钮弹出的时候把作词作曲人隐藏、整体左移，歌词可以显示出来；按钮隐藏时恢复」。最终实现 = 展开态只让署名退场，把宽度让给歌词。

- **根因**：`.dsh-music-bar-controls.on .dsh-music-bar-btns` 展开到 `max-width: 460px`，而歌词是 `flex: 1 1 0`（行内唯一可压缩项）、署名 `flex: 0 0 auto` 按内容全宽不缩，460px 全从歌词身上扣。实测条宽 828px：收起态歌词 315px；展开态只剩 31px（内容溢出 83px），「崖壁藏着未说的文」被裁成一两个字竖着堆。
- **修法（纯 CSS + 复用已有状态，零新增订阅）**：条本体加 `btns-on` 类（`lib/client.js:8570`，条件 `active && !isFloat`，`active = hovered || volOpen`）；展开态规则（`lib/client.js:6630`）把 `.dsh-music-bar-credits` 的 `max-width` 与 `margin-left` 收到 0 —— 不是只透明，而是把它从 flex 流里撤走，省出的宽度自动归 `flex:1` 的歌词，频谱与歌词一起左移。
- **不藏歌词**：用户第二轮明确要「歌词可以显示出来」。歌词是这一行最该留下的内容，空间腾出来后（291px > 8 字 × 14px）它本就完整可见。
- **为什么用 max-width 过渡不用 display:none**：display 没有过渡，署名与它后面的元素会瞬跳；`max-width: 100%`（`lib/client.js:6594`）给基础规则一个可动画的起点，且不会裁掉超长署名。
- **不给署名设固定像素上限**：用 `max-width: 100%` 而不是 `360px`，否则长署名会被裁，违反 0.2.9 的历史要求「人名必须完整显示、不要出现 …」。
- **float 形态排除**：`isFloat` 时歌词独占一行（`lib/client.js:6464-6466`）不参与挤压，加类反而白藏，故条件带 `!isFloat`。
- **验证**：`node --check` 通过、无 BOM；离线 harness（真实 CSS 66824 B 抽取 + 真实 DOM 复刻 + Edge headless）量四态 —— 收起：lyricW=315 / overflow=0 / credits 254px@0.72；展开前：lyricW=31 / overflow=83（复现 bug）；展开后：lyricW=291 / overflow=0 / creditsW=0（修好，歌词完整可见）。四态前后对照图在本地开发环境出图核对（不入库、不随包发布）。

## 1.0.6 — 2026-11-26

按用户要求去掉图标上的斜杠（"改一下logo不用带反斜杠了"）：两枚开关只保留「绿钻」「VIP」字样本身。

- **斜杠整条删除**：`SMP_GLYPHS.labelVip` / `labelGreen` 去掉 `slash` 字段，`SmpGlyph` 的文字型分支只渲染一个 `<text>`，不再画 `<path>`。开关状态改由按钮底/边/亮度表达（`monoSw` 的 on 三件套：不透明度 1 vs 0.45、14% 灰底、45% 灰边），图标本身是纯字形。
- **好处（实测）**：去掉斜杠后字号不再被斜杠挤压，9.4 号字在 20px 画布里「绿钻」实测 `getBBox` 20.19×12、「VIP」16.46×12（之前斜杠压字时字身只有约 9px 高），26px 按钮里两个字的轮廓第一次完整可辨。
- **删掉悬空常量**：`VIP_SKIP_RED`（1.0.2 引入的红色语义色）已无任何引用，随"纯灰阶"改造一并删除并留注释说明去向 —— 避免以后改配色时误以为它还在生效。
- **验证**：`node --check` SYNTAX_OK；Playwright 复刻真实主控行渲染 5 种状态（浅/深 × 三种勾选组合），18 枚按钮全部 26×26、单行不折行、`overflowX = 0`；桩环境 `probe-apply.cjs` 实跑 `APPLY_OK`；无 BOM。

## 1.0.5 — 2026-11-26

按用户拍板收口：图标定稿 **D2**（"D2可以"），绿钻开关语义按实测事实纠偏，删掉面板上的红按钮（"这个 vip 跳过的删掉"）。

- **图标换成 D2**：主控行两枚开关改为「裸文字 + 一条 45° 斜杠贯穿」——`labelGreen`（画「绿钻」）、`labelVip`（画「VIP」），纯灰阶（`filter: grayscale(1)` + TEXT/BORDER 令牌），不出现任何品牌色/红绿块。文字用 `fill` 而不是 `stroke`：15px 描边字在两字并排时糊成一团（T1/T2/T3 三轮实测结论）。
- **D2 落地时又纠了一处尺寸错**：最初照候选图写成 8.4 号字 + 斜杠从左下贯到右上（`M2.6 17.4L17.4 2.6`），实测在 26px 按钮里 `text.getBBox` 仅约 9px 高、斜杠正好横穿字身，主控行上看不清字。改为 **9.4 号字 + 斜杠只切右上角（`M8.2 19.4L19.4 8.2`）+ 图标绘制尺寸 20px**（按钮 26px 留 3px 内边）。判定方法：plyawright 渲染真实 26×26 按钮，量 `text.getBBox` 换算成 CSS 像素，再放大 6 倍肉眼确认字形。
- **顺序按用户拍板**：「绿钻反斜杠在前、VIP 反斜杠在后」→ `controls` 数组改为 `…, colsBtn, greenBtn, vipSkipBtn, miniBtn]`。
- **绿钻语义纠正（实测驱动）**：原 1.0.3 的「绿钻曲只播试听 N 秒，到点自动下一首」**整段删除**。实测依据：抽样 313 首（VIP 184 / 绿钻 75 / 免费 54），逐曲取直链 —— 免费 9/10 可播、**绿钻 10/10 可播**、**VIP 0/6 可播**；对 4 首绿钻曲拉真实字节流，均为 `HTTP 206` + 完整曲（4.97/4.44/5.05/2.62 MB MP3，文件头 `49443303`=ID3），`paydownload` 只锁下载、不锁在线播放。用户试听确认："带试听的可以听完整的"。强行跳绿钻会误杀 75/313 首本来能听的歌，与"我要听完整"的原意相反。
- **绿钻开关新语义**：`trialOnly` → `greenOnly`。勾它就是「只听完全免费的」，并**自动把 VIP 跳过一起勾上**（用户原话："勾选这个自动勾选上跳过vip"）；取消只关自己，不反手关 VIP。
- **删除死代码**：`SMP_TRIAL_TIMER` 句柄、`SMP_TRIAL_FIRED`、`SMP_TRIAL_STATE`、`smpTrialTick`、`smpCurrentTrialState`、`smpTrialOnlyOn`、`smpItemTrySec`、`SMP_TRIAL_DEFAULT_SEC`、`qqSongTrySec`、`apply` 里的 250ms 轮询与对应 disposer —— 一条常驻 interval 和一处挂载失败风险源一并消失。
- **删掉 QQ 面板工具条的红底按钮**：`VIP✕ 跳过 ·开/关` 那个 `dsh-music-settings-btn ghost on`（同步数据之后）整段移除，开关只剩主控行一处入口。
- **卡片角标缩位**：用户截图反馈角标压在人脸上 → 字号 0.76em→0.62em、内边距 0.34em→0.26em、边距 0.34em→0.22em，加 1px 暗影保证浅色封面可辨。绿钻角标文案固定「试听」（与 QQ 官方列表一致）、标题写明「可完整播放（仅下载与无损音质需绿钻）」，不再出现"只放试听段"这类与实测相反的说法。
- **顺带修掉一处重复声明**：`var miniOn = !!(panelSnap && panelSnap.barHidden);` 在同一处写了两遍（1.0.3 引入），已删除多余那行。
- **验证**：`node --check` SYNTAX_OK；桩环境 `probe-apply.cjs` 实跑 `APPLY_OK`（无 `ReferenceError`）、3 个 disposer 拆除 `DISPOSE_OK`；无 BOM。

## 1.0.4 — 2026-11-26

紧急修复：1.0.3 会让**整个插件客户端挂载失败**，播放条与侧栏面板一起消失（用户实测反馈："按钮消失了你确定重载就行吗"）。

- **根因**：`var SMP_TRIAL_TIMER = null;` 声明在 `var SMP_STORE = (function () {` … `})();` 这个 IIFE **内部**，而宿主调用的 `apply(ctx)` 在 IIFE **外面**。IIFE 内部的 `var` 不对外可见，`apply` 里的 `clearInterval(SMP_TRIAL_TIMER)` / `if (!SMP_TRIAL_TIMER)` 直接抛 `ReferenceError: SMP_TRIAL_TIMER is not defined`。`apply` 一抛异常，客户端插件就没注册成功 —— 表现是播放条、侧栏面板、两枚开关**全部消失**，不是按钮单独不显示。日志原文（`~/.dsh/logs/desktop-next.log`）：`ReferenceError: SMP_TRIAL_TIMER is not defined at new apply (...) entry: dsh-sidebar-media-player`。
- **修复**：把声明提到 IIFE 之后（模块作用域，`})();` 下一行），`apply` 与 IIFE 内的逻辑都能访问到同一个句柄；IIFE 内原位置删掉声明并留注释说明，避免以后有人再搬回去。
- **验证**：①`node --check` SYNTAX_OK；②机器核验声明行在 IIFE 结束行之后、`apply` 定义行之前；③桩环境实跑客户端 bundle（`window.__ModuleLoader__.load` → `factory(require)` → `apply(ctx)`），结果 `APPLY_OK apply() 无异常`，修前同一桩件会抛 `ReferenceError`。
- **教训**：跨 IIFE 边界的共享句柄一律放模块作用域。客户端 bundle 的任何一处顶层求值/`apply` 异常都会静默吞掉整个插件，日志只有一行 `ReferenceError`，前端表现却是"按钮不动了"——排查时必须先看 host 日志，不能靠猜"缓存没刷新"。

## 1.0.3 — 2026-11-26

调整：VIP 开关按用户两次指正重做位置与形态（"我是让你把按钮弄到这不是弄到那里" / "这个按钮不好看，一个反斜杠禁用vip就行了，此外按钮要放在后面的一排中，黑白色要求" / "然后默认是跳过vip"）；并新增绿钻曲试听开关（"为一些人没有绿钻的人准备，能够享受不听只能听一点的绿钻歌曲"）

- **位置**：从「收藏之后、音量之前」移到主控行**后半段图标组末尾**（倍速 / 循环 / 可视化 / ✨ / 🌊 / ▤ 之后、精简之前），就是用户说的"后面的一排"。
- **形态**：废弃 VIP 票框 + 红 ✕。改为**一条 45° 反斜杠**压住图形 —— 国际通用的「禁止 / 不可用」符号，`SMP_GLYPHS` 新增两枚：`noVip`（圆环被斜杠划掉 = 整首禁播）、`noFull`（播放三角被斜杠截断 = 只听一小段）。
- **配色**：严格黑白灰单色。只用 `--dsw-alias-label-primary` / `--dsw-alias-border-l2` 两个令牌 + `filter: grayscale(1)` 兜底，关 = 压暗 45% 无底，开 = 正常亮度 + 14% 灰底，**不再出现红/绿/品牌色**。深浅两套主题共用同一套令牌，不写死 hex、不用 `!important`。
- **默认值**：`skipVip` 由 `false` 改为 **`true`**（用户要求「默认是跳过 vip」）。老存档迁移：`readPrefs()` 加一次性标记 `skipVipDefaultMigrated`，把从未手动改过的老存档抬到新默认；用户主动拨过的落 `skipVipSetByUser` 永久尊重，**不会**被启动重置（`setPref` 里顺手打两个标记）。
- **新增**：绿钻曲「只播试听」开关 `trialOnly`（默认关）。绿钻判定 `smpItemIsGreenDiamond()` / `qqSongIsGreen()`：VIP 曲，或 `pay.paydownload === 1`、`pay.pay_play === 2`、`pay.pay_play_rt === 1`。试听秒数 `smpItemTrySec()` / `qqSongTrySec()` 依次取 `trySec` → `pay.pay_play_time` → `pay.pay_play_time3` → `pay.try_play_time.duration`，全缺按 30 秒，上限 600 秒防脏数据。
- **试听截止**：`smpTrialTick()` 由 `apply` 里的 250ms 轮询驱动（`document.hidden` 整轮跳过，非试听曲内部早退，开销可忽略），到点 `pause()` + toast「绿钻曲试听 N 秒已到，跳到下一首」+ 复用 `smpAdvanceOnEnded()`，所以顺序/单曲/随机三种播放模式的行为与真正播完完全一致。定时器句柄 `SMP_TRIAL_TIMER` 在 `ctx.effect` disposer 里清掉，插件停用不泄漏。
- **永不因"判成绿钻"而拒绝播放**：判错的代价只是少听几十秒，拦截的代价是整首 404 —— 所以一律「先播后说」，起播时 toast 提示会放多久，卡片角标写「试听」。
- `lib/qq.js`：榜单 / 歌单 / 搜索三处映射各补 `trySec` 顶层字段并带出 `pay` 原对象（此前只提 `payplay`，绿钻字段在协议层就丢了）。
- 歌曲卡片角标分两档：VIP 曲 → `VIP` / `VIP✕`；绿钻曲 → `绿钻` / `试听`（品牌色，与 VIP 的警示色区分 —— 蓝 = 缺特权，橙 = 缺版权）。
## 1.0.2 — 2026-11-26

新增：VIP✕ 自动跳过付费曲（用户 2026-11-26 要求「加个开关自动跳过 VIP 歌曲，防止有的账号不是 VIP 或者绿钻不能播放卡顿」）

- 新增偏好键 `skipVip`（默认 **关**：VIP 账号开着反而少听歌，且默认开会让老用户歌单无故少一半）。写入 `PREFS_DEF` 后自动落 localStorage，刷新/重启保持。
- 判定口径收敛为一个函数 `qqSongIsVip()`（`payplay === 1` 或 `pay.payplay/pay.pay_play === 1`），歌曲卡片角标、点歌拦截、跳过逻辑三处同源，不再各写一份。
- 跳过覆盖全部切曲路径：点歌 `playSong`、三个「播放全部」（歌单/榜单/新歌）、「上一首/下一首」`step`/`stepRaw`、播完自动推进 `smpAdvanceOnEnded`（顺序与随机两种模式）、`setList` 起播位。整套队列都是 VIP 时给明确提示，不静默卡住。
- `smpQQStartPlayback` 现在把 `vip` 布尔标记固化到每个播放项上 —— store 层拿不到面板的 song 对象，不固化的话「播完自动连播」照样会一头撞进 404 循环。
- 开关位置按用户指正改为**播放器主控行**（收藏 / 上一首 / 播放 / 下一首 / 停止 之后、音量之前），与倍速、循环、可视化同一排、同一 26px 高度方角风格；初版误放在侧边栏胶囊条上，已撤掉那一枚，避免同一开关出现两个入口。
- 按钮形态 = 「VIP」票框 + 右上角红 ✕（SVG 绘制，走 `--dsw-alias-state-danger-primary` 令牌）：关闭态红字 + 12% 红底（提示「有 VIP 曲会播失败」），开启态红底白字（明确「已开启跳过」）。
- 开关打开后卡片角标 `VIP` → 红字 `VIP✕`，用户能预先看出哪些会被跳过。
- 顺带修一个旧逻辑坑：开了跳过时「下一首」的长度门槛从 `< 2` 放宽到 `< 1`，否则「只剩 1 首可播、其余全 VIP」的队列里下一首会彻底失灵。

## 1.0.1 — 2026-11-26

性能：取消无条件高频轮询（用户 2026-11-26「减少卡顿」）

- `syncAll`（composer 定位条）：500ms 常驻 → 1500ms，且加了变化判据（left/width 没变就不写 CSS 变量），并新增 scroll（capture）监听补触发；`document.hidden` 时整轮跳过。
- `useSeatWidth` / `useColumnMetrics` 的 1000ms `measure()`：`document.hidden` 跳过，新增 `visibilitychange` 回前台立刻补量一次，清理函数同步移除监听。
- 效果：可见时定位/量宽逻辑不再每 500ms 强制一次同步布局；最小化或切到别的程序时这些轮询完全不跑。

# Changelog

## 1.0.0（2026-11-25） · 稳定版

本次把官方端侧边栏 inject 修复、仅胶囊播放按钮触发 QQ 音乐「我喜欢」自动播放、倍速自绘菜单三项改动一起收敛为 1.0.0 稳定版；适配 0.2.2-rc.1 及以上，本机官方 0.2.3-alpha.2 实测。

### 倍速控件改成可读的自绘菜单

- 用户反馈：展开的原生 `<select>` 是系统白底窄条，选项看不清；按钮只显示 `1`，不知道代表速度。
- 修复：按钮直接显示 `1x / 1.25x` 等带 `x` 的速度值；展开改为自绘双列菜单，选项同样带 `x`，令牌底色 + 边框，点击外部自动收起。
- 不再用原生下拉：避免 Windows 原生弹层白底、宽度受 `select` 34px 限制导致文字截断。
- 生效方式：改了客户端 bundle（`lib/client.js`），Junction 私包不走 HMR，**必须彻底退出官方 dsh 客户端再启动**。

## 0.3.7（2026-11-25）

### 严格区分「点播放」与「只打开界面」

- 用户澄清：只有胶囊上的**播放按钮**需要自动打开侧边栏并播放 QQ 音乐「我喜欢」；胶囊「播放列表」按钮、侧栏「+」里的播放器入口只应打开播放器界面，不应触发播放。
- 新出现的偏移：0.3.6 已让一次点击播放生效，但 `mineFirstRev` 只被组件局部 `ref` 去重；侧边栏播放器面板一旦重新挂载，`ref` 归零而 store 里的 rev 还在，导致「打开界面」动作重放上一次的「我喜欢」播放。
- 修复：`mineFirstRev` 改为**模块级一次性消费**（`SMP_HANDLED_MINE_FIRST_REV`），处理过的 rev 不再因面板重挂载而重播；打开类按钮只走 `openQueue` / `sidebarRight.openTab`，不再带任何播放副作用。
- 生效方式：改了客户端 bundle（`lib/client.js`），Junction 私包不走 HMR，**必须彻底退出官方 dsh 客户端再启动**。

## 0.3.6（2026-11-25）

### 官方 dsh 端胶囊失灵：补齐 sidebarRight inject，播放列表一键弹出侧边栏

- 用户现象：NEXT 端胶囊播放可直接进 QQ 音乐「我喜欢」并播放、点胶囊「播放列表」会自动弹出侧边栏播放器；装到官方 dsh 端后两处都失灵，且第一次点播放常无反应、要再点一次。
- 根因 A（侧边栏不弹出）：`exports.inject` 一直是 `[]`，cordis 下裸读 `ctx.sidebarRight` 会抛 `cannot get property "sidebarRight" without inject`；胶囊桥拿不到 `openTab`，只能退化成条上浮层，官方侧边栏播放器页签不被打开。诊断日志证据：`~/.dsh/data/smp-diag.log` 反复出现 `services tabs=none right=none bs=no`。
- 修复 A：照抄 `dsh-deepseek-web-free` 与日程助手 1.1.20 已验证写法，`inject` 声明内核确实提供的 `slots / locale / sidebarRight / sidebarRightTabs / uiConversation` 五个服务；`betterSidebar` 仍走响应式软依赖，不会把官方端 entry 拖成 pending。桥接函数再补 `ctx.get("sidebarRight")` 兜底。
- 根因 B（要点两次播放）：空列表点播放时 `mineFirstRev` 信号在 `loggedIn=false` 分支被提前标记已消费，登录态随后变 true 后 effect 不再处理，必须第二次点击才能进「我喜欢」。
- 修复 B：未登录时不消费 rev，等 `loggedIn` 变 true 后由同一 effect 自动续跑；一次点击即可完成「打开侧边栏播放器 → 切我喜欢 → 加载歌单 → 播第一首」。
- 生效方式：改了客户端 bundle（`lib/client.js`），本插件为 Junction 实装、不走 HMR，**必须彻底退出官方 dsh 客户端再启动**；Ctrl+R / Ctrl+Shift+R 不会重新读盘。

## 0.3.5（2026-11-25）

### 换掉「+」菜单里的方块占位符图标

- 内核契约（asar 内 `SidebarRightGuideEntry` 原文）：
  `icon?: ComponentType<IconProps>` ——
  "Optional glyph, drawn before the title; without one the guide draws its cube placeholder."
  之前没提供 `icon`，所以右侧栏「+」菜单里播放器一直显示方块。
- 修复：guide 条目补 `icon: SmpGuideIcon`，自绘播放器图标（currentColor 跟随主题）。
  不引 `@deepseek-ai/dsh-client-ui-primitives`（官方禁止第三方 require）。
- 生效方式：客户端 bundle 变更 —— 刷新界面（Ctrl+R）。

## 0.3.4（2026-11-25）