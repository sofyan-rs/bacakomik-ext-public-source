# Contribution guide

Step-by-step recipes. Read [ARCHITECTURE.md](ARCHITECTURE.md) once first, so
you know what `browse`, `series`, `chapters` and `chapter` do.

## 0. One-time setup

1. Install [Bun](https://bun.sh).
2. In the repository folder, run:

   ```sh
   bun install
   ```

---

## Recipe A: Add a new extension

Example: you want to add the site `https://example.com`. Its ID is `example`.

### Step 1. Study the website

Open the site in Chrome. Press `F12`, then open the **Network** tab. Find
these 5 things and write down the URLs:

| What | Look for |
| --- | --- |
| Series list | The "latest" or "popular" page, and how page 2 looks (`?page=2`, `/page/2/`) |
| Search | What URL you get when you search for "solo" |
| Genres | The list of genres and their IDs or slugs |
| Series page | Title, cover, author, synopsis, genres |
| Chapter page | The `<img>` URLs of the pages |

Tip: in the Network tab, filter by **Fetch/XHR**. Many sites load JSON from
an API. JSON is much easier than HTML. If you find an API, use it.

### Step 2. Create the folder

```
src/example/meta.json
src/example/index.js
src/example/icon.png    (optional)
```

The folder name is the ID. Use only lowercase letters, numbers and `-`.

`icon.png` is the icon the app shows in its Extensions list. Use a square
PNG, about 96x96 (Keiyoushi's `res/mipmap-xhdpi/ic_launcher.png` fits).
Without one the app shows the name's first letter.

### Step 3. Write `meta.json`

```json
{
  "id": "example",
  "name": "Example",
  "lang": "en",
  "version": "1.0.0",
  "apiVersion": 1,
  "baseUrl": "https://example.com",
  "nsfw": false
}
```

| Field | Value |
| --- | --- |
| `id` | Same as the folder name |
| `name` | Name shown in the app |
| `lang` | 2-letter language code: `id`, `en`, `ja`, ... |
| `version` | Start at `1.0.0` |
| `apiVersion` | Always `1` |
| `baseUrl` | Home page of the site, `https://` |
| `nsfw` | `true` if the site has adult content |
| `urlPatterns` | Optional. Regexes that find the slug in a series URL path (below) |
| `credits` | Optional. keiyoushi folders the code was ported from (see the end of Recipe A) |

`urlPatterns` lets the app turn a series link into a slug without running
the script, for example when it imports a Mihon/Tachiyomi backup. Each
pattern is matched against the URL's path (with query and fragment, without
the host; Mihon stores this relative path), and its one capture group must
be the slug `series(slug)` takes. Example for a site whose pages are
`/manga/<slug>/`:

```json
"urlPatterns": ["^/manga/([^/?#]+)"]
```

### Step 4. Write `index.js`

Copy one of these starting points:

- Site has a **JSON API**: copy `src/bacakomik/index.js` (simplest) or
  `src/westmanga/index.js`.
- Site has **only HTML**: use the template below.
- Site **blocks normal requests** (Cloudflare): look at
  `src/reimanga/index.js`. It uses `webview.run`.

HTML template. Change every line marked `TODO`:

```js
// @ts-check
// Example: scrapes the HTML pages of example.com.
(() => {
  const BASE = 'https://example.com' // TODO

  /** Download a page. Throws on errors. @param {string} url */
  async function get(url) {
    const res = await http.fetch({ url, headers: { Referer: BASE + '/' } })
    if (res.status === 404) throw new Error(`404 Not found: ${url}`)
    if (res.status < 200 || res.status >= 300) throw new Error(`${res.status} HTTP error: ${url}`)
    return res.body
  }

  /** First element's text, or null. */
  async function text(page, selector) {
    const [el] = await html.select(page, selector)
    return el ? el.text.trim() || null : null
  }

  /** First element's attribute, or null. */
  async function attr(page, selector, name) {
    const [el] = await html.select(page, selector)
    return el ? el.attrs[name] || null : null
  }

  /** "https://example.com/manga/solo-leveling/" -> "solo-leveling" */
  const slugOf = (url) => String(url).replace(/\/+$/, '').split('/').pop() || ''

  const pick = (f, key) => (f && f[key] && f[key][0]) || null

  /** Chapters of a series, newest first. @param {string} slug */
  async function chapterList(slug) {
    const body = await get(`${BASE}/manga/${slug}/`) // TODO
    const rows = await html.select(body, '.chapter-list li a') // TODO
    return rows
      .map((a) => ({
        number: Number((/(\d+(?:\.\d+)?)/.exec(a.text) || [])[1]),
        createdAt: null, // ISO 8601 date if the site shows one
      }))
      .filter((c) => isFinite(c.number))
      .sort((a, b) => b.number - a.number) // newest first
  }

  defineExtension({
    async filters() {
      return [
        {
          key: 'sort',
          label: 'Sort',
          type: 'select',
          options: [
            { value: 'latest', label: 'Latest update' }, // TODO: site's values
            { value: 'newest', label: 'New series' },
            { value: 'popular', label: 'Popular' },
          ],
        },
        {
          // Required. Values must be the same IDs that series() returns in genres[].id.
          key: 'genre',
          label: 'Genre',
          type: 'multi',
          options: [
            { value: 'action', label: 'Action' }, // TODO: all genres of the site
            { value: 'romance', label: 'Romance' },
          ],
        },
      ]
    },

    // What Home shows. Values must be options from filters().
    // featured: newly added series; popular only if the site has no such sort,
    // then also set featuredLabel: 'Popular' (the app titles it "New series").
    home: { featured: { sort: ['newest'] }, latest: { sort: ['latest'] } },

    async browse({ page, query, filters }) {
      // TODO: build the site's list or search URL.
      const url = BASE + '/manga/?' + qs({
        page: page || 1,
        s: query ? query.trim() : null,
        order: pick(filters, 'sort'),
        genre: (filters && filters.genre) || [],
      })
      const body = await get(url)
      // TODO: CSS selector of one card in the grid.
      const cards = await html.select(body, '.list .item')
      const items = []
      for (const card of cards) {
        items.push({
          slug: slugOf(await attr(card.outerHtml, 'a', 'href')),
          title: (await text(card.outerHtml, '.title')) || '',
          cover: await attr(card.outerHtml, 'img', 'src'),
          format: null,
          status: null,
          rating: null,
          totalChapters: null,
        })
      }
      // TODO: selector of the "next page" link.
      const hasNext = (await html.select(body, 'a.next')).length > 0
      return { items, hasNext }
    },

    webUrl(slug) {
      return `${BASE}/manga/${slug}/` // TODO
    },

    async series(slug) {
      const body = await get(`${BASE}/manga/${slug}/`) // TODO
      const genres = await html.select(body, '.genres a') // TODO
      return {
        slug,
        title: (await text(body, 'h1')) || slug, // TODO: selectors below
        cover: await attr(body, '.thumb img', 'src'),
        format: null, // lowercase: 'manga' | 'manhwa' | 'manhua'
        status: null, // lowercase: 'ongoing' | 'completed'
        rating: null,
        totalChapters: null,
        nativeTitle: null,
        altTitles: [], // optional: every alternative title, split
        releaseDate: null,
        author: await text(body, '.author'), // authors then artists, joined with ', '
        synopsis: await text(body, '.synopsis'),
        genres: genres.map((g) => ({ id: slugOf(g.attrs.href), name: g.text.trim() })),
      }
    },

    async chapters(slug) {
      return chapterList(slug)
    },

    async chapter(slug, number) {
      const list = await chapterList(slug)
      const i = list.findIndex((c) => c.number === Number(number))
      if (i < 0) throw new Error(`404 Chapter ${number} not found: ${slug}`)
      const body = await get(`${BASE}/manga/${slug}/chapter-${number}/`) // TODO
      const imgs = await html.select(body, '#reader img') // TODO
      return {
        number: Number(number),
        title: null,
        prev: i + 1 < list.length ? list[i + 1].number : null, // older chapter
        next: i > 0 ? list[i - 1].number : null, // newer chapter
        images: imgs.map((img) => img.attrs['data-src'] || img.attrs.src).filter(Boolean),
        headers: { Referer: BASE + '/' }, // many image hosts need this
      }
    },
  })
})()
```

Rules to remember:

- No `import`, `export`, `fetch`, `URL`, `setTimeout`. Use `http.fetch`,
  `qs`, `html.select`.
- Keep the code inside `(() => { ... })()`.
- `format` and `status` are lowercase.
- `chapters()` is newest first.
- The `genre` filter is required. Its values must equal `series().genres[].id`.
- Not found: `throw new Error('404 ...')`.

### Step 5. Test one function at a time

```sh
bun scripts/run.ts example filters
bun scripts/run.ts example browse '{"page":1,"limit":5}'
bun scripts/run.ts example browse '{"page":1,"limit":5,"query":"solo"}'
bun scripts/run.ts example series solo-leveling
bun scripts/run.ts example chapters solo-leveling
bun scripts/run.ts example chapter solo-leveling 1
```

Add `-v` to see every HTTP request:

```sh
bun scripts/run.ts example browse '{"page":1,"limit":5}' -v
```

If the JSON argument breaks in PowerShell, run the command in Git Bash.

### Step 6. Run the full test

```sh
bun run typecheck
bun scripts/run.ts example smoke
```

`smoke` calls every function like the app does and checks every rule. Fix
each error until it passes. See [Common errors](#common-errors).

### Step 7. Build and commit

```sh
bun run build
git add src/example dist
git commit -m "feat: Example extension (1.0.0)"
git push
```

The push deploys automatically. Open the app, refresh the repository, and
install the extension.

If you copied code from
[keiyoushi/extensions-source](https://github.com/keiyoushi/extensions-source),
keep a credit note at the top of `index.js` and list the keiyoushi folders you
ported from in `meta.json`:

```json
"credits": ["src/en/example", "lib-multisrc/mangathemesia"]
```

Do not edit the Credits table in `README.md`. A workflow rebuilds it from
`credits` after the merge to `main`.

---

## Recipe B: Fix or change an extension

The site changed and an extension is broken.

1. Find the problem:

   ```sh
   bun scripts/run.ts <id> smoke -v
   ```

2. Fix `src/<id>/index.js`.
3. Run `smoke` again until it passes.
4. **Bump `version` in `src/<id>/meta.json`.** Without this, users do not get
   the fix.

   | Change | Example |
   | --- | --- |
   | Bug fix | `1.0.3` to `1.0.4` |
   | New feature (new filter, ...) | `1.0.3` to `1.1.0` |
   | Big change (new slugs, ...) | `1.0.3` to `2.0.0` |

5. Build and commit:

   ```sh
   bun run typecheck
   bun run build
   git add src/<id> dist
   git commit -m "fix(<id>): <what you fixed> (1.0.4)"
   git push
   ```

---

## Recipe C: Remove an extension

```sh
rm -r src/<id>
bun run build      # deletes the old file from dist/
git add -A src dist
git commit -m "chore: remove <id>"
git push
```

---

## Recipe D: Ship extensions inside the app

The app can include some extensions at install time. After `bun run build`:

```sh
bun run bundle ../bacakomik-app-flutter/assets/extensions bacakomik
```

This replaces everything in that folder with the extensions you list.

---

## Commit messages

Format: `<type>(<id>): <what changed> (<new version>)`

- `(<id>)`: the extension you changed. Leave it out when the change is not
  about one extension.
- `(<new version>)`: the new `version` from `meta.json`. Add it only when you
  bumped the version.
- Start the summary in lowercase, unless it starts with a name (`Comix`,
  `ReiManga`). Do not end it with a period.

| Type | Use it for | Example |
| --- | --- | --- |
| `feat` | New extension | `feat: Comix extension (1.0.0)` |
| `feat` | New feature in an extension | `feat(reimanga): format filter (1.0.1)` |
| `fix` | Bug fix in an extension | `fix(mangadex): no chapter count in lists (1.0.2)` |
| `wip` | Unfinished work you want to save | `wip: WestManga (lists and details; images blocked)` |
| `docs` | README, docs/, credits | `docs: credit keiyoushi for ReiManga` |
| `ci` | `.github/workflows/` | `ci: publish dist to the public extension repo` |
| `chore` | Scripts, config, cleanup, removing an extension | `chore: remove <id>` |

Do not push a `wip` commit that breaks `smoke` for an extension that is
already published. Bump the version only when the extension is ready.

## Pull requests

You can push to `main` directly. To get a review first, open a pull request
instead. GitHub fills in the description from
[`.github/pull_request_template.md`](../.github/pull_request_template.md).
Use the commit message format for the PR title.

---

## Checklist before you push

- [ ] `bun scripts/run.ts <id> smoke` passes.
- [ ] `bun run typecheck` passes.
- [ ] `version` in `meta.json` is bumped (when you changed `index.js`).
- [ ] `bun run build` was run after the last change.
- [ ] `src/<id>` **and** `dist/` are both in the commit.

If you forget the build, the GitHub workflow fails at
"Check the committed dist/ matches the build". Run `bun run build`, commit
`dist/`, and push again.

---

## Common errors

| Error message | Fix |
| --- | --- |
| `id "x" must match folder name "y"` | Make `meta.json` `id` equal the folder name. |
| `version must be "major.minor.patch"` | Use `1.0.0`, not `1.0` or `v1.0.0`. |
| `defineExtension must be called exactly once` | Call it once, at the end of the file. |
| `missing method chapter()` | Add all of `browse`, `series`, `chapters`, `chapter`. |
| `home.latest must be Record<string, string[]>` | Values are arrays: `{ sort: ['latest'] }`, not `{ sort: 'latest' }`. |
| `needs a non-empty multi "genre" group` | Add a filter with `key: 'genre'`, `type: 'multi'`. |
| `"x" not an option` | `home` uses a value that is not in `filters()`. |
| `series().genres: ids not in genre group` | Use the same ID in `genres[].id` and in the genre filter's `value`. |
| `series().format "..." does not match filter` | `series()` must return the same format as the quick filter value, in lowercase. |
| `chapters(): not newest first` | Add `.sort((a, b) => b.number - a.number)`. |
| `chapters(): bad ISO date` | `createdAt` must be like `2026-10-25` or `2026-10-25T10:00:00Z`, or `null`. |
| `browse(...): no items` | The selector or URL is wrong. Run with `-v` and check the HTML. |
| `ReferenceError: fetch is not defined` (or `URL`, `atob`) | Use `http.fetch`, `qs`, and string functions. |
| `challenge: https://...` | Site has a bot check. Open the site in the app's WebView, or use `webview.run` (see `src/reimanga/index.js`). |
| Images do not load in the app | Return `headers: { Referer: BASE + '/' }` from `chapter()`. |
