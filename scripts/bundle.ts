// Copies some built extensions, with an index.json of just those, into the
// app's assets so they ship installed:
//   bun scripts/bundle.ts ../bacakomik-app-flutter/assets/extensions bacakomik voratoon
// Run `bun run build` first. Replaces everything in the target folder.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIST = fileURLToPath(new URL('../dist/', import.meta.url))
const [dir, ...ids] = process.argv.slice(2)
const target = dir && resolve(dir)
if (!target || ids.length === 0) {
  console.error('usage: bun scripts/bundle.ts <assets dir> <id> [id...]')
  process.exit(1)
}

const index = JSON.parse(readFileSync(join(DIST, 'index.json'), 'utf8'))
const picked = ids.map((id) => {
  const e = index.extensions.find((x: { id: string }) => x.id === id)
  if (!e) throw new Error(`${id} is not in dist/index.json`)
  return e
})

rmSync(target, { recursive: true, force: true })
for (const e of picked) {
  mkdirSync(join(target, dirname(e.file)), { recursive: true })
  copyFileSync(join(DIST, e.file), join(target, e.file))
  console.log(`${target}/${e.file}`)
}
writeFileSync(join(target, 'index.json'), JSON.stringify({ ...index, extensions: picked }, null, 2) + '\n')
console.log(`${target}/index.json  ${picked.length} extension(s)`)
