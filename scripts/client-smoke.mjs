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
const SLOTS = ['settings.section', 'conversation.session.header.actions', 'conversation.input.right']

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
// The indirection lets one test swap in a recorder and click a row for real.
let fetchImpl = () => Promise.reject(new Error('unexpected network call during load'))
globalThis.fetch = (...args) => fetchImpl(...args)
globalThis.AbortController = class { abort() {} signal = {} }

// The client bundle is plain script text (no exports); evaluate it with `window` in scope.
new Function('window', 'fetch', 'AbortController', source)(globalThis.window, globalThis.fetch, globalThis.AbortController)

check('module loaded', loaded !== undefined)
check('module id', loadedId === expectedId, `${String(loadedId)} != ${expectedId}`)
check('declares inject', Array.isArray(loaded?.inject) && loaded.inject.includes('slots'), JSON.stringify(loaded?.inject))

loaded?.apply(ctx)

check('slots.inject called once per surface', injections === 3, String(injections))
check('three surfaces registered', registrations.length === 3, String(registrations.length))

const registration = registrations.find((entry) => entry.definition?.name === 'settings.section')
const header = registrations.find((entry) => entry.definition?.name === 'conversation.session.header.actions')
const hero = registrations.find((entry) => entry.definition?.name === 'conversation.input.right')
check('settings panel registered', registration !== undefined)
check('header chip registered', header !== undefined)
check('new-conversation picker registered', hero !== undefined)
// The slot renders only when a Session exists, and a Session-scoped entry gets
// its id through `inject`; without this the picker would render with no session
// to read or bind.
check('the picker is handed its Session id',
  typeof hero?.definition?.inject === 'function' && hero.definition.inject('session-x').sessionId === 'session-x',
  typeof hero?.definition?.inject)

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
const FOOTER = '装备栏只决定「这个对话能用哪些工具」：切换后下一条消息即按新清单组装，随时可以切回「全部」；装备栏作用于工具（tool）这一层——界面面板、宿主服务类插件不注册工具，因此不受影响。'
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
  // 加挂 reads as "attached / attachable": the second number is what is still
  // missing from the current selection, so the group answers "how much room is
  // left" without opening it.
  check('加挂 counts attached of attachable', allText.includes('加挂（1/1）'), allText.slice(0, 400))
  check('footer text is the approved sentence', allText.includes(FOOTER))
  check('footer carries the before-you-start reminder',
    allText.includes('重要提醒') && allText.includes('建议新建对话时直接选择合适套装'), allText.slice(-600))
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

  // Saving a kit and starting to use it are two decisions. The menu offers both,
  // and only the second one can change what this conversation's tools are.
  check('the builder offers save without switching',
    source.includes("onSaveKeep: () => saveBuilder('keep')"), 'no 保存 button next to 保存并启用')
  check('the builder labels the switching button', source.includes("saveLabel: '保存并启用'"))
  check('the switching button warns it rewrites the tools',
    source.includes('保存后立刻切换到这个套装'), '保存并启用 has no hover text')
  const keepBranch = source.slice(source.indexOf("if (mode === 'keep')"), source.indexOf('const appliedKit'))
  check('save-only leaves the current selection alone', keepBranch.includes('return'), keepBranch.slice(0, 200))
}

// ---- the price of a switch, next to the switch ------------------------------
// Switching rewrites the tool definitions, so everything after them in the prefix
// is paid again at the miss price. The number is meaningless without the context
// that produced it, so the status line names the size too.
const priced = { ...fixture, context: { tokens: 200000 } }
let pricedMenu
try {
  pricedMenu = expand(header.component({
    sessionId: 'session-1',
    preview: { open: true, data: priced, groups: { kits: true, presets: true, extras: true, applied: false } },
  }))
} catch (error) {
  failures.push(`priced menu render threw: ${error instanceof Error ? error.message : String(error)}`)
}

if (pricedMenu !== undefined) {
  const pricedText = textOf(pricedMenu)
  check('the status line states the context size', pricedText.includes('上下文 ~200k'), pricedText.slice(0, 300))
  check('an inactive kit quotes one switch', pricedText.includes('≈¥0.30'), pricedText.slice(0, 900))
  const activePriced = nodesIn(pricedMenu, (node) => node.props?.role === 'menuitem' && textOf(node).includes('我的套'))
  check('the kit already in use quotes no price', !textOf(activePriced[0]).includes('≈¥'), textOf(activePriced[0]))

  // 全部 and 仅内置 are one click away from a full re-bill too, so they carry the
  // same number as the kits do.
  const allRow = nodesIn(pricedMenu, (node) => node.props?.role === 'menuitem' && textOf(node).trim().startsWith('全部'))
  check('全部 quotes the same one-switch price', allRow.length === 1 && textOf(allRow[0]).includes('≈¥0.30'), JSON.stringify(allRow.map(textOf)))

  // The sentence belongs to the whole row: the hint is four glyphs wide, and a
  // tooltip hidden behind it is a tooltip nobody finds.
  const pricedRows = nodesIn(pricedMenu, (node) => node.props?.role === 'menuitem' &&
    typeof node.props?.title === 'string' && node.props.title.includes('按未命中价重新计算一次'))
  check('a switching row explains itself on hover', pricedRows.length >= 2, JSON.stringify(pricedRows.map(textOf)))
  check('the row tooltip names the context it would re-bill', pricedRows[0]?.props?.title.includes('约 200k tokens'), String(pricedRows[0]?.props?.title))

  // What new conversations start from is a global decision and belongs to
  // 设置 → 装备栏. This menu is scoped to one conversation, so it must not grow
  // a control that writes `defaultKit` — that would be the same mistake as
  // letting the picker edit kits.
  const defaultButtons = nodesIn(pricedMenu, (node) => node.type === 'button' &&
    ['下次对话', '✓ 新对话', '设为默认'].includes(textOf(node).trim()))
  check('the conversation menu cannot set the default', defaultButtons.length === 0,
    defaultButtons.map((node) => textOf(node)).join('|'))
  check('the conversation menu does not mention 下次对话', !pricedText.includes('下次对话'),
    pricedText.slice(0, 300))

  // Below 20k the switch is lost in the noise, and a number there would be noise.
  const shortMenu = expand(header.component({
    sessionId: 'session-1',
    preview: { open: true, data: { ...fixture, context: { tokens: 5000 } }, groups: { kits: true, presets: true, extras: false } },
  }))
  const shortText = textOf(shortMenu)
  check('a short conversation is not quoted a price', !shortText.includes('≈¥'), shortText.slice(0, 600))
  check('a short conversation does not advertise its size', !shortText.includes('上下文'), shortText.slice(0, 300))
}

// ---- the blank-conversation picker (composer row, next to 标准模式) ----------
// This is the one place a switch is free: the agent does not exist yet, so no
// request prefix has been built and nothing can be re-billed.
try {
  // Collapsed, the chip says what it is and keeps the sentence for the tooltip:
  // the composer row is shared with 权限/计划 and has no room for prose.
  const collapsed = expand(hero.component({ sessionId: 'session-new', preview: { blank: true, data: fixture } }))
  const collapsedText = textOf(collapsed)
  check('the chip says what it chooses and names the kit',
    collapsedText.includes('选择对话套装') && collapsedText.includes('我的套'), collapsedText)
  check('the sentence is not printed on the row', !collapsedText.includes('这个新对话会用'), collapsedText)
  const tipButton = nodesIn(collapsed, (node) => typeof node.props?.title === 'string' && node.props.title.includes('这个新对话会用'))
  check('the sentence rides on the chip as its tooltip', tipButton.length === 1, JSON.stringify(nodesIn(collapsed, (node) => node.props?.title)))
  check('the tooltip reads as a sentence about this conversation',
    tipButton[0]?.props?.title === '这个新对话会用「我的套」套装', String(tipButton[0]?.props?.title))

  // A pick on an unsent screen is a draft: a later visit must start clean, so the
  // first look asks the host to drop whatever a previous visit left behind.
  check('a new visit releases the previous visit\'s draft',
    source.includes("action: 'release'") && source.includes('next.draft === true'),
    'the picker never releases a draft')

  // With no default set, the collapsed label is 全部.
  const noDefault = expand(hero.component({
    sessionId: 'session-new',
    preview: { blank: true, data: { ...fixture, defaultKit: '' } },
  }))
  const noDefaultText = textOf(noDefault)
  check('with no default, the chip says 全部',
    noDefaultText.includes('全部') && !noDefaultText.includes('我的套'), noDefaultText)
  check('the collapsed control is a real button',
    nodesIn(noDefault, (node) => node.props?.['aria-expanded'] === 'false').length === 1,
    noDefaultText)

  // Opened: 全部 / 仅内置 / the two groups, groups still folded.
  const opened = expand(hero.component({
    sessionId: 'session-new',
    preview: { blank: true, data: fixture, open: true },
  }))
  const openedText = textOf(opened)
  check('opened, it lists 全部 and 仅内置', openedText.includes('全部') && openedText.includes('仅内置'), openedText)
  check('opened, it groups presets and my kits', openedText.includes('预设套装') && openedText.includes('我的套装'), openedText)
  check('both kit groups start folded', !openedText.includes('写作') && !openedText.includes('另一套'), openedText)
  check('folded groups still say how many they hold',
    openedText.includes('（5）') && openedText.includes('（2）'), openedText)

  // The picker answers one question — which kit this conversation starts with.
  // Creating, editing and choosing the default are someone else's job (设置), and
  // a picker that also offered them would be a menu pretending to be a page.
  const pickerText = textOf(hero.component({
    sessionId: 'session-new',
    preview: { blank: true, data: fixture, open: true, groups: { presets: true, kits: true } },
  }))
  check('the picker does not create kits', !pickerText.includes('新建套装'), pickerText.slice(0, 300))
  check('the picker does not edit kits', !pickerText.includes('编辑') && !pickerText.includes('删除'), pickerText.slice(0, 300))
  check('the picker does not set the default', !pickerText.includes('设为默认') && !pickerText.includes('下次对话'),
    pickerText.slice(0, 300))

  // Opening the list must not reflow the page, and it opens upward: the composer
  // row sits at the bottom of the window.
  const panel = nodesIn(opened, (node) => node.props?.style?.maxHeight === 320)
  check('the list floats instead of pushing the page',
    panel.length === 1 && panel[0]?.props?.style?.position === 'absolute', JSON.stringify(panel.map((node) => node.props.style)))
  check('the list opens upward', String(panel[0]?.props?.style?.bottom ?? '').includes('100%'), JSON.stringify(panel[0]?.props?.style))
  check('the chip anchors the floating list',
    opened?.props?.style?.position === 'relative', JSON.stringify(opened?.props?.style))

  // `@dsh` is the wire value for 仅内置; it must never be shown to the user, not
  // in the list and not in the sentence that confirms a pick.
  check('仅内置 is never printed as its wire value',
    !openedText.includes('@dsh') && source.includes("if (name === DEFAULT_DSH) return '仅内置'"),
    openedText)

  // A kit inside 我的套装 is selectable once that group is opened, and picking it
  // binds this conversation only.
  const binds = []
  fetchImpl = (url, init) => {
    binds.push({ url, body: JSON.parse(String(init?.body ?? '{}')) })
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ ...fixture, bound: true, binding: 'other' }) })
  }
  const kitsOpen = expand(hero.component({
    sessionId: 'session-new',
    preview: { blank: true, data: fixture, open: true, groups: { presets: false, kits: true } },
  }))
  const kitRows = nodesIn(kitsOpen, (node) => node.props?.role === 'menuitem')
  const otherRow = kitRows.find((node) => textOf(node).includes('另一套'))
  check('my kits open to their rows', otherRow !== undefined, JSON.stringify(kitRows.map(textOf)))
  otherRow?.props?.onClick?.()
  check('picking a kit binds this conversation only',
    binds.length === 1 && binds[0]?.body?.action === 'bind' && binds[0]?.body?.sessionId === 'session-new' && binds[0]?.body?.name === 'other',
    JSON.stringify(binds))
  check('picking a kit leaves the default alone',
    binds[0]?.body?.base === undefined && binds[0]?.body?.apply === undefined && binds[0]?.body?.default === undefined,
    JSON.stringify(binds[0]?.body))

  // A bound conversation shows its own pick, not the default.
  const bound = expand(hero.component({
    sessionId: 'session-new',
    preview: { blank: true, data: { ...fixture, bound: true, binding: 'other' } },
  }))
  check('a bound conversation names its own kit', textOf(bound).includes('另一套'), textOf(bound))

  // Once the conversation has a message the hero is gone, and so is the picker.
  check('the picker leaves with the hero', hero.component({ sessionId: 'session-new', preview: { blank: false, data: fixture } }) === null)
} catch (error) {
  failures.push(`hero picker render threw: ${error instanceof Error ? error.message : String(error)}`)
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

  // A page that edits defaults has no business quoting what a switch would cost
  // *this* conversation — that number belongs to the conversation's own menu.
  check('settings does not price a switch', !panelText.includes('切换一次大概多贵') && !panelText.includes('未命中 ¥/百万'), panelText.slice(0, 600))
  check('settings explains the numbers are the last live conversation\'s',
    panelText.includes('设置页不绑定具体会话，上面的数字来自最近活跃的那个对话'), panelText.slice(0, 300))
  check('settings says where a single conversation is switched',
    panelText.includes('单独对话请在标题栏「装备栏」切换'), panelText.slice(0, 300))
  check('settings names the other two places a kit can be chosen',
    panelText.includes('新建对话时也可选择对话套装'), panelText.slice(0, 300))

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
check('the remaining surfaces still register',
  keptRegistrations.length === 2
    && keptRegistrations.some((entry) => entry.name === 'settings.section')
    && keptRegistrations.some((entry) => entry.name === 'conversation.input.right'),
  JSON.stringify(keptRegistrations.map((entry) => entry.name)))

if (failures.length === 0) {
  console.log('ok: client bundle loads, renders the new-conversation picker, the header menu (groups, check marks, tooltips, footer), and the settings panel')
  process.exit(0)
}
console.log(`FAILED (${failures.length}):`)
for (const failure of failures) console.log(` - ${failure}`)
process.exit(1)
