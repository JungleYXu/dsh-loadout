/**
 * 装备栏 dsh-loadout — the browser half.
 *
 * Two entry points, and only two:
 *   1. the conversation header (the collapsible chip next to the title bar),
 *   2. the settings page (the full editor).
 *
 * The header is the day-to-day control. It shows one base plus an optional set
 * of extras:
 *
 *   全部       no restriction at all (built-ins + every enabled plugin)
 *   仅内置     the Harness's own built-ins only
 *   我的套装   a kit the user saved (the active one stays visible when collapsed)
 *   预设套装   the shipped, read-only kits (写作 / 调研 / 编程)
 *   加挂       plugins attached on top of the base without saving a kit
 *
 * Every action posts to the same host route the settings page uses, so the two
 * can never disagree about what a conversation is running.
 */
// `id` must be the package name, exactly (`dsh-loadout`) — never a scoped or
// `@local/…` alias. The boot graph looks the factory up under the package name; a
// different id means "this bundle loaded without registering", so the loader
// re-executes it on its fallback URL and the second registration throws
// `duplicate factory registration`, which fails the entry and the whole Web boot.
// scripts/preflight.mjs checks this against package.json before every install.
window.__ModuleLoader__.load({
  id: 'dsh-loadout',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const ENDPOINT = '/dsh-loadout/state'

    /** This plugin's own tools never belong inside a kit. */
    const OWN_TOOLS = ['kit_list', 'kit_apply', 'kit_create', 'kit_set_tools', 'kit_set_default', 'kit_delete']

    /** The exact sentence the spec fixes for the panel footer. */
    const FOOTER = '装备栏只决定「这个对话能用哪些工具」：切换后下一条消息即按新清单组装，随时可以切回「全部」；新对话则从「设置 → 装备栏」的默认套装开始。它作用于工具（tool）这一层——界面面板、宿主服务类插件不注册工具，因此不受影响。'

    /** A kit's one-line reminder; keep in step with NOTE_MAX in index.js. */
    const NOTE_MAX = 20

    /** `套装1（用于视频制作）` — the note is a reminder, not part of the name. */
    function kitLabel(kit) {
      return kit.note ? `${kit.title}（${kit.note}）` : kit.title
    }

    /**
     * Why a name cannot be saved, in the user's terms. The host compares a kit
     * against preset *ids* as well as titles (a preset's `name` is a stable id —
     * `chat` — while the UI shows its title, 仅聊天), so "chat" is refused even
     * though it "looks different". Return '' when the name is free.
     */
    function nameClash(raw, presets, kits, ignore) {
      const value = String(raw ?? '').trim().toLowerCase()
      if (value === '') return ''
      const preset = (presets ?? []).find((item) =>
        String(item.name ?? '').toLowerCase() === value || String(item.title ?? '').toLowerCase() === value)
      if (preset !== undefined) {
        return `「${preset.title}」是预置套装（标识 ${preset.name}），不能用这个名字，换一个吧`
      }
      const kit = (kits ?? []).find((item) =>
        String(item.name ?? '').toLowerCase() === value || String(item.title ?? '').toLowerCase() === value)
      if (kit !== undefined && kit.name !== ignore) {
        return `已经有叫「${kit.title ?? kit.name}」的套装了，换一个名字，或者进去编辑它`
      }
      return ''
    }

    /**
     * Presets (仅聊天 / 编程用 / 查找资料 / 项目梳理 / 写作) are shown again from
     * 0.12: they are the fastest way to start a conversation of a known kind,
     * and each one now lists what it leaves out instead of silently dropping
     * tools. They stay read-only — editing one forks it into 我的套装.
     */
    const SHOW_PRESETS = true

    /**
     * Token counts are estimates (tool-definition bytes ÷ ~3.5 chars per token).
     * Round hard: a precise-looking number would invite arithmetic on a guess.
     */
    function formatTokens(value) {
      const n = Math.round(Number(value) || 0)
      if (n < 1000) return String(n)
      return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`
    }

    /** The one binding value that is not a kit: "Harness built-ins only". */
    const DEFAULT_DSH = '@dsh'

    // The cost of a switch is quoted at provider list prices, in ¥ per million
    // tokens. It is a setting, not a constant: prices move, and a wrong number
    // here can only make an estimate wrong — it never changes what a switch does.
    const PRICE_KEY = 'dsh-loadout:pricing'
    const PRICE_DEFAULT = { miss: 2, hit: 0.5 }
    /** Below this the switch is lost in the noise, and a warning would be noise. */
    const PRICE_MIN_TOKENS = 20000

    function readPrices() {
      try {
        const raw = window.localStorage?.getItem(PRICE_KEY)
        if (raw === null || raw === undefined) return { ...PRICE_DEFAULT }
        const parsed = JSON.parse(raw)
        const miss = Number(parsed?.miss)
        const hit = Number(parsed?.hit)
        return {
          miss: Number.isFinite(miss) && miss >= 0 ? miss : PRICE_DEFAULT.miss,
          hit: Number.isFinite(hit) && hit >= 0 ? hit : PRICE_DEFAULT.hit,
        }
      } catch {
        return { ...PRICE_DEFAULT }
      }
    }

    function writePrices(next) {
      try {
        window.localStorage?.setItem(PRICE_KEY, JSON.stringify(next))
      } catch {
        // A browser without storage just keeps the defaults for this page.
      }
    }

    /**
     * `≈¥0.23` for one switch at this prompt size, or `''` when it is too
     * small to be worth a number. Always approximate: the prompt size is a
     * provider-reported anchor plus a heuristic delta, and the price is a
     * setting, not a quote.
     */
    function switchPrice(tokens, prices) {
      const n = Number(tokens)
      if (!Number.isFinite(n) || n < PRICE_MIN_TOKENS) return ''
      const extra = Math.max(0, prices.miss - prices.hit)
      const yuan = (n / 1e6) * extra
      if (yuan < 0.005) return ''
      return `≈¥${yuan < 0.1 ? yuan.toFixed(3) : yuan.toFixed(2)}`
    }

    /** The sentence behind a price, spelled out for the row's tooltip. */
    function switchPriceTip(tokens, prices) {
      const n = Math.round(Number(tokens) || 0)
      const price = switchPrice(n, prices)
      return `切换会重写工具定义，这段上下文（约 ${formatTokens(n)} tokens）要按未命中价重新算一次${price === '' ? '' : `，${price}`}；之后每轮又回到缓存价。`
    }

    // Every mutation fans out to the other panel. The chip and the settings page
    // are separate React trees with separate snapshots, so a switch made in one
    // used to leave the other showing the old numbers until it remounted.
    const CHANGED_EVENT = 'dsh-loadout:changed'

    function announce() {
      try {
        document.dispatchEvent(new CustomEvent(CHANGED_EVENT))
      } catch {
        // A document without CustomEvent still gets the local setData() refresh.
      }
    }

    async function request(payload) {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${response.status}`)
      announce()
      return body
    }

    // A GET carries the Session it is about: the host keeps one selection per
    // conversation, and without this the chip would show whichever one was
    // touched last. A caller with no Session (the settings panel) keeps the bare
    // URL, which the host answers from the most recently seen agent.
    async function load(sessionId) {
      const url = typeof sessionId === 'string' && sessionId !== ''
        ? `${ENDPOINT}?sessionId=${encodeURIComponent(sessionId)}`
        : ENDPOINT
      const response = await fetch(url, { method: 'GET' })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${response.status}`)
      return body
    }

    const styles = {
      wrap: { position: 'relative', display: 'inline-flex', alignItems: 'center' },
      chip: {
        display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 10px',
        border: '1px solid var(--ds-border, #d8dbe0)', borderRadius: 8, background: 'transparent',
        color: 'var(--ds-text, inherit)', font: 'inherit', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
      },
      chipActive: { borderColor: '#3b82f6', color: '#2563eb' },
      dot: { width: 6, height: 6, borderRadius: 999, background: '#3b82f6', display: 'inline-block' },
      panel: {
        position: 'absolute', top: 34, right: 0, width: 370, maxHeight: 520, overflow: 'auto',
        background: 'var(--ds-surface, #fff)', color: 'var(--ds-text, inherit)',
        border: '1px solid var(--ds-border, #d8dbe0)', borderRadius: 10,
        boxShadow: '0 12px 32px rgba(0,0,0,.16)', padding: 10, zIndex: 60, fontSize: 12,
      },
      section: { padding: '6px 4px' },
      sectionTitle: { fontSize: 11, opacity: 0.6, margin: '2px 0 6px' },
      groupHead: {
        display: 'flex', alignItems: 'center', gap: 6, padding: '6px 6px', borderRadius: 6,
        cursor: 'pointer', userSelect: 'none',
      },
      groupHeadHover: { background: 'rgba(59,130,246,.06)' },
      groupTitle: { fontWeight: 600 },
      caret: { width: 10, fontSize: 10, opacity: 0.55, flex: 'none' },
      count: { fontWeight: 400, opacity: 0.55 },
      row: {
        display: 'flex', alignItems: 'center', gap: 6, padding: '5px 6px', borderRadius: 6, cursor: 'pointer',
      },
      rowHover: { background: 'rgba(59,130,246,.08)' },
      rowActive: { background: 'rgba(59,130,246,.10)' },
      // The one row that creates something, not selects something: keep it
      // blue and tinted so it reads as an action at a glance.
      rowPrimary: { color: '#2563eb', background: 'rgba(37,99,235,.07)', fontWeight: 600 },
      rowPrimaryHover: { background: 'rgba(37,99,235,.14)' },
      rowDisabled: { opacity: 0.45, cursor: 'default' },
      indent: { paddingLeft: 26 },
      mark: { width: 12, flex: 'none', color: '#2563eb', fontSize: 12, textAlign: 'center' },
      rowTitle: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
      meta: { fontSize: 11, opacity: 0.6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      topline: { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 6px 8px' },
      summary: {
        fontSize: 11, opacity: 0.72, whiteSpace: 'nowrap',
        overflow: 'hidden', textOverflow: 'ellipsis', flex: '1 1 auto', minWidth: 0,
      },
      divider: { height: 1, background: 'var(--ds-border, #e5e7eb)', margin: '6px 2px' },
      grid: { display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 180, overflow: 'auto', padding: 2 },
      tool: {
        padding: '2px 6px', borderRadius: 5, border: '1px solid var(--ds-border, #d8dbe0)',
        background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 11, cursor: 'pointer',
      },
      toolOn: { background: 'rgba(59,130,246,.14)', borderColor: '#3b82f6', color: '#2563eb' },
      actions: { display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 6 },
      primary: {
        padding: '4px 10px', borderRadius: 6, border: '1px solid #3b82f6', background: '#3b82f6',
        color: '#fff', font: 'inherit', fontSize: 12, cursor: 'pointer',
      },
      ghost: {
        padding: '4px 10px', borderRadius: 6, border: '1px solid var(--ds-border, #d8dbe0)',
        background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 12, cursor: 'pointer',
      },
      hint: { fontSize: 11, opacity: 0.6, marginTop: 6, lineHeight: 1.5 },
      ledger: {
        fontSize: 11, marginTop: 8, lineHeight: 1.6, padding: '6px 8px', borderRadius: 6,
        background: 'rgba(59,130,246,.06)', color: 'var(--ds-text, #334155)',
      },
      ledgerNumber: { fontWeight: 600 },
      footer: {
        fontSize: 11, opacity: 0.62, marginTop: 8, lineHeight: 1.6,
        borderTop: '1px solid var(--ds-border, #e5e7eb)', paddingTop: 6,
      },
      error: { fontSize: 11, color: '#dc2626', marginTop: 6, lineHeight: 1.5 },
      notice: { fontSize: 11, color: '#2563eb', marginTop: 6, lineHeight: 1.5 },
      input: {
        width: '100%', boxSizing: 'border-box', padding: '5px 8px', borderRadius: 6,
        border: '1px solid var(--ds-border, #d8dbe0)', background: 'transparent', color: 'inherit',
        font: 'inherit', fontSize: 12,
      },
      // A price is four characters wide, not the width of the panel.
      priceInput: {
        width: 72, boxSizing: 'border-box', padding: '3px 6px', borderRadius: 6,
        border: '1px solid var(--ds-border, #d8dbe0)', background: 'transparent', color: 'inherit',
        font: 'inherit', fontSize: 12,
      },
      iconButton: {
        border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer',
        fontSize: 13, lineHeight: 1, padding: '2px 4px', opacity: 0.7, flex: 'none',
      },
      savePanel: {
        margin: '4px 2px 6px', padding: 8, borderRadius: 8,
        border: '1px solid var(--ds-border, #e5e7eb)',
      },
      tipWrap: { position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 },
      bubble: {
        position: 'absolute', left: 0, top: 'calc(100% + 6px)', zIndex: 90, width: 236,
        padding: '6px 8px', borderRadius: 6, background: 'var(--ds-tooltip-bg, #1f2937)', color: '#fff',
        fontSize: 11, lineHeight: 1.55, boxShadow: '0 6px 18px rgba(0,0,0,.25)',
        // CJK breaks at any character by default, which splits a sentence in the
        // middle of a word (对话 → 对 / 话). keep-all only breaks at punctuation,
        // so the hint wraps into whole clauses; break-word still rescues an
        // over-long Latin token.
        wordBreak: 'keep-all', overflowWrap: 'break-word',
        pointerEvents: 'none', transition: 'opacity .12s ease',
      },
      card: { border: '1px solid var(--ds-border, #e5e7eb)', borderRadius: 8, padding: '8px 10px' },
      // The builder is an active form, not a read-only card: a blue frame plus a
      // faint tint is the cheapest way to say "this one is editable" without
      // adding a header bar.
      editorCard: {
        border: '1px solid #60a5fa', borderRadius: 8, padding: '8px 10px',
        background: 'rgba(37, 99, 235, 0.05)',
      },
      tag: { fontSize: 10, padding: '0 5px', borderRadius: 4, border: '1px solid currentColor', opacity: 0.7 },
      // The new-conversation picker, sitting in the composer's tool row next to
      // 权限/计划. It is one compact chip; the list floats above the row (below
      // is the window edge), and opening it never reflows the page.
      pickWrap: { position: 'relative', display: 'inline-flex', alignItems: 'center' },
      chipMuted: { opacity: 0.55 },
      chipStrong: { fontWeight: 600 },
      pickPanel: {
        position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, zIndex: 60,
        display: 'flex', flexDirection: 'column', gap: 2, padding: 6, borderRadius: 10,
        border: '1px solid var(--ds-border, #d8dbe0)', background: 'var(--ds-surface, #fff)',
        boxShadow: '0 12px 32px rgba(0,0,0,.16)', width: 260, maxHeight: 320, overflowY: 'auto',
        fontSize: 12,
      },
    }

    // ---- small pieces -------------------------------------------------------
    function Toggle(props) {
      const { on } = props
      return h('span', {
        style: {
          width: 14, height: 14, borderRadius: 4, border: '1px solid',
          borderColor: on ? '#3b82f6' : 'var(--ds-border, #c8ccd2)',
          background: on ? '#3b82f6' : 'transparent',
          color: '#fff', fontSize: 10, lineHeight: '13px', textAlign: 'center', flex: 'none',
        },
      }, on ? '✓' : '')
    }

    /**
     * A floating hint, not a line of layout text: the bubble is always in the
     * tree but hidden (opacity 0, no pointer events), so opening it never
     * shifts a row. Hover or keyboard focus opens it after ~300ms.
     */
    function Tip(props) {
      const [show, setShow] = useState(false)
      const timer = useRef(null)
      const open = () => {
        if (timer.current !== null) clearTimeout(timer.current)
        timer.current = setTimeout(() => setShow(true), 300)
      }
      const close = () => {
        if (timer.current !== null) clearTimeout(timer.current)
        timer.current = null
        setShow(false)
      }
      return h('span', {
        style: styles.tipWrap,
        tabIndex: 0,
        onMouseEnter: open,
        onMouseLeave: close,
        onFocus: open,
        onBlur: close,
      },
      props.children,
      h('span', {
        role: 'tooltip',
        style: { ...styles.bubble, opacity: show ? 1 : 0, visibility: show ? 'visible' : 'hidden' },
      }, props.text))
    }

    function ToolGrid(props) {
      const { tools, selected, onToggle, empty } = props
      const chosen = new Set(selected)
      if (tools.length === 0) return h('div', { style: styles.meta }, empty ?? '没有可选的工具')
      return h('div', { style: styles.grid },
        tools.map((toolName) => h('button', {
          key: toolName,
          type: 'button',
          style: { ...styles.tool, ...(chosen.has(toolName) ? styles.toolOn : null) },
          onClick: () => onToggle(toolName),
        }, toolName)))
    }

    /**
     * A selectable line: ✓ marker, label (with an optional tooltip), hint, and
     * an optional `aside` — a quiet secondary action that stops the click.
     */
    function MenuRow(props) {
      const [hover, setHover] = useState(false)
      const disabled = props.disabled === true
      const style = {
        ...styles.row,
        ...(props.indent === true ? styles.indent : null),
        ...(props.active === true ? styles.rowActive : null),
        ...(props.tone === 'primary' ? styles.rowPrimary : null),
        ...(hover && !disabled ? (props.tone === 'primary' ? styles.rowPrimaryHover : styles.rowHover) : null),
        ...(disabled ? styles.rowDisabled : null),
      }
      const activate = () => {
        if (!disabled && typeof props.onClick === 'function') props.onClick()
      }
      return h('div', {
        role: 'menuitem',
        tabIndex: disabled ? undefined : 0,
        'aria-disabled': disabled ? 'true' : 'false',
        style,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        onClick: activate,
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            activate()
          }
        },
      },
      h('span', { style: styles.mark }, props.active === true ? '✓' : ''),
      h('span', { style: { ...styles.rowTitle, ...(props.tone === 'primary' ? { color: '#2563eb' } : null) } },
        props.tip === undefined
          ? h('span', null, props.label)
          : h(Tip, { text: props.tip }, h('span', null, props.label))),
      h('span', { style: { flex: 1 } }),
      props.hint === undefined || props.hint === '' ? null : (
        props.hintTip === undefined
          ? h('span', { style: styles.meta }, props.hint)
          : h(Tip, { text: props.hintTip }, h('span', { style: styles.meta }, props.hint))
      ))
    }

    /** A collapsible group header: caret, title with its count, optional action. */
    function GroupHead(props) {
      const [hover, setHover] = useState(false)
      return h('div', {
        style: { ...styles.groupHead, ...(hover ? styles.groupHeadHover : null) },
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        onClick: () => props.onToggle(),
        role: 'button',
        tabIndex: 0,
        'aria-expanded': props.open ? 'true' : 'false',
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            props.onToggle()
          }
        },
      },
      h('span', { style: styles.caret }, props.open ? '▾' : '▸'),
      h(Tip, { text: props.tip },
        h('span', { style: styles.groupTitle }, props.title),
        props.count === undefined ? null : h('span', { style: styles.count }, `（${props.count}）`)),
      h('span', { style: { flex: 1 } }),
      props.action ?? null)
    }

    // ---- the kit builder ----------------------------------------------------
    /**
     * `＋ 新建套装`: a name plus two collapsible pickers. Built-ins start fully
     * checked (a new kit means "the usual Harness tools, unless I uncheck one").
     */
    function Builder(props) {
      const {
        catalog, draft, onChange, busy, onCancel, onSave, saveLabel,
        title, onSaveAs, saveAsLabel, nameField, namePlaceholder, clash,
      } = props
      // Both lists start collapsed: the builder opens with a name field and a
      // summary, not with forty checkboxes.
      const [openBuiltins, setOpenBuiltins] = useState(false)
      const [openPlugins, setOpenPlugins] = useState(false)
      const builtins = (catalog.builtins ?? []).filter((toolName) => !OWN_TOOLS.includes(toolName))
      const plugins = catalog.plugins ?? []
      const toggleBuiltin = (toolName) => {
        const set = new Set(draft.builtins)
        if (set.has(toolName)) set.delete(toolName)
        else set.add(toolName)
        onChange({ ...draft, builtins: [...set] })
      }
      const togglePlugin = (id) => {
        const set = new Set(draft.plugins)
        if (set.has(id)) set.delete(id)
        else set.add(id)
        onChange({ ...draft, plugins: [...set] })
      }
      return h('div', null,
        h('div', { style: styles.sectionTitle }, title ?? '新建套装'),
        // Creating binds this field to `name` (the identity the host stores);
        // editing binds it to `title` (the label), because renaming a saved kit
        // changes what it is called, never which kit the store knows it by.
        h('input', {
          style: styles.input,
          placeholder: namePlaceholder ?? '名字，例如 写作 / 调研 / 修 bug',
          value: draft[nameField ?? 'name'] ?? '',
          onChange: (event) => onChange({ ...draft, [nameField ?? 'name']: event.target.value }),
        }),
        // The host rejects a name that a preset or another kit already uses;
        // saying so *here* keeps the user from staring at a save button that
        // silently does nothing.
        typeof clash === 'string' && clash !== ''
          ? h('div', { style: { ...styles.error, marginTop: 4 } }, clash)
          : null,
        h('input', {
          style: { ...styles.input, marginTop: 6 },
          placeholder: `备注（可选，最多 ${NOTE_MAX} 字），例如 用于视频制作`,
          maxLength: NOTE_MAX,
          value: draft.note ?? '',
          onChange: (event) => onChange({ ...draft, note: event.target.value }),
        }),
        h(GroupHead, {
          title: '内置工具',
          count: `${draft.builtins.length}/${builtins.length}`,
          open: openBuiltins,
          onToggle: () => setOpenBuiltins(!openBuiltins),
          tip: 'Harness 自带的工具。默认全选；不想要的单独取消即可。',
        }),
        openBuiltins === true ? h(ToolGrid, {
          tools: builtins,
          selected: draft.builtins,
          onToggle: toggleBuiltin,
          empty: '这台机器还没回报内置工具，先在会话里用一次任意工具即可',
        }) : null,
        h(GroupHead, {
          title: '插件',
          count: `${draft.plugins.length}/${plugins.length}`,
          open: openPlugins,
          onToggle: () => setOpenPlugins(!openPlugins),
          tip: '已启用的下载插件。勾上即把该插件的全部工具放进套装。',
        }),
        openPlugins === true
          ? (plugins.length === 0
            ? h('div', { style: { ...styles.meta, padding: '2px 6px' } }, '没有检测到已启用的插件')
            : plugins.map((plugin) => h('div', {
              key: plugin.id,
              style: { ...styles.row, ...styles.indent },
              onClick: () => togglePlugin(plugin.id),
            },
            h(Toggle, { on: draft.plugins.includes(plugin.id) }),
            h('span', { style: styles.rowTitle }, plugin.title),
            h('span', { style: { flex: 1 } }),
            h('span', { style: styles.meta }, `${plugin.tools.length} 个工具`))))
          : null,
        h('div', { style: styles.actions },
          h('button', { type: 'button', style: styles.ghost, disabled: busy, onClick: onCancel }, '取消'),
          onSaveAs === undefined
            ? null
            : h('button', { type: 'button', style: styles.ghost, disabled: busy, onClick: onSaveAs }, saveAsLabel ?? '另存为新套装'),
          h('button', {
            type: 'button',
            style: { ...styles.primary, ...(typeof clash === 'string' && clash !== '' ? { opacity: 0.5 } : null) },
            disabled: busy || (typeof clash === 'string' && clash !== ''),
            onClick: onSave,
          }, saveLabel ?? '保存')))
    }

    // ---- the new-conversation picker ---------------------------------------
    /**
     * The kit picker a brand-new conversation shows in the hero row.
     *
     * A conversation that has not sent a message usually has no agent yet, so
     * there is nothing to "switch": the pick is stored as this Session's binding
     * and installed the moment the agent appears — before the first request
     * builds a prompt, which makes it the one switch that never re-bills the
     * prompt cache. The row leaves with the hero at the first send.
     *
     * Chips instead of a popover on purpose: the hero area is empty by
     * definition, so an inline row needs no measuring and cannot be clipped the
     * way the header's panel would be.
     */
    function HeroKit(props) {
      const sessionId = props.sessionId
      // `preview` is a test seam for scripts/client-smoke.mjs, same as HeaderMenu.
      const preview = props.preview ?? null
      const [data, setData] = useState(preview?.data ?? null)
      const [busy, setBusy] = useState(false)
      // What the hover sentence says once a pick has landed (or why it failed);
      // the row itself never grows a message line.
      const [picked, setPicked] = useState(false)
      const [failed, setFailed] = useState('')
      // Collapsed by default: the picker answers "which kit will this
      // conversation start with", and the list is what you open to change it.
      const [open, setOpen] = useState(preview?.open === true)
      const [groups, setGroups] = useState(preview?.groups ?? { presets: false, kits: false })
      const box = useRef(null)
      // One visit, one first look: a draft left by an earlier visit is dropped
      // before it is ever shown, so the screen starts where the host's own mode
      // starts — at the default.
      const firstLook = useRef(true)
      const lastSession = useRef(sessionId)
      // `useSession` is a standard prop for session-scoped slots; a host that
      // does not hand it over still only renders this slot in the hero phase.
      const useSession = props.useSession
      const blank = preview?.blank ?? (typeof useSession === 'function'
        ? (useSession((snapshot) => snapshot?.blank) ?? true)
        : true)

      const refresh = useCallback(async () => {
        if (typeof sessionId !== 'string' || sessionId === '') return
        // A different conversation in the same slot is a different visit.
        if (lastSession.current !== sessionId) {
          lastSession.current = sessionId
          firstLook.current = true
        }
        try {
          let next = await load(sessionId)
          // A draft pick left on this welcome screen by a previous visit is not a
          // decision: ask the host to drop it before showing anything, so the
          // user sees the same clean slate the host gives its own mode.
          if (firstLook.current === true && next.draft === true && next.live !== true) {
            next = await request({ action: 'release', sessionId })
          }
          firstLook.current = false
          setData(next)
        } catch {
          // "No agent yet" is a normal answer for this route, not something to
          // paint red above the composer.
        }
      }, [sessionId])

      useEffect(() => {
        refresh()
      }, [refresh])

      // The picker outlives the settings page: the default kit it shows when
      // nothing is bound can change while this visit stays open, and coming back
      // to the composer must not show the kit that was current at mount. Same
      // sources the header menu listens to, plus focus for changes made in
      // another window.
      useEffect(() => {
        const sync = () => { refresh() }
        window.addEventListener(CHANGED_EVENT, sync)
        window.addEventListener('focus', sync)
        return () => {
          window.removeEventListener(CHANGED_EVENT, sync)
          window.removeEventListener('focus', sync)
        }
      }, [refresh])

      // The list floats over the composer instead of pushing it down: a select
      // that resizes the page every time it opens is worse than a covered input.
      useEffect(() => {
        if (!open) return undefined
        const away = (event) => {
          if (box.current !== null && !box.current.contains(event.target)) setOpen(false)
        }
        document.addEventListener('mousedown', away)
        return () => document.removeEventListener('mousedown', away)
      }, [open])

      // The name a pick shows: the kit's title, or the two base names — `@dsh`
      // is this plugin's wire value for 仅内置 and must never surface as text.
      const labelOf = (name) => {
        if (name === '') return '全部'
        if (name === DEFAULT_DSH) return '仅内置'
        const found = [...(data?.kits ?? []), ...(data?.presets ?? [])].find((kit) => kit.name === name)
        return found?.title ?? found?.name ?? name
      }

      const pick = async (name) => {
        if (busy || typeof sessionId !== 'string' || sessionId === '') return
        setBusy(true)
        setFailed('')
        try {
          setData(await request({ action: 'bind', sessionId, name }))
          setOpen(false)
          setPicked(true)
        } catch (error) {
          setFailed(String(error?.message ?? error))
        } finally {
          setBusy(false)
        }
      }

      if (!blank || data === null || typeof sessionId !== 'string' || sessionId === '') return null
      const kits = data.kits ?? []
      const presets = data.presets ?? []
      // `bound` separates "this conversation chose 全部" from "nothing chosen
      // yet": without it, a fresh conversation would claim 全部 even when the
      // default kit is what will actually start it.
      const current = data.bound === true
        ? (typeof data.binding === 'string' ? data.binding : '')
        : (typeof data.defaultKit === 'string' ? data.defaultKit : '')
      const row = (name, label, tip) => h(MenuRow, {
        key: `pick-${name === '' ? 'all' : name}`,
        label,
        tip,
        active: current === name,
        indent: true,
        disabled: busy,
        onClick: () => pick(name),
      })
      const kitRow = (kit) => h(MenuRow, {
        key: `pick-${kit.name}`,
        label: kitLabel(kit),
        active: current === kit.name,
        indent: true,
        disabled: busy,
        onClick: () => pick(kit.name),
      })

      // The sentence lives on hover, not on the row: the composer line is shared
      // with the permission and plan chips, so the control only says what it is
      // plus the current pick.
      const tipText = failed !== ''
        ? failed
        : picked
          ? `这个对话会用「${labelOf(current)}」套装，下一条消息生效`
          : `这个新对话会用「${labelOf(current)}」套装`

      return h('span', { ref: box, style: styles.pickWrap, 'data-loadout': 'kit-pick' },
        h('button', {
          type: 'button',
          style: { ...styles.chip, ...(open ? styles.chipActive : null) },
          'aria-expanded': open ? 'true' : 'false',
          'aria-label': tipText,
          title: tipText,
          onClick: () => setOpen(!open),
        },
        h('span', { style: styles.chipMuted }, '选择对话套装'),
        h('span', { style: styles.chipStrong }, labelOf(current)),
        h('span', { style: styles.caret }, open ? '▾' : '▸')),
        open
          ? h('div', { style: styles.pickPanel },
            row('', '全部', '不裁剪：Harness 自带工具和所有已启用插件的工具都能用。'),
            row(DEFAULT_DSH, '仅内置', '只保留 Harness 自带的工具，下载插件的工具全部隐藏。'),
            h(GroupHead, {
              title: '预设套装',
              count: presets.length,
              open: groups.presets,
              tip: '出厂自带的只读套装，点一下即可套用。',
              onToggle: () => setGroups({ ...groups, presets: !groups.presets }),
            }),
            groups.presets === true ? presets.map(kitRow) : null,
            h(GroupHead, {
              title: '我的套装',
              count: kits.length,
              open: groups.kits,
              tip: '你自己保存的套装，点一下即可套用。',
              onToggle: () => setGroups({ ...groups, kits: !groups.kits }),
            }),
            groups.kits === true ? kits.map(kitRow) : null)
          : null,
      )
    }

    // ---- the header control -------------------------------------------------
    function HeaderMenu(props) {
      const sessionId = props.sessionId
      // `preview` is a test seam for scripts/client-smoke.mjs: it seeds the open
      // state and a state snapshot so the menu can be asserted without a server.
      const preview = props.preview ?? null
      const [open, setOpen] = useState(preview?.open === true)
      const [data, setData] = useState(preview?.data ?? null)
      // Prices live in this browser, so the chip reads them at mount and again
      // whenever the settings page announces a change.
      const [prices, setPrices] = useState(readPrices)
      // Both kit groups start collapsed. The menu is a switcher, not a directory:
      // it has to show which set is on, not enumerate every set every time. A
      // collapsed group still shows the one active row, and clicking the head is
      // how you go browsing.
      const [groups, setGroups] = useState(preview?.groups ?? { kits: false, presets: false, extras: false, applied: false })
      const [builder, setBuilder] = useState(preview?.builder ?? null)
      const [saveAs, setSaveAs] = useState(false)
      const [saveName, setSaveName] = useState('')
      const [saveNote, setSaveNote] = useState('')
      const [busy, setBusy] = useState(false)
      const [message, setMessage] = useState('')
      const [anchor, setAnchor] = useState(null)
      const box = useRef(null)

      // The menu is `position: fixed`, and that is not cosmetic.
      //
      // The chip lives in `conversation.session.header.actions`, whose header row
      // clips its children (`overflow: hidden`): an absolutely positioned panel
      // opened downward from a 28px chip is cut off at the header's bottom edge —
      // the first row ("不限") survives, everything below it vanishes. A fixed
      // element is positioned against the viewport, so the header's clipping no
      // longer applies. The cost is that its coordinates must be measured rather
      // than inherited, and re-measured when the page moves under it.
      const placeMenu = useCallback(() => {
        const element = box.current
        if (element === null || typeof element.getBoundingClientRect !== 'function') return
        const rect = element.getBoundingClientRect()
        const viewportWidth = window.innerWidth
        const viewportHeight = window.innerHeight
        const width = Math.min(370, Math.max(280, viewportWidth - 24))
        const below = viewportHeight - rect.bottom - 12
        const above = rect.top - 12
        const dropDown = below >= 240 || below >= above
        const maxHeight = Math.max(180, Math.min(520, dropDown ? below : above))
        const left = Math.min(Math.max(8, rect.right - width), Math.max(8, viewportWidth - width - 8))
        const top = dropDown ? rect.bottom + 6 : Math.max(8, rect.top - maxHeight - 6)
        setAnchor({ left, top, width, maxHeight })
      }, [])

      const refresh = useCallback(async () => {
        try {
          const next = await load(sessionId)
          setData(next)
          setMessage('')
          return next
        } catch (error) {
          setMessage(String(error.message ?? error))
          return null
        }
      }, [sessionId])

      // The label is this conversation's persisted binding, so read it as soon as
      // the chip mounts: waiting for the first click is what made a bound
      // conversation show 装备栏 until the menu was opened once.
      useEffect(() => {
        refresh()
      }, [refresh])

      // Another surface (the settings page, the /kit command) may have changed
      // this conversation's binding — or the price settings — while the chip sat idle.
      useEffect(() => {
        const sync = () => {
          setPrices(readPrices())
          refresh()
        }
        document.addEventListener('dsh-loadout:changed', sync)
        window.addEventListener('focus', sync)
        return () => {
          document.removeEventListener('dsh-loadout:changed', sync)
          window.removeEventListener('focus', sync)
        }
      }, [refresh])

      useEffect(() => {
        if (!open) return undefined
        const away = (event) => {
          if (box.current !== null && !box.current.contains(event.target)) setOpen(false)
        }
        document.addEventListener('mousedown', away)
        return () => document.removeEventListener('mousedown', away)
      }, [open])

      // Keep the fixed panel glued to the chip while the page scrolls or resizes.
      useEffect(() => {
        if (!open) return undefined
        const follow = () => placeMenu()
        window.addEventListener('scroll', follow, true)
        window.addEventListener('resize', follow)
        return () => {
          window.removeEventListener('scroll', follow, true)
          window.removeEventListener('resize', follow)
        }
      }, [open, placeMenu])

      if (typeof sessionId !== 'string' || sessionId === '') return null

      const catalog = data?.catalog ?? { builtins: [], plugins: [] }
      const plugins = catalog.plugins ?? []
      const kits = data?.kits ?? []
      const presets = data?.presets ?? []
      const selection = data?.selection ?? { base: 'all', kit: null, extras: [] }
      const extras = selection.extras ?? []
      const base = selection.base ?? 'all'
      const label = data?.label ?? ''
      const isAll = base === 'all'
      const isDsh = base === 'dsh'
      const activeUserKit = base === 'kit' ? kits.find((kit) => kit.name === selection.kit) : undefined
      const activePreset = base === 'kit' ? presets.find((kit) => kit.name === selection.kit) : undefined
      const applied = data?.appliedPlugins ?? []
      const available = data?.availableExtras ?? plugins.map((plugin) => plugin.id)
      // Prompt size comes from the host's `contextPressure` projection; it is
      // null until this conversation has sent its first request.
      const contextTokens = Number(data?.context?.tokens) || 0
      const price = switchPrice(contextTokens, prices)
      const priceTip = switchPriceTip(contextTokens, prices)

      /**
       * This menu belongs to one conversation: it may switch that conversation
       * and it may build a new kit, but choosing what *new* conversations start
       * from is a global decision and lives in 设置 → 装备栏 (`defaultKit`).
       */

      /** `默认 · ≈¥0.23`, and nothing at all when the switch is not worth a warning. */
      const rowHint = (parts, active) => parts
        .concat(active || price === '' ? [] : [price])
        .filter((part) => part !== undefined && part !== '')
        .join(' · ')

      const run = async (payload) => {
        setBusy(true)
        try {
          const next = await request({ ...payload, sessionId })
          setData(next)
          setMessage('')
          return next
        } catch (error) {
          setMessage(String(error.message ?? error))
          return null
        } finally {
          setBusy(false)
        }
      }

      const openBuilder = (seed) => {
        setBuilder({
          name: '',
          note: '',
          builtins: seed.builtins,
          plugins: seed.plugins,
        })
        setSaveAs(false)
      }

      const saveBuilder = async () => {
        if (builder === null) return
        const kitName = builder.name.trim()
        if (kitName === '') {
          setMessage('给套装起个名字')
          return
        }
        if (builder.builtins.length === 0 && builder.plugins.length === 0) {
          setMessage('至少选一个内置工具或一个插件')
          return
        }
        setBusy(true)
        try {
          const created = await request({
            action: 'create',
            name: kitName,
            title: kitName,
            note: builder.note ?? '',
            builtins: builder.builtins,
            plugins: builder.plugins,
          })
          setData(created)
          const appliedKit = await run({ action: 'applyBase', base: 'kit', kit: kitName })
          setBuilder(null)
          if (appliedKit !== null) setMessage(`已保存并启用「${kitName}」`)
        } catch (error) {
          setMessage(String(error.message ?? error))
        } finally {
          setBusy(false)
        }
      }

      const saveSelection = async (mode) => {
        const kitName = saveName.trim()
        if (mode === 'new' && kitName === '') {
          setMessage('给套装起个名字')
          return
        }
        const note = saveNote.trim()
        const next = await run(mode === 'overwrite'
          ? { action: 'saveAs', mode: 'overwrite' }
          : { action: 'saveAs', mode: 'new', name: kitName, title: kitName, note })
        if (next !== null) {
          setSaveAs(false)
          setSaveName('')
          setSaveNote('')
          setMessage(mode === 'overwrite' ? '已覆盖当前套装' : `已存为「${kitName}」`)
        }
      }

      const allBuiltins = (catalog.builtins ?? []).filter((toolName) => !OWN_TOOLS.includes(toolName))

      // Editing a preset is never allowed to mutate it: this turns its allow
      // list into the starting point of a brand-new kit instead.
      const forkSeed = (preset) => {
        const allow = new Set(preset.allow ?? [])
        return {
          builtins: (catalog.builtins ?? []).filter((toolName) => allow.has(toolName) && !OWN_TOOLS.includes(toolName)),
          plugins: (catalog.plugins ?? [])
            .filter((plugin) => plugin.tools.length > 0 && plugin.tools.every((toolName) => allow.has(toolName)))
            .map((plugin) => plugin.id),
        }
      }

      const appliedRows = applied
        .map((id) => plugins.find((plugin) => plugin.id === id))
        .filter((plugin) => plugin !== undefined)
      const freePlugins = plugins.filter((plugin) => !applied.includes(plugin.id))
      const extrasRows = freePlugins.map((plugin) => h(MenuRow, {
        key: plugin.id,
        label: plugin.title,
        hint: available.includes(plugin.id) ? '' : '不可用',
        active: extras.includes(plugin.id),
        disabled: !available.includes(plugin.id),
        onClick: () => run({ action: 'toggleExtra', id: plugin.id, on: !extras.includes(plugin.id) }),
      }))
      const appliedBlock = appliedRows.length === 0 ? null : h('div', { key: 'applied' },
        h(GroupHead, {
          title: `已应用 ${appliedRows.length} 个插件`,
          open: groups.applied,
          tip: '这些插件由当前选择整体带上（「全部」或套装本身），不能在这里单独关掉。',
          onToggle: () => setGroups({ ...groups, applied: !groups.applied }),
        }),
        groups.applied === true
          ? h('div', null, ...appliedRows.map((plugin) => h(MenuRow, {
            key: plugin.id,
            label: plugin.title,
            hint: '已在对话中',
            disabled: true,
            indent: true,
          })))
          : null)

      const ledger = data?.ledger
      const saved = ledger?.savedTokens ?? 0
      // The context size is not a warning, it is the denominator of every price
      // below: "why is this 0.23" needs "because this conversation is 200k".
      const contextNote = contextTokens >= PRICE_MIN_TOKENS ? ` · 上下文 ~${formatTokens(contextTokens)}` : ''
      const summary = `当前：${label === '' ? '全部' : label}${extras.length === 0 ? '' : ` · 加挂 ${extras.length}`}${saved > 0 ? ` · 省 ~${formatTokens(saved)} tokens` : ''}${contextNote}`


      const rootBody = h('div', null,
        h('div', { key: 'topline', style: styles.topline },
          h('span', { style: styles.summary, title: summary }, summary),
          h('button', {
            type: 'button',
            style: styles.iconButton,
            title: '刷新：重新读取工具目录，并重新套用当前选择',
            'aria-label': '刷新工具列表',
            disabled: busy,
            onClick: () => { run({ action: 'refresh' }) },
          }, '⟳')),
        h(MenuRow, {
          label: '全部',
          tip: '不裁剪：Harness 自带工具和所有已启用插件的工具都能用。',
          hint: '不限制',
          active: isAll,
          onClick: () => run({ action: 'applyBase', base: 'all' }),
        }),
        h(MenuRow, {
          label: '仅内置',
          tip: '只保留 Harness 自带的工具，下载插件的工具全部隐藏。',
          hint: '隐藏插件',
          active: isDsh,
          onClick: () => run({ action: 'applyBase', base: 'dsh' }),
        }),
        isAll
          ? null
          : h(MenuRow, {
            key: 'reset',
            label: '恢复为全部',
            hint: '取消应用',
            onClick: () => run({ action: 'applyBase', base: 'all' }),
          }),
        h('div', { style: styles.divider }),
        h(GroupHead, {
          title: '我的套装',
          count: kits.length,
          open: groups.kits,
          tip: '你自己保存的套装。点一下即可切换。',
          onToggle: () => setGroups({ ...groups, kits: !groups.kits }),
        }),
        // A collapsed group shows the set that is on, plus the one action that
        // creates a set — so "new kit" never needs a click on the head first.
        activeUserKit === undefined ? null : h(MenuRow, {
          key: 'active-kit',
          label: kitLabel(activeUserKit),
          hint: rowHint([activeUserKit.isDefault ? '默认' : ''], true),
          active: true,
          indent: true,
          onClick: () => run({ action: 'applyBase', base: 'kit', kit: activeUserKit.name }),
        }),
        groups.kits === true
          ? kits
            .filter((kit) => activeUserKit === undefined || kit.name !== activeUserKit.name)
            .map((kit) => h(MenuRow, {
              key: kit.name,
              label: kitLabel(kit),
              hint: rowHint([kit.isDefault ? '默认' : ''], false),
              hintTip: price === '' ? undefined : priceTip,
              indent: true,
              onClick: () => {
                run({ action: 'applyBase', base: 'kit', kit: kit.name })
                // Picking one puts the list away again; the row that stays is the
                // one just chosen, right under the group head.
                setGroups({ ...groups, kits: false })
              },
            }))
          : null,
        // Always last inside 我的套装, open or collapsed: the create action sits
        // where the eye ends up after scanning the kits.
        h(MenuRow, {
          key: 'new-kit',
          label: '＋ 新建套装',
          tone: 'primary',
          hint: '从零配一套',
          indent: true,
          onClick: () => openBuilder({ builtins: allBuiltins, plugins: [] }),
        }),
        SHOW_PRESETS === true
          ? h(GroupHead, {
            title: '预设套装',
            count: presets.length,
            open: groups.presets,
            tip: '出厂自带的只读套装，点一下即可套用。要改请在设置页另存为我的套装。',
            onToggle: () => setGroups({ ...groups, presets: !groups.presets }),
          })
          : null,
        // Same rule as 我的套装: collapsed shows the preset that is on, if any.
        SHOW_PRESETS === true && groups.presets !== true && activePreset !== undefined
          ? h(MenuRow, {
            key: 'active-preset',
            label: activePreset.title,
            hint: '只读',
            active: true,
            indent: true,
            onClick: () => run({ action: 'applyBase', base: 'kit', kit: activePreset.name }),
          })
          : null,
        SHOW_PRESETS === true && groups.presets === true
          ? (presets.length === 0
            ? h('div', { key: 'none', style: { ...styles.meta, padding: '2px 6px' } }, '没有预置套装')
            : presets.map((preset) => h(MenuRow, {
              key: preset.name,
              label: preset.title,
              hint: rowHint(['只读'], activePreset !== undefined && activePreset.name === preset.name),
              hintTip: price === '' ? undefined : priceTip,
              active: activePreset !== undefined && activePreset.name === preset.name,
              indent: true,
              onClick: () => {
                run({ action: 'applyBase', base: 'kit', kit: preset.name })
                setGroups({ ...groups, presets: false })
              },
            })))
          : null,
        appliedBlock,
        h(GroupHead, {
          title: '加挂',
          count: extras.length,
          open: groups.extras,
          tip: '在当前选择之上临时加开插件，不新建套装。已经包含的插件不能再加。',
          onToggle: () => setGroups({ ...groups, extras: !groups.extras }),
          action: extras.length === 0
            ? null
            : h('button', {
              type: 'button',
              style: styles.iconButton,
              title: '存为新套装',
              'aria-label': '存为新套装',
              disabled: busy,
              onClick: (event) => {
                event.stopPropagation()
                setSaveAs(!saveAs)
              },
            }, '💾'),
        }),
        groups.extras === true
          ? h('div', null,
            isAll
              ? h('div', { key: 'all-hint', style: { ...styles.hint, padding: '0 6px' } }, '「全部」已经包含所有插件的工具，不需要加挂。')
              : null,
            plugins.length === 0
              ? h('div', { key: 'empty', style: { ...styles.meta, padding: '2px 6px' } }, '没有检测到已启用的插件')
              : null,
            ...extrasRows,
            saveAs === true
              ? h('div', { key: 'saveAs', style: styles.savePanel },
                h('input', {
                  style: styles.input,
                  placeholder: '新套装的名字',
                  value: saveName,
                  onChange: (event) => setSaveName(event.target.value),
                }),
                h('input', {
                  style: { ...styles.input, marginTop: 6 },
                  placeholder: `备注（可选，最多 ${NOTE_MAX} 字）`,
                  maxLength: NOTE_MAX,
                  value: saveNote,
                  onChange: (event) => setSaveNote(event.target.value),
                }),
                h('div', { style: styles.actions },
                  activeUserKit !== undefined
                    ? h('button', {
                      type: 'button',
                      style: styles.ghost,
                      disabled: busy,
                      onClick: () => saveSelection('overwrite'),
                    }, `覆盖「${activeUserKit.title}」`)
                    : null,
                  h('button', {
                    type: 'button',
                    style: styles.primary,
                    disabled: busy,
                    onClick: () => saveSelection('new'),
                  }, '存为新套装'),
                  h('button', {
                    type: 'button',
                    style: styles.ghost,
                    disabled: busy,
                    onClick: () => {
                      setSaveAs(false)
                      setSaveName('')
                      setSaveNote('')
                    },
                  }, '取消')),
                activePreset !== undefined
                  ? h('div', { style: styles.hint }, '预置套装只读：这里只能另存为我的套装。')
                  : null)
              : null)
          : null,
        h('div', { style: styles.footer }, FOOTER),
        message === '' ? null : h('div', { style: styles.error }, message))

      const body = builder === null
        ? rootBody
        : h(Builder, {
          catalog,
          draft: builder,
          onChange: (next) => { setBuilder(next); setMessage('') },
          busy,
          onCancel: () => setBuilder(null),
          onSave: saveBuilder,
          saveLabel: '保存并启用',
          clash: nameClash(builder.name, presets, kits, null),
        })

      return h('div', { style: styles.wrap, ref: box },
        h('button', {
          type: 'button',
          style: { ...styles.chip, ...(isAll ? null : styles.chipActive) },
          onClick: () => {
            if (!open) placeMenu()
            setOpen(!open)
          },
          'aria-expanded': open ? 'true' : 'false',
          'aria-label': '装备栏',
          title: '装备栏：当前对话用哪一组工具',
        },
        isAll ? null : h('span', { style: styles.dot }),
        // 全部 is the default and needs no badge: the chip only speaks up when the
        // conversation is restricted, so an unrestricted one reads as 「装备栏」.
        h('span', null, isAll ? '装备栏' : (label === '' ? '装备栏' : label)),
        h('span', { style: { opacity: 0.5 } }, '▾')),
        open ? h('div', {
          style: anchor === null ? styles.panel : {
            ...styles.panel,
            position: 'fixed',
            top: anchor.top,
            left: anchor.left,
            right: 'auto',
            width: anchor.width,
            maxHeight: anchor.maxHeight,
          },
        }, body) : null)
    }

    // ---- the settings page --------------------------------------------------
    // 全部 / 仅内置 have no tools of their own, so they are not kits — but in the
    // settings list they sit next to kits, and two actions make sense for them:
    // copy the command that switches a conversation, or make them the default.
    function DefaultCard(props) {
      const { title, description, isDefault, onUse, onDefault } = props
      return h('div', { style: styles.card },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('strong', null, title),
          isDefault ? h('span', { style: { ...styles.meta, color: '#2563eb' } }, '默认') : null,
          h('span', { style: { flex: 1 } }),
          h('button', { type: 'button', style: styles.ghost, onClick: onUse }, '复制切换命令'),
          h('button', { type: 'button', style: styles.ghost, onClick: onDefault }, '设为默认')),
        h('div', { style: { ...styles.meta, marginTop: 4 } }, description))
    }

    function KitCard(props) {
      const { kit, preset, busy, isDefault, onUse, onDefault, onDelete, onNote, onEdit } = props
      const [noteEditing, setNoteEditing] = useState(false)
      const [noteValue, setNoteValue] = useState(kit.note ?? '')
      return h('div', { style: styles.card },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('strong', null, kitLabel(kit)),
          Number.isFinite(kit.tokens)
            ? h('span', { style: styles.meta, title: '按工具定义估算（约 3.5 字符 / token）' }, `≈${formatTokens(kit.tokens)} tokens`)
            : null,
          preset ? h('span', { style: styles.tag }, '预设') : null,
          isDefault ? h('span', { style: { ...styles.meta, color: '#2563eb' } }, '默认') : null,
          h('span', { style: { flex: 1 } }),
          h('button', { type: 'button', style: styles.ghost, disabled: busy, onClick: onUse }, '复制切换命令'),
          h('button', { type: 'button', style: styles.ghost, disabled: busy, onClick: onDefault }, '设为默认'),
          preset
            ? null
            : h('button', { type: 'button', style: styles.ghost, disabled: busy, onClick: () => setNoteEditing(!noteEditing) }, '备注'),
          preset
            ? null
            // 改名 lives inside 编辑: one editor for the name, the note and the tool
            // list beats three overlapping inline forms on one card.
            : h('button', { type: 'button', style: styles.ghost, disabled: busy, onClick: onEdit }, '编辑'),
          preset
            ? null
            : h('button', { type: 'button', style: styles.ghost, disabled: busy, onClick: onDelete }, '删除')),
        kit.description
          ? h('div', { style: { ...styles.meta, marginTop: 4 } }, kit.description)
          : null,
        noteEditing
          ? h('div', { style: { display: 'flex', gap: 6, marginTop: 6 } },
            h('input', {
              style: styles.input,
              maxLength: NOTE_MAX,
              placeholder: `一句备注，例如 用于视频制作（最多 ${NOTE_MAX} 字）`,
              value: noteValue,
              onChange: (event) => setNoteValue(event.target.value),
            }),
            h('button', {
              type: 'button',
              style: styles.primary,
              disabled: busy,
              onClick: () => {
                onNote(noteValue.trim())
                setNoteEditing(false)
              },
            }, '保存'))
          : null)
    }

    function SettingsPanel(props) {
      // Same test seam as the header menu: seed a snapshot without a server.
      const preview = props.preview ?? null
      const [data, setData] = useState(preview?.data ?? null)
      const [busy, setBusy] = useState(false)
      const [message, setMessage] = useState('')
      const [draft, setDraft] = useState(preview?.draft ?? null)
      // Editing a saved kit reuses the same builder as creating one; only the
      // action buttons differ (覆盖保存 keeps the name, 另存为新套装 mints a new one).
      const [editingKit, setEditingKit] = useState(null)
      // 我的套装 starts collapsed, like the chip: the page's job is "which set does
      // a new conversation start with", and a list of five kits does not answer it.
      // The test seam can seed it open so the card assertions never depend on a click.
      const [openSections, setOpenSections] = useState(preview?.openSections ?? { presets: false, kits: false })
      // Prices are a browser-local preference: nothing on the host reads them.
      const [prices, setPrices] = useState(readPrices)

      const refresh = useCallback(async () => {
        try {
          setData(await load())
          setMessage('')
        } catch (error) {
          setMessage(`读不到套装状态：${String(error.message ?? error)}`)
        }
      }, [])

      useEffect(() => { refresh() }, [refresh])

      // The page stays mounted while the user switches tools from the header
      // chip, so "read once on mount" showed the conversation's numbers from
      // whenever it was first opened. Re-read whenever the other panel says it
      // changed, and when the page comes back into focus.
      useEffect(() => {
        const sync = () => { refresh() }
        const onVisible = () => {
          if (typeof document.visibilityState === 'string' && document.visibilityState !== 'visible') return
          refresh()
        }
        document.addEventListener(CHANGED_EVENT, sync)
        document.addEventListener('visibilitychange', onVisible)
        window.addEventListener('focus', sync)
        return () => {
          document.removeEventListener(CHANGED_EVENT, sync)
          document.removeEventListener('visibilitychange', onVisible)
          window.removeEventListener('focus', sync)
        }
      }, [refresh])

      const act = async (payload) => {
        setBusy(true)
        try {
          setData(await request(payload))
          setMessage('')
          return true
        } catch (error) {
          setMessage(String(error.message ?? error))
          return false
        } finally {
          setBusy(false)
        }
      }

      if (data === null) {
        return h('div', { style: { padding: 8, fontSize: 12 } },
          message === '' ? '正在读取套装…' : h('span', { style: styles.error }, message))
      }

      const catalog = data.catalog ?? { builtins: [], plugins: [] }
      const kits = data.kits ?? []
      const presets = data.presets ?? []
      const defaultIsAll = (data.defaultKit ?? '') === ''
      const defaultIsDsh = (data.defaultKit ?? '') === '@dsh'
      const allBuiltins = (catalog.builtins ?? []).filter((toolName) => !OWN_TOOLS.includes(toolName))
      // A collapsed 我的套装 still answers "which kit is the default", the same way
      // the chip does.
      const defaultKitRow = kits.find((kit) => kit.name === data.defaultKit)
      const defaultPresetRow = presets.find((preset) => preset.name === data.defaultKit)

      // Prices only feed the chip's estimate, so they live in this browser
      // rather than in the profile store: nothing on the host reads them, and a
      // wrong number here can never change what a switch does.
      const contextTokens = Number(data.context?.tokens) || 0
      const price = switchPrice(contextTokens, prices)
      const updatePrices = (patch) => {
        const next = { ...prices, ...patch }
        setPrices(next)
        writePrices(next)
        // The chip is a separate tree: tell it, the same way a kit change does.
        announce()
      }
      const priceField = (key, label) => h('label', {
        key,
        style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, opacity: 0.8 },
      },
      h('span', null, label),
      h('input', {
        type: 'number',
        min: 0,
        step: 0.05,
        style: styles.priceInput,
        'aria-label': label,
        value: String(prices[key]),
        onChange: (event) => {
          const parsed = Number(event.target.value)
          updatePrices({ [key]: Number.isFinite(parsed) && parsed >= 0 ? parsed : 0 })
        },
      }))
      const priceSection = h('div', { key: 'pricing', style: styles.section },
        h('div', { style: styles.sectionTitle }, '切换一次大概多贵'),
        h('div', { style: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' } },
          priceField('miss', '未命中 ¥/百万'),
          priceField('hit', '命中 ¥/百万')),
        h('div', { style: styles.hint },
          contextTokens >= PRICE_MIN_TOKENS
            ? `这段对话约 ${formatTokens(contextTokens)} tokens：现在切换一次，约 ${price === '' ? '不到一分钱' : price}。`
            : '这段对话还很短，切换几乎不花钱；上下文过 20k 之后标题栏才会显示估算。',
          ' 价格只用于估算，不影响切换本身。'))

      const saveDraft = async () => {
        if (draft === null) return
        if (draft.name.trim() === '') {
          setMessage('给套装起个名字')
          return
        }
        if (draft.builtins.length === 0 && draft.plugins.length === 0) {
          setMessage('至少选一个内置工具或一个插件')
          return
        }
        const ok = await act({
          action: 'create',
          name: draft.name.trim(),
          title: draft.name.trim(),
          note: draft.note ?? '',
          builtins: draft.builtins,
          plugins: draft.plugins,
        })
        if (ok) {
          setDraft(null)
          setMessage('已保存。到标题栏点它即可切换当前对话。')
        }
      }

      // 编辑一个已保存的套装：同一个 Builder，名字锁定，保存按钮换成"覆盖保存"，另有一个"另存为新套装"。
      const startEdit = (kit) => {
        setDraft({
          name: kit.name,
          title: kit.title,
          note: kit.note ?? '',
          builtins: [...(kit.builtins ?? [])],
          plugins: [...(kit.plugins ?? [])],
        })
        setEditingKit(kit.name)
        setMessage('')
      }

      const saveOverwrite = async () => {
        if (editingKit === null || draft === null) return
        if ((draft.title ?? '').trim() === '') {
          setMessage('给套装起个名字')
          return
        }
        if (draft.builtins.length === 0 && draft.plugins.length === 0) {
          setMessage('至少选一个内置工具或一个插件')
          return
        }
        const ok = await act({
          action: 'update',
          name: editingKit,
          title: draft.title.trim(),
          note: draft.note ?? '',
          builtins: draft.builtins,
          plugins: draft.plugins,
        })
        if (ok) {
          setDraft(null)
          setEditingKit(null)
          setMessage('已覆盖保存；正在用它的对话立即生效。')
        }
      }

      const saveEditingAsNew = async () => {
        if (draft === null) return
        // In the editor the name field edits `title`; a copy gets that title as
        // its identity too, so the new kit reads the same everywhere.
        const wanted = (draft.title ?? draft.name ?? '').trim()
        if (wanted === '' || wanted === editingKit) {
          setMessage('换个新名字再另存')
          return
        }
        const ok = await act({
          action: 'create',
          name: wanted,
          title: wanted,
          note: draft.note ?? '',
          builtins: draft.builtins,
          plugins: draft.plugins,
        })
        if (ok) {
          setDraft(null)
          setEditingKit(null)
          setMessage('已另存为新套装。')
        }
      }

      const copyCommand = async (kitName) => {        const command = `/kit ${kitName}`
        try {
          await navigator.clipboard.writeText(command)
          setMessage(`已复制「${command}」，到对话里发送即可切换当前对话`)
        } catch {
          setMessage(`把这行发到对话里即可切换：${command}`)
        }
      }

      return h('div', { style: { padding: '4px 2px', fontSize: 12 } },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('button', { type: 'button', style: styles.ghost, disabled: busy, onClick: refresh }, '刷新'),
          h('button', {
            type: 'button',
            style: styles.primary,
            disabled: busy,
            onClick: () => {
              setEditingKit(null)
              setDraft({ name: '', note: '', builtins: [...allBuiltins], plugins: [] })
            },
          }, '新建套装')),
        // Creating a kit is a page-level action, so its editor opens at the very
        // top, above the default list — the form you just asked for is the first
        // thing under the button. Editing an existing kit renders under that kit
        // instead (see the kits list), so fields never detach from their card.
        draft === null || editingKit !== null
          ? null
          : h('div', { style: { ...styles.editorCard, marginTop: 10 } },
            h(Builder, {
              catalog,
              draft,
              onChange: setDraft,
              busy,
              onCancel: () => setDraft(null),
              onSave: saveDraft,
              saveLabel: '保存',
              clash: nameClash(draft.name, presets, kits, null),
            })),
        message === '' ? null : h('div', { style: styles.error }, message),
        h('div', { style: styles.ledger },
          data.ledger === undefined
            ? '读不到工具定义，这一页暂时算不出 token 账本。'
            : [
              `最近活跃对话保留 ${data.ledger.visibleTools} 个工具 · 约 ${formatTokens(data.ledger.visibleTokens)} tokens`,
              `「全部」约 ${formatTokens(data.ledger.totalTokens)} tokens`,
              `本套装省约 ${formatTokens(data.ledger.savedTokens)} tokens`,
              '（估算：按工具定义长度 ÷ 3.5 字符/token）',
            ].join('　·　')),
        // This panel has no Session of its own: the host answers a bare GET from
        // the most recently seen agent. Saying so is cheaper than explaining why
        // the numbers "don't change" when the user is only editing a default.
        h('div', { style: { ...styles.meta, marginTop: 4 } },
          '设置页不绑定具体会话，上面的数字来自最近活跃的那个对话；当前对话请在标题栏「装备栏」里切换。'),
        h('div', { style: styles.sectionTitle, marginTop: 14 }, '新对话默认套装'),
        h('div', { style: { ...styles.meta, marginBottom: 6 } },
          '只影响之后新建的对话；已经开着的对话各自保留自己的选择，这里改不到它们。'),
        // 全部 and 仅内置 are choices, not kits, but they read like the kit cards
        // below (copy the switch command / make it the default) so the page has
        // one idiom instead of two.
        h('div', { style: { display: 'grid', gap: 8, marginTop: 6 } },
          h(DefaultCard, {
            title: '全部',
            description: '内置工具和已启用插件的工具都能用。',
            isDefault: defaultIsAll,
            onUse: () => copyCommand('全部'),
            onDefault: () => act({ action: 'default', name: '' }),
          }),
          h(DefaultCard, {
            title: '仅内置',
            description: '只带 Harness 内置的工具，下载插件的工具默认隐藏。',
            isDefault: defaultIsDsh,
            onUse: () => copyCommand('仅内置'),
            onDefault: () => act({ action: 'default', name: '@dsh' }),
          })),
        message === '' ? null : h('div', { style: { ...styles.error, marginTop: 6 } }, message),
        // Presets are held back for now (SHOW_PRESETS): the data still ships and
        // the host still honours `/kit 写作`, but neither the chip nor this page
        // offers them, so a shipped preset cannot silently hide a tool.
        SHOW_PRESETS === true
          ? h(GroupHead, {
            title: '预设套装 · 只读',
            count: presets.length,
            open: openSections.presets,
            tip: '出厂自带的只读套装，只能在对话里套用，不能改。',
            onToggle: () => setOpenSections({ ...openSections, presets: !openSections.presets }),
          })
          : null,
        SHOW_PRESETS === true && openSections.presets === true
          ? (presets.length === 0
            ? h('div', { style: styles.meta }, '没有预置套装')
            : h('div', { style: { display: 'grid', gap: 8, marginTop: 4 } },
              presets.map((preset) => h(KitCard, {
                key: preset.name,
                kit: preset,
                preset: true,
                busy,
                isDefault: data.defaultKit === preset.name,
                onUse: () => copyCommand(preset.name),
                onDefault: () => act({ action: 'default', name: preset.name }),
                onDelete: () => {},
              }))))
          : null,
        SHOW_PRESETS === true && openSections.presets === false
          // Collapsed, exactly like 我的套装: only the preset that is the
          // default stays visible, so the group still answers "new conversations
          // start with this".
          ? (defaultPresetRow === undefined
            ? null
            : h(MenuRow, {
              key: `default-preset-${defaultPresetRow.name}`,
              label: kitLabel(defaultPresetRow),
              hint: '当前默认',
              indent: true,
              active: true,
              onClick: () => act({ action: 'default', name: defaultPresetRow.name }),
            }))
          : null,
        h(GroupHead, {
          title: '我的套装',
          count: kits.length,
          open: openSections.kits,
          tip: '你自己配置的工具套装，内置工具和已启用插件的工具都能随意搭配。',
          onToggle: () => setOpenSections({ ...openSections, kits: !openSections.kits }),
        }),
        openSections.kits === false
          // Collapsed: show only the kit that is the default, exactly like the
          // chip does — the answer to "what does a new conversation start with".
          ? (defaultKitRow === undefined
            ? null
            : h(MenuRow, {
              key: `default-${defaultKitRow.name}`,
              label: kitLabel(defaultKitRow),
              hint: '当前默认',
              indent: true,
              active: true,
              onClick: () => act({ action: 'default', name: defaultKitRow.name }),
            }))
          : (kits.length === 0
            ? h('div', { style: styles.meta }, '还没有套装。上面的按钮可以新建一个。')
            : h('div', { style: { display: 'grid', gap: 8, marginTop: 4 } },
              kits.map((kit) => [
                h(KitCard, {
                  key: kit.name,
                  kit,
                  preset: false,
                  busy,
                  isDefault: data.defaultKit === kit.name,
                  onUse: () => copyCommand(kit.name),
                  onDefault: () => act({ action: 'default', name: kit.name }),
                  onDelete: async () => {
                    // Ask the host how many conversations are pinned to this kit
                    // before asking the user: "3 个对话正在用它" is a decision, and
                    // the count is the only thing that makes the click weighable.
                    let bound = Number(kit.boundCount ?? 0)
                    try {
                      const probe = await request({ action: 'delete', name: kit.name, dryRun: true, sessionId })
                      if (typeof probe?.affectedSessions === 'number') bound = probe.affectedSessions
                    } catch {
                      // The count is a courtesy; a failed probe must not block the delete.
                    }
                    const question = bound > 0
                      ? `删除套装「${kit.name}」？有 ${bound} 个对话正在用它，删除后它们会回到「全部」。`
                      : `删除套装「${kit.name}」？没有对话在用它。`
                    if (!window.confirm(question)) return
                    await act({ action: 'delete', name: kit.name })
                  },
                  onNote: (note) => act({ action: 'update', name: kit.name, note }),
                  onEdit: () => startEdit(kit),
                }),
                // The editor belongs to the card that opened it: same list, right
                // under the kit, so "which kit am I changing" needs no memory.
                editingKit === kit.name && draft !== null
                  ? h('div', { key: `${kit.name}-editor`, style: { ...styles.editorCard, marginTop: -4 } },
                    h(Builder, {
                      catalog,
                      draft,
                      onChange: setDraft,
                      busy,
                      title: '编辑套装',
                      nameField: 'title',
                      namePlaceholder: '套装名字',
                      onCancel: () => {
                        setDraft(null)
                        setEditingKit(null)
                      },
                      onSave: saveOverwrite,
                      saveLabel: '覆盖保存',
                      clash: nameClash(draft.title, presets, kits, editingKit),
                      onSaveAs: saveEditingAsNew,
                      saveAsLabel: '另存为新套装',
                    }))
                  : null,
              ]))),
        priceSection,
        h('div', { style: styles.footer }, `存储：${data.source ?? '(未知)'}　新对话默认：${
          data.defaultKit === '' ? '(未设置)' : data.defaultKit === '@dsh' ? '仅内置' : data.defaultKit}`),
        h('div', { style: { ...styles.hint, marginTop: 4, lineHeight: 1.6 } },
          '边界：本插件只控制「对话看得到哪些工具」。已启用的插件仍在后台运行；界面插件（侧边栏、主题等）不受影响。'))
    }

    /**
     * Register one surface, but never fail activation over it.
     *
     * A slot this plugin targets can disappear when the client UI is refactored;
     * an exception thrown out of `apply` leaves the Loader entry inactive, and the
     * Web boot audit treats any inactive entry as a fatal boot failure — the whole
     * app refuses to start because one optional chip went missing. Losing a chip
     * must cost the chip, not the application.
     */
    function registerSurface(ctx, slot, component) {
      try {
        ctx.slots.inject(slot.name, () => ctx.slots.register(
          {
            name: slot.name,
            id: 'dsh-loadout',
            order: slot.order,
            ...slot.extra,
          },
          component,
        ))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const line = `dsh-loadout: 界面插槽 ${slot.name} 不可用（${message}），该入口已跳过`
        if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(line)
        else if (typeof console !== 'undefined') console.warn(line)
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // The header chip: the everyday control, one click from the conversation.
        //
        // Placement is the slot, not the order. In `header.utilities` the chip sits
        // in a run of small icon buttons (open-in-app -10, schedule-catalog -5,
        // session-log-download 0, the sidebar's toggles 10/20) and the far-right
        // cell is the shipped `header.corner` occupant, so no order makes the chip
        // look like it owns an edge — it always reads as a label squeezed between
        // two icons. `header.actions` is the title-adjacent row instead: -100 puts
        // the chip immediately after the title, before the shipped action buttons
        // (agent-preset -10, subagent-catalog 10, job-list 20), which is one clear
        // side of the header rather than a gap in the middle of it.
        registerSurface(ctx, {
          name: 'conversation.session.header.actions',
          order: -100,
          extra: { inject: (sessionId) => ({ sessionId }) },
        }, HeaderMenu)
        // The new-conversation picker: the one moment where switching is free,
        // because the agent — and its first request — does not exist yet. It sits
        // at the front of the composer's right-hand tool group, i.e. immediately
        // to the right of the 标准模式 selector, and that row is mounted in both
        // phases — so the component gates itself on `blank`.
        registerSurface(ctx, {
          name: 'conversation.input.right',
          order: -10,
          // Session-scoped slots get their Session id through `inject`; without
          // it the picker could neither read this conversation's binding nor
          // write one.
          extra: { inject: (sessionId) => ({ sessionId }) },
        }, HeroKit)
        // The settings page: the full editor and the place kits are stored from.
        registerSurface(ctx, {
          name: 'settings.section',
          order: 40,
          extra: { label: () => '装备栏', inject: () => ({}) },
        }, SettingsPanel)
      },
    }
  },
})
