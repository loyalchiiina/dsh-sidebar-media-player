/**
 * dsh-sidebar-media-player — host half.
 *
 * 只干一件事：注册一个带 HTTP Range 的前缀路由
 *
 *   GET/HEAD /dsh-sidebar-media-player/media?sessionId=<id>&path=<abs|rel>&cwd=<可选>
 *        → 200 全量 / 206 分片（Content-Range）/ 416 越界（Content-Range: bytes *\/size）
 *
 * 为什么必须自建路由（不是懒得用现成货，是被逼的）：
 *  - better-sidebar 自带的 `/sidebar/file` 媒体路由把整个文件读进内存、回 plain
 *    200、不带 `Accept-Ranges`，还有 20MB 上限。视频/音频一旦拿不到 206，
 *    浏览器会**直接禁用拖动条** —— 这正是「能放不能拖」的根因。
 *  - 本路由用 `createReadStream` 流式吐字节，完整实现
 *    `bytes=a-b` / `bytes=a-` / `bytes=-N` 三种 Range 形态，并支持 HEAD 探测。
 *
 * 安全姿势（照抄 dsh-video-preview 的成熟实现，逐字对齐语义）：
 *  1) Host 头信任围栏：仅 loopback 或 webRuntime 声明的 trustedHosts；带
 *     `sec-fetch-site: cross-site` 的浏览器跨站请求一律拒；Origin 必须与 Host 同源。
 *  2) 路径围栏：`path` 解析为绝对路径后**必须落在会话 cwd 之下**（大小写/分隔符
 *     容忍），所以构造 `..` 逃逸不出去。
 *  3) 扩展名白名单：只服务音视频扩展名，路由不能被当通用下载器用。
 *
 * 注意：本文件是宿主半边，改动后必须**彻底退出 DSH 客户端再启动**才生效
 * （宿主是 Node 进程，没有热重载）。
 */
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { lstat, readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { Readable } from 'node:stream'
import { basename, dirname, extname, join, parse as parsePath, resolve } from 'node:path'
// 在线 QQ 音乐底层（扫码登录 / 取链 / 歌词）。原样拷入本目录，MIT，来自 dsh-music-player v1.0.4。
import * as QQ from './qq.js'
import { decryptHex as qrcDecryptHex, parseQrc as qrcParse } from './qrc.js'
import { spawn } from 'node:child_process'

/**
 * 找本机 Chromium 系浏览器（Edge 优先，其次 Chrome）。
 * 「免费时长」自动化外壳要靠它开 --app 窗口；找不到返回空串，路由会明确报错。
 */
function findBrowserExecutable() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const cands = [
    join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe')
  ]
  for (const p of cands) {
    try { if (existsSync(p)) return p } catch { /* 忽略单条探测失败 */ }
  }
  return ''
}

/** Plugin identity — 必须与 package.json 的 name 一致，client bundle 靠它对上号。 */
export const name = 'dsh-sidebar-media-player'

/** 挂载前需要就绪的服务：web 服务器 + 会话存储（取权威 cwd）。
 *  webRuntime 不再是硬依赖：trustedHosts 仅用于放行「非 loopback 的 Host」；
 *  桌面端全部走 127.0.0.1（loopback），无 webRuntime 时 trustedHosts 兜底为空数组，
 *  isTrustedApiRequest 仍会放行 loopback，故从 inject 移除该服务，卸载 dsh-web-runtime-shim 后本插件照常挂载。 */
export const inject = ['webServer', 'sessions']

/** 本插件独占的路由前缀（避免与别的插件撞车）。 */
const ROUTE_PREFIX = '/dsh-sidebar-media-player'

/** 媒体端点。 */
const MEDIA_PATH = `${ROUTE_PREFIX}/media`

/** 歌词端点（读同目录同名 .lrc，回 JSON）。 */
const LYRIC_PATH = `${ROUTE_PREFIX}/lyric`

/** 字幕端点（同目录同名 .vtt/.srt/.ass，统一转 VTT 回纯文本）。 */
const SUBTITLE_PATH = `${ROUTE_PREFIX}/subtitle`
/** 曲库扫描（本地音乐页）：GET /library?dir=<绝对路径>&depth=<n>，只读。 */
const LIBRARY_PATH = `${ROUTE_PREFIX}/library`
const DIR_PATH = `${ROUTE_PREFIX}/dir`

/** 时长解析端点（本地 mp3/flac 头解析）：GET /duration?path=<绝对路径>[&cwd=][&sessionId=]。
 *  为什么放在宿主：桌面端媒体走自定义协议 / 代理流时，<audio>.duration 常是 Infinity 或 0，
 *  本地文件又没有元数据，客户端只能显示 0:00。在宿主读容器头算一次，客户端缓存进 durMeta。 */
const DURATION_PATH = `${ROUTE_PREFIX}/duration`

/**
 * 允许服务的扩展名 → Content-Type。
 * 视频沿用 dsh-video-preview 的一套，音频沿用 @huanlin audio 插件的一套，
 * 两套合起来就是本 viewer 在客户端声明的 exts（host / client 必须一致）。
 */
const MEDIA_TYPES = {
  // ── video ──
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.qt': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.ogv': 'video/ogg',
  '.ogg': 'video/ogg',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.3gp': 'video/3gpp',
  '.3g2': 'video/3gpp2',
  '.m2ts': 'video/mp2t',
  // ── audio ──
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.wave': 'audio/wav',
  '.flac': 'audio/flac',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wma': 'audio/x-ms-wma',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.amr': 'audio/amr',
  '.ape': 'audio/x-ape',
  '.caf': 'audio/x-caf',
  '.mka': 'audio/x-matroska',
}

// ── browser-trust fence ──────────────────────────────────────────────────────
// 与 @deepseek-ai/dsh-client-connection 的 /api 网关同语义；在此内联，插件不带内部依赖。

function header(headers, key) {
  const value = headers[key]
  return typeof value === 'string' ? value : undefined
}

function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

function isTrustedApiRequest(request, trustedHosts) {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

// ── 错误类型（wire shape 与 better-sidebar 的 SidebarError 对齐） ──────────────

class MediaError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

// ── 路径工具 ────────────────────────────────────────────────────────────────

function requireAbsolute(path) {
  if (!path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)) {
    throw new MediaError('fs-error', `"${path}" is not an absolute path`, 400)
  }
  return resolve(path)
}

/** target 是否在 base 之下（Windows 大小写不敏感，分隔符归一）。 */
function isWithin(base, target) {
  const norm = (value) => value.replace(/[\\/]+/g, '/').replace(/\/$/, '')
  const b = norm(base)
  const t = norm(target)
  if (process.platform === 'win32') {
    const lb = b.toLowerCase()
    const lt = t.toLowerCase()
    return lt === lb || lt.startsWith(`${lb}/`)
  }
  return t === b || t.startsWith(`${b}/`)
}

/**
 * 取会话的权威工作目录：已挂载会话的 header.cwd → 客户端自带 cwd → 进程 cwd。
 * @param {any} ctx - 宿主上下文切片
 * @param {string} sessionId
 * @param {string|undefined} clientCwd
 */
function sessionCwdOf(ctx, sessionId, clientCwd) {
  const session = ctx.sessions.get(sessionId)
  const headerCwd = session?.header?.cwd
  if (headerCwd !== undefined && headerCwd !== '') return headerCwd
  if (clientCwd !== undefined && clientCwd !== '') {
    try {
      return resolve(clientCwd)
    } catch {
      throw new MediaError('bad-request', `invalid working directory "${clientCwd}"`)
    }
  }
  return process.cwd()
}

/** 取本次请求的会话基准目录（/library 与 /dir 共用）。 */
function sessionBaseOf(url, ctx) {
  const cwdParam = url.searchParams.get('cwd') ?? undefined
  const sessionId = url.searchParams.get('sessionId')
  if (
    sessionId !== null && sessionId !== ''
    && ctx.sessions !== undefined && typeof ctx.sessions.get === 'function'
    && ctx.sessions.get(sessionId) !== undefined
  ) {
    return sessionCwdOf(ctx, sessionId, cwdParam)
  }
  if (cwdParam !== undefined && cwdParam !== '') {
    try { return resolve(cwdParam) } catch { throw new MediaError('bad-request', `invalid working directory "${cwdParam}"`) }
  }
  return process.cwd()
}

// ── 允许访问的根目录（多根围栏）─────────────────────────────────────────────
// 播放器要能直接播音乐库里的歌，但音乐库不在会话 cwd 之下。
// 这里把「允许的根」从单一会话 cwd 扩展成一份可信根名单：
//   1) 会话 cwd（session.header.cwd / 客户端 cwd 参数 / process.cwd()）
//   2) 音乐播放器的音乐库 root（~/.dsh/music-player-state.json 的 root 字段，
//      运行时可能被改写，所以每次请求都重新读，只做 1 秒 TTL 缓存）
//   3) 播放器自己的默认音乐目录 ~/Music（未设置 root 时的回退目录）
//   4) 环境变量 DSH_SIDEBAR_MEDIA_ROOTS（分号或逗号分隔的绝对路径列表）
// 除这几个根之外仍然一律拒绝；不允许 target 是这些根的父目录，也不允许 `..` 逃逸。

const MUSIC_STATE_FILE = 'music-player-state.json'
const MUSIC_STATE_TTL_MS = 1000
const musicStateCache = { at: 0, root: null }

/** DSH 家目录：优先 DSH_HOME，回落 ~/.dsh。 */
function dshHomeDir() {
  const env = process.env && process.env.DSH_HOME
  if (typeof env === 'string' && env !== '') return env
  try {
    return join(homedir(), '.dsh')
  } catch {
    return null
  }
}

/** 音乐库 root（来自 music-player-state.json）；读不到返回 null。 */
function musicLibraryRoot() {
  const now = Date.now()
  if (now - musicStateCache.at < MUSIC_STATE_TTL_MS) return musicStateCache.root
  let root = null
  const home = dshHomeDir()
  if (home !== null) {
    try {
      const raw = readFileSync(join(home, MUSIC_STATE_FILE), 'utf8')
      const data = JSON.parse(raw)
      if (data && typeof data.root === 'string' && data.root !== '') root = data.root
    } catch {
      root = null
    }
  }
  musicStateCache.at = now
  musicStateCache.root = root
  return root
}

/** 播放器默认音乐目录 ~/Music（未设置 root 时 dsh-music-player 的回退目录）。 */
function defaultMusicRoot() {
  try {
    return join(homedir(), 'Music')
  } catch {
    return null
  }
}

/** 环境变量追加的额外根目录。 */
function envMediaRoots() {
  const env = process.env && process.env.DSH_SIDEBAR_MEDIA_ROOTS
  if (typeof env !== 'string' || env.trim() === '') return []
  return env.split(/[;,]/).map((part) => part.trim()).filter((part) => part !== '')
}

/**
 * 当前请求允许的根目录名单（绝对路径，已 resolve）。
 * @param {string} sessionBase - 会话 cwd
 * @returns {string[]}
 */
function allowedBases(sessionBase) {
  const bases = []
  const push = (value) => {
    if (typeof value !== 'string') return
    const trimmed = value.trim()
    if (trimmed === '') return
    try {
      bases.push(resolve(trimmed))
    } catch {
      /* 非法路径忽略 */
    }
  }
  push(sessionBase)
  push(musicLibraryRoot())
  push(defaultMusicRoot())
  for (const extra of envMediaRoots()) push(extra)
  return bases
}

/** target 是否落在任一允许根之下（target 先 resolve，`..` 逃逸会被归一后判越界）。 */
function isAllowedTarget(target, sessionBase) {
  let resolvedTarget
  try {
    resolvedTarget = resolve(target)
  } catch {
    return false
  }
  return allowedBases(sessionBase).some((base) => isWithin(base, resolvedTarget))
}

/** 越界错误：保留原措辞，附带允许根列表便于排错。 */
function outsideFenceError(raw, bases) {
  return new MediaError(
    'forbidden',
    `"${raw}" is outside the session working directory (allowed roots: ${bases.join(' | ')})`,
    403,
  )
}

// ── Range 解析 ──────────────────────────────────────────────────────────────

/**
 * 解析单个 `Range: bytes=...` 头。
 * @returns {{start:number,end:number}|null|{unsatisfiable:true}}
 *   - `null`：没有 Range 头，或形态不可解析（按 RFC 9110 忽略，回全量 200）
 *   - `{unsatisfiable:true}`：起点越过文件尾 → 必须回 416
 * 多段 Range（`bytes=a-b,c-d`）只取第一段，规范明确允许。
 */
function parseRange(raw, size) {
  if (raw === undefined) return null
  const m = /^bytes=(.+)$/i.exec(raw.trim())
  if (!m) return null
  const spec = m[1].split(',')[0].trim()
  if (spec === '') return null

  if (spec.startsWith('-')) {
    // 后缀形态：最后 N 字节
    const suffix = Number(spec.slice(1))
    if (!Number.isInteger(suffix) || suffix <= 0) return null
    if (suffix >= size) return { start: 0, end: size - 1 }
    return { start: size - suffix, end: size - 1 }
  }

  const dash = spec.indexOf('-')
  if (dash === -1) return null
  const startText = spec.slice(0, dash)
  const endText = spec.slice(dash + 1)
  const start = startText === '' ? 0 : Number(startText)
  const end = endText === '' ? size - 1 : Number(endText)
  if (!Number.isInteger(start) || start < 0 || !Number.isInteger(end)) return null
  if (start >= size) return { unsatisfiable: true }
  return { start, end: Math.min(end, size - 1) }
}

// ── 响应 ────────────────────────────────────────────────────────────────────

function writeError(res, error) {
  const status = error instanceof MediaError ? error.status : 500
  if (res.headersSent) {
    res.destroy()
    return
  }
  const body = Buffer.from(JSON.stringify({
    ok: false,
    error: { code: error?.code ?? 'internal', message: error?.message ?? String(error) },
  }))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
  })
  res.end(body)
}

/** 一次请求的字节输出：Range 命中走 206，否则 200；全程 createReadStream。 */
function serveFile(req, res, path, size, type) {
  const headers = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache',
  }

  const range = parseRange(header(req.headers, 'range'), size)
  if (range?.unsatisfiable) {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` })
    res.end()
    return
  }

  if (range !== null) {
    const { start, end } = range
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': String(end - start + 1),
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    const stream = createReadStream(path, { start, end })
    stream.on('error', () => res.destroy())
    stream.pipe(res)
    return
  }

  res.writeHead(200, { ...headers, 'content-length': String(size) })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const stream = createReadStream(path)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

// ── 曲库扫描（GET /library）────────────────────────────────────────────────
// 只读：递归列目录、按扩展名白名单挑出音频/视频，绝不创建/删除/移动任何文件。
// 扩展名与前端 client.js:361-371 的 VIDEO_EXTS / AUDIO_EXTS 严格对齐（别另立一套）。
const LIBRARY_VIDEO_EXTS = new Set(['mp4', 'm4v', 'webm', 'mov', 'qt', 'mkv', 'avi', 'wmv', 'flv', 'ogv', 'ogg', 'mpeg', 'mpg', '3gp', '3g2', 'm2ts'])
const LIBRARY_AUDIO_EXTS = new Set(['mp3', 'wav', 'wave', 'flac', 'oga', 'opus', 'm4a', 'aac', 'wma', 'aif', 'aiff', 'amr', 'ape', 'caf', 'mka'])
const LIBRARY_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__', '$recycle.bin', 'system volume information'])
const LIBRARY_MAX_FILES = 20000
const LIBRARY_MAX_DEPTH = 8
/** /dir 单次返回条目上限（dirs+files 合计），超出截断并打 truncated 标。 */
const DIR_MAX_ENTRIES = 2000
const DIR_DRIVES = '__drives__'

/**
 * 递归扫描一个根目录，返回 { tracks, truncated }。
 *  - lstat 判定：符号链接一律跳过（既不跟目录链也不收文件链）；
 *  - 跳过 LIBRARY_SKIP_DIRS（大小写不敏感）；
 *  - 深度上限 maxDepth；文件数上限 LIBRARY_MAX_FILES，超出即截断并置 truncated=true。
 */
async function scanLibrary(root, maxDepth) {
  const tracks = []
  let truncated = false
  const stack = [{ dir: root, depth: 0 }]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = await readdir(current.dir, { withFileTypes: true })
    } catch {
      continue // 无权限 / 扫描期间被删的目录：跳过，不中断整次扫描
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const full = join(current.dir, entry.name)
      let info
      try {
        info = await lstat(full)
      } catch {
        continue
      }
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) {
        if (current.depth + 1 > maxDepth) continue
        if (LIBRARY_SKIP_DIRS.has(entry.name.toLowerCase())) continue
        stack.push({ dir: full, depth: current.depth + 1 })
        continue
      }
      if (!info.isFile()) continue
      const ext = extname(entry.name).slice(1).toLowerCase()
      const isVideo = LIBRARY_VIDEO_EXTS.has(ext)
      if (!isVideo && !LIBRARY_AUDIO_EXTS.has(ext)) continue
      if (tracks.length >= LIBRARY_MAX_FILES) {
        truncated = true
        return { tracks, truncated }
      }
      tracks.push({ name: entry.name, path: full, ext, size: info.size, mtimeMs: info.mtimeMs, isVideo })
    }
  }
  return { tracks, truncated }
}

/** 解析 /library 的目标目录：dir 缺省时回落到 state 里的音乐库 root（只读），并做与 /media 同一套围栏。 */
function libraryTargetOf(url, ctx) {
  const dirParam = url.searchParams.get('dir')
  const base = sessionBaseOf(url, ctx)
  let raw = dirParam
  if (raw === null || raw === '') {
    raw = musicLibraryRoot() ?? defaultMusicRoot()
    if (raw === null || raw === '') {
      throw new MediaError('bad-request', 'no music library root configured; pass dir=<absolute path>', 400)
    }
  }
  const target = requireAbsolute(raw)
  const bases = allowedBases(base)
  if (!bases.some((b) => isWithin(b, target))) {
    throw outsideFenceError(raw, bases)
  }
  return target
}

async function handleLibrary(url, ctx, request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw new MediaError('method-not-allowed', 'only GET and HEAD are allowed', 405)
  }
  const root = libraryTargetOf(url, ctx)
  let info
  try {
    info = await stat(root)
  } catch {
    throw new MediaError('fs-error', `cannot read "${root}"`, 404)
  }
  if (!info.isDirectory()) throw new MediaError('fs-error', `"${root}" is not a directory`, 400)
  const depthParam = url.searchParams.get('depth')
  const depthNum = Number(depthParam)
  const maxDepth = Number.isFinite(depthNum) && depthNum > 0
    ? Math.min(Math.floor(depthNum), LIBRARY_MAX_DEPTH)
    : LIBRARY_MAX_DEPTH
  const { tracks, truncated } = await scanLibrary(root, maxDepth)
  if (request.method === 'HEAD') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end()
    return
  }
  writeJson(response, 200, { ok: true, root, count: tracks.length, truncated, tracks })
}

// ── 目录浏览（/dir）：给前端自绘目录选择器用，只读 ──────────────────────────
// 为什么要有：DSH 这个 webview 里 <input webkitdirectory> 点了不弹框，
// 所以走「后端 readdir + 前端自绘浏览器」这条路（与参照插件同路子，但保留我们的围栏）。
// 与 /library 的区别：/library 递归找媒体文件；/dir 只列一层（子目录 + 媒体文件）。

/** 允许浏览的判定：目标在某个允许根之下（向下自由），或目标本身就是某个允许根的祖先（只为让用户能沿路径走下来）。
 *  ⚠️ 绝不能把「盘根」当成允许根塞进名单——isWithin('C:\\', 'C:\\Windows\\System32') 会成立，
 *  等于整盘放行。这里用「祖先方向只放行到允许根所在的路径链」的双向判定。 */
function isBrowsable(target, bases) {
  return bases.some((base) => isWithin(base, target) || isWithin(target, base))
}

/** 面包屑：从盘根逐级到当前目录。盘根那级 name 与 path 都是 `C:\` 形式。 */
function dirCrumbs(target) {
  const abs = String(target || '')
  if (abs === '' || abs === DIR_DRIVES) return []
  const parsed = parsePath(abs)
  const root = parsed.root || ''
  const crumbs = []
  if (root !== '') crumbs.push({ name: root, path: root })
  const parts = []
  let d = parsed.dir
  if (d !== '' && d !== root) {
    while (d !== '' && d !== root) {
      parts.unshift(basename(d))
      d = dirname(d)
    }
  }
  let cur = root
  for (const part of parts) {
    cur = cur === '' ? part : join(cur, part)
    crumbs.push({ name: part, path: cur })
  }
  if (parsed.base !== '' && parsed.base !== root) {
    cur = cur === '' ? parsed.base : join(cur, parsed.base)
    crumbs.push({ name: parsed.base, path: cur })
  }
  return crumbs
}

/** 枚举存在的盘符（A:\ ~ Z:\）；name 与 path 都带反斜杠，与参照插件一致。 */
function listDrives() {
  const drives = []
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`
    try {
      if (existsSync(root)) drives.push({ name: root, path: root })
    } catch { /* 不可访问的盘符直接跳过 */ }
  }
  return drives
}

async function handleDir(url, ctx, request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw new MediaError('method-not-allowed', 'only GET and HEAD are allowed', 405)
  }
  const raw = url.searchParams.get('path')
  const isDrives = raw === null || raw === '' || raw === DIR_DRIVES
  if (isDrives) {
    const payload = {
      ok: true,
      path: DIR_DRIVES,
      name: '本机磁盘',
      up: null,
      dirs: listDrives(),
      files: [],
      crumbs: [],
      truncated: false,
    }
    if (request.method === 'HEAD') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end()
      return
    }
    writeJson(response, 200, payload)
    return
  }

  const target = requireAbsolute(raw) // 非绝对路径 → 400
  const bases = allowedBases(sessionBaseOf(url, ctx))
  if (!isBrowsable(target, bases)) throw outsideFenceError(raw, bases)

  let info
  try {
    info = statSync(target)
  } catch {
    throw new MediaError('fs-error', `cannot read "${target}"`, 404)
  }
  if (!info.isDirectory()) throw new MediaError('fs-error', `"${target}" is not a directory`, 404)

  const dirs = []
  const files = []
  let truncated = false
  let entries = []
  try {
    entries = readdirSync(target, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    entries = [] // 目录不可读（权限/占用）→ 空列表，不抛
  }
  for (const entry of entries) {
    if (dirs.length + files.length >= DIR_MAX_ENTRIES) {
      truncated = true
      break
    }
    const name = entry.name
    const full = join(target, name)
    try {
      let isDir = entry.isDirectory()
      if (!isDir && entry.isSymbolicLink()) {
        try { isDir = statSync(full).isDirectory() } catch { continue }
      }
      if (isDir) {
        dirs.push({ name, path: full })
        continue
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue
      const ext = extname(name).slice(1).toLowerCase()
      if (ext === '') continue
      const isVideo = LIBRARY_VIDEO_EXTS.has(ext)
      if (!isVideo && !LIBRARY_AUDIO_EXTS.has(ext)) continue
      let size = 0
      try {
        const fileInfo = statSync(full)
        if (!fileInfo.isFile()) continue
        size = fileInfo.size
      } catch {
        size = 0 // 单个坏条目（被占用/无权限）不给整次请求 500
      }
      files.push({ name, path: full, ext, size, isVideo })
    } catch {
      continue // 不可读条目跳过
    }
  }
  const sortByName = (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
  dirs.sort(sortByName)
  files.sort(sortByName)

  const parsed = parsePath(target)
  const atRoot = parsed.dir === target
  const payload = {
    ok: true,
    path: target,
    name: parsed.base !== '' ? parsed.base : (parsed.root !== '' ? parsed.root : basename(target)),
    up: atRoot ? (process.platform === 'win32' ? DIR_DRIVES : null) : dirname(target),
    dirs,
    files,
    crumbs: dirCrumbs(target),
    truncated,
  }
  if (request.method === 'HEAD') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end()
    return
  }
  writeJson(response, 200, payload)
}

// ── 请求处理 ────────────────────────────────────────────────────────────────

function requireParam(url, key) {
  const value = url.searchParams.get(key)
  if (value === null || value === '') throw new MediaError('bad-request', `${key} is required`)
  return value
}

/**
 * 解析 + 校验 + stat 一次请求指向的文件。
 * @returns {Promise<{path:string,name:string,size:number,type:string}>}
 */
async function statRequestedFile(url, ctx) {
  const sessionId = requireParam(url, 'sessionId')
  const raw = requireParam(url, 'path')
  const cwd = sessionCwdOf(ctx, sessionId, url.searchParams.get('cwd') ?? undefined)

  const target = requireAbsolute(raw)
  // 路径围栏：必须落在允许根之一之下（会话 cwd / 音乐库 root / ~/Music / 环境变量根）
  const bases = allowedBases(cwd)
  if (!bases.some((base) => isWithin(base, target))) {
    throw outsideFenceError(raw, bases)
  }

  const ext = extname(target).toLowerCase()
  const type = MEDIA_TYPES[ext]
  if (type === undefined) {
    throw new MediaError(
      'unsupported-media',
      ext === '' ? 'this route serves media files only' : `this route serves media files only (got ${ext})`,
      403,
    )
  }

  let info
  try {
    info = await stat(target)
  } catch {
    throw new MediaError('fs-error', `cannot read "${target}"`, 404)
  }
  if (!info.isFile()) throw new MediaError('fs-error', `"${target}" is not a regular file`, 400)

  return { path: target, name: target.replace(/^.*[\\/]/, ''), size: info.size, type }
}

async function handleMedia(url, ctx, request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw new MediaError('method-not-allowed', 'only GET and HEAD are supported', 405)
  }
  const facts = await statRequestedFile(url, ctx)
  serveFile(request, response, facts.path, facts.size, facts.type)
}

/**
 * 从容器头解析音频时长（秒）。覆盖 mp3（Xing/Info 帧数优先，否则 CBR 按比特率估算）与 flac（STREAMINFO）。
 * 返回 null 表示「这种容器/这个文件解析不出来」——调用方回 ok:false，客户端回退到 el.duration / 元数据。
 */
function probeDurationFromBuffer(buf, size, ext) {
  if (ext === '.flac') {
    if (buf.length < 42 || buf.toString('latin1', 0, 4) !== 'fLaC') return null
    const sampleRate = (buf[18] << 12) | (buf[19] << 4) | (buf[20] >> 4)
    // totalSamples 是 36 位：JS 位移只有 32 位，这里拆成「高 4 位 × 2^32 + 低 32 位」
    const totalSamples = (buf[21] & 0x0f) * 4294967296
      + buf[22] * 16777216 + buf[23] * 65536 + buf[24] * 256 + buf[25]
    if (!sampleRate || !totalSamples) return null
    return totalSamples / sampleRate
  }
  if (ext !== '.mp3' && ext !== '.mpga') return null
  let off = 0
  if (buf.length >= 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    // ID3v2 头：size 是 4 字节 syncsafe 整数（每字节只用低 7 位）
    off = 10 + (((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f))
  }
  let i = off
  for (; i + 4 < buf.length; i++) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) break
  }
  if (i + 4 >= buf.length) return null
  const header = buf.readUInt32BE(i)
  const verBits = (header >>> 19) & 3 // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
  const layer = (header >>> 17) & 3 // 1=Layer III
  const brIdx = (header >>> 12) & 0xf
  const srIdx = (header >>> 10) & 3
  const chanMode = (header >>> 6) & 3
  const srTable = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }[verBits]
  const sampleRate = srTable ? srTable[srIdx] : 0
  if (!sampleRate || layer !== 1) return null
  const isMpeg1 = verBits === 3
  const samplesPerFrame = isMpeg1 ? 1152 : 576
  // Xing/Info 标签在帧头 + side info 之后；side info 长度按 MPEG 版本与声道模式定
  const sideInfo = isMpeg1 ? (chanMode === 3 ? 17 : 32) : (chanMode === 3 ? 9 : 17)
  const xoff = i + 4 + sideInfo
  if (xoff + 12 <= buf.length) {
    const tag = buf.toString('latin1', xoff, xoff + 4)
    if (tag === 'Xing' || tag === 'Info') {
      const flags = buf.readUInt32BE(xoff + 4)
      if (flags & 1) {
        const frames = buf.readUInt32BE(xoff + 8)
        if (frames > 0) return (frames * samplesPerFrame) / sampleRate
      }
    }
  }
  const brTable = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
  const bitrate = brTable[brIdx] * 1000
  if (!bitrate) return null
  return ((size - off) * 8) / bitrate
}

async function handleDuration(url, ctx, request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw new MediaError('method-not-allowed', 'only GET and HEAD are supported', 405)
  }
  const target = resolveFencedTarget(url, ctx)
  const ext = extname(target).toLowerCase()
  let info
  try {
    info = await stat(target)
  } catch {
    throw new MediaError('fs-error', `cannot read "${target}"`, 404)
  }
  if (!info.isFile()) throw new MediaError('fs-error', `"${target}" is not a regular file`, 400)
  // 只读前 1MB：ID3 + 第一帧（Xing）与 flac STREAMINFO 全在这一段里
  let buf
  try {
    const fd = await readFile(target)
    buf = fd.subarray(0, Math.min(fd.length, 1024 * 1024))
  } catch {
    throw new MediaError('fs-error', `cannot read "${target}"`, 404)
  }
  const duration = probeDurationFromBuffer(buf, info.size, ext)
  writeJson(response, 200, duration === null
    ? { ok: false, duration: null, ext, reason: 'unparsable-container' }
    : { ok: true, duration, ext })
}

// ── 文本轨：歌词（.lrc）/ 字幕（.vtt/.srt/.ass → VTT）────────────────────────
//
// 这两条路由不进 MEDIA_TYPES 白名单（它们不吐媒体字节，只回 JSON / VTT 文本）。
// 路径围栏与 /media 一致：path 必须落在 cwd（或会话 cwd）之下，越界 403。

function writeJson(response, status, object) {
  if (response.headersSent) { try { response.destroy() } catch { /* ignore */ } return }
  const body = Buffer.from(JSON.stringify(object), 'utf8')
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-cache',
  })
  response.end(body)
}

/** 与 /media 同样的路径围栏；入参允许 path + cwd（无 sessionId 时以 cwd 为基准）。 */
function resolveFencedTarget(url, ctx) {
  const raw = requireParam(url, 'path')
  const cwdParam = url.searchParams.get('cwd') ?? undefined
  const sessionId = url.searchParams.get('sessionId')
  let base
  if (
    sessionId !== null && sessionId !== ''
    && ctx.sessions !== undefined && typeof ctx.sessions.get === 'function'
    && ctx.sessions.get(sessionId) !== undefined
  ) {
    base = sessionCwdOf(ctx, sessionId, cwdParam)
  } else if (cwdParam !== undefined && cwdParam !== '') {
    try { base = resolve(cwdParam) } catch { throw new MediaError('bad-request', `invalid working directory "${cwdParam}"`) }
  } else {
    base = process.cwd()
  }
  const target = requireAbsolute(raw)
  const bases = allowedBases(base)
  if (!bases.some((b) => isWithin(b, target))) {
    throw outsideFenceError(raw, bases)
  }
  return target
}

/** Buffer 解码：先 UTF-8，若替换符过多（>3）判为 GBK/GB2312 再用 gbk 重解。 */
function decodeBufferToText(buffer) {
  let text = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
  const bad = (text.match(/\uFFFD/g) || []).length
  if (bad > 3) {
    try {
      text = new TextDecoder('gbk', { fatal: false }).decode(buffer)
    } catch { /* gbk 不可用则保留 utf-8 结果 */ }
  }
  return text
}

/** 解析 LRC：返回按时间升序的 [{t,text}]；无任何时间轴返回 null（视为纯文本）。 */
function parseLrc(text) {
  const lines = []
  let sawTimed = false
  for (const raw of String(text).split(/\r?\n/)) {
    const re = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
    const stamps = []
    let m
    while ((m = re.exec(raw)) !== null) {
      const min = Number(m[1])
      const sec = Number(m[2])
      const fracStr = m[3] || ''
      const frac = fracStr === '' ? 0 : Number((fracStr + '000').slice(0, 3)) / 1000
      stamps.push(min * 60 + sec + frac)
    }
    if (stamps.length === 0) continue
    const lineText = raw.replace(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g, '').trim()
    sawTimed = true
    for (const t of stamps) lines.push({ t: Math.round(t * 1000) / 1000, text: lineText })
  }
  if (!sawTimed) return null
  lines.sort((a, b) => a.t - b.t)
  return lines
}

/** 同名换扩展：a.mp3 → a.lrc；extension 传 '' 则得到去扩展名的主干。 */
function withExtension(target, extension) {
  const ext = extname(target)
  return (ext === '' ? target : target.slice(0, target.length - ext.length)) + extension
}

async function handleLyric(url, ctx, request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw new MediaError('method-not-allowed', 'only GET and HEAD are supported', 405)
  }
  const target = resolveFencedTarget(url, ctx)
  const lyricPath = withExtension(target, '.lrc')
  let buffer
  try {
    buffer = await readFile(lyricPath)
  } catch {
    writeJson(response, 200, { ok: false, error: 'no-lyric' })
    return
  }
  const text = decodeBufferToText(buffer)
  const lines = parseLrc(text)
  if (lines !== null) {
    writeJson(response, 200, { ok: true, source: 'lrc', lines })
  } else {
    writeJson(response, 200, { ok: true, source: 'plain', text })
  }
}

/** SRT → VTT：逗号时间码改点、去掉 cue 序号行、补 WEBVTT 头。 */
function srtToVtt(text) {
  let s = String(text)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
  s = s.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g, '$1.$2')
  s = s.replace(/^\s*\d+\s*\n/gm, '')
  s = s.replace(/\n{3,}/g, '\n\n').trim()
  return `WEBVTT\n\n${s}\n`
}

function assTimeToVtt(value) {
  const m = /^(\d+):(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?$/.exec(String(value).trim())
  if (m === null) return null
  const hh = String(Number(m[1])).padStart(2, '0')
  const mm = String(Number(m[2])).padStart(2, '0')
  const ss = String(Number(m[3])).padStart(2, '0')
  const fracStr = m[4] || ''
  const ms = fracStr === '' ? '000' : (fracStr + '000').slice(0, 3)
  return `${hh}:${mm}:${ss}.${ms}`
}

/** ASS → VTT：取 Dialogue 行，去 {…} 样式码，转换时间格式。 */
function assToVtt(text) {
  const src = String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const cues = []
  for (const line of src.split('\n')) {
    const idx = line.indexOf('Dialogue:')
    if (idx === -1) continue
    const parts = line.slice(idx + 'Dialogue:'.length).trim().split(',')
    if (parts.length < 10) continue
    const start = assTimeToVtt(parts[1])
    const end = assTimeToVtt(parts[2])
    if (start === null || end === null) continue
    let body = parts.slice(9).join(',')
    body = body.replace(/\{[^}]*\}/g, '')
    body = body.replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' ').trim()
    if (body === '') continue
    cues.push(`${start} --> ${end}\n${body}`)
  }
  return 'WEBVTT\n\n' + cues.join('\n\n') + (cues.length > 0 ? '\n' : '')
}

async function handleSubtitle(url, ctx, request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw new MediaError('method-not-allowed', 'only GET and HEAD are supported', 405)
  }
  const target = resolveFencedTarget(url, ctx)
  const stem = withExtension(target, '')
  let found
  for (const ext of ['.vtt', '.srt', '.ass']) {
    try {
      const info = await stat(stem + ext)
      if (info.isFile()) { found = { path: stem + ext, ext }; break }
    } catch { /* 尝试下一个扩展名 */ }
  }
  if (found === undefined) {
    writeJson(response, 404, { ok: false, error: 'no-subtitle' })
    return
  }
  const text = decodeBufferToText(await readFile(found.path))
  let vtt
  if (found.ext === '.vtt') vtt = text
  else if (found.ext === '.srt') vtt = srtToVtt(text)
  else vtt = assToVtt(text)
  if (!/^WEBVTT/.test(vtt.replace(/^\uFEFF/, ''))) vtt = 'WEBVTT\n\n' + vtt
  const body = Buffer.from(vtt, 'utf8')
  response.writeHead(200, {
    'content-type': 'text/vtt; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-cache',
  })
  if (request.method === 'HEAD') { response.end(); return }
  response.end(body)
}

// ── 在线 QQ 音乐：扫码登录 / 搜索 / 歌单 / 播放直链 / 歌词 ───────────────────────
// 移植自 dsh-music-player v1.0.4（MIT，github.com/kendu76/dsh-music-player）：
//   · 底层原样拷入本目录 lib/qq.js、lib/qrc.js（正文逐字节未改，见文件顶部来源声明）；
//   · 路由形状**逐字段对齐**其 lib/index.js 的 QQ 分支(:4358-4634)，只把前缀
//     /dsh-music 换成 /dsh-sidebar-media-player —— 前端按「一模一样、小改加功能」
//     照抄母本，所以字段名一个不改、一个不删，只做加法。
// 与母本的有意差异（移植时改的，不是抄错）：
//   1) 全部路由走本插件 handleRequest → 继承 trustedHosts 围栏（母本那些路由无鉴权）；
//   2) 凭据落 ~/.dsh/sidebar-media-player-qq-cookie.json，与母本 music-player-qq-cookie.json 物理隔离；
//   3) 不做登录态主动探测（依据 lib/qq.js:411-425 实测：探测接口对有效会话也回 500003，只会误报）；
//   4) 不设本地过期门（实测二维码 120 s 由服务端判死，本地计时不参与任何请求，见 lib/qq.js:61-64）；
//   5) 额外保留四个别名路由：/qq/qr、/qq/qr/status、/qq/playlist?id=、/qq/lyric?mid=
//      （lead 早先契约用它们；别名纯加法，不改变母本形状）。
// 错误体：QQ 路由内一律 `{ok:false, error:'字符串'}`（同母本），不走本插件外层的
// `{ok:false,error:{code,message}}` —— 照抄母本的前端直接读 data.error 字符串。

/** 在线 QQ 音乐端点（挂在插件自己的前缀下，不另开裸 HTTP 路由）。 */
const QQ_PATH = `${ROUTE_PREFIX}/qq`

/** QQ 凭据文件——**不是**母本的 music-player-qq-cookie.json，两套互不覆盖。 */
const QQ_COOKIE_FILE = join(homedir(), '.dsh', 'sidebar-media-player-qq-cookie.json')

const QQ_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

/** 取链缓存 TTL（5 分钟，落在 vkey 直链有效期内）。 */
const QQ_TAKE_TTL_MS = 5 * 60 * 1000

/** songmid → 数字 songID 缓存上限（QRC 歌词要先换 songid）。 */
const QQ_MID_INFO_MAX = 300

/** 二维码复用窗口：同一把 key 的图在此窗口内重复请求直接复用（母本无此概念，仅别名 /qq/qr 用）。 */
const QQ_QR_REUSE_MS = 15 * 1000

/** 登录态（进程内单例；凭据只从 QQ_COOKIE_FILE 读，绝不碰母本那个文件）。 */
const qq = { cookie: '', cookies: null, nickname: '', loginFrom: '', isVip: null, loaded: false }

/** 服务端持有的扫码会话（别名 /qq/qr + /qq/qr/status 用；母本版把 key 下发给前端，见 /qq/login/start）。 */
let qqLoginSession = null

const qqTakeCache = new Map()
const qqMidInfoCache = new Map()

/** 逐字歌词缓存（加法路由 /qq/lyric-words 用；解密一次约 3 KB 文本，缓存即可）。 */
const qqWordsCache = new Map()

/** 从 cookie 串里取 uin（母本同逻辑；取不到给空串）。 */
function qqUin() {
  const m = /(?:^|;)\s*?uin=([^;]+)/.exec(qq.cookie)
  return m === null ? '' : m[1].trim()
}

/**
 * 读凭据文件（幂等，只读一次）。
 * 文件里 `cookies` 是 map、`cookie` 是拼好的串，两种形态都在：map 给需要重算的接口，
 * 串给直接用 Cookie 头的接口；只有一方时从另一方推导。
 */
function loadQQCookie() {
  if (qq.loaded) return
  qq.loaded = true
  try {
    const data = JSON.parse(readFileSync(QQ_COOKIE_FILE, 'utf8'))
    if (data === null || typeof data !== 'object') throw new Error('bad cookie file')
    qq.cookies = data.cookies !== null && typeof data.cookies === 'object' ? data.cookies : null
    if (typeof data.cookie === 'string' && data.cookie !== '') qq.cookie = data.cookie
    else qq.cookie = qq.cookies === null ? '' : QQ.joinCookieMap(qq.cookies)
    qq.nickname = typeof data.nickname === 'string' ? data.nickname : ''
    qq.loginFrom = data.from === 'qq' || data.from === 'wx' ? data.from : ''
  } catch {
    // 文件不存在 / 坏 JSON：按未登录处理，不抛错（首次使用就是这种状态）。
    qq.cookie = ''
    qq.cookies = null
    qq.nickname = ''
    qq.loginFrom = ''
  }
}

/**
 * 落盘（权限 0600）。母本存 {cookie,nickname,loginFrom}，我们多存 cookies/source/savedAt——
 * 纯加法，母本那份文件的读取方不受影响，而我们自己下次启动能直接复用。
 */
function saveQQCookie() {
  const payload = {
    savedAt: new Date().toISOString(),
    source: 'dsh-sidebar-media-player',
    from: qq.loginFrom,
    nickname: qq.nickname,
    cookie: qq.cookie,
    cookies: qq.cookies,
  }
  try {
    mkdirSync(join(homedir(), '.dsh'), { recursive: true })
    writeFileSync(QQ_COOKIE_FILE, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    throw new MediaError('qq-cookie', `QQ 凭据写入失败：${error?.message ?? error}`, 502)
  }
}

function clearQQTakeCache() {
  qqTakeCache.clear()
}

/** 退出登录：清内存态 + 清取链缓存 + 把空凭据落盘（母本 :4401-4405 同一动作）。 */
function clearQQCookie() {
  qq.cookie = ''
  qq.cookies = null
  qq.nickname = ''
  qq.loginFrom = ''
  qq.isVip = null
  clearQQTakeCache()
  saveQQCookie()
}

/** VIP 判定（母本 :2612-2616）：未登录直接 false；只探测一次并缓存，失败按 false。 */
async function refreshQQVip() {
  if (qq.cookie === '') {
    qq.isVip = false
    return false
  }
  if (qq.isVip === null || qq.isVip === undefined) {
    try {
      qq.isVip = await QQ.detectVip(qq.cookie)
    } catch {
      qq.isVip = false
    }
  }
  return qq.isVip === true
}

/**
 * 从取链返回的文件名推音质档位（母本 :38-49 同逻辑）。
 * `M800…mp3` 是 320k 档、`M500…mp3` 是 128k 档，返回中文标签给前端显示。
 */
function qqQualityLabel(filename) {
  const name = String(filename || '')
  const dot = name.lastIndexOf('.')
  const ext = dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
  if (ext === 'flac') return '无损'
  if (ext === 'ogg') return '高音质'
  if (ext === 'mp3') {
    if (/^M800/i.test(name)) return '高音质'
    if (/^M500/i.test(name)) return '标准'
  }
  return ''
}

/**
 * 取（并缓存）某首歌的播放直链（母本 :2621-2637）。
 * 直链带时效，5 分钟内复用；取不到（VIP/版权/掉登录）返回空 url，交给调用方回 404。
 */
async function qqTake(songmid) {
  const hit = qqTakeCache.get(songmid)
  if (hit !== undefined && Date.now() - hit.ts < QQ_TAKE_TTL_MS) return hit
  const dl = await QQ.getDownloadURL(songmid, qq.cookie, true)
  const entry = { url: dl?.url ?? '', filename: dl?.filename ?? '', quality: qqQualityLabel(dl?.filename), ts: Date.now() }
  if (entry.url !== '') {
    qqTakeCache.set(songmid, entry)
    if (qqTakeCache.size > 200) {
      const oldest = qqTakeCache.keys().next().value
      if (oldest !== undefined) qqTakeCache.delete(oldest)
    }
  }
  return entry
}

/**
 * LRC 解析——**照抄母本 lib/index.js:1404-1432**。
 * 本文件 :505 那个是我们的本地版（不支持 [offset:]、不剥 `<...>`、无时间轴返回 null），
 * 形状不同，所以 QQ 路由单独用这一份，保证 /qq/lyric 的 lrc/trans 与母本逐字段一致。
 * 返回 [{t:秒,text}]（无时间轴返回空数组）。
 */
function qqParseLrc(text) {
  const out = []
  let offsetS = 0
  const TIME_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/^\uFEFF/, '')
    // [offset:±ms] 对整个文件生效（偏移量毫秒）。
    const om = /^\s*\[offset:\s*([+-]?\d+)\s*\]\s*$/.exec(line)
    if (om !== null) {
      offsetS = (parseInt(om[1], 10) || 0) / 1000
      continue
    }
    const tags = []
    let m
    TIME_RE.lastIndex = 0
    let contentStart = 0
    // 注意：exec 匹配失败后 lastIndex 会被重置为 0，所以文本起点要在循环里记录。
    while ((m = TIME_RE.exec(line)) !== null) {
      tags.push(m)
      contentStart = TIME_RE.lastIndex
    }
    if (tags.length === 0) continue
    const content = line.slice(contentStart).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    if (content === '') continue
    for (const tag of tags) {
      const min = parseInt(tag[1], 10) || 0
      const sec = parseInt(tag[2], 10) || 0
      const fracS = tag[3] !== undefined && tag[3] !== '' ? Number('0.' + tag[3]) : 0
      out.push({ t: min * 60 + sec + fracS + offsetS, text: content })
    }
  }
  out.sort((a, b) => a.t - b.t || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0))
  return out
}

/** 读请求体并 JSON.parse；空体 / 坏 JSON 一律回 {}（拿不到字段就走默认值，同母本策略）。 */
function readJsonBody(request) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > 1024 * 1024) {
        request.destroy()
        resolve({})
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve({})
      }
    })
    request.on('error', () => resolve({}))
  })
}

/** 登录态四件套（母本 /qq/status 的字段集；别名路由复用）。 */
function qqAuthPayload() {
  return { loggedIn: qq.cookie !== '', uin: qqUin(), nickname: qq.nickname, loginFrom: qq.loginFrom }
}

/** 扫码成功后统一落库（母本 :4386-4392 的 Host 侧动作）。 */
function qqApplyLogin(result, mode) {
  qq.cookie = result.cookie || (result.cookies ? QQ.joinCookieMap(result.cookies) : '')
  qq.cookies = result.cookies ?? null
  qq.nickname = (result.extra && result.extra.nickname) || qq.nickname || ''
  qq.loginFrom = mode === 'wx' ? 'wx' : 'qq'
  qq.isVip = null
  clearQQTakeCache()
  saveQQCookie()
}

/** 上游异常统一成 `{ok:false,error:'字符串'}` + 502（母本各 catch 分支的取值）。 */
function qqError(error) {
  return { ok: false, error: String((error && error.message) || error) }
}

// ── MV（音乐视频）只读取链 + 同源流代理 ────────────────────────────────────
// 前端绝不能把 CDN 直链塞给 <video>（主窗口 CSP default-src 'self' 无 media-src，跨域被拦），
// 所以本插件的 /qq/mv/<vid> 做同源反代：现取直链 → 透传 Range/206 → 流式回吐。
const QQ_MV_URL_TTL_MS = 60 * 60 * 1000 // 直链约 24h 有效；这里只做 ≤1h 内存缓存
const QQ_MV_URL_CACHE_MAX = 200
const qqMvUrlCache = new Map() // vid -> { url, ts }

/** 取 vid：fcg_play_single_song。无 MV 时返回 hasMv:false（不抛错，前端据此决定显示与否）。 */
async function qqFetchMvVid(songmid) {
  const u = `https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?songmid=${encodeURIComponent(songmid)}&format=json&platform=yqq`
  const res = await fetch(u, { headers: { 'User-Agent': QQ_USER_AGENT, Referer: 'https://y.qq.com/' } })
  const j = await res.json().catch(() => null)
  const row = j && Array.isArray(j.data) && j.data.length > 0 ? j.data[0] : null
  if (row === null) return { hasMv: false, vid: '', mvid: 0, name: '' }
  const mv = row.mv || {}
  const vid = typeof mv.vid === 'string' ? mv.vid : ''
  return {
    hasMv: vid !== '',
    vid,
    mvid: Number(mv.id) || 0,
    name: String(row.name || row.title || mv.name || ''),
  }
}

/** 现取 MV 直链（https mp4），≤1h 内存缓存。取不到返回 ''。 */
async function qqFetchMvUrl(vid, cookie) {
  const now = Date.now()
  const hit = qqMvUrlCache.get(vid)
  if (hit !== undefined && now - hit.ts < QQ_MV_URL_TTL_MS) return hit.url
  const body = JSON.stringify({
    comm: { cv: 4747474, ct: 24, format: 'json', platform: 'yqq.json', needNewCode: 1, uin: qqUin() || '0' },
    mvUrl: { module: 'gosrf.Stream.MvUrlProxy', method: 'GetMvUrls', param: { vids: [vid], request_typet: 100001 } },
  })
  const res = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    headers: {
      'User-Agent': QQ_USER_AGENT,
      Referer: 'https://y.qq.com/',
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body,
  })
  const j = await res.json().catch(() => null)
  const data = j && j.mvUrl && j.mvUrl.data ? j.mvUrl.data[vid] : null
  if (!data) return ''
  const mp4 = Array.isArray(data.mp4) ? data.mp4 : []
  // 档位 i 越大越清；同一档内优先 https 的那条（j=1 通常是 https）。
  for (let i = mp4.length - 1; i >= 0; i--) {
    const urls = Array.isArray(mp4[i] && mp4[i].freeflow_url)
      ? mp4[i].freeflow_url.filter((x) => typeof x === 'string' && x !== '')
      : []
    if (urls.length === 0) continue
    const chosen = urls.find((x) => x.startsWith('https://')) ?? urls[0]
    if (chosen) {
      if (qqMvUrlCache.size >= QQ_MV_URL_CACHE_MAX) {
        const oldest = qqMvUrlCache.keys().next().value
        if (oldest !== undefined) qqMvUrlCache.delete(oldest)
      }
      qqMvUrlCache.set(vid, { url: chosen, ts: now })
      return chosen
    }
  }
  return ''
}

/**
 * 别名 /qq/qr 的响应：默认 JSON（带 key 与 data URL），`?format=png` 时直接吐 PNG 字节。
 * `createdAt/expiresAt` 一并给出，前端到点自己重取（服务端二维码 120 s 寿命）。
 */
function writeQQQrPayload(url, session, response) {
  if (url.searchParams.get('format') === 'png') {
    const base64 = String(session.imageDataUrl || '').replace(/^data:image\/png;base64,/, '')
    const body = Buffer.from(base64, 'base64')
    if (body.length === 0) throw new MediaError('qq-qr', '二维码出图为空', 502)
    response.writeHead(200, {
      'content-type': 'image/png',
      'content-length': String(body.length),
      'cache-control': 'no-store, no-cache, must-revalidate',
    })
    response.end(body)
    return
  }
  writeJson(response, 200, {
    ok: true,
    key: session.key,
    image: session.imageDataUrl,
    imageDataUrl: session.imageDataUrl,
    mode: session.mode,
    createdAt: session.createdAt ?? null,
    expiresAt: session.expiresAt ?? null,
  })
}

/**
 * 同源代理播放（母本 :4420-4456 逐行对应）：把 vkey 直链的字节流中继给浏览器，
 * 透传 Range 请求头与 206/content-range 响应头，并补 `Referer: http://y.qq.com` 绕防盗链。
 */
async function handleQQPlay(songmid, request, response) {
  if (!/^[A-Za-z0-9]+$/.test(songmid)) {
    // 母本：非法 mid 回 400 空体。
    response.writeHead(400)
    response.end()
    return
  }
  const dl = await qqTake(songmid)
  if (dl.url === '') {
    // 取不到直链（VIP / 版权限制 / 登录已失效）：纯文本 404，不做登录过期判定（母本注释同此）。
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('无法获取播放地址（可能是 VIP、版权限制，或登录已失效）')
    return
  }
  const upstreamHeaders = { 'User-Agent': QQ_USER_AGENT, Referer: 'http://y.qq.com' }
  if (typeof request.headers.range === 'string') upstreamHeaders.Range = request.headers.range
  let stream
  try {
    stream = await fetch(dl.url, { headers: upstreamHeaders })
  } catch {
    response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    response.end()
    return
  }
  const headers = {
    'content-type': stream.headers.get('content-type') || 'audio/mpeg',
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  }
  // 中文档位要 percent-encode：Node 的 writeHead 拒绝非 ASCII 头值。
  if (dl.quality !== '') headers['x-dsh-qq-quality'] = encodeURIComponent(dl.quality)
  const contentRange = stream.headers.get('content-range')
  if (contentRange !== null) headers['content-range'] = contentRange
  const contentLength = stream.headers.get('content-length')
  if (contentLength !== null) headers['content-length'] = contentLength
  response.writeHead(stream.status, headers)
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  if (stream.body !== null) {
    for await (const chunk of stream.body) response.write(chunk)
  }
  response.end()
}

/**
 * 逐字歌词（word-level）取数——**加法路由 /qq/lyric-words 专用**。
 * 请求与 lib/qq.js:537-601 的 getQrcLyric 完全相同（同一 module/method/param），
 * 唯一差别：上游把 QRC 的逐词时间轴在映射时丢掉了（只留 {t,end,text} 整行窗口，
 * 见 qq.js 注释「词级时间轴（words）当前不下发」），这里用同一个 lib/qrc.js 的
 * decryptHex + parseQrc 把 words 一并保留，供侧边栏逐字高亮。
 * 返回 [{t,end,text,words:[{t,dur,text}]}]（秒）；该曲没有逐字流时返回 null。
 */
async function qqFetchQrcWords(info, cookie) {
  const songid = Number(info && info.songid)
  if (!Number.isFinite(songid) || songid <= 0) return null
  const b64 = (s) => Buffer.from(String(s ?? ''), 'utf8').toString('base64')
  const param = {
    albumName: b64(info.album),
    crypt: 1,
    ct: 19,
    cv: 2111,
    interval: Math.max(0, Math.round(Number(info.interval) || 0)),
    lrc_t: 0,
    qrc: 1,
    qrc_t: 0,
    roma: 1,
    roma_t: 0,
    singerName: b64(info.artist),
    songID: songid,
    songName: b64(info.title),
    trans: 1,
    trans_t: 0,
    type: 0,
  }
  const body = JSON.stringify({
    comm: { ct: '19', cv: '2111', format: 'json' },
    req: { module: 'music.musichallSong.PlayLyricInfo', method: 'GetPlayLyricInfo', param },
  })
  const res = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    headers: {
      'User-Agent': QQ_USER_AGENT,
      Referer: 'https://y.qq.com/',
      Origin: 'https://y.qq.com',
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body,
  })
  const j = await res.json().catch(() => null)
  if (j === null || Number(j.code) !== 0) return null
  const r = j.req || {}
  if (Number(r.code) !== 0) return null
  const data = r.data || {}
  const cipherHex = typeof data.lyric === 'string' ? data.lyric : ''
  if (cipherHex === '') return null
  // 没有逐字流（qrc_t=0）时回 null，让前端回落 /qq/lyric 的整行歌词。
  if (String(data.qrc_t ?? '0') === '0') return null
  const rows = qrcParse(qrcDecryptHex(cipherHex))
  return rows.map((row) => ({
    t: Number(row.startMs) / 1000,
    end: (Number(row.startMs) + Number(row.durMs)) / 1000,
    text: String(row.text ?? ''),
    words: (Array.isArray(row.words) ? row.words : []).map((w) => ({
      t: Number(w.startMs) / 1000,
      dur: Number(w.durMs) / 1000,
      text: String(w.text ?? ''),
    })),
  }))
}

/**
 * QQ 路由总入口（挂在 `${ROUTE_PREFIX}/qq` 下，走本插件 handleRequest，继承 trustedHosts 围栏）。
 * 路由集与响应形状逐条对齐母本 lib/index.js:4358-4634；别名与 /qq/lyric-words 是纯加法。
 */
async function handleQQ(url, request, response) {
  const pathname = url.pathname
  const method = request.method
  try {
    // ── 母本逐条对应区（前缀已换） ──────────────────────────────────────────
    if (pathname === `${QQ_PATH}/status` && method === 'GET') {
      loadQQCookie()
      // 无 ok 字段：与母本一致（前端照抄母本时读 loggedIn/uin/nickname/loginFrom）。
      writeJson(response, 200, qqAuthPayload())
      return
    }
    // ── VIP 判定（加法路由；母本无独立入口，只有 /qq/search 顺带回一个 isVip） ──
    // 前端用它拦「登录了但不是 VIP」的曲目：判据是 lib\qq.js 的 detectVip（:427-439）。
    // 未登录不报 4xx —— 前端要能区分「没登录」与「登录了但没有 VIP」。
    if (pathname === `${QQ_PATH}/vip` && method === 'GET') {
      loadQQCookie()
      const loggedIn = qq.cookie !== ''
      const isVip = await refreshQQVip()
      writeJson(response, 200, { ok: true, isVip, uin: qqUin(), loggedIn })
      return
    }
    if (pathname === `${QQ_PATH}/login/start` && method === 'POST') {
      const body = await readJsonBody(request)
      const mode = body && body.mode === 'qq' ? 'qq' : 'wx'
      const session = mode === 'qq' ? await QQ.createQRLogin() : await QQ.createWXQRLogin()
      qqLoginSession = {
        key: session.key,
        mode,
        expiresAt: session.expiresAt,
        imageDataUrl: session.imageDataUrl,
        createdAt: Date.now(),
      }
      writeJson(response, 200, { ok: true, key: session.key, image: session.imageDataUrl, mode, expiresAt: session.expiresAt })
      return
    }
    if (pathname === `${QQ_PATH}/login/check` && method === 'GET') {
      const key = (url.searchParams.get('key') || '').trim()
      if (key === '') {
        writeJson(response, 400, { ok: false, error: 'missing key' })
        return
      }
      const isWx = /(?:^|&)type=wx(?:&|$)/.test(key)
      const result = isWx ? await QQ.checkWXQRLogin(key) : await QQ.checkQRLogin(key)
      if (result.status === 'success') {
        qqApplyLogin(result, isWx ? 'wx' : 'qq')
        writeJson(response, 200, {
          ok: true,
          status: 'success',
          ...qqAuthPayload(),
          message: result.message,
          extra: result.extra,
        })
        return
      }
      writeJson(response, 200, { ok: true, status: result.status, message: result.message, extra: result.extra })
      return
    }
    if (pathname === `${QQ_PATH}/login/logout` && method === 'POST') {
      clearQQCookie()
      writeJson(response, 200, { ok: true, loggedIn: false })
      return
    }
    if (pathname === `${QQ_PATH}/search` && method === 'GET') {
      const w = (url.searchParams.get('w') || '').trim()
      if (w === '') {
        writeJson(response, 400, { ok: false, error: 'missing query' })
        return
      }
      const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1)
      loadQQCookie()
      const isVip = await refreshQQVip()
      const s = await QQ.search(w, qq.cookie, page)
      writeJson(response, 200, { ok: true, isVip, results: s.results, total: s.total, page: s.page })
      return
    }
    if (pathname.startsWith(`${QQ_PATH}/play/`) && (method === 'GET' || method === 'HEAD')) {
      const songmid = decodeURIComponent(pathname.slice(`${QQ_PATH}/play/`.length))
      await handleQQPlay(songmid, request, response)
      return
    }
    if (pathname === `${QQ_PATH}/playlist-categories` && method === 'GET') {
      loadQQCookie()
      writeJson(response, 200, { ok: true, categories: await QQ.getPlaylistCategories(qq.cookie) })
      return
    }
    if (pathname === `${QQ_PATH}/playlist-search` && method === 'GET') {
      const w = (url.searchParams.get('w') || '').trim()
      if (w === '') {
        writeJson(response, 400, { ok: false, error: 'missing query' })
        return
      }
      const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1)
      loadQQCookie()
      const s = await QQ.searchPlaylist(w, qq.cookie, page)
      writeJson(response, 200, { ok: true, playlists: s.results, total: s.total, page: s.page })
      return
    }
    if (pathname === `${QQ_PATH}/playlists` && method === 'GET') {
      const category = (url.searchParams.get('category') || '').trim()
      loadQQCookie()
      if (category === '') {
        writeJson(response, 200, { ok: true, playlists: await QQ.getRecommendedPlaylists(qq.cookie) })
        return
      }
      const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1)
      writeJson(response, 200, { ok: true, playlists: await QQ.getCategoryPlaylists(category, page, 20, qq.cookie) })
      return
    }
    if (pathname === `${QQ_PATH}/my-playlists` && method === 'GET') {
      loadQQCookie()
      writeJson(response, 200, { ok: true, playlists: await QQ.getMyPlaylists(qq.cookie), uin: qqUin() })
      return
    }
    if (pathname === `${QQ_PATH}/fav` && method === 'POST') {
      const body = await readJsonBody(request)
      const action = body && body.action === 'remove' ? 'remove' : 'add'
      loadQQCookie()
      const ok = action === 'remove' ? await QQ.removeQQFav(body.song, qq.cookie) : await QQ.addQQFav(body.song, qq.cookie)
      writeJson(response, 200, { ok, faved: action === 'add' ? ok : !ok })
      return
    }
    if (pathname === `${QQ_PATH}/playlist-add` && method === 'POST') {
      const body = await readJsonBody(request)
      loadQQCookie()
      const ok = await QQ.addSongToPlaylist(body.song, Number(body.dirId) || 0, Number(body.tid) || 0, qq.cookie)
      writeJson(response, 200, { ok })
      return
    }
    if (pathname === `${QQ_PATH}/playlist-remove` && method === 'POST') {
      const body = await readJsonBody(request)
      loadQQCookie()
      const ok = await QQ.deleteSongFromPlaylist(body.song, Number(body.dirId) || 0, Number(body.tid) || 0, qq.cookie)
      writeJson(response, 200, { ok })
      return
    }
    if (pathname === `${QQ_PATH}/playlist-create` && method === 'POST') {
      const body = await readJsonBody(request)
      const name = String((body && body.name) || '').trim()
      if (name === '') {
        writeJson(response, 400, { ok: false, error: '歌单名不能为空' })
        return
      }
      loadQQCookie()
      const created = await QQ.createPlaylist(name, qq.cookie)
      writeJson(response, 200, { ok: true, playlist: created })
      return
    }
    if (pathname === `${QQ_PATH}/playlist-delete` && method === 'POST') {
      const body = await readJsonBody(request)
      const dirId = Number(body && body.dirId) || 0
      if (!dirId) {
        writeJson(response, 400, { ok: false, error: '缺少歌单 dirId' })
        return
      }
      loadQQCookie()
      const ok = await QQ.deletePlaylist(dirId, qq.cookie)
      writeJson(response, 200, { ok })
      return
    }
    if (pathname === `${QQ_PATH}/liked` && method === 'GET') {
      loadQQCookie()
      const fav = await QQ.getQQFavIds(qq.cookie)
      writeJson(response, 200, { ok: true, ids: (fav && fav.ids) || [], mids: (fav && fav.mids) || [] })
      return
    }
    if (pathname === `${QQ_PATH}/top-lists` && method === 'GET') {
      loadQQCookie()
      writeJson(response, 200, { ok: true, groups: await QQ.getTopLists(qq.cookie) })
      return
    }
    if (pathname === `${QQ_PATH}/top-songs` && method === 'GET') {
      const topId = (url.searchParams.get('topId') || '').trim()
      if (!/^[0-9]+$/.test(topId)) {
        writeJson(response, 400, { ok: false, error: 'bad topId' })
        return
      }
      const offset = parseInt(url.searchParams.get('offset') || '0', 10)
      const num = parseInt(url.searchParams.get('num') || '30', 10)
      loadQQCookie()
      const toplist = await QQ.getTopListSongs(topId, qq.cookie, Number.isFinite(offset) ? offset : 0, Number.isFinite(num) ? num : 30)
      writeJson(response, 200, { ok: true, toplist })
      return
    }
    if (pathname === `${QQ_PATH}/new-songs` && method === 'GET') {
      const type = parseInt(url.searchParams.get('type') || '5', 10)
      loadQQCookie()
      writeJson(response, 200, { ok: true, result: await QQ.getNewSongs(Number.isFinite(type) ? type : 5, qq.cookie) })
      return
    }
    // ── 免费时长：自动化「看广告换免费时长」外壳 ──────────────────────────
    // 边界必须说清：QQ 音乐「浏览 15 秒免费听 5 分钟」是客户端内的私有机制，
    // 网页版没有对应入口 —— 所以这里做的是**自动化外壳**：开一个独立的浏览器
    // app 窗口（各自独立 user-data-dir，支持多开）→ 到秒数自动 taskkill。
    // 真实时长是否到账取决于 QQ 音乐服务端；本地累计由客户端负责，不伪造奖励。
    if (pathname === `${QQ_PATH}/free/open` && method === 'POST') {
      const body = await readJsonBody(request)
      const rawUrl = (body && typeof body.url === 'string' && body.url !== '') ? body.url : 'https://y.qq.com/'
      let u = null
      try { u = new URL(rawUrl) } catch { u = null }
      if (u === null || (u.protocol !== 'https:' && u.protocol !== 'http:')) {
        writeJson(response, 400, { ok: false, error: 'bad url' })
        return
      }
      const sec = Math.max(5, Math.min(120, Number(body && body.seconds) || 15))
      const want = Math.max(1, Math.min(6, Number(body && body.count) || 1))
      const browser = findBrowserExecutable()
      if (browser === '') {
        writeJson(response, 500, { ok: false, error: 'no-chromium-browser' })
        return
      }
      const opened = []
      for (let i = 0; i < want; i++) {
        try {
          const profileDir = join(homedir(), '.dsh', 'free-ad-profiles', 'p' + Date.now() + '_' + i + '_' + Math.random().toString(36).slice(2, 6))
          mkdirSync(profileDir, { recursive: true })
          const child = spawn(browser, [
            '--app=' + u.href,
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-features=Translate',
            '--user-data-dir=' + profileDir
          ], { detached: true, stdio: 'ignore' })
          child.unref()
          const pid = child.pid
          opened.push({ pid, profileDir })
          if (typeof pid === 'number' && pid > 0) {
            const t = setTimeout(function () {
              try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 进程可能已自行退出 */ }
            }, sec * 1000)
            if (t && typeof t.unref === 'function') t.unref()
          }
        } catch { /* 单个窗口开失败不影响其它 */ }
      }
      writeJson(response, 200, { ok: true, opened, seconds: sec })
      return
    }
    if (pathname === `${QQ_PATH}/lyric` && method === 'GET') {
      // 参数名 songmid（母本同名）；别名 `mid` 也接受，别的什么都不认。
      const songmid = (url.searchParams.get('songmid') || url.searchParams.get('mid') || '').trim()
      if (songmid === '' || !/^[0-9A-Za-z_-]+$/.test(songmid)) {
        writeJson(response, 400, { ok: false, error: 'bad songmid' })
        return
      }
      loadQQCookie()
      let info = qqMidInfoCache.get(songmid)
      if (info === undefined) {
        try {
          info = await QQ.getSongInfoByMid(songmid, qq.cookie)
        } catch {
          info = null
        }
        qqMidInfoCache.set(songmid, info)
        if (qqMidInfoCache.size > QQ_MID_INFO_MAX) {
          const oldest = qqMidInfoCache.keys().next().value
          if (oldest !== undefined) qqMidInfoCache.delete(oldest)
        }
      }
      if (info) {
        try {
          const q = await QQ.getQrcLyric(info, qq.cookie)
          if (q !== null && Array.isArray(q.lines) && q.lines.length > 0) {
            writeJson(response, 200, {
              ok: true,
              hasLyric: true,
              source: 'qq-qrc',
              // 母本键名，逐字数据；照抄母本的前端读它做逐字高亮。
              wordLines: q.lines,
              // 加法（母本没有）：同一份逐字数据投影成统一 {t,text} 形状，
              // 供我们自己的侧边栏歌词组件按时间轴直接消费。
              lines: q.lines.map((line) => ({ t: Number(line?.t ?? 0), end: Number(line?.end ?? 0), text: String(line?.text ?? '') })),
            })
            return
          }
        } catch {
          // QRC 取不到就静默回落 LRC（母本同策略，不打扰播放）。
        }
      }
      const { lyric, trans } = await QQ.getLyric(songmid, qq.cookie)
      const lrc = qqParseLrc(lyric)
      writeJson(response, 200, { ok: true, hasLyric: lrc.length > 0, lrc, trans: qqParseLrc(trans) })
      return
    }
    if (pathname === `${QQ_PATH}/lyric-words` && method === 'GET') {
      // 加法路由（母本没有，也没有删改母本任何形状）：同样的 QRC 歌，把上游丢弃的
      // 逐词时间轴一并下发，供我们侧边栏做「一个字一个字点亮」。
      const songmid = (url.searchParams.get('songmid') || url.searchParams.get('mid') || '').trim()
      if (songmid === '' || !/^[0-9A-Za-z_-]+$/.test(songmid)) {
        writeJson(response, 400, { ok: false, error: 'bad songmid' })
        return
      }
      loadQQCookie()
      let rows = qqWordsCache.get(songmid)
      if (rows === undefined) {
        let info = qqMidInfoCache.get(songmid)
        if (info === undefined) {
          try {
            info = await QQ.getSongInfoByMid(songmid, qq.cookie)
          } catch {
            info = null
          }
          qqMidInfoCache.set(songmid, info)
          if (qqMidInfoCache.size > QQ_MID_INFO_MAX) {
            const oldest = qqMidInfoCache.keys().next().value
            if (oldest !== undefined) qqMidInfoCache.delete(oldest)
          }
        }
        rows = info === null ? null : await qqFetchQrcWords(info, qq.cookie).catch(() => null)
        qqWordsCache.set(songmid, rows)
        if (qqWordsCache.size > 50) {
          const oldest = qqWordsCache.keys().next().value
          if (oldest !== undefined) qqWordsCache.delete(oldest)
        }
      }
      if (rows === null || rows.length === 0) {
        writeJson(response, 200, { ok: true, hasWords: false, source: 'qq-qrc-words', wordLines: [], lines: [] })
        return
      }
      writeJson(response, 200, {
        ok: true,
        hasWords: true,
        source: 'qq-qrc-words',
        wordLines: rows,
        lines: rows.map((row) => ({ t: row.t, end: row.end, text: row.text })),
      })
      return
    }
    if (pathname.startsWith(`${QQ_PATH}/playlist/`) && method === 'GET') {
      const id = decodeURIComponent(pathname.slice(`${QQ_PATH}/playlist/`.length))
      if (id === '' || !/^[0-9A-Za-z:]+$/.test(id)) {
        writeJson(response, 400, { ok: false, error: 'bad id' })
        return
      }
      loadQQCookie()
      try {
        const detail = await QQ.getPlaylistSongs(id, qq.cookie)
        writeJson(response, 200, { ok: true, playlist: detail })
      } catch (error) {
        // 母本此处是 404（不是 502）。
        writeJson(response, 404, qqError(error))
      }
      return
    }
    // ── MV：取 vid（前端拿它决定是否显示 MV 按钮；无 MV 不是错误） ──────────
    if (pathname === `${QQ_PATH}/mv-vid` && method === 'GET') {
      const songmid = (url.searchParams.get('songmid') || url.searchParams.get('mid') || '').trim()
      if (songmid === '' || !/^[A-Za-z0-9]+$/.test(songmid)) {
        writeJson(response, 400, { ok: false, error: 'bad songmid' })
        return
      }
      try {
        const info = await qqFetchMvVid(songmid)
        writeJson(response, 200, { ok: true, hasMv: info.hasMv, vid: info.vid, mvid: info.mvid, name: info.name })
      } catch (error) {
        writeJson(response, 502, qqError(error))
      }
      return
    }
    // ── MV：同源流代理（透传 Range/206/Content-Range，支持 HEAD，可中途 abort） ──
    if (pathname.startsWith(`${QQ_PATH}/mv/`) && (method === 'GET' || method === 'HEAD')) {
      const vid = decodeURIComponent(pathname.slice(`${QQ_PATH}/mv/`.length))
      if (vid === '' || !/^[A-Za-z0-9]+$/.test(vid)) {
        writeJson(response, 400, { ok: false, error: 'bad vid' })
        return
      }
      loadQQCookie()
      let targetUrl = ''
      try {
        targetUrl = await qqFetchMvUrl(vid, qq.cookie)
      } catch {
        targetUrl = ''
      }
      if (targetUrl === '') {
        writeJson(response, 502, { ok: false, error: 'mv url unavailable' })
        return
      }
      const upstreamHeaders = { 'User-Agent': QQ_USER_AGENT, Referer: 'https://y.qq.com/' }
      if (typeof request.headers.range === 'string' && request.headers.range !== '') {
        upstreamHeaders.Range = request.headers.range
      }
      let upstream
      try {
        upstream = await fetch(targetUrl, { method: method === 'HEAD' ? 'HEAD' : 'GET', headers: upstreamHeaders })
      } catch {
        writeJson(response, 502, { ok: false, error: 'mv upstream failed' })
        return
      }
      const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' }
      const contentRange = upstream.headers.get('content-range')
      if (contentRange !== null) headers['Content-Range'] = contentRange
      const contentLength = upstream.headers.get('content-length')
      if (contentLength !== null) headers['Content-Length'] = contentLength
      response.writeHead(upstream.status, headers)
      if (method === 'HEAD' || upstream.body === null) {
        if (upstream.body !== null) {
          try { await upstream.body.cancel() } catch { /* 忽略 */ }
        }
        response.end()
        return
      }
      const stream = Readable.fromWeb(upstream.body)
      request.on('close', () => { try { stream.destroy() } catch { /* 客户端 seek 会反复 abort */ } })
      stream.on('error', () => { try { response.destroy() } catch { /* 忽略 */ } })
      stream.pipe(response)
      return
    }
    // ── 别名区（纯加法；母本没有这几个路径，形状不改动上面任何一条） ────────
    if (pathname === `${QQ_PATH}/qr` && method === 'GET') {
      // 服务端持有会话版：取二维码图（默认 JSON 带 data URL，?format=png 给原始 PNG）。
      // 复用窗口内的重复请求回同一把 key，`?fresh=1` 强制换新码。
      const fresh = url.searchParams.get('fresh') === '1'
      const now = Date.now()
      if (!fresh && qqLoginSession !== null && now - qqLoginSession.createdAt < QQ_QR_REUSE_MS) {
        writeQQQrPayload(url, qqLoginSession, response)
        return
      }
      const session = await QQ.createQRLogin()
      qqLoginSession = {
        key: session.key,
        mode: 'qq',
        expiresAt: session.expiresAt,
        imageDataUrl: session.imageDataUrl,
        createdAt: now,
      }
      writeQQQrPayload(url, qqLoginSession, response)
      return
    }
    if (pathname === `${QQ_PATH}/qr/status` && method === 'GET') {
      // 轮询服务端会话。**不设本地过期门**：服务端 120 s 自己判死并回 status='expired'。
      loadQQCookie()
      if (qq.cookie !== '') {
        writeJson(response, 200, { ok: true, status: 'logged-in', ...qqAuthPayload() })
        return
      }
      const session = qqLoginSession
      if (session === null) {
        writeJson(response, 200, { ok: true, status: 'idle', ...qqAuthPayload(), message: '尚未获取二维码' })
        return
      }
      const result = session.mode === 'wx' ? await QQ.checkWXQRLogin(session.key) : await QQ.checkQRLogin(session.key)
      if (result.status === 'success') {
        qqApplyLogin(result, session.mode)
        writeJson(response, 200, { ok: true, status: 'success', ...qqAuthPayload(), message: result.message, extra: result.extra })
        return
      }
      writeJson(response, 200, { ok: true, status: result.status, ...qqAuthPayload(), message: result.message, extra: result.extra })
      return
    }
    if (pathname === `${QQ_PATH}/playlist` && method === 'GET') {
      // 别名：查询串写 id（母本用路径式 /qq/playlist/<id>，两者等价）。
      const id = (url.searchParams.get('id') || '').trim()
      if (id === '' || !/^[0-9A-Za-z:]+$/.test(id)) {
        writeJson(response, 400, { ok: false, error: 'bad id' })
        return
      }
      loadQQCookie()
      try {
        const detail = await QQ.getPlaylistSongs(id, qq.cookie)
        writeJson(response, 200, { ok: true, playlist: detail })
      } catch (error) {
        writeJson(response, 404, qqError(error))
      }
      return
    }
    throw new MediaError('not-found', `unknown qq route ${pathname}`, 404)
  } catch (error) {
    if (response.headersSent) {
      try {
        response.destroy()
      } catch {
        // 连接已断，忽略。
      }
      return
    }
    // QQ 路由内一律 `{ok:false,error:'字符串'}`（同母本）；取不到上游就给 502。
    writeJson(response, error instanceof MediaError ? error.status : 502, qqError(error))
  }
}

async function handleRequest(request, response, ctx) {
  try {
    // 不读取 ctx.webRuntime：本插件 inject 已不含该服务，Cordis 下对未 inject 的 ctx 服务即使短路读取属性
    // 也会抛 "cannot get property \"webRuntime\" without inject"，导致 handleRequest 全路由 500。
    // 桌面端请求全部走 127.0.0.1(loopback)，isTrustedApiRequest 对 loopback 无条件放行，故 trustedHosts 固定空数组。
    const trustedHosts = []
    if (!isTrustedApiRequest(request, trustedHosts)) {
      throw new MediaError('forbidden', 'untrusted host', 403)
    }
    const url = new URL(request.url ?? '/', 'http://localhost')
    // 诊断回写（临时）：客户端把激活/注册进度打到 ~/.dsh/data/smp-diag.log，
    // 用来定位「侧边栏页签没出现」这类渲染侧静默失败。只写本机文件，不联网。
    if (url.pathname === `${ROUTE_PREFIX}/diag`) {
      try {
        const { mkdirSync, appendFileSync } = await import('node:fs')
        const { homedir } = await import('node:os')
        const { join } = await import('node:path')
        const dir = join(homedir(), '.dsh', 'data')
        mkdirSync(dir, { recursive: true })
        appendFileSync(join(dir, 'smp-diag.log'), `${new Date().toISOString()} ${url.searchParams.get('m') ?? ''}\n`, 'utf8')
      } catch (e) {}
      writeJson(response, 200, { ok: true })
      return
    }
    if (url.pathname === MEDIA_PATH) {
      await handleMedia(url, ctx, request, response)
      return
    }
    if (url.pathname === LYRIC_PATH) {
      await handleLyric(url, ctx, request, response)
      return
    }
    if (url.pathname === SUBTITLE_PATH) {
      await handleSubtitle(url, ctx, request, response)
      return
    }
    if (url.pathname === LIBRARY_PATH) {
      await handleLibrary(url, ctx, request, response)
      return
    }
    if (url.pathname === DIR_PATH) {
      await handleDir(url, ctx, request, response)
      return
    }
    if (url.pathname === DURATION_PATH) {
      await handleDuration(url, ctx, request, response)
      return
    }
    if (url.pathname === QQ_PATH || url.pathname.startsWith(`${QQ_PATH}/`)) {
      await handleQQ(url, request, response)
      return
    }
    throw new MediaError('not-found', `unknown route ${url.pathname}`, 404)
  } catch (error) {
    writeError(response, error)
  }
}

/**
 * 在宿主 web 服务器上挂前缀路由。
 * @returns {() => void} 卸载函数（fiber teardown 时由 ctx.effect 调用）
 */
function registerMediaRoutes(ctx) {
  const webServer = ctx.webServer
  if (webServer === undefined) return () => {}
  return webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (request, response) => {
      handleRequest(request, response, ctx)
    },
  })
}

/** 挂载插件（ctx.effect 保证停用/HMR 时路由被摘掉）。 */
export function apply(ctx) {
  ctx.effect(() => registerMediaRoutes(ctx), 'dsh-sidebar-media-player: media route')
}

// ── 自测导出（node --test / 手工断言用；不参与运行时） ──────────────────────
export const __internals = {
  ROUTE_PREFIX,
  MEDIA_PATH,
  LYRIC_PATH,
  SUBTITLE_PATH,
  LIBRARY_PATH,
  DIR_PATH,
  DURATION_PATH,
  probeDurationFromBuffer,
  MEDIA_TYPES,
  parseRange,
  isWithin,
  isTrustedApiRequest,
  parseLrc,
  decodeBufferToText,
  srtToVtt,
  assToVtt,
  assTimeToVtt,
  allowedBases,
  isAllowedTarget,
  musicLibraryRoot,
}