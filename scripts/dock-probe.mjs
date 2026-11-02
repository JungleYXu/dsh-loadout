/**
 * Look at how the shipped bundles use the composer-area slots, so the kit bar
 * can plug into a real surface with real props.
 */
import { readFileSync, readdirSync } from 'node:fs'

const BASE = 'C:/Users/JungleYXu/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai'

function files(pkg) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > 3) return
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (name === 'node_modules') continue
      const full = `${dir}/${name}`
      if (name.endsWith('.js') || name.endsWith('.d.ts')) out.push(full)
      else if (!name.includes('.')) walk(full, depth + 1)
    }
  }
  walk(`${BASE}/${pkg}`, 0)
  return out
}

const targets = ['composer.dock', 'conversation.composer', 'session.header.utilities', 'shell.overlay']
const pkgs = readdirSync(BASE).filter((n) => n.startsWith('dsh-client-ui'))

for (const pkg of pkgs) {
  for (const file of files(pkg)) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const target of targets) {
      let index = text.indexOf(target)
      let shown = 0
      while (index !== -1 && shown < 2) {
        const start = Math.max(0, index - 320)
        console.log(`\n=== ${pkg}/${file.split('/').slice(-2).join('/')} :: ${target}`)
        console.log(text.slice(start, index + 320).replace(/\s+/g, ' '))
        index = text.indexOf(target, index + 1)
        shown += 1
      }
    }
  }
}
