/**
 * Offline probe: does the package-name heuristic actually recover the plugins
 * that own the host-registered tools? Prints the derived index and the mapping
 * for a list of real tool names, so the heuristic can be checked before the app
 * is restarted.
 *
 *   ELECTRON_RUN_AS_NODE=1 "DeepSeek Harness.exe" scripts/attribution-probe.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BUILTIN_PREFIXES = new Set([
  'todo', 'web', 'kit', 'agent', 'work', 'read', 'write', 'edit', 'glob', 'grep',
  'ask', 'present', 'skill', 'workflow', 'subagent', 'send', 'list', 'interrupt',
  'job', 'schedule', 'create', 'get', 'update', 'exit', 'compress', 'decompress',
  'search', 'load', 'working',
])

const NAME_NOISE = new Set([
  'core', 'tools', 'tool', 'client', 'server', 'shared', 'common', 'plugin', 'plugins',
  'dsh', 'ui', 'web', 'harness', 'extension', 'preset', 'settings', 'sidebar', 'runtime',
])

const SELF = 'dsh-loadout'

const REAL_GLOBAL_TOOLS = [
  'kit_list', 'kit_apply', 'kit_create', 'kit_set_tools', 'kit_set_default', 'kit_delete',
  'modlens_read_image',
  'weknora_list_knowledge_bases', 'weknora_search', 'weknora_read_document', 'weknora_ask',
  'hindsight_sync_status', 'hindsight_diagnose', 'hindsight_search_knowledge_pages',
  'hindsight_list_knowledge_pages', 'hindsight_read_knowledge_page', 'hindsight_reflect',
  'hindsight_capture_initiative', 'hindsight_ingest_document',
  'working_directory',
  'vision_describe', 'vision_bootstrap', 'vision_materialize', 'vision_ground', 'vision_detect',
  'vision_crop', 'vision_present', 'vision_pixel_diff', 'vision_colors', 'vision_ocr',
  'vision_long_screenshot_ocr', 'vision_trace', 'vision_extract_foreground', 'vision_html_screenshot',
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  'compress', 'decompress', 'search_context',
  'acp_status', 'acp_cache', 'acp_read_original_image',
  'load_workspace_dependencies',
]

function profilePackages() {
  const root = join(homedir(), '.dsh', 'profiles')
  const names = new Set()
  for (const entry of readdirSync(root)) {
    const file = join(root, entry, 'package.json')
    if (!existsSync(file)) continue
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    for (const name of Object.keys(parsed.dependencies ?? {})) names.add(name)
    for (const bundle of parsed?.dsh?.profile?.bundles ?? []) if (typeof bundle === 'string') names.add(bundle)
  }
  return [...names]
}

function buildIndex(packages) {
  const index = new Map()
  for (const packageName of packages) {
    const base = packageName.replace(/^@[^/]+\//, '')
    if (base === SELF) continue
    const stripped = base.replace(/^dsh-/, '').replace(/^plugin-/, '')
    const tokens = [stripped, ...stripped.split('-')]
      .map((token) => token.toLowerCase())
      .filter((token) => token.length >= 3 && !NAME_NOISE.has(token) && !BUILTIN_PREFIXES.has(token))
    for (const token of tokens) if (!index.has(token)) index.set(token, { id: token, title: stripped, packageName: base })
  }
  return index
}

const packages = profilePackages()
const index = buildIndex(packages)
console.log(`profile packages: ${packages.length}`)
console.log(`tokens: ${[...index.keys()].sort().join(', ')}`)
console.log('')
const grouped = new Map()
const orphan = []
for (const toolName of REAL_GLOBAL_TOOLS) {
  const cut = toolName.indexOf('_')
  const prefix = cut > 0 ? toolName.slice(0, cut).toLowerCase() : ''
  const owner = prefix === '' || BUILTIN_PREFIXES.has(prefix) ? undefined : index.get(prefix)
  if (owner === undefined) { orphan.push(toolName); continue }
  if (!grouped.has(owner.title)) grouped.set(owner.title, [])
  grouped.get(owner.title).push(toolName)
}
for (const [title, tools] of [...grouped.entries()].sort()) {
  console.log(`${title}  (${tools.length})`)
  console.log(`   ${tools.join(', ')}`)
}
console.log('')
console.log(`built-in / unattributed (${orphan.length}): ${orphan.join(', ')}`)
