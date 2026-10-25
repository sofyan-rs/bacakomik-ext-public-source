// Local runner: executes an extension in a bare vm context with only the host
// globals, mirroring the app's QuickJS bridge.
//   bun scripts/run.ts <id> <method> [args...]
//   bun scripts/run.ts <id> smoke
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { parse } from 'node-html-parser'

export const DEFAULT_UA =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const METHODS = ['browse', 'series', 'chapters', 'chapter'] as const

type Req = { url: string; method?: string; headers?: Record<string, string>; body?: string | null }

// host -> name -> value. Path/expiry are ignored except deletion; runs are short-lived.
function cookieJar() {
  const jar = new Map<string, Map<string, string>>()
  return {
    header(url: URL) {
      const c = jar.get(url.hostname)
      return c && c.size ? [...c].map(([k, v]) => `${k}=${v}`).join('; ') : null
    },
    store(url: URL, setCookies: string[]) {
      for (const sc of setCookies) {
        const [pair, ...attrs] = sc.split(';')
        const eq = pair.indexOf('=')
        if (eq < 1) continue
        const name = pair.slice(0, eq).trim()
        const value = pair.slice(eq + 1).trim()
        const domain = attrs.find((a) => /^\s*domain=/i.test(a))?.split('=')[1]?.trim().replace(/^\./, '')
        const host = domain || url.hostname
        const expired =
          attrs.some((a) => /^\s*max-age=\s*(0|-\d+)\s*$/i.test(a)) ||
          attrs.some((a) => /^\s*expires=/i.test(a) && Date.parse(a.split('=')[1]) < Date.now())
        const c = jar.get(host) ?? new Map()
        jar.set(host, c)
        expired ? c.delete(name) : c.set(name, value)
      }
    },
  }
}

function makeHttp(verbose: boolean) {
  const jar = cookieJar()
  return {
    async fetch(req: Req) {
      if (!req || typeof req.url !== 'string') throw new Error('http.fetch: url is required')
      let url = new URL(req.url)
      let method = (req.method || 'GET').toUpperCase()
      let body = req.body ?? null
      // Follow redirects by hand so Set-Cookie on intermediate hops is kept.
      for (let hop = 0; hop < 10; hop++) {
        const headers: Record<string, string> = { 'User-Agent': DEFAULT_UA }
        const cookie = jar.header(url)
        if (cookie) headers.Cookie = cookie
        Object.assign(headers, req.headers ?? {})
        if (verbose) console.error(`> ${method} ${url}`)
        const res = await fetch(url, { method, headers, body, redirect: 'manual' })
        jar.store(url, res.headers.getSetCookie())
        const loc = res.headers.get('location')
        if (res.status >= 300 && res.status < 400 && loc) {
          url = new URL(loc, url)
          if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
            method = 'GET'
            body = null
          }
          continue
        }
        const out: Record<string, string> = {}
        res.headers.forEach((v, k) => {
          k = k.toLowerCase()
          out[k] = out[k] ? `${out[k]}, ${v}` : v
        })
        if (verbose) console.error(`< ${res.status} ${url}`)
        return { status: res.status, url: url.toString(), headers: out, body: await res.text() }
      }
      throw new Error(`http.fetch: too many redirects: ${req.url}`)
    },
  }
}

const htmlBridge = {
  async select(source: string, selector: string) {
    return parse(String(source))
      .querySelectorAll(selector)
      .map((el) => ({ text: el.text, html: el.innerHTML, outerHtml: el.outerHTML, attrs: { ...el.attributes } }))
  },
}

function qs(params: Record<string, unknown>) {
  const parts: string[] = []
  for (const [k, v] of Object.entries(params ?? {})) {
    for (const x of Array.isArray(v) ? v : [v]) {
      if (x === null || x === undefined || x === '') continue
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(x))}`)
    }
  }
  return parts.join('&')
}

// Loads src/<id>/index.js in a fresh context. Globals QuickJS lacks are shadowed.
export function loadExtension(
  id: string,
  code: string,
  opts: { verbose?: boolean; offline?: boolean; source?: { id: string; lang: string } } = {},
) {
  const store = new Map<string, string>()
  let ext: any = null
  let calls = 0
  const sandbox: Record<string, unknown> = {
    defineExtension(obj: unknown) {
      calls++
      ext = obj
    },
    http: opts.offline
      ? { fetch: async () => { throw new Error('offline') } }
      : makeHttp(!!opts.verbose),
    html: htmlBridge,
    storage: {
      async get(k: string) {
        return store.get(String(k)) ?? null
      },
      async set(k: string, v: string) {
        if (typeof v !== 'string') throw new Error('storage.set: value must be a string')
        store.set(String(k), v)
      },
    },
    log: (...args: unknown[]) => console.error(`[${id}]`, ...args),
    qs,
    // No WebView here: run the script in Bun with fetch resolved against the
    // page's origin. Enough for scripts that only fetch; DOM access fails.
    webview: {
      async run(url: string, script: unknown, ...args: unknown[]) {
        const origin = new URL(url).origin
        const pageFetch = (input: string, init: RequestInit = {}) =>
          fetch(new URL(input, origin), { ...init, headers: { 'User-Agent': DEFAULT_UA, ...(init.headers as any) } })
        const body = typeof script === 'function' ? `return await (${String(script)})(...args)` : String(script)
        // Scripts reach the page's fetch as fetch or globalThis.fetch.
        const page = { fetch: pageFetch }
        const fn = new Function('fetch', 'globalThis', 'args', `return (async () => { ${body} })()`)
        return JSON.parse(JSON.stringify(await fn(pageFetch, page, args)))
      },
    },
    // The app runs one engine per language of a multi-language extension.
    source: opts.source ?? { id, lang: 'all' },
    Intl: undefined,
    WebAssembly: undefined,
  }
  vm.runInNewContext(code, sandbox, { filename: `${id}/index.js` })
  if (calls !== 1) throw new Error(`${id}: defineExtension must be called exactly once (got ${calls})`)
  for (const m of METHODS) {
    if (typeof ext?.[m] !== 'function') throw new Error(`${id}: missing method ${m}()`)
  }
  if (ext.filters !== undefined && typeof ext.filters !== 'function') throw new Error(`${id}: filters must be an async function`)
  for (const k of ['featured', 'latest']) {
    const v = ext.home?.[k]
    const ok = v && typeof v === 'object' && Object.values(v).every((x) => Array.isArray(x) && x.every((y) => typeof y === 'string'))
    if (!ok) throw new Error(`${id}: home.${k} must be Record<string, string[]>`)
  }
  return ext
}

// --- contract checks ---

const isStr = (v: unknown) => typeof v === 'string'
const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
const orNull = (f: (v: unknown) => boolean) => (v: unknown) => v === null || f(v)

function check(where: string, obj: any, shape: Record<string, (v: unknown) => boolean>) {
  if (!obj || typeof obj !== 'object') throw new Error(`${where}: expected object, got ${JSON.stringify(obj)}`)
  for (const [k, ok] of Object.entries(shape)) {
    if (!(k in obj)) throw new Error(`${where}: missing field "${k}"`)
    if (!ok(obj[k])) throw new Error(`${where}: bad "${k}": ${JSON.stringify(obj[k])}`)
  }
}

const lowerOrNull = orNull((v) => isStr(v) && v === (v as string).toLowerCase())
const SERIES = {
  slug: (v: unknown) => isStr(v) && v !== '',
  title: isStr,
  cover: orNull(isStr),
  format: lowerOrNull,
  status: lowerOrNull,
  rating: orNull(isNum),
  totalChapters: orNull(isNum),
}
const GENRE = { id: isStr, name: isStr }
const DETAIL = {
  ...SERIES,
  nativeTitle: orNull(isStr),
  releaseDate: orNull(isStr),
  author: orNull(isStr),
  synopsis: orNull(isStr),
  genres: Array.isArray,
}

function arr(where: string, v: unknown): any[] {
  if (!Array.isArray(v)) throw new Error(`${where}: expected array`)
  return v
}

function checkGroups(groups: any[]) {
  const keys = new Set<string>()
  groups.forEach((g, i) => {
    const where = `filters()[${i}]`
    check(where, g, { key: (v) => isStr(v) && v !== '', label: isStr, type: (v) => v === 'select' || v === 'multi', options: Array.isArray })
    if (keys.has(g.key)) throw new Error(`${where}: duplicate key "${g.key}"`)
    keys.add(g.key)
    g.options.forEach((o: any, j: number) => check(`${where}.options[${j}]`, o, { value: isStr, label: isStr }))
    const values = new Set(g.options.map((o: any) => o.value))
    if (values.size !== g.options.length) throw new Error(`${where}: duplicate option values`)
    if (g.type === 'select') {
      if (!g.options.length) throw new Error(`${where}: select needs at least one option`)
      if (g.default !== undefined && !values.has(g.default)) throw new Error(`${where}: default "${g.default}" not in options`)
    } else if (g.default !== undefined) {
      throw new Error(`${where}: default is select-only`)
    }
    if (g.quick !== undefined && typeof g.quick !== 'boolean') throw new Error(`${where}: quick must be boolean`)
  })
  if (groups.filter((g) => g.quick).length > 1) throw new Error('filters(): at most one group may be quick')
  const genre = groups.find((g) => g.key === 'genre')
  if (!genre || genre.type !== 'multi' || !genre.options.length) throw new Error('filters(): needs a non-empty multi "genre" group')
}

// Every value must be an option of a declared group.
function checkValues(where: string, values: any, groups: any[]) {
  if (!values || typeof values !== 'object') throw new Error(`${where}: expected Record<string, string[]>`)
  for (const [k, v] of Object.entries(values)) {
    const g = groups.find((x) => x.key === k)
    if (!g) throw new Error(`${where}: unknown group "${k}"`)
    if (!Array.isArray(v) || (g.type === 'select' && v.length !== 1)) throw new Error(`${where}.${k}: bad value ${JSON.stringify(v)}`)
    for (const x of v) if (!g.options.some((o: any) => o.value === x)) throw new Error(`${where}.${k}: "${x}" not an option`)
  }
}

async function smoke(id: string, ext: any) {
  const step = (name: string, msg: string) => console.log(`ok  ${name.padEnd(9)} ${msg}`)
  const short = (v: unknown) => JSON.stringify(v).slice(0, 160)
  const browse = async (where: string, params: any) => {
    const page = await ext.browse(params)
    check(where, page, { items: Array.isArray, hasNext: (v) => typeof v === 'boolean' })
    page.items.forEach((s: any, i: number) => check(`${where}.items[${i}]`, s, SERIES))
    if (!page.items.length) throw new Error(`${where}: no items`)
    return page
  }

  const groups = arr('filters()', ext.filters ? await ext.filters() : [])
  checkGroups(groups)
  step('filters', groups.map((g) => `${g.key}:${g.type}(${g.options.length})${g.quick ? '*' : ''}`).join(' '))

  for (const k of ['featured', 'latest']) {
    checkValues(`home.${k}`, ext.home?.[k], groups)
    const page = await browse(`browse(home.${k})`, { page: 1, limit: 5, query: null, filters: ext.home[k] })
    step(`home.${k}`, `${short(ext.home[k])} -> ${page.items.length} items, hasNext=${page.hasNext}, first ${page.items[0].slug}`)
  }

  const genre = groups.find((g) => g.key === 'genre')
  const quick = groups.find((g) => g.quick)
  const action = genre.options.find((o: any) => /^action$/i.test(o.label)) ?? genre.options[0]
  const filters: Record<string, string[]> = { genre: [action.value] }
  const quickOpt = quick?.options.find((o: any) => o.value !== '')
  if (quickOpt) filters[quick.key] = [quickOpt.value]
  filters.unknownKey = ['ignored']
  const page = await browse('browse(filtered)', { page: 1, limit: 5, query: null, filters })
  step('browse', `${short(filters)} -> ${page.items.length} items, hasNext=${page.hasNext}, first ${short(page.items[0])}`)

  // Some sites list series whose chapters are gone; test the first with any.
  let slug = page.items[0].slug
  for (const item of page.items) {
    const list = await ext.chapters(item.slug)
    if (Array.isArray(list) && list.length) {
      slug = item.slug
      break
    }
  }
  const detail = await ext.series(slug)
  check(`series(${slug})`, detail, DETAIL)
  detail.genres.forEach((g: any, i: number) => check(`series().genres[${i}]`, g, GENRE))
  const unknown = detail.genres.filter((g: any) => !genre.options.some((o: any) => o.value === g.id))
  if (unknown.length) throw new Error(`series().genres: ids not in genre group: ${short(unknown)}`)
  if (quickOpt && quick.key === 'format' && detail.format !== quickOpt.value) {
    throw new Error(`series().format "${detail.format}" does not match filter "${quickOpt.value}"`)
  }
  step('series', short({ ...detail, synopsis: detail.synopsis?.slice(0, 40) }))
  if (ext.webUrl) {
    const url = ext.webUrl(slug)
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      throw new Error(`webUrl(${slug}) must return an https URL, got ${short(url)}`)
    }
    step('webUrl', url)
  }

  const chapters = arr(`chapters(${slug})`, await ext.chapters(slug))
  chapters.forEach((c, i) => check(`chapters()[${i}]`, c, { number: isNum, createdAt: orNull(isStr) }))
  for (let i = 1; i < chapters.length; i++) {
    if (chapters[i].number > chapters[i - 1].number) throw new Error(`chapters(): not newest first at index ${i}`)
  }
  for (const c of chapters) {
    if (c.createdAt && Number.isNaN(Date.parse(c.createdAt))) throw new Error(`chapters(): bad ISO date ${c.createdAt}`)
  }
  if (!chapters.length) throw new Error('chapters(): empty')
  step('chapters', `${chapters.length}, newest ${short(chapters[0])}, oldest ${short(chapters.at(-1))}`)

  const target = chapters.at(-1).number
  const ch = await ext.chapter(slug, target)
  check(`chapter(${slug}, ${target})`, ch, {
    number: isNum,
    title: orNull(isStr),
    prev: orNull(isNum),
    next: orNull(isNum),
    images: (v) => Array.isArray(v) && v.length > 0 && v.every((u) => isStr(u) && /^https?:\/\//.test(u)),
  })
  if (ch.number !== target) throw new Error(`chapter(): number ${ch.number} != ${target}`)
  if (ch.headers !== undefined) {
    const ok = ch.headers && typeof ch.headers === 'object' && Object.values(ch.headers).every(isStr)
    if (!ok) throw new Error(`chapter().headers must map names to strings: ${short(ch.headers)}`)
  }
  // The app loads images with exactly these headers (plus its User-Agent).
  const img = await fetch(ch.images[0], { headers: { 'User-Agent': DEFAULT_UA, ...(ch.headers ?? {}) } })
  if (!img.ok) throw new Error(`chapter(): first image answers ${img.status} with the given headers`)
  step('chapter', `#${ch.number} prev=${ch.prev} next=${ch.next} ${ch.images.length} images, first ${ch.images[0]}`)

  const missing = `this-does-not-exist-${Date.now()}`
  try {
    await ext.series(missing)
    throw new Error('series(missing): expected a 404 error')
  } catch (e: any) {
    if (!String(e?.message).startsWith('404')) throw new Error(`series(missing): error must start with 404, got "${e?.message}"`)
    step('404', e.message)
  }
  console.log(`\n${id}: smoke passed`)
}

// --- CLI ---

function coerce(method: string, args: string[]) {
  const json = (s: string) => {
    try {
      return JSON.parse(s)
    } catch {
      return s
    }
  }
  switch (method) {
    case 'browse':
      return [args[0] ? json(args[0]) : { page: 1 }]
    case 'filters':
      return []
    case 'series':
    case 'chapters':
      return [args[0]]
    case 'chapter':
      return [args[0], Number(args[1])]
    default:
      return args.map(json)
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const verbose = argv.includes('-v')
  const langArg = argv.find((a) => a.startsWith('--lang='))
  const [id, method, ...args] = argv.filter((a) => a !== '-v' && a !== langArg)
  if (!id || !method) {
    console.error('usage: bun scripts/run.ts <id> <filters|browse|series|chapters|chapter|smoke> [args...] [-v] [--lang=en]')
    process.exit(2)
  }
  try {
    const code = await Bun.file(`${ROOT}src/${id}/index.js`).text()
    const meta = JSON.parse(await Bun.file(`${ROOT}src/${id}/meta.json`).text())
    // Multi-language: --lang=<code>, else English or the first language.
    const lang = meta.languages
      ? (langArg?.slice(7) ?? (meta.languages.includes('en') ? 'en' : meta.languages[0]))
      : meta.lang
    const source = { id: meta.languages ? `${id}-${lang}` : id, lang }
    if (meta.languages) console.error(`(${source.id})`)
    const ext = loadExtension(id, code, { verbose, source })
    if (method === 'smoke') {
      await smoke(id, ext)
    } else {
      if (![...METHODS, 'filters'].includes(method)) throw new Error(`unknown method ${method}`)
      if (typeof ext[method] !== 'function') throw new Error(`${id} does not implement ${method}()`)
      const result = await ext[method](...coerce(method, args))
      console.log(JSON.stringify(result, null, 2))
    }
  } catch (e: any) {
    console.error(`FAIL ${id} ${method}: ${e?.stack || e}`)
    process.exit(1)
  }
}
