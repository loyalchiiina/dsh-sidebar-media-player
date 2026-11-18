# 侧边栏多媒体播放器（dsh-sidebar-media-player）

侧边栏统一音视频播放器，作为 `dsh-better-sidebar` 的配套插件：一个 viewer 同时接管视频与音频预览，并提供独立的**播放器面板**（QQ 音乐在线曲库 + 本地音乐库）、一条可三态摆放的**胶囊播放条**，以及实时频谱 / 音准 / 歌词 / 字幕等播放态增强。

**适配 DSH 内核 0.2.2-rc.1；当前版本 0.2.6。**

> 0.2.6 起，此前记录的已知缺陷（进度条拖不动、切歌/收藏/倍速失效、歌词动效不生效、胶囊位置切换后消失等）已逐项修复；发布前对默认值、源码改动与打包清单做过机器断言核验（校验脚本随源码改动在开发环境执行，未纳入发布包）。仍建议先小范围试用再依赖。

- 版本：0.2.6
- 依赖：`dsh-better-sidebar`（提供 `ctx.betterSidebar` 文件查看器注册服务；缺失时插件自动降级，不影响 DSH 启动）

## 功能

### 1. 侧边栏统一音视频播放器

- **视频**：mp4 / webm / mov / m4v / ogv；**音频**：mp3 / wav / flac / ogg / opus / m4a / aac。
- **字幕**：自动加载同目录同名 `.srt / .vtt / .ass`（宿主统一转 VTT），自绘字幕层，支持开关 / 字号 4 档 / 位置 3 档，设置本地记忆。
- **拖动进度条**：自建 Range(206) 流式路由；桌面端 `content-length` 被剥离时用整文件 Blob 兜底，保证时长与 seek 可用。
- **不支持的编码**（wma / ape / ncm / qmc 等）给出中文提示，而不是静默无声。

### 2. 侧边栏播放器面板（两个页签：QQ音乐 / 本地音乐）

- **顶部播放器区**：唱盘 + 歌名、歌词区（两句 / 歌词板）、实时频谱（柱状 / 波形）、音准读数（Hz + 音名）、进度条、控件行。
- **页签行**：`QQ音乐` / `本地音乐` 两个页签（点页签自动展开列表）+ `隐藏列表`（只留上方播放器）+ `⟲` 刷新 QQ 数据（不重载页面、不中断播放）+ `⟳` 检查更新。
- **控件行（18 枚同风格按钮，单行不折行）**：收藏、上一首、播放/暂停、下一首、停止、音量、倍速 0.5–2、循环（顺序 → 单曲 → 随机）、频谱开关、频谱样式（柱状/波形）、字幕、歌词开关、歌词模式（两句/歌词板）、歌词动效（无/上滑/模糊/卡拉OK/炫彩 5 档）、胶囊位置（上/下/隐藏）、列表列数（6–10）、精简播放条、下载原文件。
- 原「系统配置」独立页已并入控件行，不再有单独的设置页。

### 3. 本地音乐库

- 递归扫描目录（音乐库根 + 扫描深度），支持「重新扫描」「选目录」、播放全部、点行播放。
- 音频项走**整文件 Blob** 读取 → 时长与 seek 完整可靠（这是本地曲能拖动快进的关键）；**视频**与 >250MB 大文件仍走 `/media` 直链，避免占内存。
- 无封面的歌单/条目统一用**唱片图标**占位；列表行内也带一枚小唱片标记。

### 4. QQ 音乐在线曲库

- 搜索、榜单、歌单（含「我喜欢」）、新歌速递；卡片封面 1:1 `contain` 自适应、VIP 左上角标、播放键右下小圆。
- **收藏与 QQ 音乐「我喜欢」同源**：胶囊 ♥、面板 ♥、卡片 ♥ 三处读写同一个集合（宿主 `GET /qq/liked` 读、`POST /qq/fav` 写），不是插件自建的本地标记。
- 歌词（含逐字歌词回落）、MV 同源反代（透传 Range/206）。
- 卡片列数 6–10 可调；「翻页」与「播放全部」同一行，列表区不被页脚占用。

### 5. 胶囊播放条

- **三种位置**：输入框上方（默认）/ 页面底部 / 隐藏。选「隐藏」则完全不渲染胶囊条（侧边栏面板顶部的播放器不受影响）。
- **精简播放条**：可切换成只留音符 + 歌名的一行（与「隐藏」是两件事）。
- 条上按钮与面板控件**一一对应、同一控制源**（`SMP_STORE`）：收藏、上一首、播放/暂停、下一首、停止、音量、播放列表。
- 音量竖条可上下拖动；歌词单行显示并跟随 5 档动效；点歌名可展开/收起。

## 默认值（0.2.6 起定稿）

| 项 | 默认值 |
|---|---|
| 胶囊位置 | 输入框上方（dock） |
| QQ 卡片列数 | 10 列 |
| 歌词动效 | 炫彩（rainbow） |
| 循环模式 | 顺序播放 |
| 频谱 | 打开，柱状 |
| 歌词模式 | 两句（duo） |

升级到 0.2.6 时会做一次**一次性迁移**（localStorage 标记 `smp.appearanceRev2`），把上述外观项拉到默认值；之后手动改过的设置完全保留，不再被覆盖。

## 安装

```bash
dsh plugin add dsh-sidebar-media-player
```

> 桌面端 `desktop` profile 由 Electron 独占管理（`dsh plugin --profile desktop add` 会被 CLI 直接拒绝），需走「真实副本 + 只加 bundles」的方式手动挂载：
>
> 1. 备份 `~/.dsh/profiles/desktop/package.json` 与 `cordis.patch.yml`；
> 2. 把插件真实副本放到 `local-plugins/` 下并加入 profile 的 `dependencies` 与 `dsh.profile.bundles`；
> 3. **彻底退出 DSH 客户端再启动**（宿主是 Node 进程，没有热重载）。

## 生效方式

| 改了什么 | 怎么生效 |
|---|---|
| `lib/client.js`（客户端 bundle） | `Ctrl+Shift+R` 硬刷新；没变化就彻底退出 DSH 再启动 |
| `lib/index.js`（宿主端）/ `package.json` / `cordis.patch.yml` | 彻底退出 DSH 客户端再启动 |
| 面板底部构建戳（`构建 YYYY-MM-DD HH:mm`） | 用来判断是否加载到新 bundle |

## 截图

![视频 + 字幕（字幕设置面板）](docs/screenshots/01-video-subtitle.png)

![音频 + 歌词 + 频谱 + 音准](docs/screenshots/02-audio-lyric.png)

## 已知限制

- QQ 音乐的付费 / VIP 曲目受登录账号权限限制；无版权或下架曲目无法播放。
- 浏览器原生不支持的编码（wma / ape / ncm / qmc）只能提示，不能解码。
- 无歌词 / 无时间轴的曲目显示「无歌词」；逐字歌词缺失时回落到整行歌词。
- 本地音乐的 seek 依赖整文件 Blob，超大文件（>250MB）走直链时依赖浏览器 Range 缓冲进度。

## 文件结构

```
dsh-sidebar-media-player/
├── package.json        # name/version/type/main/exports/dsh.bundle/dsh.client
├── cordis.patch.yml    # insert 1 条 entry（id=name=dsh-sidebar-media-player）
├── lib/index.js        # host：Range(206) 媒体路由 / 曲库扫描 / 歌词字幕 / QQ 音乐代理
├── lib/client.js       # client：__ModuleLoader__ bundle（viewer + 面板 + 胶囊条）
├── lib/qq.js           # QQ 音乐接口签名与解析
├── lib/qrc.js          # 二维码渲染（QQ 登录扫码）
├── docs/screenshots/   # 真实界面截图
├── screenshots.json    # 插件市场配图清单（纯数组、相对路径）
├── locale/{zh,en}.json # 市场标题与描述
├── icon.svg
├── CHANGELOG.md
├── README.md
└── LICENSE
```

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

---

# dsh-sidebar-media-player (Sidebar Media Player)

A unified audio + video player for `dsh-better-sidebar`. One viewer takes over audio/video preview, and the plugin adds its own **player panel** (QQ Music online library + local library) and a **capsule bar** that can sit in three places, plus live spectrum, pitch readout, lyrics and subtitles.

**Adapts the DSH kernel 0.2.2-rc.1; current version 0.2.6.**

> Since 0.2.6, the previously documented defects (undroppable scrubber, dead next/favourite/rate controls, lyrics effects not applying, capsule disappearing after changing position) have been fixed one by one, each verified with machine assertions and static previews. Trying it on a small scale first is still recommended.

- Version: 0.2.6
- Requires: `dsh-better-sidebar` (provides the `ctx.betterSidebar` viewer registration service; when absent the plugin degrades gracefully and never blocks DSH startup)

## Features

### 1. Unified sidebar audio/video viewer

- **Video**: mp4 / webm / mov / m4v / ogv. **Audio**: mp3 / wav / flac / ogg / opus / m4a / aac.
- **Subtitles**: same-name `.srt / .vtt / .ass` auto-loaded (converted to VTT host-side), custom subtitle layer with on/off, 4 font sizes and 3 positions, remembered locally.
- **Draggable scrubber**: self-hosted Range(206) streaming route; when the desktop shell strips `content-length`, a whole-file Blob rescue keeps duration and seeking working.
- **Unsupported codecs** (wma / ape / ncm / qmc …) produce an explicit message instead of silence.

### 2. Player panel (two tabs: QQ Music / Local Music)

- **Top player area**: turntable + title, lyrics (two-line or lyric board), live spectrum (bars or wave), pitch readout (Hz + note name), scrubber, control row.
- **Tab row**: `QQ音乐` / `Local Music` tabs (clicking a tab auto-expands the list) + `Hide list` (keeps only the top player) + `⟲` refresh QQ data (no page reload, no playback interruption) + `⟳` check for updates.
- **Control row (18 same-style buttons, one line, no wrapping)**: favourite, previous, play/pause, next, stop, volume, playback rate 0.5–2, loop (order → single → shuffle), spectrum on/off, spectrum style (bars/wave), subtitles, lyrics on/off, lyric mode (two-line/board), lyric effect (none/slide/blur/karaoke/rainbow), capsule position (top/bottom/hidden), grid columns (6–10), compact bar, download original file.
- The former standalone "settings" tab has been folded into this control row.

### 3. Local music library

- Recursively scans a directory (root + depth), with rescan, pick-directory, play-all and per-row play.
- Audio items are read as a **whole-file Blob** so duration and seeking are complete and reliable; **video** and files over 250MB still stream from `/media` to keep memory flat.
- Playlists/items without artwork fall back to a **vinyl record icon** (also shown inline in each list row).

### 4. QQ Music online library

- Search, charts, playlists (including "I like"), new songs; 1:1 `contain` artwork, VIP corner badge, small play button.
- **Favourites are shared with QQ Music's own "I like"**: capsule heart, panel heart and card heart all read and write the same remote collection (host `GET /qq/liked` / `POST /qq/fav`), not a local flag.
- Lyrics (with word-by-word fallback), MV proxied same-origin with Range/206 passthrough.
- Grid columns adjustable 6–10; pager sits on the same line as "Play all" so the list never loses a row to the footer.

### 5. Capsule bar

- **Three positions**: above the input box (default) / bottom of the window / hidden. Choosing "hidden" stops rendering the capsule entirely (the panel's top player is unaffected).
- **Compact mode** shrinks it to one line with just a note glyph and the title.
- Every capsule button **maps one-to-one onto a panel control** through the same store (`SMP_STORE`): favourite, previous, play/pause, next, stop, volume, playlist.
- Vertical volume slider is draggable; the single-line lyric follows the same 5 lyric effects.

## Defaults (as of 0.2.6)

| Item | Default |
|---|---|
| Capsule position | Above the input box (dock) |
| QQ grid columns | 10 |
| Lyric effect | Rainbow |
| Loop mode | Sequential |
| Spectrum | On, bars |
| Lyric mode | Two lines (duo) |

Upgrading to 0.2.6 runs a **one-time migration** (localStorage marker `smp.appearanceRev2`) that pulls these appearance settings back to defaults; anything you change afterwards is preserved.

## Install

```bash
dsh plugin add dsh-sidebar-media-player
```

> On desktop the `desktop` profile is managed exclusively by Electron (`dsh plugin --profile desktop add` is rejected by the CLI), so mount it manually: back up `~/.dsh/profiles/desktop/package.json` and `cordis.patch.yml`, place a real copy under `local-plugins/`, wire it into `dependencies` and `dsh.profile.bundles`, then **fully quit and relaunch DSH** (the host is a Node process with no hot reload).

## How changes take effect

| What changed | How to apply |
|---|---|
| `lib/client.js` (client bundle) | `Ctrl+Shift+R` hard refresh; if nothing changes, fully quit and relaunch DSH |
| `lib/index.js` (host) / `package.json` / `cordis.patch.yml` | Fully quit and relaunch DSH |
| Build stamp at the panel bottom (`构建 YYYY-MM-DD HH:mm`) | Tells you whether the new bundle is loaded |

## Screenshots

![Video + subtitles (subtitle settings panel)](docs/screenshots/01-video-subtitle.png)

![Audio + lyrics + spectrum + pitch](docs/screenshots/02-audio-lyric.png)

## Known limitations

- Paid/VIP QQ Music tracks depend on the signed-in account; unavailable or delisted tracks cannot be played.
- Codecs the browser cannot decode (wma / ape / ncm / qmc) can only be reported.
- Tracks without lyrics or timestamps show "no lyrics"; word-by-word lyrics fall back to line lyrics.
- Local seeking relies on a whole-file Blob; for files over 250MB streamed directly, the browser's Range buffering applies.

## Layout

```
dsh-sidebar-media-player/
├── package.json        # name/version/type/main/exports/dsh.bundle/dsh.client
├── cordis.patch.yml    # one insert entry (id=name=dsh-sidebar-media-player)
├── lib/index.js        # host: Range(206) media route / library scan / lyric+subtitle / QQ proxy
├── lib/client.js       # client: __ModuleLoader__ bundle (viewer + panel + capsule bar)
├── lib/qq.js           # QQ Music signing and parsing
├── docs/screenshots/   # real UI screenshots
├── screenshots.json    # marketplace screenshot list (plain array, relative paths)
├── locale/{zh,en}.json # marketplace title and description
├── icon.svg
├── CHANGELOG.md
├── README.md
└── LICENSE
```

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
