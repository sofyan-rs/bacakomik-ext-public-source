# BacaKomik Extensions

Source repository for the BacaKomik app's extensions. Each extension is a plain
JavaScript file that the app downloads and runs inside QuickJS.

This is the public part of the repository: the host typings, the build and
test scripts, and the docs. The extension sources (`src/`) and the build output
(`dist/`) of the official extensions are kept in a private repository. Use this repository to write and
test your own extension (see [docs/CONTRIBUTION.md](docs/CONTRIBUTION.md)),
or to host a third-party extension repository the app can add.

## Adding the repository in the app

Add this repository in the app with:

```
https://sofyan-rs.github.io/bacakomik-ext-public-source/index.json
```

That is GitHub Pages serving `dist/` as static files, deployed by the
`Publish` workflow (`.github/workflows/publish.yml`) on every push to `main`
that touches the extensions. `dist/` is committed; the workflow fails if it is
out of date, so run `bun run build` before committing.

The app reads `index.json`, lists the extensions, and downloads each `file`
(resolved relative to `index.json`). It checks each download against
`sha256` and uses `version` to detect updates. The app supports several
repositories at once, so a third-party repo can sit next to this one.

Files are checked out with LF line endings (`.gitattributes`) so the hashes
built on Windows match the files GitHub serves.

## Layout

```
types/bridge.d.ts    host globals + contract types (used by typecheck)
src/<id>/index.js    extension code
src/<id>/meta.json   extension metadata
scripts/build.ts     validates src/, writes dist/
scripts/bundle.ts    copies chosen extensions into the app's assets
scripts/run.ts       local runner and smoke test
dist/                build output: index.json + extensions/*.js (committed, deployed to GitHub Pages)
```

## Commands

```sh
bun install                                     # dev deps: typescript, node-html-parser
bun run build                                   # validate + write dist/
bun run bundle ../bacakomik-app-flutter/assets/extensions bacakomik  # ship these with the app
bun run typecheck                               # tsc, checkJs over src/
bun scripts/run.ts <id> smoke                   # end-to-end contract check against the live site
bun scripts/run.ts <id> filters
bun scripts/run.ts <id> browse '{"page":1,"limit":5}'
bun scripts/run.ts <id> browse '{"page":1,"limit":5,"query":"solo","filters":{"sort":["popular"],"genre":["19"]}}'
bun scripts/run.ts <id> series <slug>
bun scripts/run.ts <id> chapters <slug>
bun scripts/run.ts <id> chapter <slug> <number>
```

Add `-v` to log every HTTP request. The runner executes `index.js` in a fresh
`node:vm` context that exposes only the host globals below, so using `URL`,
`fetch`, `setTimeout`, `Intl`, etc. fails locally just as it would in the app.
Cookies are kept in memory for the duration of one run; `storage` is in memory.

`smoke` runs filters → browse with `home.featured` and `home.latest` → browse
with a genre + quick-group value (plus an unknown key, which must be ignored)
→ series (first item) → chapters → chapter (oldest) → series on a missing
slug. It validates group shapes (unique keys, select has options, `default`
is an option, at most one `quick`, a `genre` group exists), that `home`
values are declared options, every field type, that detail genre ids exist
in the `genre` group, newest-first chapter order, lowercase format/status,
and that a missing series throws a `404…` error.

## Runtime

An extension is a classic script (not an ES module: no `import`/`export`).
Only standard ECMAScript (ES2020) plus these host globals are available. There
is no `URL`, `URLSearchParams`, `fetch`, `setTimeout`, `TextEncoder`,
`atob`/`btoa` or `Intl`.

| Global | Description |
| --- | --- |
| `defineExtension(obj)` | Registers the extension. Call exactly once. |
| `http.fetch({ url, method = 'GET', headers = {}, body = null })` | Returns `Promise<{ status, url, headers, body }>`. `url` is the final URL after redirects, `headers` have lowercase keys, `body` is a string. Never throws on non-2xx; throws only on network failure. Cookies persist in a per-extension jar. Default `User-Agent` is Chrome Android 141; extension headers override it. |
| `html.select(html, selector)` | `Promise<Array<{ text, html, outerHtml, attrs }>>` (`html` is the inner HTML). |
| `storage.get(key)` / `storage.set(key, value)` | Per-extension string storage. `get` resolves `null` when unset. |
| `log(...args)` | Debug logging. |
| `qs(params)` | Sync. Builds `a=1&b=x`; skips `null`/`undefined`/`''`, arrays repeat the key, values use `encodeURIComponent`. Returns `''` when empty (no leading `?`). |

Wrap the file in an IIFE (`(() => { ... })()`) so top-level names don't leak
into the global scope (and don't collide across files during typecheck).
Start the file with `// @ts-check`.

## Contract (apiVersion 1)

```js
defineExtension({
  // Optional. Filter groups for the filter sheet; may fetch (e.g. genre lists).
  // Called once per app session.
  async filters() { return [/* FilterGroup */] },
  // Filter values for Home's two sections (same shape as browse's `filters`).
  home: { featured: { sort: ['newseries'] }, latest: { sort: ['latest'] } },

  async browse({ page, limit, query, filters }) {
    return { items: [/* Series */], hasNext: true }
  },
  // Optional. The series' page on the site, for the app's WebView.
  webUrl(slug) { return `https://example.com/series/${slug}` },
  async series(slug) { /* SeriesDetail */ },
  async chapters(slug) { /* Chapter[], newest first */ },
  async chapter(slug, number) { return { number, title, prev, next, images, headers } },
})
```

```ts
FilterGroup  = { key: string, label: string,
                 type: 'select' | 'multi',      // select: exactly one value; multi: any number
                 options: { value: string, label: string }[],
                 default?: string,              // select only; defaults to options[0].value
                 quick?: boolean }              // quick picker above the grid; at most one group
FilterValues = Record<string, string[]>         // group key -> values; missing key = group default
Series       = { slug: string, title: string, cover: string|null, format: string|null,
                 status: string|null, rating: number|null, totalChapters: number|null }
SeriesDetail = Series & { nativeTitle: string|null, releaseDate: string|null,
                          author: string|null, synopsis: string|null,
                          genres: { id: string, name: string }[] }
Chapter      = { number: number, createdAt: string|null /* ISO 8601 */ }
ChapterContent = { number: number, title: string|null, prev: number|null,
                   next: number|null, images: string[],
                   headers?: Record<string, string> }  // sent with every image request
```

- `browse` receives an array for every key (select groups get a one-element
  array). Unknown keys must be ignored. `query` and `filters` may be
  `null`/empty.
- A select group that can be unset starts with `{ value: '', label: 'All' }`;
  `''` or a missing key means no filter.
- The `multi` group with key `genre` holds the same ids as
  `SeriesDetail.genres[].id`; the app links a series' genre chips to it.
- `format` and `status` are lowercase (`'manhwa'`, `'ongoing'`).
- `prev`/`next` are chapter numbers or `null`.
- `webUrl` is what the app's WebView opens for a series, e.g. to pass a
  Cloudflare check. Cookies set there are copied into the extension's cookie
  jar, and the WebView uses the same User-Agent as `http.fetch`. Without
  `webUrl` the app opens `baseUrl`.
- `headers` (optional) go with every image request of the chapter, in the
  reader and in downloads, e.g. `{ Referer: 'https://site/' }`.
- Bot checks: when `http.fetch` gets a Cloudflare challenge page it rejects
  with an error starting with `challenge: <url>`. A script that detects its
  site's own check can throw `new Error('challenge: ' + url)` too. The app
  then offers to open `<url>` in its WebView; once the user passes the check
  there, the cookies land in the extension's jar and the call is retried.
- Errors: throw `new Error(...)`. For a missing series or chapter the message
  must start with `404`.

Full typings: [`types/bridge.d.ts`](types/bridge.d.ts).

## meta.json

```json
{
  "id": "bacakomik",
  "name": "BacaKomik",
  "lang": "id",
  "version": "1.2.0",
  "apiVersion": 1,
  "baseUrl": "https://bacakomik.my",
  "urlPatterns": ["^/komik/([^/?#]+)"],
  "nsfw": false
}
```

`id` must match the folder name. `lang` is ISO 639-1. `baseUrl` is for
display (the site's home page); the API base lives in `index.js`. `version` is semver
(`major.minor.patch`, starting at `1.0.0`): bump it on every change to
`index.js` (patch for fixes, minor for new features, major for breaking
changes), then run `bun run build` and commit `dist/` together with the
source.

`urlPatterns` (optional) lists regexes, each with one capture group, that
find the slug in a series URL path (`/manga/<slug>/`). The app uses them to
import Mihon/Tachiyomi backups without running the script.

## index.json

```json
{
  "name": "BacaKomik Extensions",
  "extensions": [
    { "id": "...", "name": "...", "lang": "id", "version": "1.2.0", "apiVersion": 1,
      "baseUrl": "...", "nsfw": false,
      "file": "bacakomik.v1.2.0.js", "sha256": "<hex of file bytes>" }
  ]
}
```

## Adding an extension

1. Create `src/<id>/meta.json` and `src/<id>/index.js`.
2. `bun run typecheck && bun scripts/run.ts <id> smoke`
3. `bun run build` and commit `src/` + `dist/`.
