import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  changedSince,
  INDEXNOW_KEY,
  MAX_URLS,
  parseArgs,
  parseSitemap,
  payloads,
} from '../../../../scripts/indexnow'

const SITE = 'https://www.mydomainshub.com'
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url>
<loc>https://www.mydomainshub.com/</loc>
<lastmod>2026-09-24T12:23:07.225Z</lastmod>
</url>
<url>
<loc>https://www.mydomainshub.com/help</loc>
</url>
<url>
<loc>https://www.mydomainshub.com/legal/privacy</loc>
<lastmod>2026-09-22T23:00:00.000Z</lastmod>
</url>
</urlset>`

describe('IndexNow submission', () => {
  it('reads each address and its date from the sitemap', () => {
    expect(parseSitemap(XML)).toEqual([
      { url: `${SITE}/`, lastModified: new Date('2026-09-24T12:23:07.225Z') },
      { url: `${SITE}/help`, lastModified: null },
      { url: `${SITE}/legal/privacy`, lastModified: new Date('2026-09-22T23:00:00.000Z') },
    ])
  })

  it('submits only pages changed since the given time — undated pages never count', () => {
    expect(changedSince(parseSitemap(XML), new Date('2026-09-24T07:00:00Z'))).toEqual([`${SITE}/`])
  })

  it('sends our own addresses only, once each, with the key and where to find it', () => {
    const [body, ...rest] = payloads(SITE, [
      `${SITE}/`,
      `${SITE}/`,
      'https://example.com/x',
      'not a url',
    ])
    expect(rest).toEqual([])
    expect(body).toEqual({
      host: 'www.mydomainshub.com',
      key: INDEXNOW_KEY,
      keyLocation: `${SITE}/${INDEXNOW_KEY}.txt`,
      urlList: [`${SITE}/`],
    })
  })

  it('splits a long list at the protocol’s limit', () => {
    const urls = Array.from({ length: MAX_URLS + 1 }, (_, index) => `${SITE}/p${index}`)
    expect(payloads(SITE, urls).map((body) => body.urlList.length)).toEqual([MAX_URLS, 1])
  })

  it('needs to be told what to submit, and refuses a date it cannot read', () => {
    expect(() => parseArgs([], {})).toThrow(/say what to submit/)
    expect(() => parseArgs(['--since=yesterday'], {})).toThrow(/not a date/)
    expect(
      parseArgs(['--', '--all', '--dry-run'], { SITE_URL: 'http://localhost:3100' }).options,
    ).toMatchObject({
      site: 'http://localhost:3100',
      all: true,
      dryRun: true,
      since: null,
    })
  })

  it('serves the key file the engines check', async () => {
    const { readFile } = await import('node:fs/promises')
    const served = await readFile(join(process.cwd(), 'public', `${INDEXNOW_KEY}.txt`), 'utf8')
    expect(served).toBe(INDEXNOW_KEY)
  })
})
