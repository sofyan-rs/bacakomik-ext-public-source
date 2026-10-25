// Rewrites the Credits table in README.md from the `credits` field of every
// src/*/meta.json. Run by the Credits workflow after a merge to main.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const README = ROOT + 'README.md'
const START = '<!-- credits:start -->'
const END = '<!-- credits:end -->'
const UPSTREAM = 'https://github.com/keiyoushi/extensions-source/tree/main/'

const rows = readdirSync(ROOT + 'src', { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(`${ROOT}src/${d.name}/meta.json`))
  .map((d) => d.name)
  .sort()
  .flatMap((id) => {
    const { credits } = JSON.parse(readFileSync(`${ROOT}src/${id}/meta.json`, 'utf8'))
    if (!credits) return []
    const links = credits.map((c: string) => `[\`${c}\`](${UPSTREAM}${c})`).join(', ')
    return [`| \`${id}\` | ${links} |`]
  })

const table = ['| Extension | Reimplemented from |', '|---|---|', ...rows].join('\n')
const readme = readFileSync(README, 'utf8')
const start = readme.indexOf(START)
const end = readme.indexOf(END)
if (start < 0 || end < start) throw new Error(`README.md: needs ${START} and ${END}`)
const next = readme.slice(0, start + START.length) + '\n' + table + '\n' + readme.slice(end)
if (next !== readme) writeFileSync(README, next)
console.log(`README.md  ${rows.length} credit(s)${next === readme ? ', unchanged' : ''}`)
