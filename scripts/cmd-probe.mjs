/**
 * What can a client plugin do with the command system, and how is a session id
 * exposed to a session-scoped slot?
 */
import { readFileSync } from 'node:fs'

const BASE = 'C:/Users/JungleYXu/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai'

function show(rel, pattern, width = 260, limit = 6) {
  let text
  try {
    text = readFileSync(`${BASE}/${rel}`, 'utf8')
  } catch (error) {
    console.log(`skip ${rel}: ${error.code}`)
    return
  }
  console.log(`\n##### ${rel}`)
  let index = text.search(pattern)
  let shown = 0
  while (index !== -1 && shown < limit) {
    console.log('...' + text.slice(Math.max(0, index - 80), index + width).replace(/\s+/g, ' '))
    index = text.slice(index + 1).search(pattern)
    if (index !== -1) index += 1
    shown += 1
  }
}

show('dsh-client-ui-commands/lib/client.js', /submitCommand|runCommand|executeCommand/)
show('dsh-client-commands/lib/index.js', /^\s*(run|execute|dispatch|submit)\(|exports\.(run|execute|dispatch|submit)/, 200, 8)
show('dsh-client-ui-conversation/lib/client.js', /inject: \(sessionId\) =>/, 700, 2)
