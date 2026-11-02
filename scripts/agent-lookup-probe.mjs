/**
 * Is there a host service that maps a session id to its live agent?
 */
import { readFileSync, readdirSync } from 'node:fs'

const BASE = 'C:/Users/JungleYXu/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai'
const packages = readdirSync(BASE)
const pattern = /agentFor|bySession|sessionAgent|agentOf|resolveAgent/g

for (const name of packages) {
  if (!name.startsWith('dsh-')) continue
  let text
  try {
    text = readFileSync(`${BASE}/${name}/lib/index.js`, 'utf8')
  } catch {
    continue
  }
  const hits = [...new Set([...text.matchAll(pattern)].map((m) => m[0]))]
  if (hits.length === 0) continue
  const index = text.search(pattern)
  console.log(`\n### ${name} :: ${hits.join(', ')}`)
  console.log(text.slice(Math.max(0, index - 200), index + 260).replace(/\s+/g, ' '))
}

