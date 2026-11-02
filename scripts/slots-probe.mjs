/**
 * Find real slot names in the shipped client bundles.
 * Electron's fs is asar-aware, so archive-internal paths start with '/'.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'

const ROOT = '/dsh/node_modules/@deepseek-ai'
const found = new Map()

function safeReaddir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: false })
  } catch {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  }
}

const packages = safeReaddir(ROOT).filter((name) => name.startsWith('dsh-client-ui') || name.startsWith('dsh-client-'))
console.log(`packages: ${packages.length}`)

const pattern = /["']((?:shell|conversation|settings|sidebar|composer|workspace|agent|home|chat|message|session)\.[a-zA-Z.]+)["']/g

function scan(dir, depth) {
  if (depth > 3) return
  for (const entry of safeReaddir(dir)) {
    const full = `${dir}/${entry}`
    let isDir = false
    try {
      isDir = statSync(full).isDirectory()
    } catch {
      continue
    }
    if (isDir) {
      if (entry === 'node_modules') continue
      scan(full, depth + 1)
      continue
    }
    if (!entry.endsWith('.js')) continue
    let text
    try {
      text = readFileSync(full, 'utf8')
    } catch {
      continue
    }
    for (const match of text.matchAll(pattern)) {
      const slot = match[1]
      if (slot.split('.').length < 2) continue
      found.set(slot, (found.get(slot) ?? 0) + 1)
    }
  }
}

for (const name of packages) scan(`${ROOT}/${name}`, 0)

for (const [slot, count] of [...found.entries()].sort()) console.log(`${slot}\t${count}`)
