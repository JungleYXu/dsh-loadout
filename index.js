/**
 * dsh-loadout — 装备栏 for DeepSeek Harness.
 *
 * One conversation runs on one *base* plus optional *extras*:
 *
 *   base = 'all'  → nothing is hidden (all built-ins + all enabled plugin tools)
 *   base = 'dsh'  → only the Harness's own built-in tools; every plugin masked
 *   base = 'kit'  → a saved kit: its built-ins + its plugins (+ OWN_TOOLS)
 *
 * `extras` are plugin ids attached on top of the base without creating a kit.
 * What an agent may keep is always derived, never stored per agent:
 *
 *   all  → undefined (nothing is hidden, no filter is installed)
 *   dsh  → catalog built-ins ∪ tools(extras) ∪ OWN_TOOLS
 *   kit  → tools(kit.builtins) ∪ tools(kit.plugins ∪ extras) ∪ OWN_TOOLS
 *
 * Presets (仅聊天 / 编程用 / 查找资料 / 项目梳理 / 写作) ship in `cordis.patch.yml`
 * and are read-only. User kits live in `~/.dsh/loadout.json`:
 *
 *   {
 *     "schema": 2,
 *     "kits": [{ "name", "title", "note", "builtins", "plugins" }],
 *     "defaultKit": "",
 *     "assignments": { "<sessionId>": "kit-name" | "@dsh" | null },
 *     "migratedAt": "2026-11-02T13:00:00.000Z"
 *   }
 *
 * `assignments` is what makes a conversation's choice last: every conversation
 * gets ONE persisted binding when it is created (never re-derived afterwards),
 * so changing the default only affects conversations created later, and an
 * explicit switch survives a restart. `null` means 全部 — an explicit choice, not
 * "no answer". `migratedAt` lets a conversation that predates the upgrade keep
 * the state it effectively had instead of inheriting today's default.
 *
 * Three surfaces share the same store and the same operations:
 *   - tools:  kit_list / kit_apply / kit_create / kit_set_tools / kit_set_default
 *             / kit_delete / kit_assign / kit_rename
 *   - chat:   the `/kit [name]` command
 *   - web UI: the header chip and 设置 → 装备栏, served under /dsh-loadout/
 *
 * The restriction itself is a DENY filter on one agent's context, never an
 * allow list. `ctx.tools.restrict({ allow })` reads as "only these", but the
 * runtime turns an allow list into "drop everything else" — and it refuses the
 * built-in names themselves, so every built-in silently disappeared from the
 * conversation (0.7.0 and 0.8.0 both shipped that bug; see applyMask()).
 * A deny filter subtracts names instead, so a name we forget to mention can
 * never be lost, and names the public API refuses are appended to the same
 * layer with `layers.effect(...restrictions.append({ deny }))`.
 * @module dsh-loadout
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-loadout'

/** Cordis waits for the tool registry before applying this plugin. */
export const inject = ['tools']

const OWN_TOOLS = ['kit_list', 'kit_apply', 'kit_create', 'kit_set_tools', 'kit_set_default', 'kit_delete', 'kit_assign', 'kit_rename']

/** Runtime store. Profile-independent on purpose: one place, easy to back up. */
const STORE_PATH = join(homedir(), '.dsh', 'loadout.json')

/** The store written up to 0.4.x. Read once, so a rename never loses saved kits. */
const LEGACY_STORE_PATH = join(homedir(), '.dsh', 'plugin-kits.json')

/**
 * Version of the on-disk shape. 2 introduced `assignments` (one persisted
 * binding per conversation) and `migratedAt`; 1 and 0 are the same kit-only
 * shape and are upgraded by `migrateBook`. A shape change bumps this, so a
 * release never has to guess what it is looking at.
 */
const STORE_SCHEMA = 2

/**
 * Names a user kit may not take: the two built-in choices, the words the UI
 * shows for "no kit", and the shipped preset names (checked separately because
 * they come from the bundle). `title` is free text; only `name` is an id.
 */
const RESERVED_NAMES = ['全部', '全部工具', '仅内置', '自定义', '默认', 'all', 'builtin', 'custom', 'default']

const NAME_MAX = 32

/** Ids the UI parses, so a kit may not look like a path or a glob. */
const NAME_FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f\u007f]/u

/**
 * Normalize and validate a kit id. NFKC folds full-width letters (`ｃｈａｔ` →
 * `chat`), which otherwise produce two ids that look identical in the menu.
 */
function assertKitName(raw, presets) {
  const value = typeof raw === 'string' ? raw.trim().normalize('NFKC') : ''
  if (value === '') throw new Error('名字不能为空')
  if (value.length > NAME_MAX) throw new Error(`名字最多 ${NAME_MAX} 个字符`)
  if (NAME_FORBIDDEN.test(value)) throw new Error('名字里不能有 / \\ : * ? " < > | 或控制字符')
  const lower = value.toLowerCase()
  if (RESERVED_NAMES.includes(lower)) throw new Error(`"${value}" 是保留名字，请换一个名字`)
  const preset = presets === undefined ? undefined : findKit(presets, value)
  if (preset !== undefined) throw new Error(`「${preset.title}」是预置套装（标识 ${preset.name}），不能占用这个名字`)
  return value
}

/**
 * One-line reminder on a kit ("套装1（用于视频制作）"). It rides in the menu next
 * to the title, so it has to stay a glance, not a paragraph.
 */
const NOTE_MAX = 20

/**
 * `defaultKit` is "the kit a new conversation starts from". Besides a saved kit
 * it also accepts the one non-kit choice the menu offers — 仅内置 — spelled as a
 * value no kit name can collide with.
 */
const DEFAULT_DSH = '@dsh'

function clampNote(value) {
  return typeof value === 'string' ? value.trim().slice(0, NOTE_MAX) : ''
}

/** Route prefix the settings panel and the header chip talk to. */
const ROUTE_PREFIX = '/dsh-loadout'

const BASE_ALL = 'all'
const BASE_DSH = 'dsh'
const BASE_KIT = 'kit'

const text = (value) => [{ type: 'text', text: value }]

const asNames = (value) => (Array.isArray(value)
  ? value.filter((entry) => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim())
  : [])

const dedupe = (names) => [...new Set(names)]

const stripOwnTools = (names) => names.filter((entry) => !OWN_TOOLS.includes(entry))

function sameSet(left, right) {
  const a = new Set(left)
  const b = new Set(right)
  if (a.size !== b.size) return false
  for (const item of a) if (!b.has(item)) return false
  return true
}

function normalizeKit(row) {
  if (typeof row !== 'object' || row === null) return undefined
  const kitName = typeof row.name === 'string' ? row.name.trim() : ''
  if (kitName === '') return undefined
  return {
    name: kitName,
    title: typeof row.title === 'string' && row.title.trim() !== '' ? row.title.trim() : kitName,
    note: clampNote(row.note),
    allow: dedupe(asNames(row.allow)),
    deny: dedupe(asNames(row.deny)),
    plugins: dedupe(asNames(row.plugins)),
    builtins: dedupe(asNames(row.builtins)),
  }
}

function normalizeKits(rows) {
  const kits = []
  for (const row of Array.isArray(rows) ? rows : []) {
    const kit = normalizeKit(row)
    if (kit !== undefined) kits.push(kit)
  }
  return kits
}

/**
 * Normalize the on-disk store. Missing arrays, unknown fields and a bare array
 * (a hand-written store) all degrade to an empty, still-usable book.
 *
 * `schema` records what the file claimed. 0/1 mean "written before 0.11.x" and
 * carry no bindings; `migrateBook` stamps `migratedAt` and lets conversations
 * that already existed keep the state they effectively had. Unknown future
 * versions are still parsed by their known fields rather than rejected — losing
 * a user's kits over a number would be worse than reading what we understand.
 */
function normalizeStore(value) {
  if (Array.isArray(value)) {
    return { schema: 0, kits: normalizeKits(value), defaultKit: '', assignments: {}, migratedAt: undefined }
  }
  if (typeof value !== 'object' || value === null) return undefined
  return {
    schema: Number.isInteger(value.schema) ? value.schema : 0,
    kits: normalizeKits(value.kits),
    defaultKit: typeof value.defaultKit === 'string' ? value.defaultKit.trim() : '',
    assignments: normalizeAssignments(value.assignments),
    migratedAt: typeof value.migratedAt === 'string' && !Number.isNaN(Date.parse(value.migratedAt))
      ? value.migratedAt
      : undefined,
  }
}

/**
 * Session id → binding. `null` is a real value here (全部), so a missing key and
 * a stored `null` must stay distinguishable: `hasOwnProperty` decides, never a
 * truthiness test.
 */
function normalizeAssignments(value) {
  const out = {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return out
  for (const [key, entry] of Object.entries(value)) {
    if (typeof key !== 'string' || key === '') continue
    if (entry === null) out[key] = null
    else if (typeof entry === 'string' && entry.trim() !== '') out[key] = entry.trim()
  }
  return out
}

function readStore() {
  // New file first, then the pre-0.5 copy: a rename must not silently drop the
  // kits someone already saved. The legacy file is never written again, so the
  // next save moves the store forward for good.
  for (const path of [STORE_PATH, LEGACY_STORE_PATH]) {
    try {
      if (!existsSync(path)) continue
      const store = normalizeStore(JSON.parse(readFileSync(path, 'utf8')))
      if (store !== undefined) return { store, path }
    } catch {
      // Unreadable or malformed: try the next location, then fall back to defaults.
    }
  }
  return undefined
}

function writeStore(next) {
  mkdirSync(dirname(STORE_PATH), { recursive: true })
  // Write beside the target and rename over it. A crash mid-write (or a second
  // window saving at the same moment) must not leave a truncated store behind:
  // the kits are the only copy of what the user built.
  const temporary = `${STORE_PATH}.tmp`
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  renameSync(temporary, STORE_PATH)
}

function findKit(kits, wanted) {
  if (typeof wanted !== 'string') return undefined
  const needle = wanted.trim().toLowerCase()
  if (needle === '') return undefined
  return kits.find((kit) => kit.name.toLowerCase() === needle) ?? kits.find((kit) => kit.title.toLowerCase() === needle)
}

/**
 * Drop the unmodified copies of shipped presets a 0.5.x store may carry, plus
 * the old "everything" kits that only meant "no restriction".
 *
 * Without this, the first boot after the redesign lists 写作 / 调研 / 编程 twice
 * (once as 预设, once as 我的) and an old allow-less kit would suddenly hide
 * every built-in tool instead of none.
 */
function migrateUserKits(rows, presetRows) {
  const out = []
  for (const kit of rows) {
    if (kit.allow.length === 0 && kit.builtins.length === 0 && kit.plugins.length === 0) continue
    const preset = findKit(presetRows, kit.name)
    if (preset !== undefined) {
      const kitTools = kit.builtins.length > 0 || kit.plugins.length > 0
        ? [...kit.builtins, ...kit.plugins.map((id) => `plugin:${id}`)]
        : kit.allow
      const presetTools = preset.builtins.length > 0 || preset.plugins.length > 0
        ? [...preset.builtins, ...preset.plugins.map((id) => `plugin:${id}`)]
        : preset.allow
      if (sameSet(stripOwnTools(kitTools), stripOwnTools(presetTools))) continue
    }
    out.push(kit)
  }
  return out
}

function agentOf(exec) {
  return exec?.agent ?? exec?.session?.agent ?? exec?.ctx?.agent
}

/** Read one JSON request body with a size cap. */
function readJson(req, limit = 262144) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/** Only answer requests whose Host is this machine's loopback alias. */
function isLocalRequest(req) {
  const host = String(req.headers?.host ?? '').toLowerCase().replace(/:\d+$/u, '')
  return host === '' || host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
}

export function apply(ctx, config = {}) {
  /** Shipped, read-only kits (写作 / 调研 / 编程). */
  const presets = normalizeKits(config?.kits)
  const loaded = readStore()
  /** My kits: the user-created ones only. Presets are never stored here. */
  /**
   * My kits: the user-created ones only. Presets are never stored here.
   *
   * `assignments` is the v2 binding table: one entry per conversation, written
   * once and then only on an explicit switch. `migratedAt` marks the upgrade, so
   * a conversation older than it keeps the state it effectively had.
   */
  const book = {
    kits: migrateUserKits(loaded?.store.kits ?? [], presets),
    defaultKit: loaded?.store.defaultKit ?? (typeof config?.defaultKit === 'string' ? config.defaultKit.trim() : ''),
    assignments: loaded?.store.assignments ?? {},
    migratedAt: loaded?.store.migratedAt,
    // The file the kits actually came from: the legacy path on the first boot
    // after the rename, the new one afterwards.
    source: loaded?.path ?? 'bundle 配置',
  }

  function save() {
    writeStore({
      // Stamped so a future release can migrate instead of guessing. Files from
      // 0.10.x and earlier have no `schema`; normalizeStore reads them as 0 and
      // migrateBook upgrades them.
      schema: STORE_SCHEMA,
      kits: book.kits.map((kit) => ({
        name: kit.name,
        title: kit.title,
        builtins: kit.builtins,
        plugins: kit.plugins,
        // Without this the note lives only until the next restart: normalizeKit
        // reads `note`, but this writer defined what "a kit" is and left it out,
        // which made the field look UI-only.
        note: kit.note ?? '',
      })),
      defaultKit: book.defaultKit,
      assignments: book.assignments,
      ...(book.migratedAt === undefined ? {} : { migratedAt: book.migratedAt }),
    })
    // `source` answers "where do the user's kits live". Writing assignments or a
    // default is bookkeeping, not a kit, so it does not turn a fresh install's
    // 「bundle 配置」 into a file path; saving a kit does.
    if (book.kits.length > 0) book.source = STORE_PATH
  }

  /** Session ids that already exist on disk (conversations only, not subagents). */
  function knownConversations() {
    const root = join(homedir(), '.dsh', 'sessions')
    const out = []
    try {
      for (const workspace of readdirSync(root, { withFileTypes: true })) {
        if (!workspace.isDirectory()) continue
        const dir = join(root, workspace.name)
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name.startsWith('session-')) out.push(entry.name)
        }
      }
    } catch {
      // No sessions directory yet: a fresh install has nothing to migrate.
    }
    return out
  }

  /**
   * Upgrade the store to schema 2 exactly once.
   *
   * Before v2 a conversation had no stored choice, so whatever it showed was
   * inherited from the default at the moment it was created. Freezing that as
   * `null` (全部) for the conversations that already exist is the honest reading:
   * it changes nobody's tools today, and it stops a later default change from
   * reaching back into conversations the user never touched. The pre-upgrade
   * file is copied aside first, so a wrong guess is undoable by hand.
   */
  function migrateBook() {
    if (book.migratedAt !== undefined) return
    if (loaded !== undefined && loaded.store.schema >= STORE_SCHEMA) {
      book.migratedAt = new Date().toISOString()
      save()
      return
    }
    try {
      if (loaded?.path !== undefined && existsSync(loaded.path)) {
        copyFileSync(loaded.path, `${loaded.path}.v1.bak-${Date.now()}`)
      }
    } catch {
      // A backup is best-effort; the migration itself still has to run.
    }
    book.migratedAt = new Date().toISOString()
    for (const sessionId of knownConversations()) {
      if (!Object.prototype.hasOwnProperty.call(book.assignments, sessionId)) book.assignments[sessionId] = null
    }
    // Writing the upgraded file must not make an untouched install look as if the
    // user had saved kits there: `source` is what the UI prints, and a fresh
    // install with nothing of the user's own still reads 「bundle 配置」.
    const before = book.source
    save()
    if (book.kits.length === 0 && book.defaultKit === '') book.source = before
    if (knownConversations().length > 0) {
      ctx.logger?.info('dsh-loadout: 升级到 schema 2，已有对话保持原状（全部）')
    }
  }

  /**
   * A kit saved before the preset list existed may carry a preset's name or
   * title (`chat`, `plan`, `写作`…). `resolveKit` prefers user kits, so a
   * default naming such a preset would actually answer the user's kit while the
   * settings page marked the preset — two rows claiming 「默认」. Renaming is the
   * only honest fix: keep the user's kit (with its tools) under a free name and
   * repoint every binding that used the old one.
   */
  function disambiguatePresetClashes() {
    const taken = new Set(presets.flatMap((preset) => [preset.name.toLowerCase(), preset.title.toLowerCase()]))
    const changed = []
    for (const kit of book.kits) {
      const nameClash = taken.has(kit.name.toLowerCase())
      const titleClash = taken.has(kit.title.toLowerCase())
      if (!nameClash && !titleClash) continue
      const before = kit.name
      if (nameClash) {
        let suffix = 2
        let candidate = `${before}-${suffix}`
        while (taken.has(candidate.toLowerCase()) || findKit(book.kits, candidate) !== undefined) {
          suffix += 1
          candidate = `${before}-${suffix}`
        }
        kit.name = candidate
        taken.add(candidate.toLowerCase())
      }
      if (titleClash) kit.title = `${kit.title}（自建）`
      for (const [sessionId, value] of Object.entries(book.assignments)) {
        if (value === before) book.assignments[sessionId] = kit.name
      }
      if (book.defaultKit === before) book.defaultKit = kit.name
      changed.push(`${before} → ${kit.name}`)
    }
    if (changed.length === 0) return
    save()
    ctx.logger?.warn(`dsh-loadout: 自建套装与预置同名，已改名（没有删除）：${changed.join('，')}`)
  }

  migrateBook()
  disambiguatePresetClashes()

  /** agent -> { selection: {base,kit,extras}, label, dispose } */
  const state = new Map()

  /** Transient kits created by the backward-compatible `applySet` action. */
  const customKits = new Map()

  /**
   * The host service that turns a Session id into its live agent.
   *
   * Cordis throws on `ctx.<service>` for a service the plugin never injected,
   * so this is captured through an optional injection instead of read directly.
   */
  let sessionController
  /**
   * The session service, used only to read a Session's header (createdAt /
   * parentSession / origin). Optional for the same reason as sessionController.
   */
  let sessions
  let lastAgent
  /** Every tool name this profile can expose; filled by learnTools below. */
  const knownTools = new Set(OWN_TOOLS)
  /** Agents stay reachable for the catalog; a long-lived app sees a handful. */
  const seenAgents = []
  function rememberAgent(agent) {
    if (agent === undefined || agent === null) return
    lastAgent = agent
    if (!seenAgents.includes(agent)) {
      seenAgents.push(agent)
      if (seenAgents.length > 8) seenAgents.shift()
    }
    learnTools(agent)
  }

  // ---- selection model -----------------------------------------------------
  function emptySelection() {
    return { base: BASE_ALL, kit: null, extras: [] }
  }

  /** The Session id behind an agent; `Agent.id` is the Session id. */
  function sessionIdOf(agent) {
    const id = agent?.id ?? agent?.session?.id
    return typeof id === 'string' && id !== '' ? id : undefined
  }

  /** The Session header (createdAt / parentSession / origin), when available. */
  function sessionHeaderOf(sessionId) {
    if (sessionId === undefined || sessions === undefined) return undefined
    try {
      return sessions.get?.(sessionId)?.header
    } catch {
      return undefined
    }
  }

  /** `hasOwnProperty`, because a stored `null` (全部) is a real answer. */
  function bindingOf(sessionId) {
    if (typeof sessionId !== 'string') return undefined
    return Object.prototype.hasOwnProperty.call(book.assignments, sessionId)
      ? book.assignments[sessionId]
      : undefined
  }

  function selectionForBinding(value) {
    if (value === undefined || value === null) return emptySelection()
    if (value === DEFAULT_DSH) return { base: BASE_DSH, kit: null, extras: [] }
    return { base: BASE_KIT, kit: value, extras: [] }
  }

  function bindingForSelection(selection) {
    if (selection.base === BASE_DSH) return DEFAULT_DSH
    if (selection.base === BASE_KIT) return selection.kit ?? null
    return null
  }

  /** What a conversation created right now would start from. */
  function defaultBinding() {
    const wanted = book.defaultKit
    if (wanted === '') return null
    if (wanted === DEFAULT_DSH) return DEFAULT_DSH
    return resolveKit(lastAgent, wanted) === undefined ? null : wanted
  }

  /**
   * Give this conversation its ONE binding, if it has none yet.
   *
   * Called lazily (first state read, first tool call) as well as on
   * `agent/created`, because the tool layer may not be readable yet when
   * `agent/created` fires. Three rules:
   *   - a fork inherits its parent's binding (the parent's context is what the
   *     child was cut from; re-deriving it from today's default would change
   *     the tools mid-fork);
   *   - a conversation that predates the upgrade keeps the state it effectively
   *     had (全部) instead of inheriting today's default;
   *   - a subagent gets no entry at all (R11) — its parent's filters already
   *     shape what it can see, and it must not pin a kit for itself.
   */
  function ensureBinding(agent) {
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined) return undefined
    const existing = bindingOf(sessionId)
    if (existing !== undefined) return existing
    const header = sessionHeaderOf(sessionId)
    if (header?.origin === 'subagent') return undefined
    let value
    const parentBinding = header?.parentSession === undefined ? undefined : bindingOf(header.parentSession)
    if (parentBinding !== undefined) value = parentBinding
    else if (book.migratedAt !== undefined && typeof header?.createdAt === 'number'
      && header.createdAt < Date.parse(book.migratedAt)) value = null
    else value = defaultBinding()
    book.assignments[sessionId] = value
    save()
    return value
  }

  function currentSelection(agent) {
    const entry = agent === undefined || agent === null ? undefined : state.get(agent)
    const raw = entry?.selection
    if (raw === undefined) {
      // No live restriction yet: fall back to the persisted binding, so a
      // restarted app and a fresh HTTP read agree with what the chip shows.
      const bound = bindingOf(sessionIdOf(agent))
      return bound === undefined ? emptySelection() : selectionForBinding(bound)
    }
    const base = raw.base === BASE_DSH || raw.base === BASE_KIT ? raw.base : BASE_ALL
    if (base === BASE_ALL) return emptySelection()
    if (base === BASE_DSH) return { base: BASE_DSH, kit: null, extras: dedupe(asNames(raw.extras)) }
    return {
      base: BASE_KIT,
      kit: typeof raw.kit === 'string' && raw.kit !== '' ? raw.kit : null,
      extras: dedupe(asNames(raw.extras)),
    }
  }

  /** User kit first, then a shipped preset, then this agent's transient kit. */
  function resolveKit(agent, wanted) {
    if (typeof wanted !== 'string') return undefined
    const userKit = findKit(book.kits, wanted)
    if (userKit !== undefined) return userKit
    const preset = findKit(presets, wanted)
    if (preset !== undefined) return preset
    const custom = agent === undefined ? undefined : customKits.get(agent)
    if (custom !== undefined && (custom.name.toLowerCase() === wanted.trim().toLowerCase()
      || custom.title.toLowerCase() === wanted.trim().toLowerCase())) return custom
    return undefined
  }

  function isPresetName(wanted) {
    return findKit(presets, wanted) !== undefined && findKit(book.kits, wanted) === undefined
  }

  /**
   * The built-ins and plugins a kit stands for.
   *
   * New kits carry both arrays. A legacy kit (0.5 store, hand-written config)
   * only carries `allow`; classify it against the live catalog.
   */
  function kitParts(kit) {
    if (kit.builtins.length > 0 || kit.plugins.length > 0) {
      return { builtins: dedupe(asNames(kit.builtins)), plugins: dedupe(asNames(kit.plugins)) }
    }
    const catalog = splitCatalog()
    const pluginTools = new Set(catalog.plugins.flatMap((plugin) => plugin.tools))
    const builtins = kit.allow.filter((toolName) => !pluginTools.has(toolName) && !OWN_TOOLS.includes(toolName))
    const plugins = catalog.plugins
      .filter((plugin) => plugin.tools.length > 0 && plugin.tools.every((toolName) => kit.allow.includes(toolName)))
      .map((plugin) => plugin.id)
    return { builtins, plugins }
  }

  function rawKitAllow(kit) {
    const parts = kitParts(kit)
    if (parts.builtins.length === 0 && parts.plugins.length === 0) {
      // A legacy allow-only kit keeps its own order.
      return dedupe([...asNames(kit.allow), ...OWN_TOOLS])
    }
    return dedupe([...parts.builtins, ...expandPlugins(parts.plugins), ...OWN_TOOLS])
  }

  function describeKit(kit) {
    const parts = kitParts(kit)
    if (parts.builtins.length === 0 && parts.plugins.length === 0) {
      return kit.allow.length === 0 ? '全部工具' : kit.allow.join(', ')
    }
    const bits = [`内置 ${parts.builtins.length} 个`]
    if (parts.plugins.length > 0) bits.push(`插件 ${parts.plugins.length} 个`)
    return bits.join(' · ')
  }

  function normalizeSelection(agent, selection) {
    const raw = selection ?? {}
    if (raw.base === BASE_ALL || raw.base === undefined) return emptySelection()
    if (raw.base === BASE_DSH) return { base: BASE_DSH, kit: null, extras: dedupe(asNames(raw.extras)) }
    const kit = resolveKit(agent, raw.kit)
    if (kit === undefined) return undefined
    return { base: BASE_KIT, kit: kit.name, extras: dedupe(asNames(raw.extras)) }
  }

  function labelOf(agent, selection) {
    if (selection.base === BASE_ALL) return '全部'
    if (selection.base === BASE_DSH) return '仅内置'
    const kit = resolveKit(agent, selection.kit)
    return kit?.title ?? (selection.kit ?? '套装')
  }

  /**
   * Mask the tools a selection leaves out by DENYING them — never by writing an
   * allow list.
   *
   * Measured on this runtime (the 0.7.0 and 0.8.0 incidents): `restrict({ allow })`
   * replaces the visible set for every scope under the agent, and the tools a
   * conversation registers on its own layer — every built-in, `pwsh` included —
   * can never be named in `allow`. One allow list therefore strips the session
   * bare, and it does so silently: the call returns 200 and the model simply has
   * no tools left. A `deny` list only subtracts, so a name we leave out cannot
   * be lost.
   *
   * `restrict()` refuses names outside its inherited surface (exactly the
   * built-ins) while implementing a restriction as one append to the agent's
   * filter list. Names it accepts go through it; the rest go through the same
   * append, feature-detected. Every filter is a deny, so an unexpected layer
   * shape can only make the call fail closed — never strip.
   */
  function denyInLayer(tools, agent, names) {
    const layers = tools?.layers
    if (typeof layers?.effect !== 'function') {
      throw new Error('这个运行时的工具层不暴露 layers.effect，无法隐藏内置工具')
    }
    return layers.effect(agent.ctx, (layer) => layer.restrictions.append({ deny: new Set(names) }), {
      label: 'dsh-loadout: hide tools',
    })
  }

  /** Names the runtime shows this agent right now, or undefined when unreadable. */
  function visibleNamesFor(tools, agent) {
    // `schemas()` is what the model is actually offered — prefer it. `view()` is a
    // second opinion used only when the schema projection is missing.
    try {
      const schemas = tools.schemas?.(agent)
      if (Array.isArray(schemas)) return schemas.map((schema) => schema.name)
    } catch {
      // Fall through to the layer view below.
    }
    try {
      const view = tools.view?.(agent)
      if (view?.visible instanceof Map) return [...view.visible.keys()]
    } catch {
      // Neither reader works on this runtime.
    }
    return undefined
  }

  /** The names the runtime said it knows, parsed out of its own rejection. */
  function knownFromError(error) {
    const message = error instanceof Error ? error.message : String(error)
    const marker = 'known global tools:'
    const at = message.indexOf(marker)
    if (at < 0) return undefined
    return new Set(
      message
        .slice(at + marker.length)
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== ''),
    )
  }

  /**
   * Chars per token for tool definitions. Mixed Chinese/English text lands near
   * 3.5; the ledger quotes an estimate rather than pretending to measure.
   */
  const CHARS_PER_TOKEN = 3.5

  /** Wire size of one tool definition — the bytes the model is charged for. */
  function definitionChars(definition) {
    const { name, description, parameters } = definition ?? {}
    try {
      return JSON.stringify({ name: name ?? '', description: description ?? '', parameters: parameters ?? {} }).length
    } catch {
      return String(name ?? '').length
    }
  }

  /** Wire size of a projected schema — for the visible side this is exact. */
  function schemaChars(schema) {
    try {
      return JSON.stringify(schema).length
    } catch {
      return String(schema?.name ?? '').length
    }
  }

  /**
   * Every tool definition this host knows, keyed by name.
   *
   * Visible tools are not enough: the point of the ledger is pricing the tools a
   * selection HIDES, and the runtime only projects the visible ones through
   * `schemas()`. The layer maps still carry the full definitions.
   */
  function definitionIndex(tools, agent) {
    const index = new Map()
    const layers = tools?.layers
    const add = (name, definition) => {
      if (typeof name === 'string' && definition !== null && typeof definition === 'object' && !index.has(name)) {
        index.set(name, definition)
      }
    }
    // Layer tool tables are `NamedEntries` (they expose `entries()` and `keys()`
    // but are not Maps), so duck-type instead of `instanceof Map`.
    const take = (container) => {
      if (container === null || typeof container !== 'object') return
      if (typeof container.entries === 'function') {
        try {
          for (const [name, definition] of container.entries()) add(name, definition)
          return
        } catch {
          // Not iterable as pairs; fall through to a plain record.
        }
      }
      if (Array.isArray(container)) return
      for (const [name, definition] of Object.entries(container)) add(name, definition)
    }
    take(layers?.global?.tools)
    let chain = []
    try {
      if (typeof layers?.chainLayers === 'function') chain = layers.chainLayers(agent) ?? []
    } catch {
      chain = []
    }
    for (const layer of Array.isArray(chain) ? chain : []) take(layer?.tools)
    if (!Array.isArray(chain) || chain.length === 0) {
      const scoped = layers?.scoped
      if (scoped !== null && typeof scoped === 'object') {
        const values = typeof scoped.values === 'function' ? [...scoped.values()] : Object.values(scoped)
        for (const layer of values) take(layer?.tools)
      }
    }
    return index
  }

  function tokensOf(chars) {
    return Math.max(0, Math.round(chars / CHARS_PER_TOKEN))
  }

  /** Estimated prompt cost of a list of tool names. */
  function tokensForNames(names, index) {
    let chars = 0
    for (const name of asNames(names)) {
      const definition = index.get(name)
      if (definition !== undefined) chars += definitionChars(definition)
    }
    return tokensOf(chars)
  }

  /**
   * The last unrestricted (全部) reading, in definition chars.
   *
   * 全部 is the only moment the runtime shows every tool this agent can get, so
   * it is the honest denominator for "what did this switch save". A restricted
   * view cannot answer it: the deny filter already removed those tools from
   * `view(agent).visible`, which is why pricing both sides off the current view
   * reported a saving of zero for a kit that really does hide eleven tools.
   */
  let lastUnrestricted

  /**
   * The ledger: what this selection keeps in the prompt, and what 全部 costs.
   *
   * The kept side is the tools the mask left visible, priced through their
   * definitions; the denominator is the last 全部 reading. Only tools in
   * `catalogue` are priced — the layer map also holds tools other scopes
   * registered, which this agent never sees.
   */
  function ledgerFor(agent, keep, catalogue) {
    const tools = agent?.ctx?.tools ?? agent?.tools
    if (tools === undefined) return undefined
    const index = definitionIndex(tools, agent)
    const known = (name) => (index.has(name) ? index.get(name) : undefined)
    const visible = (visibleNamesFor(tools, agent) ?? []).filter((name) => catalogue === undefined || catalogue.has(name))
    let keptChars = 0
    let keptTools = 0
    let unpriced = 0
    for (const name of visible) {
      const definition = known(name)
      if (definition === undefined) {
        unpriced += 1
        continue
      }
      keptChars += definitionChars(definition)
      keptTools += 1
    }
    let totalChars = keptChars
    if (keep === undefined) {
      lastUnrestricted = { chars: keptChars, names: new Set(visible) }
    } else if (lastUnrestricted !== undefined) {
      totalChars = Math.max(lastUnrestricted.chars, keptChars)
    }
    const visibleTokens = tokensOf(keptChars)
    const totalTokens = tokensOf(totalChars)
    return {
      estimated: true,
      charsPerToken: CHARS_PER_TOKEN,
      visibleTools: keptTools,
      visibleTokens,
      totalTools: baselineTools(keep, visible, unpriced),
      totalTokens,
      savedTokens: Math.max(0, totalTokens - visibleTokens),
      unpriced,
    }
  }

  /**
   * Ledger for a page with no conversation attached: the settings page right
   * after a restart, before any conversation has been created in this process.
   * `ledgerFor` needs an agent to read a visible surface from, so without one the
   * page used to print "读不到工具定义". Pricing the whole catalogue is exactly
   * the 全部 number and reads better than an error.
   */
  function catalogueLedger(index, catalogue) {
    if (index.size === 0 || catalogue.size === 0) return undefined
    let chars = 0
    let priced = 0
    let unpriced = 0
    for (const name of catalogue) {
      const definition = index.get(name)
      if (definition === undefined) {
        unpriced += 1
        continue
      }
      chars += definitionChars(definition)
      priced += 1
    }
    if (priced === 0) return undefined
    const tokens = tokensOf(chars)
    return {
      estimated: true,
      charsPerToken: CHARS_PER_TOKEN,
      visibleTools: priced,
      visibleTokens: tokens,
      totalTools: priced,
      totalTokens: tokens,
      savedTokens: 0,
      unpriced,
    }
  }

  /** How many tools 全部 would show: the baseline when known, else this view. */  function baselineTools(keep, visible, unpriced) {
    if (keep === undefined) return visible.length - unpriced
    return Math.max(lastUnrestricted?.names.size ?? 0, visible.length - unpriced)
  }
  function applyMask(agent, keep) {
    const tools = agent.ctx?.tools
    if (tools === undefined) return { ok: false, reason: '这个会话没有可用的工具作用域（agent.ctx.tools）' }
    if (keep === undefined) return { ok: true, dispose: undefined, tools: [], hidden: [], bypassed: [] }
    const visible = visibleNamesFor(tools, agent)
    if (visible === undefined) return { ok: false, reason: '读不到当前会话的工具清单（tools.schemas / tools.view）' }
    const kept = visible.filter((name) => keep.has(name))
    const restricted = visible.filter((name) => name !== 'run_code' && !keep.has(name))
    if (restricted.length === 0) return { ok: true, dispose: undefined, tools: kept, hidden: [], bypassed: [] }
    const disposers = []
    const rollback = () => {
      for (const dispose of [...disposers].reverse()) {
        try {
          dispose?.()
        } catch {
          // A failed rollback must not hide the original error.
        }
      }
    }
    // Ask the runtime directly instead of predicting its answer: try one deny for
    // everything, and if it refuses some names, split the list it names back.
    let accepted = restricted
    let bypassed = []
    let installed = false
    try {
      disposers.push(tools.restrict({ deny: restricted }))
      installed = true
    } catch (error) {
      const known = knownFromError(error)
      if (known === undefined) {
        rollback()
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, reason: `未能应用这组工具：${message}` }
      }
      accepted = restricted.filter((name) => known.has(name))
      bypassed = restricted.filter((name) => !known.has(name))
    }
    try {
      if (!installed) {
        if (accepted.length > 0) disposers.push(tools.restrict({ deny: accepted }))
        if (bypassed.length > 0) disposers.push(denyInLayer(tools, agent, bypassed))
      }
    } catch (error) {
      rollback()
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, reason: `未能应用这组工具：${message}` }
    }
    // Post-condition: the promise of this plugin is "the tools you kept are still
    // there". Re-read the surface after installing; if a kept tool disappeared the
    // filter was wider than intended, so undo it and say so instead of shipping a
    // conversation whose tools silently went missing (0.7.0 / 0.8.0 each did).
    const after = visibleNamesFor(tools, agent)
    if (after !== undefined) {
      const afterSet = new Set(after)
      const lost = kept.filter((name) => !afterSet.has(name))
      if (lost.length > 0) {
        rollback()
        return { ok: false, reason: `这组工具会连保留的工具一起隐藏（${lost.join('、')}），已回滚` }
      }
    }
    return {
      ok: true,
      dispose: () => {
        for (const dispose of [...disposers].reverse()) {
          try {
            dispose?.()
          } catch {
            // Same tolerance the caller already gives a stale restriction.
          }
        }
      },
      tools: kept,
      hidden: restricted,
      bypassed,
    }
  }

  /** Tool names a selection keeps; undefined means "leave the agent alone". */
  function effectiveKeepFor(agent, selection) {
    if (selection.base === BASE_ALL) return undefined
    const extras = selection.extras ?? []
    if (selection.base === BASE_DSH) {
      return new Set(dedupe([...splitCatalog().builtins, ...expandPlugins(extras), ...OWN_TOOLS]))
    }
    const kit = resolveKit(agent, selection.kit)
    if (kit === undefined) return undefined
    const parts = kitParts(kit)
    if (parts.builtins.length === 0 && parts.plugins.length === 0) {
      return new Set(dedupe([...asNames(kit.allow), ...expandPlugins(extras), ...OWN_TOOLS]))
    }
    return new Set(dedupe([...parts.builtins, ...expandPlugins([...parts.plugins, ...extras]), ...OWN_TOOLS]))
  }

  /** Plugins the base already applies; extras only cover what is left. */
  function appliedPluginsFor(agent, selection) {
    if (selection.base === BASE_ALL) return splitCatalog().plugins.map((plugin) => plugin.id)
    if (selection.base === BASE_DSH) return []
    const kit = resolveKit(agent, selection.kit)
    return kit === undefined ? [] : kitParts(kit).plugins
  }

  function availableExtrasFor(agent, selection) {
    const applied = new Set(appliedPluginsFor(agent, selection))
    return splitCatalog().plugins.map((plugin) => plugin.id).filter((id) => !applied.has(id))
  }

  /**
   * Apply one choice to one agent. Every surface (menu, settings page, /kit)
   * funnels through here so the three never disagree.
   */
  function useSelection(agent, selection, options = {}) {
    if (agent?.ctx?.tools === undefined) return { ok: false, reason: '这个会话没有可用的工具作用域（agent.ctx.tools）' }
    const normalized = normalizeSelection(agent, selection)
    if (normalized === undefined) {
      return { ok: false, reason: `未知套装 "${String(selection?.kit ?? '')}"` }
    }
    const previous = state.get(agent)
    try {
      previous?.dispose?.()
    } catch {
      // A stale restriction that no longer undoes itself must not block the new one.
    }
    state.delete(agent)
    const keep = effectiveKeepFor(agent, normalized)
    const label = labelOf(agent, normalized)
    const result = applyMask(agent, keep)
    if (!result.ok) return result
    state.set(agent, { selection: normalized, label, dispose: result.dispose })
    // An explicit switch is the only thing that rewrites this conversation's
    // binding (ensureBinding writes the first one). Everything else — a default
    // change, a restart — must leave it alone.
    const sessionId = sessionIdOf(agent)
    if (sessionId !== undefined && options.persist !== false) {
      const next = bindingForSelection(normalized)
      if (bindingOf(sessionId) !== next) {
        book.assignments[sessionId] = next
        save()
      }
    }
    if (result.bypassed.length > 0) {
      ctx.logger?.warn(`dsh-loadout: 隐藏 ${result.hidden.length} 个工具，其中 ${result.bypassed.length} 个走工具层遮罩（${result.bypassed.join(', ')}）`)
    }
    return { ok: true, label, tools: result.tools, hidden: result.hidden, bypassed: result.bypassed }
  }

  function applyBase(agent, base, kitName) {
    const previous = currentSelection(agent)
    if (base === BASE_ALL || base === undefined) {
      return useSelection(agent, emptySelection())
    }
    if (base === BASE_DSH) {
      return useSelection(agent, { base: BASE_DSH, kit: null, extras: previous.extras })
    }
    const kit = resolveKit(agent, kitName)
    if (kit === undefined) return { ok: false, status: 400, reason: `未知套装 "${String(kitName ?? '')}"` }
    const parts = kitParts(kit)
    return useSelection(agent, {
      base: BASE_KIT,
      kit: kit.name,
      // A new base already containing a plugin must not keep it as an extra.
      extras: previous.extras.filter((id) => !parts.plugins.includes(id)),
    })
  }

  /**
   * Re-apply the current selection against the live catalog.
   *
   * Installing a plugin registers its tools while the conversation is already
   * open, and nothing re-reads the catalog on its own — the menu keeps showing
   * the list it fetched. Re-running the same selection is the cheap fix: the
   * allow list is rebuilt from what exists right now.
   */
  function refreshSelection(agent) {
    const selection = currentSelection(agent)
    if (selection.base === BASE_KIT && resolveKit(agent, selection.kit) === undefined) {
      return useSelection(agent, emptySelection())
    }
    return useSelection(agent, selection)
  }

  function toggleExtra(agent, id, on) {
    const selection = currentSelection(agent)
    const plugin = splitCatalog().plugins.find((entry) => entry.id === id)
    if (plugin === undefined) return { ok: false, status: 400, reason: `未知插件 "${String(id)}"` }
    if (appliedPluginsFor(agent, selection).includes(id)) {
      const where = selection.base === BASE_ALL ? '「全部」' : `套装「${labelOf(agent, selection)}」`
      return { ok: false, status: 400, reason: `插件「${plugin.title}」已由${where}应用，不需要再加挂` }
    }
    const extras = on
      ? dedupe([...selection.extras, id])
      : selection.extras.filter((entry) => entry !== id)
    return useSelection(agent, { ...selection, extras })
  }

  /** `存为新套装` / `覆盖当前套装` behind the 加挂 group. */
  function saveSelectionAs(agent, input) {
    const mode = input?.mode === 'overwrite' ? 'overwrite' : 'new'
    const selection = currentSelection(agent)
    if (selection.base === BASE_ALL) throw new Error('「全部」下没有需要保存的选择')
    const catalog = splitCatalog()
    const currentKit = selection.base === BASE_KIT ? resolveKit(agent, selection.kit) : undefined
    if (selection.base === BASE_KIT && currentKit === undefined) {
      throw new Error(`未知套装 "${String(selection.kit ?? '')}"`)
    }
    const baseParts = currentKit === undefined ? { builtins: [], plugins: [] } : kitParts(currentKit)
    const builtins = selection.base === BASE_DSH
      ? catalog.builtins.filter((toolName) => !OWN_TOOLS.includes(toolName))
      : dedupe(baseParts.builtins)
    const plugins = dedupe([...baseParts.plugins, ...selection.extras])

    if (mode === 'overwrite') {
      if (selection.base !== BASE_KIT) throw new Error('只有「我的套装」可以覆盖保存')
      const target = findKit(book.kits, currentKit.name)
      if (target === undefined) throw new Error('预置套装只读，请另存为我的套装')
      target.builtins = builtins
      target.plugins = plugins
      target.allow = expandSelection(target.builtins, target.plugins)
      target.deny = []
      save()
      const result = useSelection(agent, { base: BASE_KIT, kit: target.name, extras: [] })
      if (!result.ok) throw new Error(result.reason)
      return { mode, kit: target }
    }

    const kitName = typeof input?.name === 'string' ? input.name.trim() : ''
    if (kitName === '') throw new Error('给套装起个名字')
    const kit = operations.create({
      name: kitName,
      title: typeof input?.title === 'string' && input.title.trim() !== '' ? input.title.trim() : kitName,
      note: typeof input?.note === 'string' ? input.note : '',
      builtins,
      plugins,
    })
    const result = useSelection(agent, { base: BASE_KIT, kit: kit.name, extras: [] })
    if (!result.ok) throw new Error(result.reason)
    return { mode, kit }
  }

  /**
   * Does the live selection already come from this binding?
   *
   * Only the base and the kit are compared: 加挂 (extras) are session-local and
   * deliberately NOT persisted to `assignments`, so a state read that treated a
   * different extras list as "the binding changed" would wipe them — the exact
   * regression this comparison exists to prevent.
   */
  function sameSelection(left, right) {
    return left.base === right.base
      && (left.kit ?? null) === (right.kit ?? null)
  }

  /**
   * Make this conversation's tool layer match its persisted binding.
   *
   * `ensureBinding` owns the "what does this conversation start from" decision;
   * this function only applies it. It is idempotent (once base+kit match, nothing
   * is re-applied), and it runs from `agent/created`, from one deferred retry
   * (the tool layer can attach a tick after creation), and from `snapshot()` —
   * the UI reads state before the first message, which closes the 0.9.x window
   * where a saved default silently did nothing.
   */
  function ensureBindingApplied(agent) {
    if (agent === undefined || agent === null) return
    let value = ensureBinding(agent)
    if (value === undefined) return
    // A stored binding can name a kit that no longer exists — an older build, a
    // hand-edited store, or a kit deleted while the app was closed. Applying it
    // would compute an empty allow list and strip the conversation down to the
    // kit_* tools, so such a conversation falls back to 全部 and the dangling
    // name is rewritten to stop it resurfacing on every read.
    if (value !== null && value !== DEFAULT_DSH && resolveKit(lastAgent, value) === undefined) {
      book.assignments[sessionIdOf(agent)] = null
      save()
      ctx.logger?.warn(`dsh-loadout: 套装「${value}」已不存在，这个对话回到「全部」`)
      value = null
    }
    const selection = selectionForBinding(value)
    const current = state.get(agent)?.selection
    if (current !== undefined && sameSelection(current, selection)) return
    // The binding is already stored by ensureBinding; applying it must not write
    // it again (that would turn a default into an explicit choice).
    const result = useSelection(agent, selection, { persist: false })
    if (!result.ok) ctx.logger?.warn(`dsh-loadout: 会话绑定 ${labelOf(agent, selection)} 未应用：${result.reason}`)
  }

  ctx.on('agent/created', (agent) => {
    rememberAgent(agent)
    ensureBindingApplied(agent)
    // The tool layer can attach a tick after creation; one deferred retry covers
    // that race without putting timers on any hot path.
    const retry = setTimeout(() => ensureBindingApplied(agent), 100)
    if (typeof retry?.unref === 'function') retry.unref()
  })

  try {
    ctx.effect(() => () => {
      for (const [, entry] of state) {
        try {
          entry.dispose?.()
        } catch {
          // ignore
        }
      }
      state.clear()
    })
  } catch {
    // No effect registration available; restrictions still die with their agent.
  }

  // ---- what can a kit contain? ---------------------------------------------
  /**
   * Tool names one agent can see, discovered without a private API.
   *
   * Tools reach a model from three places: core packages, host-side plugin
   * fibers, and per-agent registrations. Only the core ones sit in the global
   * registry, so asking the bare registry would hide exactly the downloaded
   * plugins a kit is meant to organize — hence per-agent views plus memory.
   */
  function toolNamesOf(agent) {
    const tools = agent?.ctx?.tools
    if (tools === undefined) return []
    try {
      const schemas = tools.schemas?.(agent)
      if (Array.isArray(schemas) && schemas.length > 0) return schemas.map((entry) => entry.name).filter(Boolean)
    } catch {
      // fall through to the probe
    }
    try {
      // A rejected restriction names every global tool it knows about.
      tools.restrict({ deny: ['__dsh_loadout_probe__'] })
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error)
      const match = /known global tools: ([^;]+)/u.exec(message)
      if (match !== null) {
        return match[1].split(',').map((entry) => entry.trim().replace(/^"|"$/gu, '')).filter(Boolean)
      }
    }
    return []
  }

  function learnTools(agent) {
    for (const toolName of toolNamesOf(agent)) knownTools.add(toolName)
    try {
      for (const schema of ctx.tools?.schemas?.() ?? []) if (schema?.name !== undefined) knownTools.add(schema.name)
    } catch {
      // Global view unavailable; agent views already contribute.
    }
  }

  function toolCatalog() {
    // A brand-new host may have no agent yet; the shipped kits still name a few tools.
    if (knownTools.size <= OWN_TOOLS.length) {
      for (const kit of [...presets, ...book.kits]) {
        for (const toolName of kit.allow) knownTools.add(toolName)
        for (const toolName of kit.builtins) knownTools.add(toolName)
      }
    }
    return [...knownTools].sort()
  }

  /**
   * Tools whose name starts with one of these prefixes are the Harness's own,
   * whatever else the profile has installed. Downloaded plugins can pick the
   * same prefix, so the built-ins win.
   */
  const BUILTIN_PREFIXES = new Set([
    'todo', 'web', 'kit', 'agent', 'work', 'read', 'write', 'edit', 'glob', 'grep',
    'ask', 'present', 'skill', 'workflow', 'subagent', 'send', 'list', 'interrupt',
    'job', 'schedule', 'create', 'get', 'update', 'exit', 'compress', 'decompress',
    'search', 'load', 'working',
  ])

  /** Words inside a package name that say nothing about the plugin. */
  const NAME_NOISE = new Set([
    'core', 'tools', 'tool', 'client', 'server', 'shared', 'common', 'plugin', 'plugins',
    'dsh', 'ui', 'web', 'harness', 'extension', 'preset', 'settings', 'sidebar', 'runtime',
  ])

  /**
   * The profile's installed packages. A downloaded plugin is a package; the
   * registry does not record which package registered a tool, so the package
   * name is used instead. Read from `<profile>/package.json`, which sits two
   * directories above this bundle inside the profile's node_modules.
   */
  const profileCache = { at: 0, names: [] }

  function profilePackages() {
    if (Date.now() - profileCache.at < 5000) return profileCache.names
    const candidates = [fileURLToPath(new URL('../../../package.json', import.meta.url))]
    try {
      const home = join(homedir(), '.dsh', 'profiles')
      if (existsSync(home)) {
        for (const entry of readdirSync(home)) candidates.push(join(home, entry, 'package.json'))
      }
    } catch { /* a missing profiles directory is not an error */ }
    const names = new Set()
    for (const file of candidates) {
      try {
        if (!existsSync(file)) continue
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        for (const section of [parsed.dependencies, parsed.devDependencies]) {
          for (const packageName of Object.keys(section ?? {})) names.add(packageName)
        }
        for (const bundle of parsed?.dsh?.profile?.bundles ?? []) {
          if (typeof bundle === 'string') names.add(bundle)
        }
      } catch { /* a malformed profile is skipped, never fatal */ }
    }
    profileCache.at = Date.now()
    profileCache.names = [...names]
    return profileCache.names
  }

  /** Package name -> the tokens a tool prefix may match. */
  function pluginTokenIndex() {
    const index = new Map()
    for (const packageName of profilePackages()) {
      const base = packageName.replace(/^@[^/]+\//, '')
      if (base === name) continue
      const stripped = base.replace(/^dsh-/, '').replace(/^plugin-/, '')
      const tokens = [stripped, ...stripped.split('-')]
        .map((token) => token.toLowerCase())
        .filter((token) => token.length >= 3 && !NAME_NOISE.has(token) && !BUILTIN_PREFIXES.has(token))
      for (const token of tokens) {
        if (!index.has(token)) index.set(token, { id: token, packageName: base, title: stripped })
      }
    }
    return index
  }

  /**
   * Names grouped by the layer they are registered in, read straight from the
   * tool runtime's own layer table.
   *
   * `global` holds tools registered once for the whole host: every downloaded
   * plugin (and this one) lands there. `scoped` holds the tools each agent gets
   * from the core packages — the Harness's own read/write/pwsh and friends.
   * That split is exactly what the panel shows, and it needs no naming guess.
   */
  function layerCatalog() {
    const scoped = []
    const global = []
    try {
      const layers = ctx.tools?.layers
      for (const actor of ['scoped']) {
        const table = layers?.[actor]
        if (!(table instanceof Map)) continue
        for (const [, layer] of table) {
          for (const toolName of layer?.tools?.keys?.() ?? []) scoped.push(toolName)
        }
      }
      for (const toolName of layers?.global?.tools?.keys?.() ?? []) global.push(toolName)
    } catch {
      // Older runtime without a layer table: fall back to what agents showed us.
    }
    return { scoped: dedupe(scoped), global: dedupe(global) }
  }

  function splitCatalog() {
    const owners = pluginTokenIndex()
    const layers = layerCatalog()
    const builtins = new Set(layers.scoped)
    const groups = new Map()
    const candidates = layers.global.length > 0 ? layers.global : toolCatalog()
    for (const toolName of candidates) {
      const cut = toolName.indexOf('_')
      const prefix = cut > 0 ? toolName.slice(0, cut).toLowerCase() : ''
      const owner = prefix === '' || BUILTIN_PREFIXES.has(prefix) ? undefined : owners.get(prefix)
      if (owner === undefined) {
        builtins.add(toolName)
        continue
      }
      if (!groups.has(owner.id)) groups.set(owner.id, { id: owner.id, title: owner.title, tools: [] })
      groups.get(owner.id).tools.push(toolName)
    }
    for (const toolName of layers.scoped) builtins.add(toolName)
    return {
      builtins: [...builtins].sort(),
      plugins: [...groups.values()].sort((left, right) => left.title.localeCompare(right.title)),
    }
  }

  /** Plugin ids -> every tool those plugins register. */
  function expandPlugins(ids) {
    const byId = new Map(splitCatalog().plugins.map((plugin) => [plugin.id, plugin.tools]))
    const out = []
    for (const id of asNames(ids)) {
      for (const toolName of byId.get(id) ?? []) out.push(toolName)
    }
    return dedupe(out)
  }

  /** Built-ins + whole plugins + this plugin's own tools. */
  function expandSelection(builtins, plugins) {
    return dedupe([...asNames(builtins), ...expandPlugins(plugins), ...OWN_TOOLS])
  }

  // ---- shared operations, used by tools, the command and the routes --------
  /** How many conversations are pinned to this kit (a delete warning quotes it). */
  function boundCountOf(name) {
    let count = 0
    for (const value of Object.values(book.assignments)) if (value === name) count += 1
    return count
  }

  function kitRow(kit) {
    const parts = kitParts(kit)
    return {
      name: kit.name,
      title: kit.title,
      note: kit.note ?? '',
      builtins: parts.builtins,
      plugins: parts.plugins,
      allow: rawKitAllow(kit),
      description: describeKit(kit),
      isDefault: kit.name === book.defaultKit,
      boundCount: boundCountOf(kit.name),
    }
  }

  function snapshot(agent = lastAgent) {
    // A conversation may reach its first state read before the creation listener
    // could install its binding (the tool layer is not readable yet at that
    // moment). Retrying here means the chip shows, and the first message uses,
    // the binding instead of 全部.
    ensureBindingApplied(agent)
    const selection = currentSelection(agent)
    const appliedPlugins = appliedPluginsFor(agent, selection)
    const availableExtras = availableExtrasFor(agent, selection)
    const label = labelOf(agent, selection)
    const catalog = splitCatalog()
    // Price against THIS agent's catalogue. The layer map also holds tools that
    // belong to other scopes (workflow, cordis_inspect, vision …); pricing a kit
    // over those would promise savings the agent can never see.
    const catalogue = new Set([...catalog.builtins, ...catalog.plugins.flatMap((plugin) => plugin.tools)])
    // With no agent (settings page before the first conversation after a
    // restart) the global tool service still exposes the same layer maps, which
    // is enough to price the catalogue.
    const index = definitionIndex(agent?.ctx?.tools ?? ctx.tools, agent)
    const ledger = ledgerFor(agent, effectiveKeepFor(agent, selection), catalogue) ?? catalogueLedger(index, catalogue)
    // Price a kit over the tools this agent can actually get. Its allow list may
    // name tools other scopes register; counting those would print a number
    // larger than the whole tool table.
    const surface = new Set(visibleNamesFor(agent?.ctx?.tools, agent) ?? [])
    const universe = surface.size > 0 ? surface : catalogue
    const priced = (row) => {
      if (index.size === 0) return row
      const names = asNames(row.allow ?? row.builtins).filter((name) => universe.has(name))
      return { ...row, tokens: tokensForNames(names, index) }
    }
    return {
      source: book.source,
      // `description` is what the settings page's shared KitCard renders for both
      // kinds, so a preset must carry the same summary a user kit does.
      presets: presets.map((kit) => priced({ name: kit.name, title: kit.title, allow: rawKitAllow(kit), description: describeKit(kit) })),
      presetNames: presets.map((kit) => kit.name),
      kits: book.kits.map((kit) => priced(kitRow(kit))),
      defaultKit: book.defaultKit,
      // This conversation's own binding: `null` (全部), '@dsh', a kit name, or
      // '' when the conversation has none (a subagent). The chip reads this
      // instead of inferring "no kit" from the live label.
      binding: bindingOf(sessionIdOf(agent)) ?? '',
      ledger,
      catalog,
      tools: toolCatalog(),
      selection,
      label,
      active: label,
      appliedPlugins,
      availableExtras,
    }
  }

  /**
   * The live agent behind a Session id, for calls that arrive over HTTP.
   *
   * A tool call carries its own agent; a button in the UI does not, so the
   * client posts the Session it is looking at and the host resolves it back to
   * the same agent object a tool would have used.
   */
  async function agentForSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, reason: '缺少会话 id' }
    if (sessionController === undefined) return { ok: false, reason: '宿主没有会话控制器，无法按会话切换' }
    const found = await sessionController.resolveAgent(sessionId)
    if (found?.agent !== undefined) return { ok: true, agent: found.agent }
    return { ok: false, reason: found?.error?.message ?? '找不到这个会话' }
  }

  const operations = {
    create(input) {
      if (typeof input?.note === 'string' && input.note.trim().length > NOTE_MAX) {
        throw new Error(`备注最多 ${NOTE_MAX} 个字`)
      }
      const kit = normalizeKit(input ?? {})

      if (kit === undefined) throw new Error('名字不能为空')
      kit.name = assertKitName(kit.name, presets)
      if (findKit(book.kits, kit.name) !== undefined) throw new Error(`套装 "${kit.name}" 已存在`)
      if (Array.isArray(input?.builtins) || Array.isArray(input?.plugins)) {
        kit.builtins = dedupe(asNames(input.builtins))
        kit.plugins = dedupe(asNames(input.plugins))
        kit.allow = expandSelection(kit.builtins, kit.plugins)
        kit.deny = []
      }
      if (kit.allow.length === 0 && kit.builtins.length === 0 && kit.plugins.length === 0) {
        throw new Error('至少要选一个内置工具或一个插件，否则这个包等于"全部"')
      }
      book.kits.push(kit)
      save()
      return kit
    },
    update(input) {
      if (typeof input?.note === 'string' && input.note.trim().length > NOTE_MAX) {
        throw new Error(`备注最多 ${NOTE_MAX} 个字`)
      }
      const wanted = String(input?.name ?? '')
      const kit = findKit(book.kits, wanted)
      if (kit === undefined) {
        if (findKit(presets, wanted) !== undefined) throw new Error('预置套装只读，请另存为我的套装')
        throw new Error(`未知套装 "${wanted}"`)
      }
      const oldName = kit.name
      if (typeof input.rename === 'string' && input.rename.trim() !== '' && input.rename.trim() !== kit.name) {
        const nextName = assertKitName(input.rename, presets)
        if (findKit(book.kits, nextName) !== undefined) throw new Error(`套装 "${nextName}" 已存在`)
        if (book.defaultKit === kit.name) book.defaultKit = nextName
        // A rename moves the identity, so every conversation pinned to the old
        // name follows it — otherwise those conversations would read as 全部.
        for (const [sessionId, value] of Object.entries(book.assignments)) {
          if (value === oldName) book.assignments[sessionId] = nextName
        }
        kit.name = nextName
      }
      if (typeof input.title === 'string' && input.title.trim() !== '') kit.title = input.title.trim()
      if (typeof input.note === 'string') kit.note = clampNote(input.note)
      if (input.allow !== undefined || input.deny !== undefined) {
        // An explicit allow/deny list replaces the builtins+plugins form, but it
        // is classified right away: the store only persists builtins+plugins, so
        // an allow-only kit would otherwise read back as "empty" and vanish.
        if (input.allow !== undefined) kit.allow = dedupe(asNames(input.allow))
        if (input.deny !== undefined) kit.deny = dedupe(asNames(input.deny))
        kit.builtins = []
        kit.plugins = []
        const classified = kitParts(kit)
        kit.builtins = classified.builtins
        kit.plugins = classified.plugins
      }
      if (Array.isArray(input.builtins) || Array.isArray(input.plugins)) {
        if (input.builtins !== undefined) kit.builtins = dedupe(asNames(input.builtins))
        if (input.plugins !== undefined) kit.plugins = dedupe(asNames(input.plugins))
        kit.allow = expandSelection(kit.builtins, kit.plugins)
        kit.deny = []
      }
      if (kit.allow.length > 0 && kit.deny.length > 0) kit.deny = []
      if (kit.allow.length === 0 && kit.builtins.length === 0 && kit.plugins.length === 0) {
        throw new Error('至少要选一个内置工具或一个插件，否则这个包等于"全部"')
      }
      if (oldName !== kit.name) {
        for (const [agent, entry] of [...state]) {
          if (entry.selection.base === BASE_KIT && entry.selection.kit === oldName) {
            entry.selection = { ...entry.selection, kit: kit.name }
            entry.label = labelOf(agent, entry.selection)
          }
        }
      }
      // Editing the tools of the kit a conversation is running has to change that
      // conversation now: a saved edit that only takes effect after the next
      // switch reads as "the edit did nothing".
      //
      // Iterate a snapshot: `useSelection` deletes and re-adds the agent's entry,
      // and a Map iterator that is handed back an entry it already passed never
      // finishes (that is a hang, not a slow loop).
      for (const [agent, entry] of [...state]) {
        if (entry.selection.base === BASE_KIT && entry.selection.kit === kit.name) {
          useSelection(agent, { base: BASE_KIT, kit: kit.name, extras: [...entry.selection.extras] })
        }
      }
      save()
      return kit
    },
    remove(input) {
      const dryRun = input?.dryRun === true
      const wanted = String(input?.name ?? '')
      const kit = findKit(book.kits, wanted)
      if (kit === undefined) {
        if (findKit(presets, wanted) !== undefined) throw new Error('预置套装只读，请另存为我的套装')
        throw new Error(`未知套装 "${wanted}"`)
      }
      // Quoted by the delete confirmation ("N 个对话正在用它") and by the tool's
      // dry run, so a destructive click is never a surprise.
      const affected = boundCountOf(kit.name)
      if (dryRun) return { kit, affected }
      book.kits = book.kits.filter((row) => row !== kit)
      if (book.defaultKit === kit.name) book.defaultKit = ''
      // A binding is an explicit answer; the kit is gone, so the honest answer is
      // 全部 (null) — never "inherit whatever the default is today".
      for (const [sessionId, value] of Object.entries(book.assignments)) {
        if (value === kit.name) book.assignments[sessionId] = null
      }
      // Snapshot for the same reason as `update`: each `useSelection` rewrites the
      // map entry it belongs to.
      for (const [agent, entry] of [...state]) {
        if (entry.selection.base === BASE_KIT && entry.selection.kit === kit.name) {
          useSelection(agent, emptySelection())
        }
      }
      save()
      return { kit, affected }
    },
    setDefault(input) {
      const wanted = typeof input?.name === 'string' ? input.name.trim() : ''
      if (wanted === '' || wanted === DEFAULT_DSH) {
        book.defaultKit = wanted
        save()
        return { defaultKit: book.defaultKit }
      }
      const kit = resolveKit(lastAgent, wanted)
      if (kit === undefined) throw new Error(`未知套装 "${wanted}"`)
      book.defaultKit = kit.name
      save()
      return { defaultKit: book.defaultKit }
    },
  }

  // ---- tools ---------------------------------------------------------------
  const outputSchema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false })

  ctx.tools.register({
    name: 'kit_list',
    description: 'List the tool kits defined for this profile, which base and extras this conversation uses, '
      + 'and where they are stored. A kit is a named set of tools for one kind of work; other conversations keep their own.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: () => true,
    output: {
      schema: outputSchema({
        active: { type: 'string' },
        base: { type: 'string' },
        extras: { type: 'array', items: { type: 'string' } },
        default: { type: 'string' },
        binding: { type: 'string' },
        source: { type: 'string' },
        kits: {
          type: 'array',
          items: outputSchema({
            name: { type: 'string' },
            title: { type: 'string' },
            note: { type: 'string' },
            tools: { type: 'array', items: { type: 'string' } },
            boundCount: { type: 'number' },
          }, ['name', 'title', 'tools', 'boundCount']),
        },
        presets: {
          type: 'array',
          items: outputSchema({
            name: { type: 'string' },
            title: { type: 'string' },
            note: { type: 'string' },
            tools: { type: 'array', items: { type: 'string' } },
          }, ['name', 'title', 'tools']),
        },
      }, ['active', 'base', 'extras', 'default', 'binding', 'source', 'kits', 'presets']),
      render: (_args, value) => text([
        `当前：${value.active === '' ? '(未设置)' : value.active}（base=${value.base}${value.extras.length > 0 ? `，加挂 ${value.extras.length} 个` : ''}）`,
        `默认套装：${value.default === '' ? '(未设置)' : value.default}`,
        `存储：${value.source}`,
        '我的套装：',
        ...(value.kits.length === 0 ? ['- (还没有)'] : value.kits.map((kit) => `- ${kit.name} (${kit.title})${kit.note ? `（${kit.note}）` : ''}: ${kit.tools.length > 0 ? kit.tools.join(', ') : '全部工具'}`)),
        '预设套装（只读）：',
        ...(value.presets.length === 0 ? ['- (无)'] : value.presets.map((kit) => `- ${kit.name} (${kit.title})${kit.note ? `（${kit.note}）` : ''}: ${kit.tools.length > 0 ? kit.tools.join(', ') : '全部工具'}`)),
      ].join('\n')),
    },
    async execute(_args, exec) {
      const agent = agentOf(exec) ?? lastAgent
      rememberAgent(agent)
      const selection = currentSelection(agent)
      return {
        active: labelOf(agent, selection),
        base: selection.base,
        extras: selection.extras,
        default: book.defaultKit,
        binding: bindingOf(sessionIdOf(agent)) ?? '',
        source: book.source,
        kits: book.kits.map((kit) => ({
          name: kit.name,
          title: kit.title,
          note: kit.note ?? '',
          tools: rawKitAllow(kit),
          boundCount: boundCountOf(kit.name),
        })),
        presets: presets.map((kit) => ({ name: kit.name, title: kit.title, note: kit.note ?? '', tools: rawKitAllow(kit) })),
      }
    },
  })

  ctx.tools.register({
    name: 'kit_apply',
    description: 'Switch this conversation to a tool kit (base = that kit, extras cleared). '
      + 'The kit replaces the visible tool set for this conversation only; other conversations keep their own. '
      + 'Use it when the work changes kind.',
    parameters: {
      type: 'object',
      properties: { kit: { type: 'string', description: `Kit name or title. One of: ${[...book.kits, ...presets].map((kit) => kit.name).join(', ')}` } },
      required: ['kit'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        kit: { type: 'string' },
        tools: { type: 'array', items: { type: 'string' } },
        message: { type: 'string' },
      }, ['kit', 'tools', 'message']),
      render: (_args, value) => text(value.message),
    },
    async execute(args, exec) {
      const agent = agentOf(exec) ?? lastAgent
      rememberAgent(agent)
      const kit = resolveKit(agent, args?.kit)
      if (kit === undefined) {
        const names = [...book.kits, ...presets].map((row) => row.name)
        throw new Error(`kit_apply: 未知套装 "${String(args?.kit ?? '')}"；可用：${names.join(', ') || '(无)'}`)
      }
      if (agent === undefined) throw new Error('kit_apply: 拿不到当前会话的 agent，无法应用套装')
      const result = useSelection(agent, { base: BASE_KIT, kit: kit.name, extras: [] })
      if (!result.ok) throw new Error(`kit_apply: ${kit.name} 应用失败：${result.reason}`)
      const tools = result.tools.length > 0 ? result.tools.join(', ') : '全部工具'
      return { kit: kit.name, tools: result.tools, message: `已切换到套装 ${kit.name} (${kit.title})。下一步起可见工具：${tools}。` }
    },
  })

  ctx.tools.register({
    name: 'kit_create',
    description: 'Create a tool kit (a named set of tools) and persist it. Later conversations can use it through kit_apply or as the default. '
      + 'Give builtins (Harness tool names) and/or plugins (plugin ids from kit_list); an allow list still works for one-off kits.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short id used by kit_apply, e.g. "writing".' },
        title: { type: 'string', description: 'Human label shown in lists.' },
        builtins: { type: 'array', items: { type: 'string' } },
        plugins: { type: 'array', items: { type: 'string' } },
        allow: { type: 'array', items: { type: 'string' } },
        deny: { type: 'array', items: { type: 'string' } },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({ name: { type: 'string' }, message: { type: 'string' } }, ['name', 'message']),
      render: (_args, value) => text(value.message),
    },
    async execute(args) {
      const kit = operations.create(args)
      return { name: kit.name, message: `已创建套装 ${kit.name} (${kit.title})：${describeKit(kit)}` }
    },
  })

  ctx.tools.register({
    name: 'kit_set_tools',
    description: 'Replace the tool list of one of my kits and persist it. Presets are read-only: save as one of my kits instead. '
      + 'Pass builtins and/or plugins; allow/deny still work for one-off kits.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        builtins: { type: 'array', items: { type: 'string' } },
        plugins: { type: 'array', items: { type: 'string' } },
        allow: { type: 'array', items: { type: 'string' } },
        deny: { type: 'array', items: { type: 'string' } },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({ name: { type: 'string' }, tools: { type: 'array', items: { type: 'string' } }, message: { type: 'string' } }, ['name', 'tools', 'message']),
      render: (_args, value) => text(value.message),
    },
    async execute(args) {
      const kit = operations.update({
        name: args?.name,
        builtins: args?.builtins,
        plugins: args?.plugins,
        allow: args?.allow,
        deny: args?.deny,
      })
      return { name: kit.name, tools: rawKitAllow(kit), message: `套装 ${kit.name} 现在是：${describeKit(kit)}` }
    },
  })

  ctx.tools.register({
    name: 'kit_set_default',
    description: 'Choose the kit new conversations start with (a preset or one of my kits). An empty name starts new conversations unrestricted.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({ default: { type: 'string' }, message: { type: 'string' } }, ['default', 'message']),
      render: (_args, value) => text(value.message),
    },
    async execute(args) {
      const result = operations.setDefault(args)
      const message = result.defaultKit === ''
        ? '新会话将不再自动套用套装（全部工具）。'
        : result.defaultKit === DEFAULT_DSH
          ? '新会话默认只带 Harness 自带工具（仅内置）。现有会话不受影响。'
          : `新会话默认使用套装 ${result.defaultKit}。现有会话不受影响。`
      return { default: result.defaultKit, message }
    },
  })

  ctx.tools.register({
    name: 'kit_delete',
    description: 'Remove one of my kits from the store. Presets cannot be deleted. '
      + 'Conversations pinned to the kit fall back to 全部; pass dryRun to see how many first.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        dryRun: { type: 'boolean', description: 'Only report affectedSessions; delete nothing.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        name: { type: 'string' },
        affectedSessions: { type: 'number' },
        deleted: { type: 'boolean' },
        message: { type: 'string' },
      }, ['name', 'affectedSessions', 'deleted', 'message']),
      render: (_args, value) => text(value.message),
    },
    async execute(args) {
      const dryRun = args?.dryRun === true
      const { kit, affected } = operations.remove(args)
      if (dryRun) {
        return {
          name: kit.name,
          affectedSessions: affected,
          deleted: false,
          message: affected > 0
            ? `套装 ${kit.name} 正被 ${affected} 个对话使用；删除后它们会回到「全部」。`
            : `套装 ${kit.name} 没有对话在用，可以直接删除。`,
        }
      }
      return {
        name: kit.name,
        affectedSessions: affected,
        deleted: true,
        message: affected > 0
          ? `已删除套装 ${kit.name}；${affected} 个对话回到「全部」。`
          : `已删除套装 ${kit.name}`,
      }
    },
  })

  ctx.tools.register({
    name: 'kit_assign',
    description: 'Pin one conversation (by Session id) to a kit, 仅内置, or 全部. '
      + 'Normally you switch the conversation you are in with kit_apply; this is for correcting '
      + 'another conversation whose tools were set up wrong.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Target Session id.' },
        kit: { type: 'string', description: 'Kit name or title; "@dsh" for 仅内置; "" or "全部" for 全部.' },
      },
      required: ['sessionId', 'kit'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({
        sessionId: { type: 'string' },
        binding: { type: 'string' },
        applied: { type: 'boolean' },
        message: { type: 'string' },
      }, ['sessionId', 'binding', 'applied', 'message']),
      render: (_args, value) => text(value.message),
    },
    async execute(args) {
      const sessionId = String(args?.sessionId ?? '')
      if (sessionId === '') throw new Error('kit_assign: 缺少 sessionId')
      const wanted = String(args?.kit ?? '').trim()
      let value
      if (wanted === '' || wanted === '全部' || wanted.toLowerCase() === 'all') value = null
      else if (wanted === DEFAULT_DSH || wanted === '仅内置') value = DEFAULT_DSH
      else {
        const kit = resolveKit(lastAgent, wanted)
        if (kit === undefined) throw new Error(`kit_assign: 未知套装 "${wanted}"`)
        value = kit.name
      }
      book.assignments[sessionId] = value
      save()
      // Apply it live when that conversation is still open; otherwise the pin is
      // picked up the next time the conversation is read.
      let applied = false
      if (sessionController !== undefined) {
        try {
          const found = await sessionController.resolveAgent(sessionId)
          if (found?.agent !== undefined) {
            const result = useSelection(found.agent, selectionForBinding(value))
            applied = result.ok
          }
        } catch {
          // The pin is stored; a closed conversation will read it on resume.
        }
      }
      const label = value === null ? '全部' : value === DEFAULT_DSH ? '仅内置' : value
      return {
        sessionId,
        binding: value ?? '',
        applied,
        message: `${sessionId} 现在固定使用「${label}」（${applied ? '已即时应用' : '下次打开该对话时生效'}）。`,
      }
    },
  })

  ctx.tools.register({
    name: 'kit_rename',
    description: 'Change the display title of one of my kits. The kit id stays the same, '
      + 'so its default and every conversation pinned to it keep working.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Kit id (not the title).' },
        title: { type: 'string', description: 'New display title.' },
      },
      required: ['name', 'title'],
      additionalProperties: false,
    },
    output: {
      schema: outputSchema({ name: { type: 'string' }, title: { type: 'string' }, message: { type: 'string' } }, ['name', 'title', 'message']),
      render: (_args, value) => text(value.message),
    },
    async execute(args) {
      const title = typeof args?.title === 'string' ? args.title.trim() : ''
      if (title === '') throw new Error('kit_rename: 缺少新的标题')
      const kit = operations.update({ name: args?.name, title })
      return { name: kit.name, title: kit.title, message: `套装 ${kit.name} 改名为「${kit.title}」（id 不变）。` }
    },
  })

  // ---- /kit command --------------------------------------------------------
  const registerCommand = (commands) => {
    if (commands?.register === undefined) return
    commands.register({
      definitionId: 'dsh-loadout',
      name: 'kit',
      description: '查看或切换当前会话的套装（/kit 列表，/kit 名字 切换，/kit all|dsh 切到全部或仅内置）',
      async handler(invocation) {
        const raw = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : ''
        const agent = invocation?.agent ?? lastAgent
        rememberAgent(agent)
        if (raw === '' || raw === 'list') {
          const selection = currentSelection(agent)
          const active = labelOf(agent, selection)
          const extras = selection.extras.length > 0 ? `　加挂：${selection.extras.join(', ')}` : ''
          return {
            kind: 'success',
            text: [
              `当前：${active}（base=${selection.base}）${extras}　默认：${book.defaultKit === '' ? '(未设置)' : book.defaultKit === DEFAULT_DSH ? '仅内置' : book.defaultKit}`,
              '我的套装：',
              ...(book.kits.length === 0 ? ['  (还没有)'] : book.kits.map((kit) => `${kit.name === book.defaultKit ? '*' : ' '} ${kit.name} — ${kit.title}：${describeKit(kit)}`)),
              '预设套装（只读）：',
              ...presets.map((kit) => `${kit.name === book.defaultKit ? '*' : ' '} ${kit.name} — ${kit.title}：${describeKit(kit)}`),
            ].join('\n'),
          }
        }
        if (agent === undefined) return { kind: 'error', text: '当前没有可用的会话' }
        const lower = raw.toLowerCase()
        if (lower === 'all' || raw === '全部') {
          const result = applyBase(agent, BASE_ALL)
          return result.ok ? { kind: 'success', text: '已切到「全部」：不再裁剪工具。' } : { kind: 'error', text: `切换失败：${result.reason}` }
        }
        if (lower === 'dsh' || raw === '仅内置' || raw === '内置') {
          const result = applyBase(agent, BASE_DSH)
          return result.ok ? { kind: 'success', text: '已切到「仅内置」：下载插件的工具全部隐藏。' } : { kind: 'error', text: `切换失败：${result.reason}` }
        }
        const kit = resolveKit(agent, raw)
        if (kit === undefined) {
          const names = [...book.kits, ...presets].map((row) => row.name)
          return { kind: 'error', text: `未知套装 "${raw}"。可用：${names.join(', ')}` }
        }
        const result = useSelection(agent, { base: BASE_KIT, kit: kit.name, extras: [] })
        if (!result.ok) return { kind: 'error', text: `切换失败：${result.reason}` }
        return { kind: 'success', text: `已切换到 ${kit.name} (${kit.title})：${result.tools.length > 0 ? result.tools.join(', ') : '全部工具'}` }
      },
    })
  }

  // ---- HTTP routes for the header chip and the settings panel ---------------
  const registerRoutes = (webServer) => {
    if (webServer?.register === undefined) return
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/state`,
      handler: async (req, res) => {
        if (!isLocalRequest(req)) return sendJson(res, 403, { ok: false, error: '仅允许本机访问' })
        try {
          if (req.method === 'GET') {
            // The chip belongs to one conversation, so a GET names its Session and
            // is resolved exactly like a POST action. A bare GET (the settings page)
            // and an unknown id still answer from the last agent seen.
            const sessionId = new URL(req.url ?? '', 'http://localhost').searchParams.get('sessionId') ?? ''
            const found = await agentForSession(sessionId)
            return sendJson(res, 200, { ok: true, ...(found.ok ? snapshot(found.agent) : snapshot()) })
          }
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 GET/POST' })
          const body = await readJson(req)
          const action = String(body.action ?? '')
          const needAgent = async () => {
            const found = await agentForSession(body.sessionId)
            if (!found.ok) return { ok: false, response: sendJson(res, 400, { ok: false, error: found.reason }) }
            rememberAgent(found.agent)
            return { ok: true, agent: found.agent }
          }
          switch (action) {
            case 'applyBase': {
              const base = String(body.base ?? '')
              if (![BASE_ALL, BASE_DSH, BASE_KIT].includes(base)) {
                return sendJson(res, 400, { ok: false, error: `未知基础 "${base}"` })
              }
              const found = await needAgent()
              if (!found.ok) return found.response
              const result = applyBase(found.agent, base, body.kit)
              if (!result.ok) return sendJson(res, result.status ?? 400, { ok: false, error: result.reason })
              // Every filter this plugin installs is a deny, so nothing is
              // "kept visible because it could not be masked" — `hidden` is what
              // the agent stopped seeing, and the UI can quote it back.
              const hidden = result.hidden ?? []
              return sendJson(res, 200, {
                ok: true,
                // `kept` is the selection's own answer to "what is still there";
                // `tools` further down is the host-wide catalog and must not be
                // mistaken for it.
                ...(Array.isArray(result.tools) ? { kept: result.tools } : {}),
                ...(hidden.length > 0 ? { hidden } : {}),
                ...snapshot(found.agent),
              })
            }
            case 'refresh': {
              // New tools can appear after a plugin is installed or switched on;
              // the catalog is read live, so re-applying the same selection picks
              // them up without the user having to switch away and back.
              const found = await needAgent()
              if (!found.ok) return found.response
              const result = refreshSelection(found.agent)
              if (!result.ok) return sendJson(res, result.status ?? 400, { ok: false, error: result.reason })
              return sendJson(res, 200, { ok: true, ...snapshot(found.agent) })
            }
            case 'toggleExtra': {
              const found = await needAgent()
              if (!found.ok) return found.response
              const result = toggleExtra(found.agent, String(body.id ?? ''), body.on !== false)
              if (!result.ok) return sendJson(res, result.status ?? 400, { ok: false, error: result.reason })
              return sendJson(res, 200, { ok: true, ...snapshot(found.agent) })
            }
            case 'saveAs': {
              const found = await needAgent()
              if (!found.ok) return found.response
              const saved = saveSelectionAs(found.agent, body)
              return sendJson(res, 200, { ok: true, mode: saved.mode, kit: saved.kit.name, ...snapshot(found.agent) })
            }
            case 'apply': {
              const found = await needAgent()
              if (!found.ok) return found.response
              const kit = resolveKit(found.agent, String(body.kit ?? ''))
              if (kit === undefined) return sendJson(res, 400, { ok: false, error: `未知套装 "${String(body.kit ?? '')}"` })
              const result = useSelection(found.agent, { base: BASE_KIT, kit: kit.name, extras: [] })
              if (!result.ok) return sendJson(res, 400, { ok: false, error: result.reason })
              return sendJson(res, 200, { ok: true, kit: kit.name, ...snapshot(found.agent) })
            }
            case 'create': operations.create(body); break
            case 'update': operations.update(body); break
            case 'delete':
            case 'remove': {
              // The settings page asks with dryRun first so it can quote how many
              // conversations a delete would release, then confirms.
              const { kit, affected } = operations.remove(body)
              return sendJson(res, 200, {
                ok: true,
                name: kit.name,
                affectedSessions: affected,
                deleted: body?.dryRun !== true,
                ...snapshot(),
              })
            }
            case 'default': operations.setDefault(body); break
            case 'applySet': {
              // Backward compatibility for panels written against 0.5: an explicit
              // (builtins, plugins) pair becomes a transient kit for that agent.
              const found = await needAgent()
              if (!found.ok) return found.response
              const builtins = Array.isArray(body.builtins) ? dedupe(asNames(body.builtins)) : undefined
              const plugins = Array.isArray(body.plugins) ? dedupe(asNames(body.plugins)) : undefined
              if (builtins === undefined && plugins === undefined) {
                return sendJson(res, 400, { ok: false, error: '至少给出 builtins 或 plugins' })
              }
              const nextBuiltins = builtins ?? []
              const nextPlugins = plugins ?? []
              // An explicit empty choice means "everything visible", not "hide all".
              if (nextBuiltins.length === 0 && nextPlugins.length === 0) {
                const result = applyBase(found.agent, BASE_ALL)
                if (!result.ok) return sendJson(res, 400, { ok: false, error: result.reason })
                return sendJson(res, 200, { ok: true, ...snapshot(found.agent) })
              }
              const custom = {
                name: '__custom__',
                title: typeof body.label === 'string' && body.label.trim() !== '' ? body.label.trim() : '自定义',
                builtins: nextBuiltins,
                plugins: nextPlugins,
                allow: [],
                deny: [],
              }
              customKits.set(found.agent, custom)
              const result = useSelection(found.agent, { base: BASE_KIT, kit: custom.name, extras: [] })
              if (!result.ok) return sendJson(res, 400, { ok: false, error: result.reason })
              return sendJson(res, 200, { ok: true, ...snapshot(found.agent) })
            }
            case 'current': {
              const found = await needAgent()
              if (!found.ok) return found.response
              const selection = currentSelection(found.agent)
              return sendJson(res, 200, {
                ok: true,
                active: labelOf(found.agent, selection),
                label: labelOf(found.agent, selection),
                selection,
              })
            }
            default: return sendJson(res, 400, { ok: false, error: `未知操作 ${action}` })
          }
          return sendJson(res, 200, { ok: true, ...snapshot() })
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    })
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/debug`,
      handler: async (req, res) => {
        if (!isLocalRequest(req)) return sendJson(res, 403, { ok: false, error: '仅允许本机访问' })
        const view = {}
        try {
          const tools = ctx.tools
          view.serviceKeys = Object.keys(tools).slice(0, 40)
          const layers = tools?.layers
          view.layerKeys = layers === undefined ? null : Object.keys(layers).slice(0, 20)
          if (layers?.scoped instanceof Map) {
            view.scopedLayers = []
            for (const [key, layer] of layers.scoped) {
              view.scopedLayers.push({
                keyType: typeof key,
                keyName: key?.name ?? key?.id ?? key?.fiber?.name ?? String(key).slice(0, 60),
                tools: layer?.tools === undefined ? null : [...layer.tools.keys()].slice(0, 30),
              })
            }
          }
          view.globalTools = layers?.global?.tools === undefined ? null : [...layers.global.tools.keys()]
          const first = seenAgents[0]
          if (first !== undefined) {
            try {
              const index = definitionIndex(first.ctx?.tools ?? ctx.tools, first)
              view.ledgerIndex = { size: index.size, names: [...index.keys()].slice(0, 8) }
              view.ledger = ledgerFor(first)
            } catch (error) {
              view.ledgerError = String(error instanceof Error ? error.message : error)
            }
          }
          view.chain = []
          if (layers?.chainLayers !== undefined && first !== undefined) {
            for (const layer of layers.chainLayers(first)) {
              view.chain.push(layer?.tools === undefined ? null : [...layer.tools.keys()].slice(0, 10))
            }
          }
        } catch (error) {
          view.error = String(error instanceof Error ? error.message : error)
        }
        return sendJson(res, 200, { ok: true, view })
      },
    })
  }

  const optional = (dependencies, install) => {
    try {
      if (typeof ctx.inject === 'function') ctx.inject(dependencies, (child) => install(child))
    } catch {
      // The service is optional: tools keep working without it.
    }
  }

  optional(['commands'], (child) => registerCommand(child.commands))
  optional(['webServer'], (child) => registerRoutes(child.webServer))
  optional(['sessionController'], (child) => {
    sessionController = child.sessionController
  })
  optional(['sessions'], (child) => {
    sessions = child.sessions
  })

  ctx.logger?.info(`dsh-loadout: ${book.kits.length} 个我的套装 + ${presets.length} 个预设，默认 ${book.defaultKit || '(未设置)'}，来源 ${book.source}`)
}
