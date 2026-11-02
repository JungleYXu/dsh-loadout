/**
 * Client smoke test: loads ../client.js with a fake `window`, fake React and a
 * fake slots registry, then checks the header menu rows and the settings panel.
 *
 *   $env:ELECTRON_RUN_AS_NODE="1"
 *   & "…\DeepSeek Harness.exe" dsh-loadout\scripts\client-smoke.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')
// The factory id must be the package name, so read it rather than restating it:
// a rename in package.json has to break this test instead of the boot.
const expectedId = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).name

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(detail === undefined ? label : `${label} — ${detail}`)
}

let loaded
let loadedId

const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
  useCallback(fn) {
    return fn
  },
  useMemo(fn) {
    return fn()
  },
  useRef(value) {
    return { current: value }
  },
}

const registrations = []
let injections = 0
const SLOTS = ['settings.section', 'conversation.session.header.actions']

const slots = {
  inject(name, callback) {
    injections += 1
    check('slots.inject targets a known slot', SLOTS.includes(name), name)
    callback()
    return () => {}
  },
  register(definition, component) {
    registrations.push({ definition, component })
    return () => {}
  },
}

const ctx = {
  slots,
  effect() {
    return () => {}
  },
  logger: { info() {}, warn() {} },
}

globalThis.window = {
  __ModuleLoader__: {
    load(descriptor) {
      check('load receives id', typeof descriptor.id === 'string', String(descriptor.id))
      check('load receives factory', typeof descriptor.factory === 'function')
      loadedId = descriptor.id
      loaded = descriptor.factory((request) => {
        check('factory requires react', request === 'react', String(request))
        return React
      })
    },
  },
}

// fetch must not run during load; it only runs inside effects, which the fake React never invokes.
globalThis.fetch = () => Promise.reject(new Error('unexpected network call during load'))
globalThis.AbortController = class { abort() {} signal = {} }

// The client bundle is plain script text (no exports); evaluate it with `window` in scope.
new Function('window', 'fetch', 'AbortController', source)(globalThis.window, globalThis.fetch, globalThis.AbortController)

check('module loaded', loaded !== undefined)
check('module id', loadedId === expectedId, `${String(loadedId)} != ${expectedId}`)
check('declares inject', Array.isArray(loaded?.inject) && loaded.inject.includes('slots'), JSON.stringify(loaded?.inject))

loaded?.apply(ctx)

check('slots.inject called twice', injections === 2, String(injections))
check('two surfaces registered', registrations.length === 2, String(registrations.length))

const registration = registrations.find((entry) => entry.definition?.name === 'settings.section')
const header = registrations.find((entry) => entry.definition?.name === 'conversation.session.header.actions')
check('settings panel registered', registration !== undefined)
check('header chip registered', header !== undefined)

const definition = registration?.definition ?? {}
check('slot name', definition.name === 'settings.section', String(definition.name))
check('slot id', definition.id === expectedId, String(definition.id))
check('slot order is a number', typeof definition.order === 'number', String(definition.order))
check('slot label', typeof definition.label === 'function' && definition.label() === '装备栏', String(definition.label?.()))
check('component provided', typeof registration?.component === 'function')

// The header chip needs the Session it belongs to; the host hands it over through inject.
check('header id', header?.definition?.id === expectedId, String(header?.definition?.id))
check('header order is a number', typeof header?.definition?.order === 'number', String(header?.definition?.order))
const headerProps = typeof header?.definition?.inject === 'function' ? header.definition.inject('session-1') : undefined
check('header receives its Session', headerProps?.sessionId === 'session-1', JSON.stringify(headerProps))
check('header component provided', typeof header?.component === 'function')

// ---- the chip's GET carries the conversation it belongs to ------------------
// A bare GET makes the host answer from whichever agent was touched last, which
// is exactly the cross-conversation leak the chip must not have. The settings
// panel has no Session, so its call stays bare on purpose (the host-side
// selftest covers that fallback).
check('the chip GET names its Session', source.includes('await load(sessionId)'), 'client.js never passes the header sessionId to load()')
check(
  'the GET query percent-encodes the Session',
  source.includes('?sessionId=${encodeURIComponent(sessionId)}'),
  'load() does not build ?sessionId=…',
)
check('a caller with no Session keeps the bare URL', source.includes('await load()'), 'the settings panel stopped calling load() without a Session')

// ---- tree helpers -----------------------------------------------------------
function walk(node, visit) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node !== 'object') return
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

function textOf(node) {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node === null || node === undefined || typeof node !== 'object') return ''
  return (node.children ?? []).map(textOf).join('')
}

function nodesIn(root, predicate) {
  const found = []
  walk(root, (node) => { if (predicate(node)) found.push(node) })
  return found
}

// The fake React only records element trees, so function components render as
// opaque { type: fn } nodes. Expand them by hand (their hooks are stateless in
// this fake) so assertions can see the rows they produce.
function expand(node) {
  if (Array.isArray(node)) return node.map(expand)
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (typeof node.type === 'function') {
    const props = { ...(node.props ?? {}) }
    const kids = node.children ?? []
    // Real React hands children to the component as props.children.
    if (kids.length === 1) props.children = expand(kids[0])
    else if (kids.length > 1) props.children = kids.map(expand)
    return expand(node.type(props))
  }
  return { ...node, children: (node.children ?? []).map(expand) }
}

// ---- the rendered menu (seeded through the documented `preview` test seam) --
const FOOTER = '装备栏只决定「这个对话能用哪些工具」：切换后下一条消息即按新清单组装，随时可以切回「全部」；新对话则从「设置 → 装备栏」的默认套装开始。它作用于工具（tool）这一层——界面面板、宿主服务类插件不注册工具，因此不受影响。'
const fixture = {
  ok: true,
  source: 'C:/fake/.dsh/loadout.json',
  presets: [
    { name: 'chat', title: '仅聊天', allow: ['ask_user_question', 'web_search', 'read'] },
    { name: 'coding', title: '编程用', allow: ['pwsh', 'read'] },
    { name: 'research', title: '查找资料', allow: ['web_search', 'web_fetch'] },
    { name: 'plan', title: '项目梳理', allow: ['read', 'write', 'todo_write'] },
    { name: 'writing', title: '写作', allow: ['read', 'write', 'edit'] },
  ],
  presetNames: ['chat', 'coding', 'research', 'plan', 'writing'],
  kits: [
    { name: 'mine', title: '我的套', note: '用于视频制作', builtins: ['read'], plugins: [], allow: ['read'], description: '内置 1 个', tokens: 860, isDefault: true },
    { name: 'other', title: '另一套', builtins: ['write'], plugins: [], allow: ['write'], description: '内置 1 个', tokens: 420, isDefault: false },
  ],
  defaultKit: 'mine',
  catalog: {
    builtins: ['read', 'write', 'pwsh'],
    plugins: [
      { id: 'demo', title: 'demo 插件', tools: ['demo_search'] },
      { id: 'alpha', title: 'alpha 插件', tools: ['alpha_search'] },
    ],
  },
  selection: { base: 'kit', kit: 'mine', extras: ['demo'] },
  label: '我的套',
  appliedPlugins: ['alpha'],
  availableExtras: ['demo'],
  ledger: {
    estimated: true, charsPerToken: 3.5,
    visibleTools: 12, visibleTokens: 860,
    totalTools: 31, totalTokens: 2410, savedTokens: 1550, unpriced: 0,
  },
}

let menu
try {
  menu = expand(header.component({
    sessionId: 'session-1',
    preview: { open: true, data: fixture, groups: { kits: false, presets: true, extras: true, applied: true } },
  }))
  check('menu renders', menu !== undefined && typeof menu === 'object')
} catch (error) {
  failures.push(`menu render threw: ${error instanceof Error ? error.message : String(error)}`)
}

// Defaults: both kit groups start collapsed, so the menu shows the set that is on
// and nothing else; 加挂's applied-plugin list stays folded into one row.
let menuDefault
try {
  menuDefault = expand(header.component({ sessionId: 'session-1', preview: { open: true, data: fixture } }))
} catch (error) {
  failures.push(`default menu render threw: ${error instanceof Error ? error.message : String(error)}`)
}
if (menuDefault !== undefined) {
  const flat = textOf(menuDefault)
  check('presets start collapsed', !flat.includes('写作'), flat.slice(0, 400))
  check('user kits start collapsed', !flat.includes('另一套'), flat.slice(0, 400))
  check('the active kit is the only kit row while collapsed', flat.includes('我的套（用于视频制作）'), flat.slice(0, 400))
  // Creating a kit must not need a click on the group head first.
  check('the new-kit row is visible while my kits are collapsed', flat.includes('＋ 新建套装'), flat.slice(0, 400))
  check('applied plugins start collapsed', !flat.includes('alpha 插件'), flat.slice(0, 400))
  check('applied plugins collapse into one summary row', flat.includes('已应用 1 个插件'), flat.slice(0, 400))
  check('menu opens with a status line', flat.includes('当前：我的套') && flat.includes('加挂 1'), flat.slice(0, 200))
  check('a way back to 全部 is offered', flat.includes('恢复为全部'), flat.slice(0, 400))
  check('status line quotes the token saving', flat.includes('省 ~1.6k tokens'), flat.slice(0, 200))
}

if (menu !== undefined) {
  const allText = textOf(menu)
  for (const label of ['全部', '仅内置', '我的套装', '加挂']) {
    check(`menu shows «${label}»`, allText.includes(label), allText.slice(0, 400))
  }
  check('我的套装 counts user kits only', allText.includes('我的套装（2）'), allText.slice(0, 400))
  // Presets are back from 0.12: they are the quickest way to start a known kind
  // of work, they stay read-only, and each one now says what it leaves out.
  check('menu lists the presets again', allText.includes('预设套装（5）') && allText.includes('写作') && allText.includes('仅聊天'), allText.slice(0, 400))
  check('加挂 counts extras', allText.includes('加挂（1）'), allText.slice(0, 400))
  check('footer text is the approved sentence', allText.includes(FOOTER))
  check('the menu shows the note with the kit name', allText.includes('我的套（用于视频制作）'), allText.slice(0, 400))
  check('the save panel can be cancelled', source.includes("setSaveNote('')"), 'the 取消 button does not reset the save panel')

  const rows = nodesIn(menu, (node) => node.props?.role === 'menuitem')
  const activeRow = rows.find((node) => textOf(node).includes('我的套'))
  check('active kit is visible while its group is collapsed', activeRow !== undefined, JSON.stringify(rows.map(textOf)))
  check('active kit row is indented', activeRow?.props?.style?.paddingLeft === 26, JSON.stringify(activeRow?.props?.style))
  check('active kit row carries the check mark', textOf(activeRow).includes('✓'), textOf(activeRow))

  const blockedRow = rows.find((node) => textOf(node).includes('alpha 插件'))
  check('plugin already applied is disabled', blockedRow?.props?.['aria-disabled'] === 'true', JSON.stringify(blockedRow?.props))
  check('plugin already applied explains why', textOf(blockedRow).includes('已在对话中'), textOf(blockedRow))

  const extraRow = rows.find((node) => textOf(node).includes('demo 插件'))
  check('attached extra is marked', textOf(extraRow).includes('✓'), textOf(extraRow))
  check('attached extra is selectable', extraRow?.props?.['aria-disabled'] !== 'true')

  const bubbles = nodesIn(menu, (node) => node.props?.role === 'tooltip')
  check('row headers carry tooltip bubbles', bubbles.length >= 4, String(bubbles.length))
  check('tooltip explains 全部', bubbles.some((node) => textOf(node).includes('不裁剪')))
  check('tooltip floats out of layout', bubbles.every((node) => node.props?.style?.position === 'absolute'), JSON.stringify(bubbles[0]?.props?.style))
  check('tooltip is hidden until hover', bubbles.every((node) => node.props?.style?.opacity === 0))
  const tips = nodesIn(menu, (node) => typeof node.props?.onMouseEnter === 'function' && typeof node.props?.onFocus === 'function')
  check('tooltips wire hover and keyboard focus', tips.length >= 4, String(tips.length))

  const refreshIcon = nodesIn(menu, (node) => node.props?.['aria-label'] === '刷新工具列表')
  check('panel offers a refresh icon', refreshIcon.length === 1, String(refreshIcon.length))

  const saveIcon = nodesIn(menu, (node) => node.props?.['aria-label'] === '存为新套装')
  check('存为新套装 icon appears once extras exist', saveIcon.length === 1, String(saveIcon.length))
  check('save icon stops the group toggle', typeof saveIcon[0]?.props?.onClick === 'function')
  let stopped = false
  saveIcon[0]?.props?.onClick?.({ stopPropagation: () => { stopped = true } })
  check('save icon click does not collapse the group', stopped === true)

  check('全部 row is not the active base', textOf(rows.find((node) => textOf(node).includes('全部')))?.includes('✓') !== true)

  const kitsOpen = expand(header.component({
    sessionId: 'session-1',
    preview: { open: true, data: fixture, groups: { kits: true, presets: true, extras: true } },
  }))
  const kitsOpenText = textOf(kitsOpen)
  check('我的套装 expands to the other kits', kitsOpenText.includes('另一套'), kitsOpenText.slice(0, 400))
  check('新建套装 is offered under 我的套装', kitsOpenText.includes('＋ 新建套装'), kitsOpenText.slice(0, 400))
}

// ---- the chip stays a single button while closed ---------------------------
try {
  const chip = header.component({ sessionId: 'session-1' })
  check('chip renders a wrapper', chip !== undefined && typeof chip === 'object', String(chip))
  const children = (chip?.children ?? []).filter(Boolean)
  check('chip renders one button while closed', children.length === 1, JSON.stringify(children.map((child) => child?.type)))
  check('chip without a Session renders nothing', header.component({}) === null)
} catch (error) {
  failures.push(`chip render threw: ${error instanceof Error ? error.message : String(error)}`)
}

// ---- the settings panel -----------------------------------------------------
// Loading state first (no seeded data): rendering must not throw.
try {
  const element = expand(registration.component({}))
  check('panel renders an element', element !== undefined && typeof element === 'object')
  check('panel root is a div', element?.type === 'div', String(element?.type))
  check('panel shows a loading line', textOf(element).includes('正在读取'))
} catch (error) {
  failures.push(`panel render threw: ${error instanceof Error ? error.message : String(error)}`)
}

try {
  const panel = expand(registration.component({ preview: { data: fixture, openSections: { presets: true, kits: true } } }))
  const panelText = textOf(panel)
  check('settings lists the presets again', panelText.includes('预设套装 · 只读（5）') && panelText.includes('写作') && panelText.includes('项目梳理'), panelText.slice(0, 400))
  check('settings lists my kits', panelText.includes('我的套装'), panelText.slice(0, 400))
  check('settings picks a default kit', panelText.includes('新对话默认套装') && panelText.includes('仅内置'), panelText.slice(0, 400))
  check('a note rides next to the kit name', panelText.includes('我的套（用于视频制作）'), panelText.slice(0, 400))
  check('settings shows the store source', panelText.includes(fixture.source), panelText.slice(-300))
  check('settings marks the default kit', panelText.includes('默认'))
  check('settings shows the token ledger', panelText.includes('本套装省约 1.6k tokens') && panelText.includes('「全部」约 2.4k tokens'), panelText.slice(0, 400))
  check('settings says which conversation the ledger describes', panelText.includes('最近活跃对话保留') && panelText.includes('设置页不绑定具体会话'), panelText.slice(0, 400))
  // 全部 / 仅内置 sit in the same list as the kits, so they are rendered as cards
  // with the same two actions; presets are read-only and carry no save-as button.
  // The default section says out loud that it cannot reach an open conversation.
  check('settings says the default only affects new conversations', panelText.includes('只影响之后新建的对话'), panelText.slice(0, 400))
  const copyButtons = nodesIn(panel, (node) => node.type === 'button' && textOf(node) === '复制切换命令')
  const defaultButtons = nodesIn(panel, (node) => node.type === 'button' && textOf(node) === '设为默认')
  // 2 defaults + 3 presets + 2 user kits — every card carries both actions.
  check('全部 and 仅内置 are cards with the two actions', copyButtons.length === 9 && defaultButtons.length === 9, `${copyButtons.length}/${defaultButtons.length}`)
  check('preset cards no longer offer save-as', !panelText.includes('另存为我的套装'), panelText.slice(0, 400))
  const editButtons = nodesIn(panel, (node) => node.type === 'button' && textOf(node) === '编辑')
  check('settings offers an edit action for saved kits', editButtons.length === 2, `${editButtons.length} · 编辑`)
  check('kit cards show their own estimate', panelText.includes('≈860 tokens') && panelText.includes('≈420 tokens'), panelText.slice(0, 400))
  const deleteButtons = nodesIn(panel, (node) => node.type === 'button' && textOf(node) === '删除')
  check('only my kits can be deleted', deleteButtons.length === 2, `${deleteButtons.length} · 删除@${panelText.indexOf('删除')} · ${panelText.slice(0, 200)}`)

  // Presets start collapsed, and while collapsed they behave like 我的套装: the
  // one that is the default stays visible so the page still answers "a new
  // conversation starts with this".
  const presetDefault = { ...fixture, defaultKit: 'chat', selection: { base: 'kit', kit: 'chat', extras: [] } }
  const collapsed = expand(registration.component({ preview: { data: presetDefault } }))
  const collapsedText = textOf(collapsed)
  check('presets start collapsed',
    collapsedText.includes('预设套装 · 只读（5）') && !collapsedText.includes('写作'), collapsedText.slice(0, 400))
  check('a collapsed preset group keeps the default visible',
    collapsedText.includes('仅聊天') && collapsedText.includes('当前默认'), collapsedText.slice(0, 400))
  const presetExpanded = expand(registration.component({ preview: { data: presetDefault, openSections: { presets: true, kits: false } } }))
  const presetExpandedText = textOf(presetExpanded)
  check('only the default preset carries the default tag',
    presetExpandedText.includes('仅聊天') && presetExpandedText.includes('默认'), presetExpandedText.slice(0, 400))
  // 「＋ 新建套装」 is the only row that creates something; it must read as an
  // action (blue, tinted), not as another selectable kit.
  const menuWithKits = expand(header.component({ sessionId: 'session-1', preview: { data: fixture, open: true, groups: { kits: true, presets: false, extras: false } } }))
  const newKit = nodesIn(menuWithKits, (node) => node.props?.role === 'menuitem' && node.props?.style?.color === '#2563eb' && textOf(node).includes('＋ 新建套装'))
  check('the new-kit row is highlighted as an action', newKit.length === 1, String(newKit.length))
  const renameButtons = nodesIn(panel, (node) => node.type === 'button' && textOf(node) === '重命名')
  // Renaming moved into 编辑: one editor for name, note and tools on the card.
  check('renaming lives inside 编辑 rather than its own button', renameButtons.length === 0 && editButtons.length === 2, `${renameButtons.length} · 重命名 / ${editButtons.length} · 编辑`)

  // A name the host would refuse is explained where the user typed it: a preset's
  // `name` is a private id (`chat`), so "chat" looks free and is not.
  const clashPanel = expand(registration.component({
    preview: { data: fixture, draft: { name: 'chat', note: '', builtins: ['read'], plugins: [] } },
  }))
  const clashText = textOf(clashPanel)
  check('a name taken by a preset is explained inline',
    clashText.includes('是预置套装') && clashText.includes('仅聊天'), clashText.slice(0, 600))
  const clashKitPanel = expand(registration.component({
    preview: { data: fixture, draft: { name: '我的套', note: '', builtins: ['read'], plugins: [] } },
  }))
  check('a name taken by my own kit is explained inline',
    textOf(clashKitPanel).includes('已经有叫「我的套」的套装了'), textOf(clashKitPanel).slice(0, 600))
} catch (error) {
  failures.push(`panel render threw: ${error instanceof Error ? error.message : String(error)}`)
}

// Activation must survive a client UI that no longer has the chip slot: throwing
// out of apply leaves the Loader entry inactive, and an inactive entry is a fatal
// Web boot failure for the whole application.
const keptRegistrations = []
const partial = {
  slots: {
    inject(name, callback) {
      if (name === 'conversation.session.header.actions') throw new Error('slot removed in this release')
      callback()
      return () => {}
    },
    register(definition) {
      keptRegistrations.push(definition)
      return () => {}
    },
  },
  logger: { info() {}, warn() {} },
}
let applyError
try {
  loaded?.apply(partial)
} catch (error) {
  applyError = error
}
check('apply survives a missing slot', applyError === undefined, String(applyError))
check('the remaining surface still registers',
  keptRegistrations.length === 1 && keptRegistrations[0].name === 'settings.section',
  JSON.stringify(keptRegistrations.map((entry) => entry.name)))

if (failures.length === 0) {
  console.log('ok: client bundle loads, renders the new header menu (groups, check marks, tooltips, footer), and renders the settings panel')
  process.exit(0)
}
console.log(`FAILED (${failures.length}):`)
for (const failure of failures) console.log(` - ${failure}`)
process.exit(1)
