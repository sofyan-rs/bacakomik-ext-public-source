// Validates src/*/meta.json + index.js and writes dist/extensions/<id>.v<version>.js,
// dist/icon/<id>.png (from the optional src/<id>/icon.png) and dist/index.json
// (whose `file` and `icon` fields are relative to it).
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { getQuickJS } from 'quickjs-emscripten'
import { loadExtension } from './run.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = ROOT + 'src/'
const DIST = ROOT + 'dist/'
const REPO_NAME = 'BacaKomik Extensions Public'
/** Folder of the scripts inside dist/. */
const SCRIPTS = 'extensions'
/** Folder of the icons inside dist/. */
const ICONS = 'icon'
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// The app's QuickJS (flutter_js on Android) is older than Node's parser and
// rejects some valid code, e.g. a line starting with `await` right after an
// arrow function ("expecting ';'"). quickjs-emscripten 0.10.0, pinned, has a
// QuickJS of that age; every script must parse in it too.
const oldQuickJS = await getQuickJS()

const META_KEYS = ['id', 'name', 'lang', 'version', 'apiVersion', 'baseUrl', 'nsfw']

function validateMeta(dir: string, meta: any) {
  const fail = (msg: string) => {
    throw new Error(`src/${dir}/meta.json: ${msg}`)
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) fail('must be an object')
  for (const k of Object.keys(meta)) if (![...META_KEYS, 'languages', 'urlPatterns', 'credits'].includes(k)) fail(`unknown key "${k}"`)
  for (const k of META_KEYS) if (!(k in meta)) fail(`missing "${k}"`)
  if (meta.id !== dir) fail(`id "${meta.id}" must match folder name "${dir}"`)
  if (!/^[a-z0-9][a-z0-9-]*$/.test(meta.id)) fail('id must be lowercase [a-z0-9-]')
  if (typeof meta.name !== 'string' || !meta.name.trim()) fail('name must be a non-empty string')
  if ('languages' in meta) {
    const ok = Array.isArray(meta.languages) && meta.languages.length > 0 &&
      meta.languages.every((l: unknown) => typeof l === 'string' && /^[a-z]{2}(-[a-z]{2})?$/.test(l)) &&
      new Set(meta.languages).size === meta.languages.length
    if (!ok) fail('languages must be unique codes like "en" or "pt-br"')
    if (meta.lang !== 'all') fail('lang must be "all" when languages is set')
  } else if (typeof meta.lang !== 'string' || !/^[a-z]{2}$/.test(meta.lang)) {
    fail('lang must be ISO 639-1 (e.g. "id")')
  }
  if (typeof meta.version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(meta.version)) fail('version must be "major.minor.patch" (e.g. "1.0.0")')
  if (meta.apiVersion !== 1) fail('apiVersion must be 1')
  if (typeof meta.baseUrl !== 'string' || !/^https:\/\/[^/\s]+/.test(meta.baseUrl)) fail('baseUrl must be an https URL')
  if (typeof meta.nsfw !== 'boolean') fail('nsfw must be a boolean')
  if ('urlPatterns' in meta) {
    if (!Array.isArray(meta.urlPatterns) || meta.urlPatterns.length === 0) fail('urlPatterns must be a non-empty array')
    for (const p of meta.urlPatterns) {
      let re: RegExp
      try {
        re = new RegExp(p)
      } catch (e: any) {
        fail(`urlPatterns: ${e?.message}`)
      }
      // One capture group: the slug.
      if (new RegExp(`${re!.source}|`).exec('')!.length !== 2) fail(`urlPatterns: "${p}" needs exactly one capture group`)
    }
  }
  if ('credits' in meta) {
    // Folders in keiyoushi/extensions-source, listed in the README's Credits table.
    const ok = Array.isArray(meta.credits) && meta.credits.length > 0 &&
      meta.credits.every((c: unknown) => typeof c === 'string' && /^(src|lib-multisrc)(\/[a-z0-9_-]+)+$/.test(c))
    if (!ok) fail('credits must be keiyoushi folders like "src/en/comix"')
  }
}

function validateCode(id: string, code: string) {
  // Parse as a classic script: import/export or syntax errors throw here.
  try {
    new vm.Script(code, { filename: `src/${id}/index.js` })
  } catch (e: any) {
    throw new Error(`src/${id}/index.js: ${e?.message}`)
  }
  // Compiled inside a function that never runs: parsing only.
  const context = oldQuickJS.createVm()
  try {
    const result = context.evalCode(`(function () {
${code}
})`, `src/${id}/index.js`)
    if (result.error) {
      const error = context.dump(result.error)
      result.error.dispose()
      // Line numbers are off by one: the wrapper adds a line.
      throw new Error(`src/${id}/index.js: the app's QuickJS can't parse it: ${error?.message} (${String(error?.stack || '').trim()}, minus 1)`)
    }
    result.value.dispose()
  } finally {
    context.dispose()
  }
  // Evaluate offline to verify defineExtension(), the method set and home's shape.
  // filters() may fetch, so its groups are only checked by `run.ts smoke`.
  loadExtension(id, code, { offline: true })
}

const ids = readdirSync(SRC, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()

const extensions = []
for (const id of ids) {
  const metaPath = `${SRC}${id}/meta.json`
  const codePath = `${SRC}${id}/index.js`
  if (!existsSync(metaPath) || !existsSync(codePath)) throw new Error(`src/${id}: needs meta.json and index.js`)
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  validateMeta(id, meta)
  const bytes = readFileSync(codePath)
  validateCode(id, bytes.toString('utf8'))
  const file = `${SCRIPTS}/${id}.v${meta.version}.js`
  // Optional; without one the app shows the name's first letter.
  const iconPath = `${SRC}${id}/icon.png`
  let icon: { file: string; bytes: Buffer } | undefined
  if (existsSync(iconPath)) {
    const iconBytes = readFileSync(iconPath)
    if (!iconBytes.subarray(0, 8).equals(PNG_MAGIC)) throw new Error(`src/${id}/icon.png: not a PNG`)
    icon = { file: `${ICONS}/${id}.png`, bytes: iconBytes }
  }
  extensions.push({ meta, file, bytes, icon })
}

// Anything but index.json, the current scripts and the icons is stale.
mkdirSync(DIST + SCRIPTS, { recursive: true })
mkdirSync(DIST + ICONS, { recursive: true })
const keep = new Set([
  'index.json', SCRIPTS, ICONS,
  ...extensions.map((e) => e.file),
  ...extensions.flatMap((e) => (e.icon ? [e.icon.file] : [])),
])
for (const dir of ['', SCRIPTS + '/', ICONS + '/']) {
  for (const f of readdirSync(DIST + dir)) {
    if (!keep.has(dir + f)) {
      rmSync(DIST + dir + f, { recursive: true })
      console.log(`removed dist/${dir}${f}`)
    }
  }
}

const index = {
  name: REPO_NAME,
  // credits only feed the README, not the app.
  extensions: extensions.map(({ meta: { credits, ...meta }, file, bytes, icon }) => {
    writeFileSync(DIST + file, bytes)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    console.log(`dist/${file}  ${sha256.slice(0, 12)}  ${bytes.length} B`)
    if (!icon) return { ...meta, file, sha256 }
    writeFileSync(DIST + icon.file, icon.bytes)
    console.log(`dist/${icon.file}  ${icon.bytes.length} B`)
    return { ...meta, file, sha256, icon: icon.file }
  }),
}
writeFileSync(DIST + 'index.json', JSON.stringify(index, null, 2) + '\n')
console.log(`dist/index.json  ${extensions.length} extension(s)`)
