/**
 * How does host code get a session id from an agent object?
 */
import { readFileSync } from 'node:fs'

const BASE = 'C:/Users/JungleYXu/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai'
const files = [
  'dsh-tools/lib/index.js',
  'dsh-agent/lib/index.js',
  'dsh-session/lib/index.js',
  'dsh-subagent/lib/index.js',
]

for (const rel of files) {
  let text
  try {
    text = readFileSync(`${BASE}/${rel}`, 'utf8')
  } catch (error) {
    console.log(`skip ${rel}: ${error.code}`)
    continue
  }
  const hits = [...text.matchAll(/agent\.session[A-Za-z]*/g)].map((m) => m[0])
  const unique = [...new Set(hits)]
  console.log(`${rel} -> ${unique.join(', ') || '(none)'}`)
}
