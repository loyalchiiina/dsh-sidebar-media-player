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
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve } from 'node:path'

/** Plugin identity — 必须与 package.json 的 name 一致，client bundle 靠它对上号。 */
export const name = 'dsh-sidebar-media-player'

/** 挂载前需要就绪的服务：web 服务器 + 会话存储（取权威 cwd）+ web 运行时（trustedHosts）。 */
export const inject = ['webServer', 'sessions', 'webRuntime']

/** 本插件独占的路由前缀（避免与别的插件撞车）。 */
const ROUTE_PREFIX = '/dsh-sidebar-media-player'

/** 媒体端点。 */
const MEDIA_PATH = `${ROUTE_PREFIX}/media`

/** 歌词端点（读同目录同名 .lrc，回 JSON）。 */
const LYRIC_PATH = `${ROUTE_PREFIX}/lyric`

/** 字幕端点（同目录同名 .vtt/.srt/.ass，统一转 VTT 回纯文本）。 */
const SUBTITLE_PATH = `${ROUTE_PREFIX}/subtitle`

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
  // 路径围栏：必须落在会话 cwd 之下（含 cwd 本身）
  if (!isWithin(resolve(cwd), target)) {
    throw new MediaError('forbidden', `"${raw}" is outside the session working directory`, 403)
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
  if (!isWithin(resolve(base), target)) {
    throw new MediaError('forbidden', `"${raw}" is outside the session working directory`, 403)
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

async function handleRequest(request, response, ctx) {
  try {
    const trustedHosts = ctx.webRuntime?.trustedHosts ?? []
    if (!isTrustedApiRequest(request, trustedHosts)) {
      throw new MediaError('forbidden', 'untrusted host', 403)
    }
    const url = new URL(request.url ?? '/', 'http://localhost')
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
  MEDIA_TYPES,
  parseRange,
  isWithin,
  isTrustedApiRequest,
  parseLrc,
  decodeBufferToText,
  srtToVtt,
  assToVtt,
  assTimeToVtt,
}