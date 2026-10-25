// Host globals provided by the app's QuickJS runtime (apiVersion 1).
// Anything not declared here (URL, fetch, setTimeout, TextEncoder, atob, Intl...)
// does not exist at runtime.

interface HttpRequest {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string | null
}

interface HttpResponse {
  status: number
  /** Final URL after redirects. */
  url: string
  /** Lowercase keys. */
  headers: Record<string, string>
  body: string
}

interface HtmlNode {
  text: string
  /** Inner HTML. */
  html: string
  outerHtml: string
  attrs: Record<string, string>
}

type QsValue = string | number | boolean | null | undefined
type QsParams = Record<string, QsValue | QsValue[]>

declare const http: {
  /** Never throws on non-2xx; throws only on network failure. Cookies persist per extension. */
  fetch(req: HttpRequest): Promise<HttpResponse>
}

declare const html: {
  select(html: string, selector: string): Promise<HtmlNode[]>
}

declare const storage: {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
}

declare function log(...args: unknown[]): void

/** `a=1&b=x`; skips null/undefined/'', arrays repeat the key, '' when empty. */
declare function qs(params: QsParams): string

/** Must be called exactly once per extension file. */
declare const webview: {
  /**
   * Opens `url` in a hidden WebView (kept a few minutes per extension; not
   * reloaded while it already shows that URL) and runs `script` there: an async
   * function, sent as source so it sees only its own `args`, or the body of
   * one. Resolves with its JSON-able result. Use it for sites that only
   * answer a real browser. Waits out Cloudflare's automatic check; one that
   * needs the user rejects with `challenge: <url>`.
   */
  run<A extends unknown[], R>(url: string, script: ((...args: A) => Promise<R> | R) | string, ...args: A): Promise<R>
}

declare function defineExtension(ext: Extension): void

/**
 * The source this engine runs as. A multi-language extension (meta.json
 * `languages`) gets one engine per enabled language: id `<ext>-<lang>`,
 * `lang` that language. Single-language extensions get their id and meta.json `lang`.
 */
declare const source: { id: string; lang: string }

// --- Extension contract ---

interface FilterOption {
  value: string
  label: string
}

interface FilterGroup {
  key: string
  label: string
  /** select: exactly one value; multi: any number. */
  type: 'select' | 'multi'
  /** A select group that can be unset starts with { value: '', label: 'All' }. */
  options: FilterOption[]
  /** select only; defaults to options[0].value. */
  default?: string
  /** Show as a quick picker above the grid. At most one group sets it. */
  quick?: boolean
}

/** Group key -> selected values (select groups get a one-element array). Missing key = group default. */
type FilterValues = Record<string, string[]>

interface Genre {
  /** Same ids as the `genre` filter group's option values. */
  id: string
  name: string
}

interface Series {
  slug: string
  title: string
  cover: string | null
  format: string | null
  status: string | null
  rating: number | null
  totalChapters: number | null
}

interface SeriesDetail extends Series {
  nativeTitle: string | null
  /**
   * Every alternative title (other languages, romanized, older names), one
   * per item, without the main title, placeholders or repeats. Optional: apps
   * fall back to `nativeTitle` when missing.
   */
  altTitles?: string[] | null
  releaseDate: string | null
  /** Authors then artists, without repeats, joined with `, `. */
  author: string | null
  synopsis: string | null
  genres: Genre[]
}

interface Chapter {
  number: number
  /** ISO 8601. */
  createdAt: string | null
}

interface ChapterContent {
  number: number
  title: string | null
  prev: number | null
  next: number | null
  images: string[]
  /** Sent with every image request, e.g. a Referer the image host requires. */
  headers?: Record<string, string>
}

interface BrowseParams {
  page: number
  limit?: number | null
  query?: string | null
  /** Unknown keys must be ignored. */
  filters?: FilterValues | null
}

interface BrowseResult {
  items: Series[]
  hasNext: boolean
}

interface Extension {
  /** Filter groups for the filter sheet; may fetch. Called once per app session. */
  filters?(): Promise<FilterGroup[]>
  /** Filter values for Home's two sections. */
  home?: { featured: FilterValues; latest: FilterValues }
  browse(params: BrowseParams): Promise<BrowseResult>
  /**
   * Page of the series on the site, opened in the app's WebView (e.g. to pass
   * a Cloudflare check). Optional; the app falls back to `baseUrl`.
   */
  webUrl?(slug: string): string
  /** Throws an Error starting with `404` when missing. */
  series(slug: string): Promise<SeriesDetail>
  /** Newest first. */
  chapters(slug: string): Promise<Chapter[]>
  /** Throws an Error starting with `404` when missing. */
  chapter(slug: string, number: number): Promise<ChapterContent>
}
