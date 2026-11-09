# Changelog

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
