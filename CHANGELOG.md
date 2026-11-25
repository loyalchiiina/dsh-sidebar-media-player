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