import type { DnsRecord } from './records'

/**
 * Each record as the public internet sees it right now (MAIL-SPEC §5: "checks
 * them live from public DNS", as the shop's DNS views do — CLAUDE.md §15):
 * asked of Cloudflare and Google over DNS-over-HTTPS (the JSON form), with a
 * short timeout, and never cached. A resolver we could not ask counts for
 * nothing either way.
 */

export type DohResolver = { name: string; url: string }

export const PUBLIC_RESOLVERS: readonly DohResolver[] = [
  { name: 'Cloudflare', url: 'https://cloudflare-dns.com/dns-query' },
  { name: 'Google', url: 'https://dns.google/resolve' },
]

/**
 *   found     — every resolver that answered has it
 *   spreading — some have it, some not yet (DNS takes time to spread)
 *   different — the name has a value, but not this one (`seen` says what)
 *   missing   — nobody has it
 *   unknown   — no resolver answered
 */
export type RecordState = 'found' | 'spreading' | 'different' | 'missing' | 'unknown'

export type RecordCheck = { id: string; state: RecordState; seen: string[] }

type View = { state: 'found' | 'different' | 'missing' | 'unknown'; seen: string[] }

const TYPE_CODE = { CNAME: 5, MX: 15, TXT: 16 } as const

const normaliseHost = (value: string) => value.trim().toLowerCase().replace(/\.+$/, '')

/** A TXT answer's text: `"v=spf1 " "include:…"` → `v=spf1 include:…`. */
export function txtText(data: string): string {
  const chunks = data.match(/"((?:[^"\\]|\\.)*)"/g)
  return chunks ? chunks.map((chunk) => chunk.slice(1, -1).replace(/\\(.)/g, '$1')).join('') : data
}

const squash = (value: string) =>
  value.trim().replace(/\s+/g, ' ').replace(/;\s*$/, '').toLowerCase()

/** Whether one answer's data is the record we asked for. */
export function matches(record: DnsRecord, data: string): boolean {
  switch (record.type) {
    case 'CNAME':
      return normaliseHost(data) === normaliseHost(record.value)
    case 'MX': {
      // The priority does not decide where bounces go; the host does.
      const host = data.trim().split(/\s+/).pop() ?? ''
      return normaliseHost(host) === normaliseHost(record.value)
    }
    case 'TXT':
      // Any DMARC policy the owner already has is theirs to keep.
      return record.purpose === 'dmarc'
        ? /^v=dmarc1(;|\s|$)/i.test(txtText(data).trim())
        : squash(txtText(data)) === squash(record.value)
  }
}

/** Answers of other records on the same name that would be the same kind (an SPF, a DMARC). */
function relevant(record: DnsRecord, data: string): boolean {
  if (record.type !== 'TXT') return true
  const text = txtText(data).trim().toLowerCase()
  return record.purpose === 'dmarc' ? text.startsWith('v=dmarc1') : text.startsWith('v=spf1')
}

/** One resolver's view of one record. */
export function readView(record: DnsRecord, body: unknown): View {
  if (typeof body !== 'object' || body === null) return { state: 'unknown', seen: [] }
  const { Status, Answer } = body as { Status?: unknown; Answer?: unknown }
  if (Status === 3) return { state: 'missing', seen: [] }
  if (Status !== 0) return { state: 'unknown', seen: [] }
  const owner = normaliseHost(record.name)
  const data: string[] = []
  for (const item of Array.isArray(Answer) ? Answer : []) {
    if (typeof item !== 'object' || item === null) continue
    const { name, type, data: value } = item as { name?: unknown; type?: unknown; data?: unknown }
    if (type !== TYPE_CODE[record.type] || typeof value !== 'string' || typeof name !== 'string') {
      continue
    }
    if (normaliseHost(name) !== owner) continue
    data.push(value)
  }
  if (data.some((value) => matches(record, value))) return { state: 'found', seen: [] }
  const seen = data
    .filter((value) => relevant(record, value))
    .map((value) => (record.type === 'TXT' ? txtText(value) : normaliseHost(value)))
  return seen.length > 0 ? { state: 'different', seen } : { state: 'missing', seen: [] }
}

export function combine(id: string, views: View[]): RecordCheck {
  const answered = views.filter((view) => view.state !== 'unknown')
  if (answered.length === 0) return { id, state: 'unknown', seen: [] }
  const found = answered.filter((view) => view.state === 'found').length
  if (found === answered.length) return { id, state: 'found', seen: [] }
  if (found > 0) return { id, state: 'spreading', seen: [] }
  const seen = [...new Set(answered.flatMap((view) => view.seen))]
  return { id, state: seen.length > 0 ? 'different' : 'missing', seen }
}

export type DnsLookup = (records: readonly DnsRecord[]) => Promise<RecordCheck[]>

export function createDnsLookup({
  resolvers = PUBLIC_RESOLVERS,
  fetchImpl = fetch,
  timeoutMs = 3_000,
}: {
  resolvers?: readonly DohResolver[]
  fetchImpl?: typeof fetch
  timeoutMs?: number
} = {}): DnsLookup {
  async function ask(resolver: DohResolver, record: DnsRecord): Promise<View> {
    const url = new URL(resolver.url)
    url.searchParams.set('name', record.name)
    url.searchParams.set('type', record.type)
    try {
      const response = await fetchImpl(url, {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(timeoutMs),
        cache: 'no-store',
      })
      if (!response.ok) return { state: 'unknown', seen: [] }
      return readView(record, await response.json())
    } catch {
      return { state: 'unknown', seen: [] }
    }
  }

  return (records) =>
    Promise.all(
      records.map(async (record) =>
        combine(record.id, await Promise.all(resolvers.map((resolver) => ask(resolver, record)))),
      ),
    )
}
