# Architecture

This page explains how the repository works. Read it once. When you want to
add or change an extension, follow [CONTRIBUTION.md](CONTRIBUTION.md).

## The big picture

```
 you write                 bun run build              git push main             the app
┌──────────────┐        ┌──────────────────┐       ┌──────────────────┐      ┌──────────────┐
│ src/<id>/    │ ─────► │ dist/index.json  │ ────► │ GitHub Pages     │ ───► │ BacaKomik app│
│  meta.json   │        │ dist/extensions/ │       │ (static files)   │      │ runs the .js │
│  index.js    │        │  <id>.v<ver>.js  │       │                  │      │ in QuickJS   │
└──────────────┘        └──────────────────┘       └──────────────────┘      └──────────────┘
```

1. An **extension** is one website (a "source"). It is one folder in `src/`.
2. `bun run build` checks every folder and copies the code to `dist/`.
   It also writes `dist/index.json`, the list of all extensions.
3. When you push to `main`, GitHub Actions deploys `dist/` to
   GitHub Pages.
4. The app downloads `index.json`, then downloads each extension file and
   runs it.

The app does not use a server to scrape. The extension code runs **inside the
app** on the user's phone.

## Folders

| Path | What it is | Do you edit it? |
| --- | --- | --- |
| `src/<id>/meta.json` | Name, language, version of one extension | Yes |
| `src/<id>/index.js` | The code of one extension | Yes |
| `dist/` | Build output. Committed to git | No. `bun run build` writes it |
| `types/bridge.d.ts` | Types of the app's globals and of the contract | Only if the app changes |
| `scripts/build.ts` | Checks `src/` and writes `dist/` | Rarely |
| `scripts/run.ts` | Runs an extension on your computer, for testing | Rarely |
| `scripts/bundle.ts` | Copies some extensions into the app's assets | Rarely |
| `.github/workflows/publish.yml` | Deploys `dist/` on push | Rarely |

## How the app talks to an extension

The app calls functions that your `index.js` gives to `defineExtension(...)`.
Each function answers one screen of the app:

| App screen | Function the app calls | You return |
| --- | --- | --- |
| Filter sheet | `filters()` | List of filter groups (sort, genre, ...) |
| Home: two rows | `home` (an object, not a function) | Filter values for "featured" and "latest" |
| Browse / search grid | `browse({ page, limit, query, filters })` | `{ items: Series[], hasNext }` |
| Series page | `series(slug)` | One series with details |
| Chapter list | `chapters(slug)` | Chapters, **newest first** |
| Reader | `chapter(slug, number)` | Image URLs + prev/next chapter number |
| "Open in browser" | `webUrl(slug)` (optional) | The series URL on the website |

A **slug** is your own ID for a series. It is any string that lets you find
the series again (for example `solo-leveling` or `solo-leveling-1234`).

## What the code can use

The code runs in QuickJS, not in a browser and not in Node. So these do
**not** exist: `fetch`, `URL`, `URLSearchParams`, `setTimeout`, `atob`,
`btoa`, `TextEncoder`, `Intl`, `import`, `export`, `require`.

The app gives you these globals instead:

| Global | Use it to |
| --- | --- |
| `http.fetch({ url, method, headers, body })` | Download a page or JSON. Returns `{ status, url, headers, body }`. `body` is a string. It does not throw on 404/500, so check `status`. |
| `html.select(html, cssSelector)` | Find elements in HTML. Returns `[{ text, html, outerHtml, attrs }]`. |
| `qs({ a: 1, b: 'x' })` | Build a query string: `a=1&b=x`. Skips empty values. |
| `storage.get(key)` / `storage.set(key, value)` | Save small strings between runs. |
| `webview.run(url, fn, ...args)` | Run `fn` inside a hidden real browser on `url`. Only for sites that block normal requests. |
| `log(...)` | Print debug output. |
| `source` | `{ id, lang }` of the running extension. Used by multi-language extensions. |

Cookies are saved per extension, so login or "adult content" cookies stay.

Full types: [`types/bridge.d.ts`](../types/bridge.d.ts).

## Data shapes

```ts
Series = {
  slug: string, title: string, cover: string | null,
  format: string | null,        // lowercase: 'manga' | 'manhwa' | 'manhua' | ...
  status: string | null,        // lowercase: 'ongoing' | 'completed' | ...
  rating: number | null, totalChapters: number | null,
  altTitles?: string[] | null,  // every alternative title, split, without the main title
}

SeriesDetail = Series & {
  nativeTitle: string | null, releaseDate: string | null,
  author: string | null,         // authors then artists, joined with ', '
  synopsis: string | null,
  genres: { id: string, name: string }[],   // id = a value of the 'genre' filter
}

Chapter = { number: number, createdAt: string | null }   // createdAt: ISO 8601

ChapterContent = {
  number: number, title: string | null,
  prev: number | null, next: number | null,   // chapter numbers
  images: string[],
  headers?: Record<string, string>,           // sent with each image, e.g. Referer
}

FilterGroup = {
  key: string, label: string,
  type: 'select' | 'multi',      // select: one value, multi: many values
  options: { value: string, label: string }[],
  default?: string,              // select only
  quick?: boolean,               // shown above the grid; max one group
}
```

### Field rules

- **`author`**: everyone credited, authors first, then artists, without
  repeats, joined with `, ` (`Chugong, DUBU (REDICE STUDIO)`). If the site
  has separate author and artist fields, read both. If it has one field,
  send it as it is. `null` when the site has none.
- **`altTitles`**: every alternative title as its own item: other languages,
  romanized, older names. Split the site's string on the separator it uses
  (`•`, `|`, `;`, ` / `, line breaks). Split on `, ` only when there is no
  other separator, because titles often contain commas. Drop the main title,
  placeholders (`-`, `N/A`, `Updating`, `Field Kosong`) and repeats.
  Send it in `browse` items too when the list has it: the app matches
  comics by these titles when moving a library between sources.
- **`nativeTitle`**: one title for older apps, usually the first of
  `altTitles`.

`browse` gets filters as `{ key: string[] }`, for example
`{ sort: ['popular'], genre: ['action', 'drama'] }`. A select group also gets
an array (one item). A missing key means "use the default".

## Errors

- Throw `new Error('...')` when something fails.
- Series or chapter not found: the message **must start with `404`**.
  Example: `throw new Error('404 Chapter 12 not found')`.
- Site shows a bot check (Cloudflare): throw
  `new Error('challenge: ' + url)`. The app opens `url` in a WebView so the
  user can pass the check. Then the app retries. `http.fetch` already does
  this for normal Cloudflare pages.

## Versions and updates

- `meta.json` has `version` like `1.2.3`.
- The build names the file `dist/extensions/<id>.v<version>.js` and puts a
  `sha256` hash in `index.json`.
- The app sees a new version and downloads the new file. If you change code
  but not the version, users do not get the update.

## Deploy

`.github/workflows/publish.yml` runs on every push to `main` that changes
`src/`, `scripts/`, or `dist/`. It:

1. runs `bun run typecheck`,
2. runs `bun run build`,
3. **fails if `dist/` differs from what you committed** (you forgot to build),
4. deploys `dist/` to GitHub Pages.

Manual deploy: Actions > Publish > Run workflow.

The app's repository URL is `https://sofyan-rs.github.io/bacakomik-ext-public-source/index.json`.
