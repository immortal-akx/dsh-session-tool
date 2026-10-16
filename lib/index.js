/**
 * dsh-session-tool v0.2.0 — 删除会话（含已归档会话）的 DSH 宿主插件。
 *
 * 斜杠命令（Web/TUI 的 "/" 菜单自动渲染，无需客户端界面）：
 *   /sessions-archived   查看已归档会话（标题/时间/占用/id/是否运行中）
 *   /sessions-delete     删除已归档会话（默认移入回收目录；--purge 永久；--yes 确认）
 *
 * agent 工具：session_delete / session_archived_list —— 让模型也能直接删。
 *
 * 删除链路对齐成熟实现（参考 @pepsi-ai/dsh-plugin-session-delete 的设计）：
 *   1. 运行中的会话默认拒绝；带 --stop 时先取消并等待静默；
 *   2. flush + 从内存会话表 detach，避免 dispose 阶段把日志目录重建回来；
 *   3. 先删磁盘日志目录（确认删净），再动记账 —— 半删的会话不会掉进"未分组"；
 *   4. 通过活的 storageDomain 清投影缓存行与工作区记账（内存/磁盘一致，
 *      不会被下一次周期 flush 复活）；
 *   5. 兜底再删一次投影缓存 JSON 文件。
 *
 * 只用 Node 内置模块 + 宿主服务（ctx.get(...)），不 import 任何 @deepseek-ai 的值。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

export const name = 'dsh-session-tool'
export const inject = ['commands']

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
const sessionsRoot = () => join(dshHome(), 'sessions')
const trashRoot = () => join(dshHome(), 'session-trash')
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

const fmtSize = (bytes) => (bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB')
const fmtTime = (ms) => (Number.isFinite(ms) ? new Date(ms).toLocaleString('zh-CN') : '—')
const stamp = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
}

/* ------------------------------ 宿主服务访问 ------------------------------- */

const service = (ctx, name) => (typeof ctx.get === 'function' ? ctx.get(name) : undefined)

/** 运行中的会话由 agents 注册表持有。 */
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

/* -------------------------------- 归档清单 -------------------------------- */

async function collectArchived(ctx) {
  const registry = service(ctx, 'workspaceRegistry')
  if (!registry) throw new Error('宿主服务 workspaceRegistry 不可用')
  const ids = Array.isArray(registry.archivedSessionIds) ? [...registry.archivedSessionIds] : []
  const items = []
  for (const raw of ids) {
    const id = bareId(raw)
    const dirs = locateSessionDirs(id)
    const projection = readProjection(id)
    items.push({
      id,
      raw,
      dirs,
      title: projection.title ?? '(无标题)',
      createdAt: projection.createdAt,
      size: dirs.length ? dirs.reduce((sum, d) => sum + dirSize(d), 0) : 0,
      running: agentFor(ctx, id) !== undefined,
    })
  }
  return items
}

function renderList(items) {
  if (items.length === 0) return '(没有已归档的会话)'
  return items.map((item, index) => {
    const flags = [item.running ? '⚡运行中' : '', item.dirs.length ? '' : '⚠文件已不存在'].filter(Boolean).join(' ')
    return (index + 1) + '. ' + item.title + (flags ? '  [' + flags + ']' : '') + '\n' +
      '   ' + fmtTime(item.createdAt) + ' · ' + fmtSize(item.size) + ' · id ' + item.id.slice(0, 8)
  }).join('\n')
}

/* -------------------------------- 参数解析 -------------------------------- */

function parseInput(raw) {
  const flags = new Set()
  const words = []
  for (const word of String(raw ?? '').trim().split(/\s+/).filter(Boolean)) {
    const lower = word.toLowerCase()
    if (lower === '--yes' || lower === '-y') flags.add('yes')
    else if (lower === '--purge') flags.add('purge')
    else if (lower === '--stop') flags.add('stop')
    else words.push(word)
  }
  return { flags, selector: words.join(' ').trim() }
}

function pick(items, selector) {
  if (selector === '' || selector.toLowerCase() === 'all') return items
  const chosen = []
  for (const part of selector.split(/[,，\s]+/).filter(Boolean)) {
    if (/^\d+$/.test(part)) {
      const item = items[Number(part) - 1]
      if (item && !chosen.includes(item)) chosen.push(item)
      continue
    }
    const matches = items.filter((item) => item.id.startsWith(bareId(part)))
    if (matches.length === 1) { if (!chosen.includes(matches[0])) chosen.push(matches[0]) }
    else if (matches.length > 1) throw new Error('id 前缀 "' + part + '" 匹配到 ' + matches.length + ' 个会话，请写全一点')
  }
  return chosen
}

function callerSessionId(agent) {
  const session = agent?.session
  if (typeof session === 'string') return bareId(session)
  if (session && typeof session === 'object') return bareId(session.id ?? session.sessionId)
  return bareId(agent?.sessionId ?? agent?.id ?? '')
}

/* -------------------------------- 删除核心 -------------------------------- */

/**
 * 删除若干会话。
 * @returns {{removed:Array, missing:Array, refused:Array, failed:Array, warnings:Array, trashDir:string}}
 */
async function deleteSessions(ctx, targets, options = {}) {
  const purge = options.purge === true
  const registered = accountingIds(ctx)
  const allowStop = options.stop === true
  const caller = options.caller ?? ''
  const trashDir = join(trashRoot(), stamp())
  const result = { removed: [], missing: [], refused: [], failed: [], warnings: [], trashDir }

  for (const item of targets) {
    const id = bareId(item.id ?? item)
    const label = (item.title ? item.title + '（' + id.slice(0, 8) + '）' : id.slice(0, 8))
    if (caller && id === caller) { result.refused.push(label + ' — 当前会话，拒绝删除'); continue }

    const running = agentFor(ctx, id) !== undefined
    if (running && !allowStop) { result.refused.push(label + ' — 正在运行（加 --stop 可先停止再删）'); continue }

    // 1) 运行中的先停机、静默
    if (running) {
      try { await stopAgent(ctx, id) } catch (error) { result.warnings.push(label + ' — 停止运行失败：' + (error?.message ?? error)) }
    }
    // 2) flush + 从内存表摘除，避免 dispose 重建日志目录
    try {
      const { flushed, detached } = await flushAndDetach(ctx, id)
      if (flushed || detached) result.warnings.push(label + ' — 已 flush=' + flushed + ' detach=' + detached)
    } catch (error) { result.warnings.push(label + ' — flush/detach 失败：' + (error?.message ?? error)) }

    // 3) 先删磁盘（确认删净），再动记账
    let dirs = locateSessionDirs(id)
    if (dirs.length === 0) {
      await stripStorage(ctx, id, { workspace: true })
      try { rmSync(projectionPath(id), { force: true }) } catch { /* 忽略 */ }
      result.missing.push(label + ' — 文件已不存在，只清理了登记')
      continue
    }
    const failures = []
    for (const dir of dirs) {
      try {
        if (purge) rmSync(dir, { recursive: true, force: true })
        else { mkdirSync(trashDir, { recursive: true }); renameSync(dir, join(trashDir, SESSION_PREFIX + id)) }
      } catch (error) { failures.push((error?.message ?? String(error))) }
    }
    // 收尾再扫两遍：dispose 可能刚把目录重建回来
    await new Promise((resolve) => setImmediate(resolve))
    for (const stale of locateSessionDirs(id)) {
      try { rmSync(stale, { recursive: true, force: true }) } catch { /* 忽略 */ }
    }
    if (failures.length > 0 || locateSessionDirs(id).length > 0) {
      result.failed.push(label + ' — ' + (failures.join('; ') || '文件未能完全删除'))
      continue
    }

    // 4) 文件确认没了，才清投影缓存 + 工作区记账（含归档集合）
    try {
      const { projRemoved, workspaceRemoved } = await stripStorage(ctx, id, { workspace: true })
      if (!projRemoved) { try { rmSync(projectionPath(id), { force: true }) } catch { /* 忽略 */ } }
      if (registered.has(id) && !workspaceRemoved) result.warnings.push(label + ' — 工作区记账未能清理，重启后会自动对齐')
    } catch (error) { result.warnings.push(label + ' — 记账清理失败：' + (error?.message ?? error)) }

    result.removed.push(label)
  }
  return result
}

function renderDeleteResult(result, purge) {
  const lines = []
  if (result.removed.length === 0) lines.push('未删除任何会话。')
  else {
    lines.push((purge ? '已永久删除 ' : '已移入回收目录 ') + result.removed.length + ' 个会话：')
    lines.push(...result.removed.map((line) => '  ✓ ' + line))
  }
  if (!purge && result.removed.length > 0) {
    lines.push('')
    lines.push('回收目录：' + result.trashDir)
    lines.push('（想恢复：把里面的 session-<id> 文件夹搬回 ' + sessionsRoot() + '\\<原分组>\\）')
  }
  if (result.missing.length) lines.push('\n已不存在（只清理登记）：\n' + result.missing.map((l) => '  – ' + l).join('\n'))
  if (result.refused.length) lines.push('\n跳过：\n' + result.refused.map((l) => '  – ' + l).join('\n'))
  if (result.failed.length) lines.push('\n失败：\n' + result.failed.map((l) => '  ✗ ' + l).join('\n'))
  if (result.warnings.length) lines.push('\n提示：\n' + result.warnings.map((l) => '  ! ' + l).join('\n'))
  return lines.join('\n')
}

/* ------------------------------- agent 工具 ------------------------------- */

/** 手写工具定义：不依赖 defineTool，参数是标准 JSON Schema。 */
function toolDefinitions() {
  return [
    {
      name: 'session_delete',
      description: 'Delete sessions of this workbench: removes the session log directory, the projection-cache row and the workspace accounting (including the archive set). By default the logs are moved to <DSH_HOME>/session-trash (recoverable); pass purge=true to erase them permanently. Refuses a running session unless stop=true (then it cancels the turn and waits for quiescence first). Refuses the calling session.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['sessionIds'],
        properties: {
          sessionIds: { type: 'array', items: { type: 'string' }, description: 'Session ids to delete (uuid or session-<uuid> form).' },
          purge: { type: 'boolean', description: 'Erase the logs permanently instead of moving them to the trash directory. Defaults to false.' },
          stop: { type: 'boolean', description: 'Allow deleting running sessions by cancelling them first. Defaults to false.' },
        },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      execute: (args, exec) => {
        // 由 apply 注入实现（见 registerTools）
      },
    },
    {
      name: 'session_archived_list',
      description: 'List archived sessions of this workbench with title, creation time, disk usage and running state.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      execute: () => '',
    },
  ]
}

/* ---------------------------------- 插件 ---------------------------------- */

function registerCommands(ctx, state) {
  const commands = ctx.commands
  if (!commands) { ctx.logger?.warn?.(LABEL + ': commands 服务不可用，插件未生效'); return }

  commands.register({
    name: 'sessions-archived',
    description: '查看已归档的会话（标题 / 时间 / 占用 / id / 是否运行中）',
    handler: async () => {
      try {
        const items = await collectArchived(ctx)
        return { kind: 'success', text: '已归档会话共 ' + items.length + ' 个：\n\n' + renderList(items) }
      } catch (error) { return { kind: 'error', text: LABEL + ': ' + (error?.message ?? String(error)) } }
    },
  })

  commands.register({
    name: 'sessions-delete',
    description: '删除已归档的会话：默认移入回收目录；--purge 永久删除；--stop 允许删除运行中的会话；需 --yes 确认',
    input: { hint: '[all|1,3|id前缀] [--purge] [--stop] [--yes]' },
    handler: async ({ agent, rawInput }) => {
      try {
        const items = await collectArchived(ctx)
        if (items.length === 0) return { kind: 'success', text: '当前没有已归档的会话，无需清理。' }

        const { flags, selector } = parseInput(rawInput)
        let chosen
        try { chosen = pick(items, selector) } catch (error) { return { kind: 'error', text: LABEL + ': ' + (error?.message ?? error) } }
        if (chosen.length === 0) return { kind: 'error', text: LABEL + ': 没有匹配「' + selector + '」的已归档会话。\n\n' + renderList(items) }

        const purge = flags.has('purge')
        const allowStop = flags.has('stop')
        const runningCount = chosen.filter((item) => item.running).length
        if (!flags.has('yes')) {
          const risk = purge ? '永久删除，不可恢复' : '移入回收目录，可手动搬回'
          const runningNote = runningCount > 0 && !allowStop
            ? '\n\n⚠ 其中 ' + runningCount + ' 个正在运行，本次会被跳过；要连它们一起删，请加 --stop。'
            : runningCount > 0 ? '\n\n⚠ 其中 ' + runningCount + ' 个正在运行，加 --stop 会先停止它们的任务再删除。' : ''
          return {
            kind: 'success',
            text: '即将删除 ' + chosen.length + ' 个已归档会话（' + risk + '）：\n\n' + renderList(chosen) + runningNote +
              '\n\n确认请再执行一次并加 --yes：\n/sessions-delete ' + (selector || 'all') + (purge ? ' --purge' : '') + (allowStop ? ' --stop' : '') + ' --yes',
          }
        }

        const result = await deleteSessions(ctx, chosen, { purge, stop: allowStop, caller: callerSessionId(agent) })
        const failed = result.failed.length > 0
        if (result.removed.length === 0 && !failed) {
          return { kind: 'success', text: renderDeleteResult(result, purge) }
        }
        return { kind: failed ? 'error' : 'success', text: renderDeleteResult(result, purge) + '\n\n侧栏若仍显示旧行，重载页面即可。' }
      } catch (error) { return { kind: 'error', text: LABEL + ': ' + (error?.message ?? String(error)) } }
    },
  })
  state.commandsRegistered = true
}

function registerTools(ctx) {
  const tools = service(ctx, 'tools')
  if (!tools || typeof tools.register !== 'function') return false
  const definitions = toolDefinitions()
  for (const definition of definitions) {
    if (definition.name === 'session_delete') {
      definition.execute = async (args, exec) => {
        const ids = Array.isArray(args?.sessionIds) ? args.sessionIds : []
        if (ids.length === 0) return 'session_delete: sessionIds is required and must be a non-empty array of session ids.'
        const targets = ids.map((id) => ({ id: bareId(id), title: readProjection(id).title ?? undefined }))
        const caller = callerSessionId(exec?.agent ?? exec?.session ?? exec)
        const purge = args?.purge === true
        const result = await deleteSessions(ctx, targets, { purge, stop: args?.stop === true, caller })
        return (purge ? '永久删除 ' : '移入回收目录 ') + result.removed.length + ' 个，跳过 ' + result.refused.length + ' 个，失败 ' + result.failed.length + ' 个。\n' + renderDeleteResult(result, purge)
      }
    }
    if (definition.name === 'session_archived_list') {
      definition.execute = async () => {
        const items = await collectArchived(ctx)
        return '已归档会话共 ' + items.length + ' 个：\n\n' + renderList(items)
      }
    }
    try { tools.register(definition); ctx.logger?.info?.(LABEL + ': 已注册工具 ' + definition.name) }
    catch (error) { ctx.logger?.warn?.(LABEL + ': 注册工具 ' + definition.name + ' 失败：' + (error?.message ?? error)) }
  }
  return true
}


/* ------------------------------- HTTP 路由 -------------------------------- */
/**
 * 图形界面用的 HTTP 接口：浏览器里的客户端半边 fetch 同源路由。
 * 第三方插件无法新增 Typert RPC namespace，注册同源 HTTP 路由是与界面通信的可用路径。
 * 安全：只接受回环来源 + 同源请求；删除走与命令完全相同的链路（默认进回收目录）。
 */
const HTTP_PATH = '/__dsh-session-tool/delete'
const LIST_PATH = '/__dsh-session-tool/list'
const CONFIG_PATH = '/__dsh-session-tool/config'
const OPEN_PATH = '/__dsh-session-tool/open-trash'

/** 界面可配置项（在 profile 的 cordis.patch.yml 里给 dsh-session-tool 写 config）。 */
const DEFAULT_CONFIG = {
  menu: { label: '', order: 500, hidden: false, danger: true, icon: true },
  rowAction: { order: 200, hidden: false },
  header: { order: 30, hidden: false },
  trash: { menu: true, label: '' },
  shippedRows: { pin: {}, rename: {}, fork: {}, archive: {} },
}
let PLUGIN_CONFIG = DEFAULT_CONFIG


/** 官方菜单行（置顶/重命名/分叉/归档）的显示配置：hidden / label / activeLabel / order。 */
function shippedRows(cfg) {
  const raw = cfg && typeof cfg.shippedRows === 'object' && cfg.shippedRows !== null ? cfg.shippedRows : {}
  const one = (id) => {
    const item = raw[id] && typeof raw[id] === 'object' ? raw[id] : {}
    const out = { hidden: item.hidden === true }
    if (typeof item.label === 'string' && item.label !== '') out.label = item.label
    if (typeof item.activeLabel === 'string' && item.activeLabel !== '') out.activeLabel = item.activeLabel
    if (typeof item.order === 'number' && Number.isFinite(item.order)) out.order = item.order
    return out
  }
  return { pin: one('pin'), rename: one('rename'), fork: one('fork'), archive: one('archive') }
}
function normalizeConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {}
  const part = (key) => (cfg[key] && typeof cfg[key] === 'object' ? cfg[key] : {})
  const menu = part('menu')
  const row = part('rowAction')
  const head = part('header')
  const trash = part('trash')
  const num = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
  return {
    menu: {
      label: typeof menu.label === 'string' ? menu.label : '',
      order: num(menu.order, DEFAULT_CONFIG.menu.order),
      hidden: menu.hidden === true,
      danger: menu.danger !== false,
      icon: menu.icon !== false,
    },
    rowAction: { order: num(row.order, DEFAULT_CONFIG.rowAction.order), hidden: row.hidden === true },
    header: { order: num(head.order, DEFAULT_CONFIG.header.order), hidden: head.hidden === true },
    trash: { menu: trash.menu !== false, label: typeof trash.label === 'string' ? trash.label : '' },
    shippedRows: shippedRows(cfg),
  }
}

/** 在系统文件管理器里打开一个目录（Electron shell 优先，退回 explorer.exe）。 */
let OPEN_FOLDER_ERROR = ''

async function openFolder(dir) {
  OPEN_FOLDER_ERROR = ''
  try { mkdirSync(dir, { recursive: true }) } catch { /* 目录已存在或无权限，交给打开动作报错 */ }
  try {
    const req = createRequire(import.meta.url)
    const electron = req('electron')
    const shell = electron && electron.shell
    if (shell && typeof shell.openPath === 'function') {
      const failure = await shell.openPath(dir)
      if (!failure) return true
      OPEN_FOLDER_ERROR = 'electron: ' + String(failure)
    }
  } catch (error) { OPEN_FOLDER_ERROR = 'electron: ' + String(error?.message ?? error) }
  try {
    const absolute = join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'explorer.exe')
    const command = existsSync(absolute) ? absolute : 'explorer.exe'
    const child = spawn(command, [dir], { detached: true, stdio: 'ignore' })
    child.unref()
    return true
  } catch (error) { OPEN_FOLDER_ERROR = 'explorer: ' + String(error?.message ?? error); return false }
  return false
}

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

/** 回收站命令：/sessions-trash [--open] */
function registerTrashCommand(ctx) {
  const commands = service(ctx, 'commands')
  if (!commands || typeof commands.register !== 'function') return false
  try {
    commands.register({
      name: 'sessions-trash',
      description: '查看回收站里的会话（--open 直接在文件管理器里打开回收站）',
      input: { hint: '[--open]', optional: true },
      handler: async (raw) => {
        const args = String(raw ?? '').split(/\s+/).filter((x) => x !== '')
        if (args.includes('--open')) {
          const opened = await openFolder(trashRoot())
          return { kind: 'text', text: opened ? `已打开回收站：${trashRoot()}` : `无法自动打开，请手动访问：${trashRoot()}` }
        }
        const batches = listTrash()
        if (batches.length === 0) return { kind: 'text', text: `回收站是空的：${trashRoot()}` }
        const lines = [`回收站共 ${batches.length} 批（每次删除一批）：`, '']
        for (const batch of batches) {
          lines.push(`📦 ${batch.name}  ·  ${batch.items.length} 个会话  ·  ${formatSize(batch.size)}`)
          for (const item of batch.items) lines.push(`    ${item.id}  ${item.title ? `「${item.title}」` : ''}  ${formatSize(item.size)}`)
        }
        lines.push('', `提示：把批次文件夹搬回 sessions/<工作区分组>/ 即可恢复；/sessions-trash --open 打开目录`)
        return { kind: 'text', text: lines.join('\n') }
      },
    })
    return true
  } catch { return false }
}

/** 列出回收站的批次与其中的会话。 */
function listTrash() {
  const root = trashRoot()
  let batches = []
  try { batches = readdirSync(root, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const batch of batches) {
    if (!batch.isDirectory()) continue
    const dir = join(root, batch.name)
    const items = []
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const match = entry.name.match(/^session-([0-9a-fA-F-]{8,})/i)
      items.push({
        id: match ? match[1].slice(0, 8) : entry.name,
        title: readProjection(match ? match[1] : entry.name).title ?? null,
        size: dirSize(join(dir, entry.name)),
      })
    }
    out.push({ name: batch.name, items, size: items.reduce((sum, x) => sum + x.size, 0) })
  }
  return out.sort((a, b) => (a.name < b.name ? 1 : -1))
}

function formatSize(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(2)} MB`
}
function registerHttp(ctx) {
  const host = service(ctx, 'webServer')
  if (!host || typeof host.register !== 'function') return false
  let dispose
  try {
    host.register({
      kind: 'exact',
      path: LIST_PATH,
      handler: (req, res) => {
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
        if (!isLocalSameOrigin(req)) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return }
        try { sendJson(res, 200, { ok: true, sessions: collectAll(ctx) }) }
        catch (error) { sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }) }
      },
    })
    host.register({
      kind: 'exact',
      path: CONFIG_PATH,
      handler: (req, res) => {
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
        if (!isLocalSameOrigin(req)) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return }
        sendJson(res, 200, { ok: true, config: PLUGIN_CONFIG, trashDir: trashRoot() })
      },
    })
    host.register({
      kind: 'exact',
      path: OPEN_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
        if (!isLocalSameOrigin(req)) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return }
        let body
        try { body = await readJsonBody(req) } catch { body = {} }
        const wanted = typeof body?.path === 'string' && body.path.trim() !== '' ? body.path : trashRoot()
        try {
          const opened = await openFolder(wanted)
          sendJson(res, opened ? 200 : 500, { ok: opened, path: wanted, detail: opened ? undefined : OPEN_FOLDER_ERROR })
        } catch (error) { sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }) }
      },
    })
    dispose = host.register({
      kind: 'exact',
      path: HTTP_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
        if (!isLocalSameOrigin(req)) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return }
        let body
        try { body = await readJsonBody(req) } catch { sendJson(res, 400, { ok: false, error: 'invalid json body' }); return }
        const ids = (Array.isArray(body?.sessionIds) ? body.sessionIds : []).map((x) => bareId(x)).filter((x) => x !== '')
        if (ids.length === 0) { sendJson(res, 400, { ok: false, error: 'sessionIds is required' }); return }
        const running = ids.filter((id) => agentFor(ctx, id) !== undefined)
        if (running.length > 0 && body?.stop !== true) {
          sendJson(res, 409, { ok: false, code: 'running', running, error: 'session is running' })
          return
        }
        const targets = ids.map((id) => ({ id, title: readProjection(id).title ?? undefined }))
        try {
          const result = await deleteSessions(ctx, targets, {
            purge: body?.purge === true,
            stop: body?.stop === true,
            caller: bareId(body?.caller ?? ''),
          })
          sendJson(res, 200, {
            ok: result.failed.length === 0,
            removed: result.removed, refused: result.refused, failed: result.failed,
            missing: result.missing, warnings: result.warnings,
            trash: body?.purge === true ? null : result.trashDir,
          })
        } catch (error) { sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }) }
      },
    })
  } catch (error) {
    ctx.logger?.warn?.(`${LABEL}: 注册 HTTP 路由失败：${error?.message ?? error}`)
    return false
  }
  return typeof dispose === 'function'
}

export function apply(ctx, config = {}) {
  PLUGIN_CONFIG = normalizeConfig(config)
  const state = { commandsRegistered: false }
  registerCommands(ctx, state)
  registerTrashCommand(ctx)

  if (!registerTools(ctx) && typeof ctx.inject === 'function') {
    // tools 服务晚到的组合里，等它出现再注册
    try { ctx.inject(['tools'], (sub) => registerTools(sub)) } catch { /* 忽略 */ }
  }

  // 图形界面用的同源 HTTP 路由（终端型 profile 没有 webServer，自动跳过）
  if (!registerHttp(ctx) && typeof ctx.inject === 'function') {
    try { ctx.inject(['webServer'], (sub) => registerHttp(sub)) } catch { /* 忽略 */ }
  }
  ctx.logger?.info?.(LABEL + ': 已加载（侧栏「删除会话」菜单项、/sessions-archived、/sessions-delete、session_delete）')
}
