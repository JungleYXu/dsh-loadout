/**
 * Self-test for dsh-loadout without a running harness.
 *
 * Uses a fake cordis context (fake tools registry + layer table, fake agent
 * scopes, fake command registry and fake web server) plus a scratch
 * USERPROFILE, so the whole surface runs under plain Node:
 *
 *   $env:ELECTRON_RUN_AS_NODE="1"
 *   & "…\DeepSeek Harness.exe" dsh-loadout\scripts\selftest.mjs
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = join(tmpdir(), `loadout-selftest-${process.pid}`)
rmSync(scratch, { recursive: true, force: true })
mkdirSync(join(scratch, '.dsh'), { recursive: true })
// A profile package that owns a plugin tool, so the catalog has something to
// split off as a plugin instead of a built-in.
mkdirSync(join(scratch, '.dsh', 'profiles', 'demo'), { recursive: true })
writeFileSync(join(scratch, '.dsh', 'profiles', 'demo', 'package.json'),
  JSON.stringify({ name: 'demo-profile', dependencies: { 'dsh-demo': '1.0.0' } }), 'utf8')
process.env.USERPROFILE = scratch
process.env.HOME = scratch

const { apply, inject, name } = await import('../index.js')

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(detail === undefined ? label : `${label} — ${detail}`)
}

const SESSION_ID = 'session-1'
const OWN_TOOLS = ['kit_list', 'kit_apply', 'kit_create', 'kit_set_tools', 'kit_set_default', 'kit_delete', 'kit_assign', 'kit_rename']
const SCOPED = ['read', 'write', 'edit', 'glob', 'grep', 'pwsh', 'web_search', 'web_fetch', 'todo_write']
/** Registered by each agent into its own layer: visible, but never restrictable. */
const SCOPE_OWNED = ['subagent']
const GLOBAL = ['demo_search', ...OWN_TOOLS]

/** The runtime's layer table shape: entries()/keys()/get(), but not a `Map`. */
function namedEntries(pairs) {
  const store = new Map(pairs)
  return {
    entries: () => store.entries(),
    keys: () => store.keys(),
    values: () => store.values(),
    get: (name) => store.get(name),
    has: (name) => store.has(name),
    get size() { return store.size },
  }
}

/**
 * A definition with the fields the ledger prices (name/description/parameters).
 * An empty object would make every tool cost the same 41 chars.
 */
const definitionOf = (toolName) => ({
  name: toolName,
  description: `demo tool ${toolName}`,
  parameters: { type: 'object', properties: {}, additionalProperties: false },
})

/**
 * Session headers and agents are shared by every fake host in this file: the
 * plugin keeps one registry per process, and a second `apply()` (the legacy and
 * v2 blocks) must see the conversations the first one registered.
 */
const fakeSessions = new Map()
const fakeAgents = new Map()

/** One fake host. `layers` is what the real tool runtime exposes. */
function makeCtx() {
  const tools = new Map()
  const handlers = new Map()
  const commands = new Map()
  const routes = new Map()
  const scoped = new Map([...SCOPED, ...SCOPE_OWNED].map((toolName) => [toolName, definitionOf(toolName)]))
  const global = new Map(GLOBAL.map((toolName) => [toolName, definitionOf(toolName)]))
  const built = {
    tools: {
      layers: { scoped: new Map([['core', { tools: scoped }]]), global: { tools: global } },
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(handler)
      return () => {}
    },
    effect(callback) {
      const dispose = typeof callback === 'function' ? callback() : undefined
      return typeof dispose === 'function' ? dispose : () => {}
    },
    logger: { info() {}, warn() {} },
    get(key) { return built[key] },
    optional(dependencies, install) { install(childFor(dependencies, built, commands, routes, sessionAgentOf)) },
    inject(dependencies, install) { install(childFor(dependencies, built, commands, routes, sessionAgentOf)) },
  }
  // `sessions` is the host's Session registry: `get(id)` hands back a Session
  // whose `header` carries `createdAt` / `parentSession` / `origin`. The agents
  // themselves live in their own map — the plugin only reads headers from this
  // one, and `sessionController` is what resolves a Session id to an agent.
  const sessions = fakeSessions
  const agents = fakeAgents
  built.sessionController = {
    async resolveAgent(sessionId) {
      if (agents.has(sessionId)) return { agent: agents.get(sessionId) }
      if (sessionId === SESSION_ID) return { agent: sessionAgentOf.agent }
      return { error: { message: `找不到会话 "${sessionId}"` } }
    },
  }
  built.registered = tools
  built.handlers = handlers
  built.commands = commands
  built.routes = routes
  built.sessions = { get: (sessionId) => sessions.get(sessionId) }
  built.sessionTable = sessions
  built.agentTable = agents
  return built
}

/** The agent a Session id resolves to; route tests switch its kit. */
const sessionAgentOf = { agent: undefined }

function childFor(dependencies, built, commands, routes) {
  const child = {}
  if (dependencies.includes('commands')) {
    child.commands = {
      register(definition) {
        commands.set(definition.name, definition)
        return () => commands.delete(definition.name)
      },
    }
  }
  if (dependencies.includes('webServer')) {
    child.webServer = {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    }
  }
  if (dependencies.includes('sessionController')) child.sessionController = built.sessionController
  // The plugin injects `sessions` optionally; a fake host without it must still
  // work (that is the 0.x path), so this mirrors the real `optional` contract.
  if (dependencies.includes('sessions')) child.sessions = built.sessions
  return child
}

const COLLAB = ['send_message', 'list_agents', 'interrupt_agent', 'subagent', 'subagent_fork']

// The coding preset restricted to what the fake runtime actually exposes: the
// collaboration five are listed by the real preset, but this fake agent only owns
// subagent from that group, and a tool it cannot see can never survive a mask.
const CODING_KEPT = ['pwsh', 'read', 'write', 'edit', 'glob', 'grep', 'todo_write', 'subagent', ...OWN_TOOLS]

// Mirrors the presets in `cordis.patch.yml` (the host hands this same shape to
// `apply`). The last check in this block keeps the two lists from drifting.
const config = {
  defaultKit: 'writing',
  kits: [
    {
      name: 'chat',
      title: '仅聊天',
      builtins: ['ask_user_question', 'weather', 'web_search', 'web_fetch', 'read'],
    },
    { name: 'coding', title: '编程用', builtins: ['pwsh', 'read', 'write', 'edit', 'glob', 'grep', 'todo_write'] },
    {
      name: 'research',
      title: '查找资料',
      builtins: ['web_search', 'web_fetch', 'advanced_search', 'research', 'platform_search', 'read', 'write', 'glob', 'grep'],
    },
    {
      name: 'plan',
      title: '项目梳理',
      builtins: ['ask_user_question', 'web_search', 'web_fetch', 'read', 'write', 'edit', 'glob', 'grep', 'todo_write'],
    },
    { name: 'writing', title: '写作', builtins: ['read', 'write', 'edit', 'glob', 'grep'] },
  ].map((preset) => ({
    ...preset,
    // Every preset carries the collaboration five, or a subagent running it
    // cannot answer its parent at all.
    builtins: [...preset.builtins, 'send_message', 'list_agents', 'interrupt_agent', 'subagent', 'subagent_fork'],
  })),
}

// The five preset ids must exist in the shipped patch too — the test's copy above
// is hand-written, and a rename in one place without the other is silent drift.
{
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const missing = config.kits.filter((preset) => !new RegExp(`name:\\s*${preset.name}\\b`).test(patch))
  check('the shipped patch carries every preset the tests use',
    missing.length === 0, missing.map((preset) => preset.name).join(','))
}

const ctx = makeCtx()
apply(ctx, config)
const registered = ctx.registered

check('name', name === 'dsh-loadout', name)
check('inject lists tools', Array.isArray(inject) && inject.includes('tools'), JSON.stringify(inject))
for (const tool of OWN_TOOLS) check(`registered ${tool}`, registered.has(tool))
check('no unexpected tools', registered.size === OWN_TOOLS.length, [...registered.keys()].join(','))
check('registered /kit command', ctx.commands.has('kit'))
check('registered state route', ctx.routes.has('/dsh-loadout/state'))

// A fresh store has no `defaultKit`, so the first conversation starts on 全部 —
// no mask at all. (A reinstall keeps `~/.dsh/loadout.json`, so a default the
// user already chose survives it; only a fresh store is 全部.)
{
  const freshResponse = fakeResponse()
  await ctx.routes.get('/dsh-loadout/state').handler(fakeRequest('GET', undefined, '127.0.0.1:63937', ''), freshResponse)
  const fresh = { status: freshResponse.status, body: JSON.parse(freshResponse.body) }
  check('a fresh install starts on 全部', fresh.body.label === '全部' && fresh.body.selection?.base === 'all',
    JSON.stringify({ label: fresh.body.label, base: fresh.body.selection?.base }))
  // The settings page asks without a session right after a restart, when no
  // conversation exists in this process yet. It must still show numbers instead
  // of "读不到工具定义" — the catalogue price is the 全部 figure.
  check('settings ledgers the catalogue before any conversation exists',
    fresh.body.ledger !== undefined && fresh.body.ledger.visibleTools > 0 && fresh.body.ledger.savedTokens === 0,
    JSON.stringify(fresh.body.ledger))
}

/**
 * A fake agent that behaves like the shipped runtime in the two ways that
 * matter here: only the global layer is restrictable — every built-in and
 * `subagent` live in the agent's own layer and make `restrict()` throw — and an
 * `allow` list hides every name it omits, for the agent and everything under it.
 * `layers.effect` is the append `restrict()` performs internally, which is how
 * the plugin masks those same tools without ever writing an allow list.
 */
let agentSeq = 0

function makeAgent(tools = [...SCOPED, ...SCOPE_OWNED, 'demo_search', ...OWN_TOOLS], options = {}) {
  // Every agent carries a Session id, because that id is the key a conversation's
  // binding is stored under (`assignments[sessionId]`). An id-less fake made the
  // whole binding layer look like a no-op.
  const agent = { id: options.id ?? `session-agent-${++agentSeq}`, tools, filters: [], restrictable: new Set(GLOBAL) }
  const append = (filter) => {
    const entry = { filter, active: true }
    agent.filters.push(entry)
    return () => { entry.active = false }
  }
  const deniedNames = () => {
    const denied = new Set()
    for (const entry of agent.filters) {
      if (!entry.active) continue
      for (const toolName of entry.filter.deny ?? []) denied.add(toolName)
    }
    return denied
  }
  agent.ctx = {
    tools: {
      schemas: () => {
        const denied = deniedNames()
        return tools.filter((toolName) => !denied.has(toolName)).map((toolName) => definitionOf(toolName))
      },
      view: () => {
        const denied = deniedNames()
        const visible = tools.filter((toolName) => !denied.has(toolName))
        return {
          visible: new Map(visible.map((toolName) => [toolName, { name: toolName }])),
          knownNames: new Set(tools),
          restrictableNames: new Set([...agent.restrictable].filter((toolName) => tools.includes(toolName))),
        }
      },
      layers: {
        // Real layers hold `NamedEntries` (entries()/keys(), NOT a Map) — that is
        // exactly the shape that made 0.9.0 report a one-tool catalogue live, so
        // the fake keeps it instead of a convenient Map.
        scoped: new Map([['core', { tools: namedEntries([...SCOPED, ...SCOPE_OWNED].map((toolName) => [toolName, definitionOf(toolName)])) }]]),
        global: { tools: namedEntries(['demo_search', ...OWN_TOOLS].map((toolName) => [toolName, definitionOf(toolName)])) },
        effect(_target, install) {
          return install({ restrictions: { append } })
        },
        chainLayers: () => [{ tools: namedEntries([...SCOPED, ...SCOPE_OWNED].map((toolName) => [toolName, definitionOf(toolName)])) }],
      },
      restrict(filter) {
        const names = [...(filter.allow ?? []), ...(filter.deny ?? [])]
        if (names.includes('run_code')) throw new Error('tools.restrict() cannot name reserved PTC mode presentation transport "run_code"; restrict end-capability tools instead')
        const unknown = names.filter((toolName) => !agent.restrictable.has(toolName))
        if (unknown.length > 0) {
          throw new Error(`tools.restrict() names unknown global tool "${unknown[0]}"; known global tools: ${[...agent.restrictable].join(', ')}`)
        }
        return append(filter)
      },
    },
  }
  // Publish the Session header and the agent itself, so `ensureBinding()` can
  // read `createdAt` / `parentSession` / `origin` exactly like the host does.
  const header = {
    createdAt: options.createdAt ?? Date.now(),
    ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession }),
    ...(options.origin === undefined ? {} : { origin: options.origin }),
  }
  fakeSessions.set(agent.id, { id: agent.id, header })
  fakeAgents.set(agent.id, agent)
  return agent
}

/** Tools still visible under every live filter: only a denial can hide one. */
function keptOf(agent) {
  const denied = new Set()
  for (const entry of agent.filters) {
    if (!entry.active) continue
    for (const toolName of entry.filter.deny ?? []) denied.add(toolName)
  }
  return agent.tools.filter((toolName) => !denied.has(toolName))
}

const activeFilters = (agent) => agent.filters.filter((entry) => entry.active)
const sameSet = (left, right) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())

const exec = (agent) => ({ agent })
const run = (tool, args, agent) => registered.get(tool).execute(args, exec(agent))

const stateRoute = ctx.routes.get('/dsh-loadout/state')

function fakeRequest(method, body, host = '127.0.0.1:63937', query = '') {
  const listeners = {}
  const request = {
    method,
    url: `/dsh-loadout/state${query}`,
    headers: { host },
    on(event, handler) { listeners[event] = handler },
    destroy() {},
  }
  setImmediate(() => {
    if (body !== undefined && listeners.data) listeners.data(Buffer.from(JSON.stringify(body)))
    if (listeners.end) listeners.end()
  })
  return request
}

function fakeResponse() {
  const response = { status: 0, headers: undefined, body: '' }
  response.writeHead = (status, headers) => { response.status = status; response.headers = headers }
  response.end = (chunk) => { if (chunk !== undefined) response.body += String(chunk) }
  return response
}

async function getState(sessionId) {
  const response = fakeResponse()
  const query = typeof sessionId === 'string' ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
  await stateRoute.handler(fakeRequest('GET', undefined, '127.0.0.1:63937', query), response)
  return { status: response.status, body: JSON.parse(response.body) }
}

async function post(body) {
  const response = fakeResponse()
  await stateRoute.handler(fakeRequest('POST', body), response)
  const payload = JSON.parse(response.body)
  return { status: response.status, body: payload }
}

// ---- default kit applies to a new conversation ------------------------------
const agent = makeAgent()
sessionAgentOf.agent = agent
for (const handler of ctx.handlers.get('agent/created') ?? []) handler(agent)
const defaultKept = keptOf(agent)
check('new conversation masked', activeFilters(agent).length >= 1, String(activeFilters(agent).length))
check('default preset applied as a kit', defaultKept.includes('write') && defaultKept.includes('read'), defaultKept.join(','))
check('default preset also keeps own tools', defaultKept.includes('kit_create'), defaultKept.join(','))

// The creation listener runs while the agent is still being assembled: its tool
// layer may not be readable yet, the mask is skipped, and the failure is only a
// log line. 0.9.x shipped exactly that — a saved default never reached a new
// conversation. The first state read has to install it, with no listener help.
const lateAgent = makeAgent()
sessionAgentOf.agent = lateAgent
const lateState = await getState(SESSION_ID)
check('a new conversation picks up the default on its first state read',
  activeFilters(lateAgent).length >= 1 && keptOf(lateAgent).includes('write'), JSON.stringify({ filters: activeFilters(lateAgent).length, label: lateState.body.label }))
sessionAgentOf.agent = agent

// ---- kit_list ---------------------------------------------------------------
let listed = await run('kit_list', {}, agent)
check('kit_list active title', listed.active === '写作', listed.active)
check('kit_list base is kit', listed.base === 'kit', listed.base)
check('kit_list prefers the shipped config', listed.source === 'bundle 配置', listed.source)
check('kit_list lists the five shipped presets', listed.presets.length === 5, String(listed.presets.length))
check('kit_list has no user kit yet', listed.kits.length === 0, String(listed.kits.length))
// The host validates execute() output against the declared schema, so a field
// that is returned but not declared fails the whole call at runtime
// (`kit_list returned invalid output: "note" is not a declared property`).
// Keep the two sides in sync.
{
  const schema = registered.get('kit_list').output.schema
  const kitItem = schema.properties.kits.items.properties
  const presetItem = schema.properties.presets.items.properties
  check('kit_list declares every field it returns', 'note' in kitItem && 'note' in presetItem,
    `kits=${Object.keys(kitItem).join(',')} presets=${Object.keys(presetItem).join(',')}`)
}

// ---- kit_apply by title ------------------------------------------------------
const appliedKit = await run('kit_apply', { kit: '编程用' }, agent)
check('kit_apply by title', appliedKit.kit === 'coding', appliedKit.kit)
check('previous restriction released', agent.filters[0].active === false)
check(
  'preset keeps exactly its built-ins plus own tools',
  sameSet(keptOf(agent), CODING_KEPT),
  keptOf(agent).join(','),
)

let unknownError = ''
try {
  await run('kit_apply', { kit: 'nope' }, agent)
} catch (error) {
  unknownError = String(error.message)
}
check('unknown kit throws', unknownError.includes('未知套装'), unknownError)

// ---- GET /state exposes the whole model -------------------------------------
let state = await getState()
check('state route 200', state.status === 200, String(state.status))
check('state lists presets with names', JSON.stringify(state.body.presetNames) === JSON.stringify(['chat', 'coding', 'research', 'plan', 'writing']), JSON.stringify(state.body.presetNames))
check('state lists preset allow', Array.isArray(state.body.presets) && state.body.presets[0].allow.includes('read'), JSON.stringify(state.body.presets?.[0]))
check('state splits the catalog', Array.isArray(state.body.catalog.builtins) && Array.isArray(state.body.catalog.plugins), JSON.stringify(state.body.catalog))
check(
  'catalog plugin has id, title, tools',
  state.body.catalog.plugins.some((plugin) => plugin.id === 'demo' && Array.isArray(plugin.tools) && plugin.tools.includes('demo_search')),
  JSON.stringify(state.body.catalog.plugins),
)
check('catalog keeps unprefixed tools built-in', state.body.catalog.builtins.includes('pwsh'), JSON.stringify(state.body.catalog.builtins))
check('state reports the selection', state.body.selection.base === 'kit' && state.body.selection.kit === 'coding', JSON.stringify(state.body.selection))
check('state reports applied and available plugins', Array.isArray(state.body.appliedPlugins) && JSON.stringify(state.body.availableExtras) === JSON.stringify(['demo']), JSON.stringify({ applied: state.body.appliedPlugins, available: state.body.availableExtras }))

// ---- applyBase: all ---------------------------------------------------------
const beforeAll = agent.filters.length
let answer = await post({ action: 'applyBase', sessionId: SESSION_ID, base: 'all' })
check('applyBase all 200', answer.status === 200, JSON.stringify(answer.body))
check('applyBase all clears the selection', answer.body.selection.base === 'all' && answer.body.selection.kit === null && answer.body.selection.extras.length === 0, JSON.stringify(answer.body.selection))
check('applyBase all calls no restrict', agent.filters.length === beforeAll, String(agent.filters.length))
check('applyBase all disposes the old restriction', agent.filters.at(-1).active === false)
check('applyBase all shows every tool again', sameSet(keptOf(agent), agent.tools), keptOf(agent).join(','))
check('applyBase all applies every plugin', JSON.stringify(answer.body.availableExtras) === '[]', JSON.stringify(answer.body.availableExtras))
// With nothing masked, the ledger must report no saving rather than a negative one.
check('all saves no prompt bytes', answer.body.ledger !== undefined && answer.body.ledger.savedTokens === 0, JSON.stringify(answer.body.ledger))
// 全部 is the denominator for every later selection, read here while it is live.
const allLedger = answer.body.ledger

// ---- applyBase: dsh ---------------------------------------------------------
answer = await post({ action: 'applyBase', sessionId: SESSION_ID, base: 'dsh' })
const dshKept = keptOf(agent)
check('applyBase dsh 200', answer.status === 200, JSON.stringify(answer.body))
check('dsh keeps every built-in', sameSet(dshKept, [...SCOPED, ...SCOPE_OWNED, ...OWN_TOOLS]), dshKept.join(','))
check('dsh masks every plugin tool', !dshKept.includes('demo_search'), dshKept.join(','))
check('dsh offers all plugins as extras', JSON.stringify(answer.body.availableExtras) === JSON.stringify(['demo']), JSON.stringify(answer.body.availableExtras))
// Regression for 0.7.0/0.8.0: an allow list that omits a built-in hides it for
// the whole session. `subagent` is the name that made the throw obvious; the
// deny path must never name it at all, and must still hide the plugin tool.
check('dsh never names a scope-owned tool', !activeFilters(agent).some((entry) => (entry.filter.deny ?? []).includes('subagent')), JSON.stringify(activeFilters(agent).map((entry) => entry.filter)))
check('dsh hides exactly the plugin tool', JSON.stringify(answer.body.hidden) === JSON.stringify(['demo_search']), JSON.stringify(answer.body.hidden))
// The response must say what it kept: the shared `tools` field is the host-wide
// catalog, and reading it instead of `kept` is how a live check looked like a
// strip that had not happened.
check('dsh reports the kept tools', Array.isArray(answer.body.kept) && answer.body.kept.includes('read') && answer.body.kept.includes('pwsh'), JSON.stringify(answer.body.kept))
check('dsh ledger shows a saving', answer.body.ledger !== undefined && answer.body.ledger.savedTokens > 0, JSON.stringify(answer.body.ledger))
check('dsh ledger prices fewer tools than the catalogue', answer.body.ledger.visibleTools < answer.body.ledger.totalTools, JSON.stringify(answer.body.ledger))
// 全部 is the denominator: once seen, every later selection is measured against it.
check('dsh total uses the 全部 baseline', answer.body.ledger.totalTokens === allLedger.visibleTokens, `${answer.body.ledger.totalTokens} vs ${allLedger.visibleTokens}`)
check('presets never cost more than 全部', answer.body.presets.every((preset) => preset.tokens <= answer.body.ledger.totalTokens), JSON.stringify(answer.body.presets.map((preset) => preset.tokens)))
check('presets carry a token estimate', Number.isFinite(answer.body.presets[0].tokens), JSON.stringify(answer.body.presets[0]))

// ---- applyBase: kit ---------------------------------------------------------
answer = await post({ action: 'applyBase', sessionId: SESSION_ID, base: 'kit', kit: 'coding' })
const kitKept = keptOf(agent)
check('applyBase kit 200', answer.status === 200, JSON.stringify(answer.body))
check('kit keeps only its built-ins', sameSet(kitKept, CODING_KEPT), kitKept.join(','))
check('kit masks plugin tools', !kitKept.includes('demo_search'), kitKept.join(','))

let badBase = await post({ action: 'applyBase', sessionId: SESSION_ID, base: 'kit', kit: 'ghost' })
check('unknown kit 400', badBase.status === 400 && String(badBase.body.error).includes('未知套装'), JSON.stringify(badBase.body))

// ---- toggleExtra on / off ---------------------------------------------------
answer = await post({ action: 'toggleExtra', sessionId: SESSION_ID, id: 'demo', on: true })
let kept = keptOf(agent)
check('toggleExtra on 200', answer.status === 200, JSON.stringify(answer.body))
check('toggleExtra on exposes the plugin', kept.includes('demo_search'), kept.join(','))
check('toggleExtra on records the extra', JSON.stringify(answer.body.selection.extras) === JSON.stringify(['demo']), JSON.stringify(answer.body.selection))
check('toggleExtra on stays listed so it can be detached', answer.body.availableExtras.includes('demo'), JSON.stringify(answer.body.availableExtras))

answer = await post({ action: 'toggleExtra', sessionId: SESSION_ID, id: 'demo', on: false })
kept = keptOf(agent)
check('toggleExtra off 200', answer.status === 200, JSON.stringify(answer.body))
check('toggleExtra off hides the plugin again', !kept.includes('demo_search'), kept.join(','))
check('toggleExtra off clears the extras', answer.body.selection.extras.length === 0, JSON.stringify(answer.body.selection))

badBase = await post({ action: 'toggleExtra', sessionId: SESSION_ID, id: 'nope', on: true })
check('toggleExtra unknown plugin 400', badBase.status === 400 && String(badBase.body.error).includes('未知插件'), JSON.stringify(badBase.body))

// ---- a kit that already applies the plugin refuses to attach it -------------
answer = await post({ action: 'create', name: 'withdemo', title: '带插件', builtins: ['read'], plugins: ['demo'] })
check('create kit with a plugin 200', answer.status === 200, JSON.stringify(answer.body))
answer = await post({ action: 'applyBase', sessionId: SESSION_ID, base: 'kit', kit: 'withdemo' })
check('kit with plugin: plugin is applied', JSON.stringify(answer.body.appliedPlugins) === JSON.stringify(['demo']), JSON.stringify(answer.body.appliedPlugins))
check('kit with plugin: no extras left', JSON.stringify(answer.body.availableExtras) === '[]', JSON.stringify(answer.body.availableExtras))
badBase = await post({ action: 'toggleExtra', sessionId: SESSION_ID, id: 'demo', on: true })
check('toggleExtra already applied 400', badBase.status === 400 && String(badBase.body.error).includes('已由'), JSON.stringify(badBase.body))

// ---- 全部 refuses every extra ------------------------------------------------
await post({ action: 'applyBase', sessionId: SESSION_ID, base: 'all' })
badBase = await post({ action: 'toggleExtra', sessionId: SESSION_ID, id: 'demo', on: true })
check('toggleExtra under 全部 400', badBase.status === 400 && String(badBase.body.error).includes('「全部」'), JSON.stringify(badBase.body))

// ---- saveAs: new from 仅内置 + extras ---------------------------------------
await post({ action: 'applyBase', sessionId: SESSION_ID, base: 'dsh' })
await post({ action: 'toggleExtra', sessionId: SESSION_ID, id: 'demo', on: true })
answer = await post({ action: 'saveAs', sessionId: SESSION_ID, mode: 'new', name: 'mine', title: '我的' })
const mine = answer.body.kits?.find((kit) => kit.name === 'mine')
check('saveAs new 200', answer.status === 200, JSON.stringify(answer.body))
check('saveAs new stores every built-in', mine !== undefined && mine.builtins.includes('read') && mine.builtins.includes('pwsh'), JSON.stringify(mine?.builtins))
check('saveAs new stores the extras', JSON.stringify(mine?.plugins) === JSON.stringify(['demo']), JSON.stringify(mine?.plugins))
check('saveAs new applies the new kit', answer.body.selection.base === 'kit' && answer.body.selection.kit === 'mine' && answer.body.selection.extras.length === 0, JSON.stringify(answer.body.selection))
check('saveAs new exposes the plugin through the kit', keptOf(agent).includes('demo_search'), keptOf(agent).join(','))

badBase = await post({ action: 'saveAs', sessionId: SESSION_ID, mode: 'new', name: 'mine' })
check('saveAs duplicate 400', badBase.status === 400 && String(badBase.body.error).includes('已存在'), JSON.stringify(badBase.body))

// ---- saveAs: overwrite a user kit ------------------------------------------
answer = await post({ action: 'create', name: 'plain', title: 'Plain', builtins: ['read'] })
await post({ action: 'applyBase', sessionId: SESSION_ID, base: 'kit', kit: 'plain' })
await post({ action: 'toggleExtra', sessionId: SESSION_ID, id: 'demo', on: true })
answer = await post({ action: 'saveAs', sessionId: SESSION_ID, mode: 'overwrite' })
const plain = answer.body.kits?.find((kit) => kit.name === 'plain')
check('saveAs overwrite 200', answer.status === 200, JSON.stringify(answer.body))
check('saveAs overwrite mutates the kit', JSON.stringify(plain?.plugins) === JSON.stringify(['demo']), JSON.stringify(plain?.plugins))
check('saveAs overwrite keeps the kit applied', answer.body.selection.kit === 'plain' && answer.body.selection.extras.length === 0, JSON.stringify(answer.body.selection))

// ---- presets are read-only --------------------------------------------------
await post({ action: 'applyBase', sessionId: SESSION_ID, base: 'kit', kit: 'writing' })
badBase = await post({ action: 'saveAs', sessionId: SESSION_ID, mode: 'overwrite' })
check('saveAs overwrite preset 400', badBase.status === 400 && String(badBase.body.error).includes('预置套装只读'), JSON.stringify(badBase.body))

let presetError = ''
try {
  await run('kit_set_tools', { name: 'writing', builtins: ['read'] }, agent)
} catch (error) {
  presetError = String(error.message)
}
check('kit_set_tools preset rejected', presetError.includes('预置套装只读，请另存为我的套装'), presetError)

presetError = ''
try {
  await run('kit_delete', { name: 'coding' }, agent)
} catch (error) {
  presetError = String(error.message)
}
check('kit_delete preset rejected', presetError.includes('预置套装只读，请另存为我的套装'), presetError)

badBase = await post({ action: 'delete', name: 'writing' })
check('POST delete preset 400', badBase.status === 400 && String(badBase.body.error).includes('预置套装只读'), JSON.stringify(badBase.body))

// ---- kit_create / persistence ----------------------------------------------
const storePath = join(scratch, '.dsh', 'loadout.json')
const created = await run('kit_create', { name: 'probe', title: 'Probe', builtins: ['pwsh', 'read'] }, agent)
check('kit_create ok', created.name === 'probe', JSON.stringify(created))
const store = JSON.parse(readFileSync(storePath, 'utf8'))
check('store written', store.kits.some((kit) => kit.name === 'probe'), JSON.stringify(store.kits.map((kit) => kit.name)))
check('store keeps builtins, not allow', Array.isArray(store.kits.find((kit) => kit.name === 'probe')?.builtins), JSON.stringify(store.kits.find((kit) => kit.name === 'probe')))

let duplicateError = ''
try {
  await run('kit_create', { name: 'probe' }, agent)
} catch (error) {
  duplicateError = String(error.message)
}
check('duplicate rejected', duplicateError.includes('已存在'), duplicateError)

let emptyError = ''
try {
  await run('kit_create', { name: 'empty' }, agent)
} catch (error) {
  emptyError = String(error.message)
}
check('empty kit rejected', emptyError.includes('至少要选一个内置工具或一个插件'), emptyError)

// ---- kit_set_tools ----------------------------------------------------------
const rewritten = await run('kit_set_tools', { name: 'probe', allow: ['pwsh'], deny: ['read'] }, agent)
check('allow wins over deny', rewritten.tools.includes('pwsh') && !rewritten.tools.includes('read'), JSON.stringify(rewritten.tools))

// ---- kit_set_default --------------------------------------------------------
await run('kit_set_default', { name: 'coding' }, agent)
listed = await run('kit_list', {}, agent)
check('default changed to a preset', listed.default === 'coding', listed.default)
check('source switched to the store', listed.source === storePath, listed.source)

// ---- a fresh apply reads the store back ------------------------------------
const ctx2 = makeCtx()
apply(ctx2, config)
const fromStore = await ctx2.registered.get('kit_list').execute({}, exec(makeAgent()))
check('store overrides bundle defaults', fromStore.source === storePath, fromStore.source)
check('default survives restart', fromStore.default === 'coding', fromStore.default)
check('user kits survive restart', fromStore.kits.some((kit) => kit.name === 'probe'), JSON.stringify(fromStore.kits.map((kit) => kit.name)))

// ---- kit 备注 ---------------------------------------------------------------
let noted = await post({ action: 'create', name: 'noted', title: '带备注', note: '用于视频制作', builtins: ['read'], plugins: [] })
check('create keeps a note', noted.status === 200 && (noted.body.kits ?? []).some((kit) => kit.name === 'noted' && kit.note === '用于视频制作'), JSON.stringify((noted.body.kits ?? []).find((kit) => kit.name === 'noted')))
noted = await post({ action: 'create', name: 'toolong', title: '太长', note: 'x'.repeat(21), builtins: ['read'], plugins: [] })
check('create rejects an over-long note', noted.status === 400 && String(noted.body.error).includes('备注最多 20'), JSON.stringify(noted.body))
noted = await post({ action: 'update', name: 'noted', note: '专用于资料检索' })
check('update replaces the note', noted.status === 200 && (noted.body.kits ?? []).some((kit) => kit.name === 'noted' && kit.note === '专用于资料检索'), JSON.stringify((noted.body.kits ?? []).find((kit) => kit.name === 'noted')))
noted = await post({ action: 'update', name: 'noted', note: 'y'.repeat(25) })
check('update rejects an over-long note', noted.status === 400 && String(noted.body.error).includes('备注最多 20'), JSON.stringify(noted.body))

// The note has to reach the file, not just the response body. A writer that
// dropped it made the field look UI-only: it survived until the next restart and
// then vanished, which no response-level assertion can catch.
const notedOnDisk = JSON.parse(readFileSync(storePath, 'utf8')).kits?.find((kit) => kit.name === 'noted')
check('a note survives the store file', notedOnDisk?.note === '专用于资料检索', JSON.stringify(notedOnDisk))
const noteCtx = makeCtx()
apply(noteCtx, config)
const afterRestart = await noteCtx.registered.get('kit_list').execute({}, exec(makeAgent()))
check('a note survives a restart', afterRestart.kits.find((kit) => kit.name === 'noted')?.note === '专用于资料检索', JSON.stringify(afterRestart.kits.find((kit) => kit.name === 'noted')))

// ---- store schema ----------------------------------------------------------
// 0.11.0 stamps the file so a later release can migrate instead of guessing.
const stamped = JSON.parse(readFileSync(storePath, 'utf8')).schema
check('the store file records its schema version', stamped === 2, String(stamped))

// A store written by 0.10.x has no `schema` field at all; it still has to load,
// because that is the exact file everyone upgrading from 0.10.x has on disk.
writeFileSync(storePath, JSON.stringify({
  kits: [{ name: 'legacy-file', title: '旧文件', builtins: ['read'], plugins: [] }],
  defaultKit: '',
}))
const legacyStoreCtx = makeCtx()
apply(legacyStoreCtx, config)
const legacyStoreList = await legacyStoreCtx.registered.get('kit_list').execute({}, exec(makeAgent()))
check('a 0.10 store without schema still loads', legacyStoreList.kits.some((kit) => kit.name === 'legacy-file'), legacyStoreList.kits.map((kit) => kit.name).join(','))

// ---- default: 仅内置 --------------------------------------------------------
let defaulted = await post({ action: 'default', name: '@dsh' })
check('default accepts 仅内置', defaulted.status === 200 && defaulted.body.defaultKit === '@dsh', JSON.stringify(defaulted.body))
const dshDefaultAgent = makeAgent()
for (const handler of ctx.handlers.get('agent/created') ?? []) handler(dshDefaultAgent)
const dshDefaultKept = keptOf(dshDefaultAgent)
check('仅内置 default masks plugins in a new conversation', dshDefaultKept.includes('read') && !dshDefaultKept.includes('demo_search'), dshDefaultKept.join(','))

// ---- refresh re-applies the current selection ------------------------------
answer = await post({ action: 'refresh', sessionId: SESSION_ID })
check('refresh 200', answer.status === 200 && answer.body.ok === true, JSON.stringify(answer.body))
await post({ action: 'default', name: 'coding' })

// ---- dispose releases restrictions -----------------------------------------
const disposeAgent = makeAgent()
for (const handler of ctx.handlers.get('agent/created') ?? []) handler(disposeAgent)
const firstLive = activeFilters(disposeAgent).length
for (const handler of ctx.handlers.get('agent/created') ?? []) handler(disposeAgent)
check('reapply leaves the same number of live filters', firstLive > 0 && activeFilters(disposeAgent).length === firstLive, `${firstLive} -> ${activeFilters(disposeAgent).length}`)

// ---- /kit command -----------------------------------------------------------
const command = ctx.commands.get('kit')
const listResult = await command.handler({ agent, rawInput: '' })
check('/kit lists presets', listResult.kind === 'success' && listResult.text.includes('预设套装'), listResult.text)
const switchResult = await command.handler({ agent, rawInput: 'writing' })
check('/kit switches', switchResult.kind === 'success' && switchResult.text.includes('writing'), switchResult.text)
const liveBeforeAll = agent.filters.length
const allResult = await command.handler({ agent, rawInput: 'all' })
check('/kit all stops restricting', allResult.kind === 'success' && agent.filters.length === liveBeforeAll, allResult.text)
const badResult = await command.handler({ agent, rawInput: 'nope' })
check('/kit rejects unknown', badResult.kind === 'error' && badResult.text.includes('未知套装'), badResult.text)

// ---- HTTP: current / applySet / errors --------------------------------------
const currentResponse = fakeResponse()
await stateRoute.handler(fakeRequest('POST', { action: 'current', sessionId: SESSION_ID }), currentResponse)
check('POST current reports the selection', JSON.parse(currentResponse.body).selection.base === 'all', currentResponse.body)

const setResponse = fakeResponse()
await stateRoute.handler(
  fakeRequest('POST', { action: 'applySet', sessionId: SESSION_ID, builtins: ['read', 'pwsh'], plugins: [], label: '自定义' }),
  setResponse,
)
const setPayload = JSON.parse(setResponse.body)
const setKept = keptOf(agent)
check('POST applySet 200', setResponse.status === 200, setResponse.body)
check('POST applySet keeps the label', setPayload.label === '自定义', JSON.stringify(setPayload.label))
check('POST applySet hides what it left out', setKept.includes('read') && !setKept.includes('web_search'), setKept.join(','))
check('POST applySet keeps the escape hatch', setKept.includes('kit_apply'), setKept.join(','))

const everythingResponse = fakeResponse()
await stateRoute.handler(fakeRequest('POST', { action: 'applySet', sessionId: SESSION_ID, builtins: [], plugins: [] }), everythingResponse)
check('POST applySet empty means everything', JSON.parse(everythingResponse.body).selection.base === 'all', everythingResponse.body)

const badActionResponse = fakeResponse()
await stateRoute.handler(fakeRequest('POST', { action: 'nope' }), badActionResponse)
check('POST bad action 400', badActionResponse.status === 400, String(badActionResponse.status))

const ghostResponse = fakeResponse()
await stateRoute.handler(fakeRequest('POST', { action: 'applyBase', sessionId: 'ghost', base: 'dsh' }), ghostResponse)
check('POST unknown Session 400', ghostResponse.status === 400, String(ghostResponse.status))

const missingSessionResponse = fakeResponse()
await stateRoute.handler(fakeRequest('POST', { action: 'applyBase', base: 'dsh' }), missingSessionResponse)
check('POST without Session 400', missingSessionResponse.status === 400, String(missingSessionResponse.status))

const foreignResponse = fakeResponse()
await stateRoute.handler(fakeRequest('GET', undefined, 'evil.example.com'), foreignResponse)
check('non-local Host refused', foreignResponse.status === 403, String(foreignResponse.status))

// ---- GET /state is per-Session: two agents never leak into each other -------
// The header chip asks for one conversation; answering from whichever agent was
// touched last is the bug this covers.
const secondAgent = makeAgent([...SCOPED, ...SCOPE_OWNED, 'demo_search', ...OWN_TOOLS], { id: 'session-2' })
await post({ action: 'applyBase', sessionId: SESSION_ID, base: 'kit', kit: 'coding' })
await post({ action: 'applyBase', sessionId: 'session-2', base: 'kit', kit: 'research' })

const firstView = await getState(SESSION_ID)
const secondView = await getState('session-2')
check('GET answers for the Session it names', firstView.body.selection.kit === 'coding', JSON.stringify(firstView.body.selection))
check('GET answers for a different Session', secondView.body.selection.kit === 'research', JSON.stringify(secondView.body.selection))
check(
  'two Sessions do not leak into each other',
  firstView.body.label === '编程用' && secondView.body.label === '查找资料',
  JSON.stringify([firstView.body.label, secondView.body.label]),
)

const bareView = await getState()
check(
  'GET without a Session still answers from the last agent',
  bareView.status === 200 && bareView.body.selection.kit === 'research',
  JSON.stringify(bareView.body.selection),
)

const ghostView = await getState('ghost')
check(
  'GET with an unknown Session falls back to the last agent',
  ghostView.status === 200 && ghostView.body.selection.kit === 'research',
  JSON.stringify(ghostView.body.selection),
)

// ---- v2: one persisted binding per conversation ----------------------------
// The plan's core promise: a conversation carries its own choice, so changing
// the default later never reaches back into it, and an explicit switch survives
// a restart. Everything here reads the store file, not the in-memory state.
const v2Home = join(tmpdir(), `loadout-v2-${process.pid}`)
rmSync(v2Home, { recursive: true, force: true })
mkdirSync(join(v2Home, '.dsh', 'sessions', 'ws', 'session-old'), { recursive: true })
const savedHomeV2 = process.env.USERPROFILE
const savedHomeV2b = process.env.HOME
process.env.USERPROFILE = v2Home
process.env.HOME = v2Home
writeFileSync(join(v2Home, '.dsh', 'loadout.json'), JSON.stringify({
  schema: 1,
  kits: [{ name: 'mine', title: '我的', builtins: ['read', 'write'], plugins: [] }],
  defaultKit: '',
}), 'utf8')
const v2 = await import('../index.js?v2=1')
const ctxV2 = makeCtx()
v2.apply(ctxV2, { defaultKit: '', kits: config.kits })
const fireCreated = (agent) => {
  for (const handler of ctxV2.handlers.get('agent/created') ?? []) handler(agent)
}
const storeOf = () => JSON.parse(readFileSync(join(v2Home, '.dsh', 'loadout.json'), 'utf8'))
const backups = () => readdirSync(join(v2Home, '.dsh')).filter((entry) => entry.startsWith('loadout.json.v1.bak-'))

check('migration stamps schema 2', storeOf().schema === 2, String(storeOf().schema))
check('migration freezes existing conversations on 全部', storeOf().assignments['session-old'] === null,
  JSON.stringify(storeOf().assignments))
check('migration keeps the schema-1 file aside', backups().length === 1, backups().join(','))

const agentA = makeAgent(undefined, { id: 'session-a' })
fireCreated(agentA)
check('a new conversation records 全部', storeOf().assignments['session-a'] === null, JSON.stringify(storeOf().assignments))
check('a new conversation starts unmasked', activeFilters(agentA).length === 0, String(activeFilters(agentA).length))

await ctxV2.registered.get('kit_set_default').execute({ name: 'coding' }, exec(agentA))
check('changing the default leaves an existing conversation alone',
  activeFilters(agentA).length === 0 && keptOf(agentA).includes('web_search'),
  JSON.stringify({ filters: activeFilters(agentA).length, kept: keptOf(agentA) }))

const agentB = makeAgent(undefined, { id: 'session-b' })
fireCreated(agentB)
check('a later conversation starts on the saved default',
  !keptOf(agentB).includes('web_search') && keptOf(agentB).includes('read'), keptOf(agentB).join(','))
check('a later conversation records the default', storeOf().assignments['session-b'] === 'coding',
  JSON.stringify(storeOf().assignments))

const agentFork = makeAgent(undefined, { id: 'session-fork', parentSession: 'session-b' })
fireCreated(agentFork)
check('a fork inherits its parent binding', storeOf().assignments['session-fork'] === 'coding',
  JSON.stringify(storeOf().assignments))

const agentChild = makeAgent(undefined, { id: 'sub-1', origin: 'subagent' })
fireCreated(agentChild)
check('a subagent gets no binding', storeOf().assignments['sub-1'] === undefined,
  JSON.stringify(storeOf().assignments))

const assigned = await ctxV2.registered.get('kit_assign').execute({ sessionId: 'session-b', kit: 'mine' }, exec(agentB))
check('kit_assign pins the conversation', assigned.ok !== false && storeOf().assignments['session-b'] === 'mine',
  JSON.stringify({ assigned, assignments: storeOf().assignments }))

const dryDelete = await ctxV2.registered.get('kit_delete').execute({ name: 'mine', dryRun: true }, exec(agentB))
check('kit_delete --dryRun counts without deleting',
  dryDelete.affectedSessions === 1 && storeOf().kits.some((kit) => kit.name === 'mine'),
  JSON.stringify(dryDelete))

const deleted = await ctxV2.registered.get('kit_delete').execute({ name: 'mine' }, exec(agentB))
check('kit_delete clears the bindings it owned',
  deleted.deleted === true && storeOf().assignments['session-b'] === null,
  JSON.stringify({ deleted, assignments: storeOf().assignments }))

const createdV2 = await ctxV2.registered.get('kit_create').execute(
  { name: 'k-one', title: '一号', builtins: ['read'], plugins: [] }, exec(agentB))
const renamed = await ctxV2.registered.get('kit_rename').execute({ name: 'k-one', title: '改过的一号' }, exec(agentB))
const listedV2 = await ctxV2.registered.get('kit_list').execute({}, exec(agentB))
check('kit_rename changes the title and keeps the id',
  renamed.ok !== false && listedV2.kits.some((kit) => kit.name === 'k-one' && kit.title === '改过的一号'),
  JSON.stringify({ createdV2, renamed, kits: listedV2.kits.map((kit) => [kit.name, kit.title]) }))
check('kit_list reports the binding', listedV2.binding === null || listedV2.binding === '',
  JSON.stringify(listedV2.binding))

let reservedError
try {
  await ctxV2.registered.get('kit_create').execute({ name: '全部', title: '占位', builtins: ['read'], plugins: [] }, exec(agentB))
} catch (error) {
  reservedError = String(error?.message ?? error)
}
check('a reserved name is refused', /全部/u.test(reservedError ?? ''), reservedError)

// T18: the same name with different case or surrounding space is the same kit.
let caseDupError
await ctxV2.registered.get('kit_create').execute(
  { name: 'qa', title: '问答', builtins: ['read'], plugins: [] }, exec(agentB))
try {
  await ctxV2.registered.get('kit_create').execute(
    { name: ' QA ', title: '重复', builtins: ['read'], plugins: [] }, exec(agentB))
} catch (error) {
  caseDupError = String(error?.message ?? error)
}
check('a name that differs only by case or space is refused',
  /已存在/u.test(caseDupError ?? ''), caseDupError)

// T24: a user kit may not shadow a shipped preset.
let presetClashError
try {
  await ctxV2.registered.get('kit_create').execute(
    { name: 'chat', title: '冒充预置', builtins: ['read'], plugins: [] }, exec(agentB))
} catch (error) {
  presetClashError = String(error?.message ?? error)
}
check('a preset name cannot be taken by a user kit',
  /预置/u.test(presetClashError ?? ''), presetClashError)

// T22: a binding that names a kit removed outside the app falls back to 全部.
// Simulated the way it really happens: the kit is gone from the store file when
// the app starts again, so a fresh module instance has to cope with it.
await ctxV2.registered.get('kit_create').execute(
  { name: 'ghost-kit', title: '已删除的', builtins: ['read'], plugins: [] }, exec(agentB))
await ctxV2.registered.get('kit_assign').execute({ sessionId: 'session-ghost', kit: 'ghost-kit' }, exec(agentB))
const storeWithGhost = storeOf()
storeWithGhost.kits = storeWithGhost.kits.filter((kit) => kit.name !== 'ghost-kit')
writeFileSync(join(v2Home, '.dsh', 'loadout.json'), JSON.stringify(storeWithGhost), 'utf8')
const v2b = await import('../index.js?v2=2')
const ctxV2b = makeCtx()
v2b.apply(ctxV2b, { defaultKit: '', kits: config.kits })
const agentGhost = makeAgent(undefined, { id: 'session-ghost' })
for (const handler of ctxV2b.handlers.get('agent/created') ?? []) handler(agentGhost)
check('a binding to a deleted kit falls back to 全部',
  storeOf().assignments['session-ghost'] === null && keptOf(agentGhost).includes('web_search'),
  JSON.stringify({ assignments: storeOf().assignments, kept: keptOf(agentGhost) }))

// T03/T05: the default changes again; conversations that already answered keep theirs.
const agentC = makeAgent(undefined, { id: 'session-c' })
await ctxV2.registered.get('kit_set_default').execute({ name: 'chat' }, exec(agentB))
fireCreated(agentC)
check('changing the default twice keeps earlier conversations',
  storeOf().assignments['session-a'] === null && storeOf().assignments['session-c'] === 'chat',
  JSON.stringify(storeOf().assignments))

// T08: deleting a kit reports and releases every conversation that held it.
await ctxV2.registered.get('kit_create').execute(
  { name: 'shared', title: '共享', builtins: ['read'], plugins: [] }, exec(agentB))
for (const id of ['session-a', 'session-b', 'session-c']) {
  await ctxV2.registered.get('kit_assign').execute({ sessionId: id, kit: 'shared' }, exec(agentB))
}
const sharedDelete = await ctxV2.registered.get('kit_delete').execute({ name: 'shared' }, exec(agentB))
check('deleting a kit reports every conversation it held',
  sharedDelete.affectedSessions === 3
    && ['session-a', 'session-b', 'session-c'].every((id) => storeOf().assignments[id] === null),
  JSON.stringify({ sharedDelete, assignments: storeOf().assignments }))

// T09: deleting the default kit also clears the default.
await ctxV2.registered.get('kit_create').execute(
  { name: 'shared-two', title: '共享二', builtins: ['read'], plugins: [] }, exec(agentB))
await ctxV2.registered.get('kit_set_default').execute({ name: 'shared-two' }, exec(agentB))
await ctxV2.registered.get('kit_assign').execute({ sessionId: 'session-a', kit: 'shared-two' }, exec(agentB))
const defaultDelete = await ctxV2.registered.get('kit_delete').execute({ name: 'shared-two' }, exec(agentB))
check('deleting the default kit clears the default',
  defaultDelete.affectedSessions === 1
    && (storeOf().defaultKit === null || storeOf().defaultKit === ''),
  JSON.stringify({ defaultDelete, defaultKit: storeOf().defaultKit }))

// T10: renaming changes the display name only; bindings point at the stable id.
await ctxV2.registered.get('kit_create').execute(
  { name: 'stable', title: '稳定', builtins: ['read'], plugins: [] }, exec(agentB))
await ctxV2.registered.get('kit_assign').execute({ sessionId: 'session-b', kit: 'stable' }, exec(agentB))
await ctxV2.registered.get('kit_rename').execute({ name: 'stable', title: '稳定改名' }, exec(agentB))
check('renaming a bound kit keeps the binding',
  storeOf().assignments['session-b'] === 'stable'
    && storeOf().kits.some((kit) => kit.name === 'stable' && kit.title === '稳定改名'),
  JSON.stringify(storeOf().kits.map((kit) => [kit.name, kit.title])))

// T15: every write is a complete file — the temporary one never survives.
check('the store write leaves no temporary file',
  !existsSync(join(v2Home, '.dsh', 'loadout.json.tmp')), 'loadout.json.tmp is still there')

// T25: a shipped preset can be the new-conversation default too.
await ctxV2.registered.get('kit_set_default').execute({ name: 'plan' }, exec(agentB))
const agentD = makeAgent(undefined, { id: 'session-d' })
fireCreated(agentD)
check('a preset can be the default',
  storeOf().assignments['session-d'] === 'plan'
    && keptOf(agentD).includes('read') && !keptOf(agentD).includes('pwsh'),
  JSON.stringify({ binding: storeOf().assignments['session-d'], kept: keptOf(agentD) }))

process.env.USERPROFILE = savedHomeV2
process.env.HOME = savedHomeV2b
rmSync(v2Home, { recursive: true, force: true })

// ---- legacy store: plugin-kits.json is read once ---------------------------
const legacyHome = join(tmpdir(), `loadout-legacy-${process.pid}`)
rmSync(legacyHome, { recursive: true, force: true })
mkdirSync(join(legacyHome, '.dsh'), { recursive: true })
writeFileSync(join(legacyHome, '.dsh', 'plugin-kits.json'), JSON.stringify({
  kits: [{ name: 'old', title: '旧套装', allow: ['read', 'pwsh'] }],
  defaultKit: 'old',
}), 'utf8')
const savedProfile = process.env.USERPROFILE
const savedHome = process.env.HOME
process.env.USERPROFILE = legacyHome
process.env.HOME = legacyHome
const legacyModule = await import('../index.js?legacy=1')
const ctx3 = makeCtx()
legacyModule.apply(ctx3, config)
const legacyListed = await ctx3.registered.get('kit_list').execute({}, exec(makeAgent()))
// Migration copies the legacy kits into `loadout.json` and saves immediately, so
// the file the user's kits live in is the new one from the first boot. What must
// survive is the data (kits + default), not the old path string.
check('legacy store is migrated', legacyListed.source === join(legacyHome, '.dsh', 'loadout.json'), legacyListed.source)
check('legacy kit survives', legacyListed.kits.some((kit) => kit.name === 'old'), JSON.stringify(legacyListed.kits.map((kit) => kit.name)))
check('legacy default survives', legacyListed.default === 'old', legacyListed.default)
await ctx3.registered.get('kit_set_default').execute({ name: 'coding' }, exec(makeAgent()))
check('next save moves to loadout.json', existsSync(join(legacyHome, '.dsh', 'loadout.json')))
process.env.USERPROFILE = savedProfile
process.env.HOME = savedHome
rmSync(legacyHome, { recursive: true, force: true })

// ---- report ----------------------------------------------------------------
rmSync(scratch, { recursive: true, force: true })
if (failures.length === 0) {
  console.log(`ok — ${OWN_TOOLS.length} tools, base/extras model, presets, saveAs, store round-trip and dispose verified`)
  process.exit(0)
}
console.log(`FAILED (${failures.length}):`)
for (const failure of failures) console.log(` - ${failure}`)
process.exit(1)
