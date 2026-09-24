/**
 * IndexNow: tell Bing, Yandex, Seznam, Naver, Yep and the other participants
 * which pages changed, instead of waiting for their next crawl. Bing's index
 * feeds Copilot, so this is also how an AI assistant hears about a new price
 * quickly. Google does not take part; it reads the sitemap.
 *
 * The protocol asks for changed pages only, so by default this submits the
 * sitemap entries whose lastmod is at or after `--since`: after the daily
 * exchange-rate job, the pages whose prices moved.
 *
 *   pnpm --filter @dr/web seo:indexnow -- --since=2026-09-24T07:00:00Z --wait
 *   pnpm --filter @dr/web seo:indexnow -- --all          # first launch, or a site-wide change
 *   pnpm --filter @dr/web seo:indexnow -- https://www.mydomainshub.com/about
 *   … --dry-run                                           # list, send nothing
 *
 * Runs under Node's type stripping, so plain TypeScript only (no enums, no
 * path aliases). The key is public by design: it is served at /{key}.txt so
 * the engines can check the site sent the list.
 */

import { pathToFileURL } from 'node:url'

export const INDEXNOW_KEY = '2e9aceee178d9e05ee2da67d9e8a6916'
export const ENDPOINT = 'https://api.indexnow.org/indexnow'
/** The protocol's limit per request. */
export const MAX_URLS = 10_000

export type SitemapEntry = { url: string; lastModified: Date | null }

const decode = (value: string) =>
  value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')

/** The <url> entries of a sitemap: our own, simple format — loc and an optional lastmod. */
export function parseSitemap(xml: string): SitemapEntry[] {
  const entries: SitemapEntry[] = []
  for (const block of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const body = block[1] ?? ''
    const loc = body.match(/<loc>\s*([^<]+?)\s*<\/loc>/)?.[1]
    if (!loc) continue
    const lastmod = body.match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/)?.[1]
    const when = lastmod ? new Date(lastmod) : null
    entries.push({
      url: decode(loc),
      lastModified: when && !Number.isNaN(when.getTime()) ? when : null,
    })
  }
  return entries
}

/** Entries changed at or after `since`; an entry without a lastmod never counts as changed. */
export function changedSince(entries: SitemapEntry[], since: Date): string[] {
  return entries
    .filter((entry) => entry.lastModified !== null && entry.lastModified >= since)
    .map((entry) => entry.url)
}

/** The request bodies: our host's URLs only, de-duplicated, at most MAX_URLS each. */
export function payloads(site: string, urls: string[]) {
  const host = new URL(site).host
  const own = [...new Set(urls)].filter((url) => {
    try {
      return new URL(url).host === host
    } catch {
      return false
    }
  })
  const bodies = []
  for (let start = 0; start < own.length; start += MAX_URLS) {
    bodies.push({
      host,
      key: INDEXNOW_KEY,
      keyLocation: new URL(`/${INDEXNOW_KEY}.txt`, site).toString(),
      urlList: own.slice(start, start + MAX_URLS),
    })
  }
  return bodies
}

type Options = { site: string; all: boolean; since: Date | null; wait: boolean; dryRun: boolean }

export function parseArgs(argv: string[], env: Record<string, string | undefined>) {
  const flags = new Map<string, string>()
  const urls: string[] = []
  for (const arg of argv) {
    if (arg === '--') continue
    const match = arg.match(/^--([a-z-]+)(?:=(.*))?$/)
    if (match?.[1]) flags.set(match[1], match[2] ?? 'true')
    else urls.push(arg)
  }
  const since = flags.get('since')
  const sinceDate = since ? new Date(since) : null
  if (sinceDate && Number.isNaN(sinceDate.getTime()))
    throw new Error(`--since is not a date: ${since}`)
  const options: Options = {
    site: env.SITE_URL ?? 'https://www.mydomainshub.com',
    all: flags.has('all'),
    since: sinceDate,
    wait: flags.has('wait'),
    dryRun: flags.has('dry-run'),
  }
  if (urls.length === 0 && !options.all && !options.since) {
    throw new Error('say what to submit: --since=<date>, --all, or URLs')
  }
  return { options, urls }
}

async function readSitemap(site: string): Promise<SitemapEntry[]> {
  const response = await fetch(new URL('/sitemap.xml', site), { cache: 'no-store' })
  if (!response.ok) throw new Error(`sitemap: HTTP ${response.status}`)
  return parseSitemap(await response.text())
}

/**
 * Right after prices change, the cached sitemap can still carry the old
 * date for a minute; with --wait, look again for up to five minutes.
 */
async function changedUrls(options: Options): Promise<string[]> {
  const since = options.since as Date
  for (let attempt = 1; ; attempt += 1) {
    const changed = changedSince(await readSitemap(options.site), since)
    if (changed.length > 0 || !options.wait || attempt >= 10) return changed
    await new Promise((resolve) => setTimeout(resolve, 30_000))
  }
}

async function main() {
  const { options, urls } = parseArgs(process.argv.slice(2), process.env)
  const list =
    urls.length > 0
      ? urls
      : options.all
        ? (await readSitemap(options.site)).map((entry) => entry.url)
        : await changedUrls(options)

  const bodies = payloads(options.site, list)
  const count = bodies.reduce((total, body) => total + body.urlList.length, 0)
  if (count === 0) {
    console.log('IndexNow: nothing changed, nothing sent.')
    return
  }
  if (options.dryRun) {
    for (const body of bodies) for (const url of body.urlList) console.log(url)
    console.log(`IndexNow: ${count} URLs (dry run, nothing sent).`)
    return
  }
  for (const body of bodies) {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    })
    // 200 received, 202 received and the key is still being checked.
    if (response.status !== 200 && response.status !== 202) {
      throw new Error(`IndexNow refused ${body.urlList.length} URLs: HTTP ${response.status}`)
    }
    console.log(`IndexNow: sent ${body.urlList.length} URLs (HTTP ${response.status}).`)
  }
}

// Run as a script, not when a test imports it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
