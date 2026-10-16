/**
 * 配置文件分两个顶层组（键名区分大小写）：
 *
 *   config:
 *     MenuItems:                     # ⋯ 菜单里的项
 *       official:                    # 官方 4 项（不写 = 完全不动）
 *         pin:     { label, activeLabel, order, hidden }
 *         rename:  { hidden }        # 只支持 hidden
 *         fork:    { label, order, hidden }
 *         archive: { label, activeLabel, order, hidden }
 *       plugin:
 *         delete:  { label, order, hidden, danger, disabled, shortcut, separatorBefore }
 *     ButtonItems:                   # 会话行悬停时的图标按钮
 *       official:
 *         archive: { hidden }        # 只支持 hidden
 *         pin:     { hidden }        # 只支持 hidden
 *       plugin: {}                   # 占位：本插件不提供悬停按钮
 *
 * 官方项一律"不写就不碰"；其行为永不改变，只覆盖显示。
 */
/**
 * dsh-session-tool —— DSH 会话删除插件（宿主半边）。
 *
 * 能力：
 *   · 同源 HTTP 桥：GET /list（会话清单/运行状态）、POST /delete（执行删除）、GET /config（界面配置）
 *   · 删除 = 【永久删除，不可恢复】；运行中的会话会先停止，再删除
 *   · 全部界面配置问题与每次删除都写入 ~/.dsh/logs/dsh-session-tool.log
 *
 * 删除链路（六步）：
 *   1. 回环 + 同源校验；
 *   2. 运行中的会话：cancel + whenIdle 等它静默（最多 15s）；
 *   3. flush + 从内存会话表 detach，避免 dispose 阶段把日志目录重建回来；
 *   4. 删除磁盘日志目录（收尾再扫一遍，防止被重建）；
 *   5. 清理记账：投影缓存行 + 工作区 sessionIds + 全局归档集合；
 *   6. 写审计日志。
 *
 * 只用 Node 内置模块 + 宿主服务（ctx.get(...)），不 import 任何 @deepseek-ai 的值。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'dsh-session-tool'
export const inject = []

/* --------------------------------- 日志 ---------------------------------- */

const LOG_NAME = 'dsh-session-tool.log'
const LOG_MAX_BYTES = 1024 * 1024
const logsDir = () => join(dshHome(), 'logs')
const logPath = () => join(logsDir(), LOG_NAME)

/**
 * 追加一行日志；超过 1 MB 就先轮转成 .1（覆盖旧的 .1）。日志失败绝不影响主流程。
 * @param category - 类别：config / delete / plugin
 * @param level - 结果：warn / ok / failed / info
 * @param message - 正文
 */
function logLine(category, level, message) {
  try {
    const dir = logsDir()
    mkdirSync(dir, { recursive: true })
    const file = logPath()
    try {
      if (statSync(file).size > LOG_MAX_BYTES) {
        const rotated = file + '.1'
        rmSync(rotated, { force: true })
        renameSync(file, rotated)
      }
    } catch { /* 文件还不存在 */ }
    appendFileSync(file, '[' + new Date().toISOString() + '] ' + category.padEnd(7) + level.padEnd(7) + message + '\n', 'utf8')
  } catch { /* 忽略 */ }
}

const logConfig = (level, message) => logLine('config', level, message)

/**
 * 写一条删除审计记录。
 * @param outcome - ok / missing / refused / failed
 * @param id - 会话裸 id
 * @param label - 展示名（标题（短id））
 * @param extra - 附加字段：running / stopped / dirs / elapsed / reason
 */
function logDelete(outcome, id, label, extra = {}) {
  const parts = ['id=' + SESSION_PREFIX + id]
  if (label) parts.push('title="' + String(label).replace(/"/g, "'") + '"')
  if (extra.running !== undefined) parts.push('running=' + extra.running)
  if (extra.stopped !== undefined) parts.push('stopped=' + extra.stopped)
  if (extra.dirs !== undefined) parts.push('dirs=' + extra.dirs)
  if (extra.elapsed !== undefined) parts.push('elapsed=' + (extra.elapsed / 1000).toFixed(1) + 's')
  if (extra.reason !== undefined) parts.push('reason="' + String(extra.reason).replace(/"/g, "'") + '"')
  logLine('delete', outcome, parts.join('  '))
}

/* --------------------------------- 配置 ---------------------------------- */

/** 官方菜单项的 order 参考值（只用于日志提示）。 */
const OFFICIAL_ORDER = { pin: 100, rename: 200, fork: 300, archive: 400 }

const DEFAULT_CONFIG = {
  menu: { label: '', order: 500, hidden: false, danger: true, disabled: false },
  shippedRows: { pin: {}, rename: {}, fork: {}, archive: {} },
  shippedButtons: { archive: { hidden: false }, pin: { hidden: false } },
}
let PLUGIN_CONFIG = DEFAULT_CONFIG

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function typeName(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** 把常见的键名错误提示成正确写法。 */
function guessKey(key) {
  const map = {
    menuItems: 'MenuItems', menuItem: 'MenuItems', MenuItem: 'MenuItems', menu: 'MenuItems', menuRows: 'MenuItems',
    buttons: 'ButtonItems', buttonItems: 'ButtonItems', buttonsItem: 'ButtonItems', buttonRows: 'ButtonItems', ButtonItem: 'ButtonItems',
  }
  return map[key] ? ' → 你是否想写 "' + map[key] + '"？（键名区分大小写）' : ''
}

function checkKeys(obj, path, allowed) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) logConfig('warn', path + ' 里未知的字段 "' + key + '"（已忽略）')
  }
}

function readString(obj, path, key, fallback) {
  const value = obj[key]
  if (value === undefined) return fallback
  if (typeof value !== 'string') { logConfig('warn', path + '.' + key + ' 应为字符串，收到 ' + typeName(value) + '（已忽略）'); return fallback }
  return value
}

function readOrder(obj, path, key, fallback) {
  const value = obj[key]
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) { logConfig('warn', path + '.' + key + ' 应为数字，收到 ' + typeName(value) + '（已忽略）'); return fallback }
  return value
}

function readBool(obj, path, key, fallback) {
  const value = obj[key]
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') { logConfig('warn', path + '.' + key + ' 应为布尔值，收到 ' + typeName(value) + '（已忽略）'); return fallback }
  return value
}

/** 官方悬停按钮的显示配置：只支持 hidden。 */
function hiddenOnly(raw, path) {
  const item = asObject(raw)
  checkKeys(item, path, ['hidden', 'label', 'activeLabel', 'order'])
  for (const key of ['label', 'activeLabel', 'order']) {
    if (item[key] !== undefined) logConfig('warn', path + '.' + key + ' 不支持修改（该项只能 hidden），已忽略')
  }
  return { hidden: readBool(item, path, 'hidden', false) }
}

/** 官方菜单行的显示配置：label / activeLabel / order / hidden（未写的字段不覆盖默认行为）。 */
function officialRow(raw, path, writable) {
  const item = asObject(raw)
  checkKeys(item, path, ['label', 'activeLabel', 'order', 'hidden'])
  const out = { hidden: readBool(item, path, 'hidden', false) }
  if (!writable) {
    for (const key of ['label', 'activeLabel', 'order']) {
      if (item[key] !== undefined) logConfig('warn', path + '.' + key + ' 不支持修改（该项只能 hidden），已忽略')
    }
    return out
  }
  const label = readString(item, path, 'label', undefined)
  const activeLabel = readString(item, path, 'activeLabel', undefined)
  const order = readOrder(item, path, 'order', undefined)
  if (label !== undefined && label !== '') out.label = label
  if (activeLabel !== undefined && activeLabel !== '') out.activeLabel = activeLabel
  if (order !== undefined) out.order = order
  return out
}

/**
 * 解析配置。严格采用两个分组：MenuItems（⋯ 菜单里的项）与 ButtonItems（入口按钮），键名区分大小写。
 * 未知键 / 类型错误只写日志，不影响插件加载。
 */
function normalizeConfig(raw) {
  const cfg = asObject(raw)
  for (const key of Object.keys(cfg)) if (key !== 'MenuItems' && key !== 'ButtonItems') logConfig('warn', '未知的配置键 "' + key + '"' + guessKey(key))

  const menuItems = asObject(cfg.MenuItems)
  const buttons = asObject(cfg.ButtonItems)
  checkKeys(menuItems, 'MenuItems', ['official', 'plugin'])
  checkKeys(buttons, 'ButtonItems', ['official', 'plugin'])

  const officialGroup = asObject(menuItems.official)
  checkKeys(officialGroup, 'MenuItems.official', ['pin', 'rename', 'fork', 'archive'])
  const pluginGroup = asObject(menuItems.plugin)
  checkKeys(pluginGroup, 'MenuItems.plugin', ['delete'])
  const del = asObject(pluginGroup.delete)

  const menuPath = 'MenuItems.plugin.delete'
  checkKeys(del, menuPath, ['label', 'order', 'hidden', 'danger', 'disabled', 'shortcut', 'separatorBefore'])
  const menu = {
    label: readString(del, menuPath, 'label', ''),
    order: readOrder(del, menuPath, 'order', DEFAULT_CONFIG.menu.order),
    hidden: readBool(del, menuPath, 'hidden', false),
    danger: readBool(del, menuPath, 'danger', true),
    disabled: readBool(del, menuPath, 'disabled', false),
  }
  if (del.shortcut !== undefined) logConfig('warn', menuPath + '.shortcut 已登记但本阶段尚未实现（暂不生效）')
  if (del.separatorBefore !== undefined) {
    readBool(del, menuPath, 'separatorBefore', false)
    logConfig('warn', menuPath + '.separatorBefore 已登记但本阶段尚未实现（暂不生效）')
  }
  if (menu.order === OFFICIAL_ORDER.rename && menu.order !== DEFAULT_CONFIG.menu.order) logConfig('warn', menuPath + '.order 与官方「重命名」相同（200），先后顺序不确定，建议错开')

  const buttonOfficial = asObject(buttons.official)
  checkKeys(buttonOfficial, 'ButtonItems.official', ['archive', 'pin'])
  checkKeys(asObject(buttons.plugin), 'ButtonItems.plugin', [])   // 占位分组：当前没有任何字段

  return {
    menu,
    shippedButtons: {
      archive: hiddenOnly(buttonOfficial.archive, 'ButtonItems.official.archive'),
      pin: hiddenOnly(buttonOfficial.pin, 'ButtonItems.official.pin'),
    },
    shippedRows: {
      pin: officialRow(officialGroup.pin, 'MenuItems.official.pin', true),
      rename: officialRow(officialGroup.rename, 'MenuItems.official.rename', false),
      fork: officialRow(officialGroup.fork, 'MenuItems.official.fork', true),
      archive: officialRow(officialGroup.archive, 'MenuItems.official.archive', true),
    },
  }
}

/* -------------------------------- 基础工具 -------------------------------- */

const LABEL = 'dsh-session-tool'
const SESSION_PREFIX = 'session-'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/* --------------------------------- 基础工具 -------------------------------- */

const bareId = (id) => String(id ?? '').replace(/^session-/, '')

/** 会话 id 在磁盘/记账里可能有两种拼写，两种都要清。 */
function sessionIdVariants(id) {
  const bare = bareId(id)
  return bare === '' ? [] : [bare, SESSION_PREFIX + bare]
}

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
}

/* 会话目录 / 投影缓存 / 代理 / 删除底层工具 */
const sessionsRoot = () => join(dshHome(), 'sessions')
const projectionPath = (id) => join(dshHome(), 'storages', 'session_projcache', 'sessions', SESSION_PREFIX + bareId(id) + '.json')

/** 扫描所有工作区分组，返回该会话的所有目录（两种 id 拼写都找）。 */
function locateSessionDirs(id) {
  const wants = sessionIdVariants(id)
  const found = []
  let groups = []
  try { groups = readdirSync(sessionsRoot(), { withFileTypes: true }) } catch { return found }
  for (const group of groups) {
    if (!group.isDirectory()) continue
    for (const want of wants) {
      const dir = join(sessionsRoot(), group.name, want)
      try { if (statSync(dir).isDirectory() && !found.includes(dir)) found.push(dir) } catch { /* 不存在 */ }
    }
  }
  return found
}

function dirSize(dir) {
  let total = 0
  const walk = (p) => {
    let entries = []
    try { entries = readdirSync(p, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = join(p, e.name)
      if (e.isDirectory()) walk(full)
      else { try { total += statSync(full).size } catch { /* 忽略 */ } }
    }
  }
  walk(dir)
  return total
}

function readProjection(id) {
  try {
    const record = JSON.parse(readFileSync(projectionPath(id), 'utf8'))?.record ?? {}
    return {
      title: record?.rows?.title?.val ?? undefined,
      createdAt: record?.identity?.createdAt ?? undefined,
      cwd: record?.identity?.cwd ?? undefined,
    }
  } catch { return {} }
}


const service = (ctx, name) => (typeof ctx.get === 'function' ? ctx.get(name) : undefined)

function agentFor(ctx, id) {
  const agents = service(ctx, 'agents')
  if (!agents || typeof agents.get !== 'function') return undefined
  for (const variant of sessionIdVariants(id)) {
    try { const agent = agents.get(variant); if (agent) return agent } catch { /* 忽略 */ }
  }
  return undefined
}

/** 取消运行中的回合并等它静默（有上限，卡住的驱动不阻塞删除）。 */
async function stopAgent(ctx, id) {
  const agent = agentFor(ctx, id)
  if (!agent) return false
  try { if (typeof agent.cancel === 'function') agent.cancel({ kind: 'user' }) } catch { /* 可能已在收尾 */ }
  if (typeof agent.whenIdle === 'function') {
    try { await Promise.race([agent.whenIdle(), new Promise((r) => setTimeout(r, 15000))]) } catch { /* 忽略 */ }
  }
  return true
}

/** 会话活着时先 flush，再把它从内存表里摘掉，防止 dispose 重建日志目录。 */
async function flushAndDetach(ctx, id) {
  const sessions = service(ctx, 'sessions')
  if (!sessions) return { flushed: false, detached: false }
  let flushed = false
  let detached = false
  const variants = sessionIdVariants(id)
  if (typeof sessions.get === 'function' && typeof sessions.flush === 'function') {
    for (const variant of variants) {
      let session
      try { session = sessions.get(variant) } catch { session = undefined }
      if (!session) continue
      try { await sessions.flush(session); flushed = true } catch { /* 删除照样进行 */ }
    }
  }
  try {
    const store = sessions.store
    for (const variant of variants) {
      const entry = store && typeof store.get === 'function' ? store.get(variant) : undefined
      if (entry === undefined) continue
      if (typeof sessions.detachEntered === 'function') { sessions.detachEntered(entry); detached = true }
      else if (store && typeof store.delete === 'function') { store.delete(variant); detached = true }
    }
  } catch { /* 忽略 */ }
  return { flushed, detached }
}

/**
 * 通过活的 storageDomain 清账：投影缓存行 + 工作区记账（sessionIds / 归档集合）。
 * 走活的领域设施而不是直接改文件，内存与磁盘才不会重新写回陈旧行。
 */
async function stripStorage(ctx, id, { workspace = true } = {}) {
  const sd = service(ctx, 'storageDomain')
  if (!sd || typeof sd.get !== 'function') return { projRemoved: false, workspaceRemoved: false }
  const variants = sessionIdVariants(id)
  let projRemoved = false
  let workspaceRemoved = false

  try {
    const proj = sd.get('session_projcache')
    if (proj && typeof proj.table === 'function') {
      const table = proj.table('sessions')
      for (const variant of variants) {
        if (table.get(variant) !== undefined) { await table.delete(variant); projRemoved = true }
      }
    }
  } catch { /* 单元已关或无此表 */ }

  if (workspace) {
    try {
      const ws = sd.get('workspace')
      if (ws && typeof ws.table === 'function') {
        const workspaces = ws.table('workspaces')
        for (const [wid, rec] of workspaces.entries()) {
          if (rec && Array.isArray(rec.sessionIds) && variants.some((v) => rec.sessionIds.includes(v))) {
            await workspaces.put(wid, { ...rec, sessionIds: rec.sessionIds.filter((x) => !variants.includes(x)) })
            workspaceRemoved = true
          }
        }
      }
      const global = ws && ws.global
      if (global && typeof global.get === 'function' && typeof global.set === 'function') {
        const state = global.get()
        if (state && Array.isArray(state.archivedSessionIds) && variants.some((v) => state.archivedSessionIds.includes(v))) {
          await global.set({ ...state, archivedSessionIds: state.archivedSessionIds.filter((x) => !variants.includes(x)) })
          workspaceRemoved = true
        }
      }
    } catch { /* 无 global 槽或单元已关 */ }
  }
  return { projRemoved, workspaceRemoved }
}

/* -------------------------------- 删除核心 -------------------------------- */

/**
 * 删除若干会话（永久删除，不可恢复）。
 * @param targets - [{ id, title }]
 * @param options - { caller }：caller 为调用方自己的会话 id 时拒绝删除
 * @returns {{removed:Array, missing:Array, refused:Array, failed:Array, warnings:Array}}
 */
async function deleteSessions(ctx, targets, options = {}) {
  const registered = accountingIds(ctx)
  const caller = options.caller ?? ''
  const result = { removed: [], missing: [], refused: [], failed: [], warnings: [] }

  for (const item of targets) {
    const started = Date.now()
    const id = bareId(item.id ?? item)
    const label = (item.title ? item.title + '（' + id.slice(0, 8) + '）' : id.slice(0, 8))
    const running = agentFor(ctx, id) !== undefined

    if (caller && id === caller) {
      result.refused.push(label + ' — 当前会话，拒绝删除')
      logDelete('refused', id, label, { running, reason: '调用方自己的会话' })
      continue
    }

    // 1) 运行中的先停机、等静默
    let stopped = false
    if (running) {
      try { stopped = await stopAgent(ctx, id) } catch (error) { result.warnings.push(label + ' — 停止运行失败：' + (error?.message ?? error)) }
    }
    // 2) flush + 从内存表摘除，避免 dispose 重建日志目录
    try {
      const { flushed, detached } = await flushAndDetach(ctx, id)
      if (flushed || detached) result.warnings.push(label + ' — 已 flush=' + flushed + ' detach=' + detached)
    } catch (error) { result.warnings.push(label + ' — flush/detach 失败：' + (error?.message ?? error)) }

    // 3) 文件没了：只清理登记
    const dirs = locateSessionDirs(id)
    if (dirs.length === 0) {
      await stripStorage(ctx, id, { workspace: true })
      try { rmSync(projectionPath(id), { force: true }) } catch { /* 忽略 */ }
      result.missing.push(label + ' — 文件已不存在，只清理了登记')
      logDelete('missing', id, label, { running, stopped, dirs: 0, elapsed: Date.now() - started })
      continue
    }

    // 4) 永久删除磁盘目录
    const failures = []
    let removedDirs = 0
    for (const dir of dirs) {
      try { rmSync(dir, { recursive: true, force: true }); removedDirs++ } catch (error) { failures.push(error?.message ?? String(error)) }
    }
    // 收尾再扫一遍：dispose 可能刚把目录重建回来
    await new Promise((resolve) => setImmediate(resolve))
    for (const stale of locateSessionDirs(id)) {
      try { rmSync(stale, { recursive: true, force: true }); removedDirs++ } catch { /* 忽略 */ }
    }
    if (failures.length > 0 || locateSessionDirs(id).length > 0) {
      const reason = failures.join('; ') || '文件未能完全删除'
      result.failed.push(label + ' — ' + reason)
      logDelete('failed', id, label, { running, stopped, dirs: removedDirs, elapsed: Date.now() - started, reason })
      continue
    }

    // 5) 文件确认没了，才清投影缓存 + 工作区记账（含归档集合）
    try {
      const { workspaceRemoved } = await stripStorage(ctx, id, { workspace: true })
      // 投影缓存是按会话落盘的单个 JSON 文件：领域活着删了行，文件本身也要清掉
      try { rmSync(projectionPath(id), { force: true }) } catch { /* 忽略 */ }
      if (registered.has(id) && !workspaceRemoved) result.warnings.push(label + ' — 工作区记账未能清理，重启后会自动对齐')
    } catch (error) { result.warnings.push(label + ' — 记账清理失败：' + (error?.message ?? error)) }

    result.removed.push(label)
    logDelete('ok', id, label, { running, stopped, dirs: removedDirs, elapsed: Date.now() - started })
  }
  return result
}

/* ------------------------------ 宿主 HTTP 接口 ------------------------------ */

/**
 * 图形界面用的 HTTP 接口：浏览器里的客户端半边 fetch 同源路由。
 * 第三方插件无法新增 Typert RPC namespace，注册同源 HTTP 路由是与界面通信的可用路径。
 * 安全：只接受回环来源 + 同源请求。
 */
const HTTP_PATH = '/__dsh-session-tool/delete'
const LIST_PATH = '/__dsh-session-tool/list'
const CONFIG_PATH = '/__dsh-session-tool/config'
const DIAG_PATH = '/__dsh-session-tool/diag'

function isLocalSameOrigin(req) {
  const addr = String(req?.socket?.remoteAddress ?? '')
  if (!/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(addr)) return false
  const site = String(req?.headers?.['sec-fetch-site'] ?? '')
  if (site !== '' && site !== 'same-origin') return false
  const origin = String(req?.headers?.origin ?? '')
  if (origin !== '') {
    try {
      const host = new URL(origin).hostname
      if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return false
    } catch { return false }
  }
  return true
}

function readJsonBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk; if (data.length > limit) { req.destroy(); reject(new Error('body too large')) } })
    req.on('end', () => { try { resolve(data === '' ? {} : JSON.parse(data)) } catch (error) { reject(error) } })
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
  res.end(body)
}

/** 登记过（在工作区会计或归档集合里）的会话 id 集合。 */
function accountingIds(ctx) {
  const ids = new Set()
  const registry = service(ctx, 'workspaceRegistry')
  if (!registry) return ids
  for (const id of registry.archivedSessionIds ?? []) ids.add(bareId(id))
  try {
    const rows = typeof registry.list === 'function' ? registry.list() : []
    for (const row of rows ?? []) for (const id of row?.sessionIds ?? []) ids.add(bareId(id))
  } catch { /* 忽略 */ }
  return ids
}

/** 列出磁盘上的全部会话（供图形界面做 running 预判 / 标题解析 / notFound 判断）。 */
function collectAll(ctx) {
  const registry = service(ctx, 'workspaceRegistry')
  const archived = new Set((registry?.archivedSessionIds ?? []).map((x) => bareId(x)))
  const items = []
  let groups = []
  try { groups = readdirSync(sessionsRoot(), { withFileTypes: true }) } catch { return items }
  for (const group of groups) {
    if (!group.isDirectory()) continue
    const groupDir = join(sessionsRoot(), group.name)
    let entries = []
    try { entries = readdirSync(groupDir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const id = bareId(entry.name)
      const projection = readProjection(id)
      items.push({
        id,
        title: projection.title ?? null,
        createdAt: projection.createdAt ?? null,
        running: agentFor(ctx, id) !== undefined,
        archived: archived.has(id),
        size: dirSize(join(groupDir, entry.name)),
      })
    }
  }
  return items
}

/** 进程级路由单例：同一进程里本插件被多次加载时，路由只注册一次，避免 "duplicate exact route"。 */
const ROUTES_KEY = Symbol.for('dsh-session-tool.http-routes')
function routesState() {
  if (!globalThis[ROUTES_KEY]) globalThis[ROUTES_KEY] = { dispose: null, users: 0 }
  return globalThis[ROUTES_KEY]
}

function registerHttp(ctx) {
  const state = routesState()
  state.users += 1
  if (typeof state.dispose === 'function') {
    logLine('plugin', 'info', 'HTTP 路由已存在（本插件另一实例已注册），直接复用')
    return true
  }
  const host = service(ctx, 'webServer')
  if (!host || typeof host.register !== 'function') {
    logLine('plugin', 'warn', 'webServer 服务此刻不可用，稍后重试注册 HTTP 路由')
    return false
  }
  const disposers = []
  try {
    disposers.push(host.register({
      kind: 'exact',
      path: LIST_PATH,
      handler: (req, res) => {
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
        if (!isLocalSameOrigin(req)) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return }
        try { sendJson(res, 200, { ok: true, sessions: collectAll(ctx) }) }
        catch (error) { sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }) }
      },
    }))
    disposers.push(host.register({
      kind: 'exact',
      path: CONFIG_PATH,
      handler: (req, res) => {
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
        if (!isLocalSameOrigin(req)) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return }
        sendJson(res, 200, { ok: true, config: PLUGIN_CONFIG })
      },
    }))
    disposers.push(host.register({
      kind: 'exact',
      path: DIAG_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
        if (!isLocalSameOrigin(req)) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return }
        let body
        try { body = await readJsonBody(req) } catch { sendJson(res, 400, { ok: false, error: 'invalid json body' }); return }
        const level = typeof body?.level === 'string' ? body.level : 'info'
        const lines = Array.isArray(body?.lines) ? body.lines.slice(0, 40) : []
        for (const line of lines) logLine('client', level, String(line).slice(0, 400))
        sendJson(res, 200, { ok: true, written: lines.length })
      },
    }))
    disposers.push(host.register({
      kind: 'exact',
      path: HTTP_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
        if (!isLocalSameOrigin(req)) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return }
        let body
        try { body = await readJsonBody(req) } catch { sendJson(res, 400, { ok: false, error: 'invalid json body' }); return }
        const ids = (Array.isArray(body?.sessionIds) ? body.sessionIds : []).map((x) => bareId(x)).filter((x) => x !== '')
        if (ids.length === 0) { sendJson(res, 400, { ok: false, error: 'sessionIds is required' }); return }
        const targets = ids.map((id) => ({ id, title: readProjection(id).title ?? undefined }))
        try {
          const result = await deleteSessions(ctx, targets, { caller: bareId(body?.caller ?? '') })
          sendJson(res, 200, {
            ok: result.failed.length === 0,
            removed: result.removed, refused: result.refused, failed: result.failed,
            missing: result.missing, warnings: result.warnings,
          })
        } catch (error) { sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }) }
      },
    }))
  } catch (error) {
    for (const dispose of disposers) { try { dispose() } catch { /* 忽略 */ } }
    const message = String(error?.message ?? error)
    logLine('plugin', 'failed', '注册 HTTP 路由失败：' + message)
    if (/duplicate/i.test(message)) {
      // 很可能是上一个实例仍持有这些路由：视为"已存在"，不再重试
      state.dispose = () => { /* 由持有者负责注销 */ }
      return true
    }
    state.users -= 1
    return false
  }

  state.dispose = () => {
    for (const dispose of disposers) { try { dispose() } catch { /* 忽略 */ } }
    state.dispose = null
  }
  // 注销挂在插件生命周期上（最后一个使用者离开时才真正解除）
  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => () => {
        state.users -= 1
        if (state.users <= 0 && typeof state.dispose === 'function') state.dispose()
      }, 'dsh-session-tool: HTTP routes')
    } catch { /* 忽略 */ }
  }
  logLine('plugin', 'info', 'HTTP 路由已注册：/list /config /diag /delete')
  return true
}

/* --------------------------------- 入口 ---------------------------------- */

export function apply(ctx, config = {}) {
  try { PLUGIN_CONFIG = normalizeConfig(config) }
  catch (error) { logConfig('warn', '配置解析失败：' + (error?.message ?? error)); PLUGIN_CONFIG = DEFAULT_CONFIG }

  logLine('plugin', 'info', '已加载：⋯ 菜单「删除会话」+ 头部「重命名会话」；删除为永久删除（不可恢复）')

  // 图形界面用的同源 HTTP 路由（终端型 profile 没有 webServer，自动跳过）。
  // webServer 可能比本插件晚就绪：先试一次，再挂 ctx.inject 等待，最后做有限次定时重试。
  if (!registerHttp(ctx)) {
    if (typeof ctx.inject === 'function') {
      try { ctx.inject(['webServer'], (sub) => { registerHttp(sub) }) } catch { /* 忽略 */ }
    }
    let attempts = 0
    const timer = setInterval(() => {
      attempts += 1
      if (registerHttp(ctx) || attempts >= 20) {
        clearInterval(timer)
        if (attempts >= 20) logLine('plugin', 'failed', 'webServer 持续不可用，界面接口未注册（界面功能会全部失效）')
      }
    }, 500)
    if (typeof timer.unref === 'function') timer.unref()
  }
}
