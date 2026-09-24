import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The DNS wire is the boundary: a resolver double that answers per server
 * ("1.1.1.1|NS:getpaid.com"), or for every server ("*|NS:getpaid.com"), and
 * fails with a DNS error code when told to.
 */
const answers = new Map<string, unknown>()
const failures = new Map<string, string>()

class FakeResolver {
  server = ''
  setServers([address]: string[]) {
    this.server = address ?? ''
  }
  async call(type: string, name: string) {
    const keys = [`${this.server}|${type}:${name}`, `*|${type}:${name}`, `*|*:${name}`]
    const failure = keys.map((key) => failures.get(key)).find(Boolean)
    if (failure) throw Object.assign(new Error(failure), { code: failure })
    const key = keys.find((candidate) => answers.has(candidate))
    if (key) return answers.get(key)
    throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' })
  }
  resolve4(name: string) {
    return this.call('A', name)
  }
  resolve6(name: string) {
    return this.call('AAAA', name)
  }
  resolveNs(name: string) {
    return this.call('NS', name)
  }
  resolveCname(name: string) {
    return this.call('CNAME', name)
  }
  resolveMx(name: string) {
    return this.call('MX', name)
  }
  resolveTxt(name: string) {
    return this.call('TXT', name)
  }
  resolveCaa(name: string) {
    return this.call('CAA', name)
  }
}

vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>()
  return { ...actual, default: { ...actual, Resolver: FakeResolver }, Resolver: FakeResolver }
})

const { currentRecordSummary, DnsRecords, DnsSkeleton, ResolverViews } = await import(
  '../components/dns-sections'
)

const VERCEL = ['ns1.vercel-dns.com', 'ns2.vercel-dns.com']

beforeEach(() => {
  answers.clear()
  failures.clear()
})

function resolverRow(name: string) {
  const list = screen.getByRole('list', { name: 'What public resolvers see' })
  const row = within(list)
    .getAllByRole('listitem')
    .find((item) => item.textContent?.startsWith(name))
  if (!row) throw new Error(`No row for ${name}`)
  return row
}

describe('ResolverViews (FR-D6)', () => {
  it('shows what each big public resolver sees right now', async () => {
    answers.set('*|NS:getpaid.com', ['NS2.vercel-dns.com', 'ns1.vercel-dns.com'])
    render(await ResolverViews({ domain: 'getpaid.com', expected: VERCEL }))

    const rows = within(
      screen.getByRole('list', { name: 'What public resolvers see' }),
    ).getAllByRole('listitem')
    expect(rows.map((row) => row.textContent)).toEqual([
      'Cloudflare, matches what you setns1.vercel-dns.com, ns2.vercel-dns.com',
      'Google, matches what you setns1.vercel-dns.com, ns2.vercel-dns.com',
      'Quad9, matches what you setns1.vercel-dns.com, ns2.vercel-dns.com',
    ])
  })

  it('tells apart a resolver still on the old nameservers from one that has caught up', async () => {
    answers.set('1.1.1.1|NS:getpaid.com', VERCEL)
    answers.set('8.8.8.8|NS:getpaid.com', ['ns1.oldhost.com', 'ns2.oldhost.com'])
    answers.set('9.9.9.9|NS:getpaid.com', VERCEL)
    render(await ResolverViews({ domain: 'getpaid.com', expected: VERCEL }))

    expect(resolverRow('Google')).toHaveTextContent('ns1.oldhost.com, ns2.oldhost.com')
    // The icon marks a mismatch to the eye; the words say it to a screen reader.
    expect(resolverRow('Google').querySelector('svg.lucide-circle-x')).not.toBeNull()
    expect(resolverRow('Google')).toHaveTextContent('does not match what you set')
    expect(resolverRow('Cloudflare')).toHaveTextContent('matches what you set')
    expect(resolverRow('Cloudflare').querySelector('svg.lucide-circle-check')).not.toBeNull()
  })

  it('shows the answer without judging it when there is nothing to compare with', async () => {
    answers.set('*|NS:getpaid.com', VERCEL)
    render(await ResolverViews({ domain: 'getpaid.com', expected: null }))
    expect(resolverRow('Quad9')).toHaveTextContent('ns1.vercel-dns.com, ns2.vercel-dns.com')
    expect(resolverRow('Quad9').querySelector('svg.lucide-circle-check')).not.toBeNull()
    expect(resolverRow('Quad9')).not.toHaveTextContent('match')
  })

  it('says a name is not in DNS yet, and a resolver that did not answer did not answer', async () => {
    failures.set('1.1.1.1|NS:new.ng', 'ENOTFOUND')
    failures.set('8.8.8.8|NS:new.ng', 'ETIMEOUT')
    failures.set('9.9.9.9|NS:new.ng', 'ENOTFOUND')
    render(await ResolverViews({ domain: 'new.ng', expected: VERCEL }))

    expect(resolverRow('Cloudflare')).toHaveTextContent(
      'Not in DNS yet — no nameservers answer for this name',
    )
    expect(resolverRow('Google')).toHaveTextContent('No answer just now')
    expect(resolverRow('Google').querySelector('svg.lucide-circle-dashed')).not.toBeNull()
  })
})

describe('DnsRecords (FR-N4)', () => {
  it('says there is nothing yet for a name that is not in DNS', async () => {
    failures.set('*|*:new.ng', 'ENOTFOUND')
    render(await DnsRecords({ domain: 'new.ng' }))

    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(
      screen.getByText(
        /new\.ng has no DNS records yet\. Once it is registered and pointed at your host/,
      ),
    ).toBeInTheDocument()
  })

  it('lists every record type, in words, as a public resolver sees them', async () => {
    answers.set('*|A:getpaid.com', ['76.76.21.21'])
    answers.set('*|MX:getpaid.com', [
      { exchange: 'alt.mail.com', priority: 20 },
      { exchange: 'mail.com', priority: 10 },
    ])
    answers.set('*|TXT:getpaid.com', [['v=spf1 include:mail.com ~all']])
    answers.set('*|CAA:getpaid.com', [{ critical: 0, issue: 'letsencrypt.org' }])
    render(await DnsRecords({ domain: 'getpaid.com' }))

    const table = screen.getByRole('table', {
      name: 'DNS records for getpaid.com, as a public resolver sees them',
    })
    // Each row header is the record type, then what it is for.
    const row = (type: string) => {
      const header = within(table)
        .getAllByRole('rowheader')
        .find((cell) => cell.firstChild?.textContent === type)
      const tr = header?.closest('tr')
      if (!header || !tr) throw new Error(`No ${type} row`)
      return { meaning: header.lastChild?.textContent, records: within(tr).getByRole('cell') }
    }

    expect(row('A').meaning).toBe('Website address (IPv4)')
    expect(row('A').records).toHaveTextContent(/^76\.76\.21\.21$/)
    expect(row('AAAA').records).toHaveTextContent(/^None$/)
    expect(row('CNAME').records).toHaveTextContent(/^None$/)
    expect(row('MX').meaning).toBe('Email')
    expect(row('MX').records.textContent).toBe('10 mail.com\n20 alt.mail.com')
    expect(row('TXT').records).toHaveTextContent(/^v=spf1 include:mail\.com ~all$/)
    expect(row('CAA').meaning).toBe('Who may issue certificates')
    expect(row('CAA').records).toHaveTextContent(/^issue "letsencrypt\.org"$/)
  })
})

describe('currentRecordSummary (FR-N6)', () => {
  it('names what the current provider serves, counted', async () => {
    answers.set('*|AAAA:getpaid.com', ['2001:db8::1'])
    answers.set('*|MX:getpaid.com', [{ exchange: 'mail.com', priority: 10 }])
    answers.set('*|TXT:getpaid.com', [['v=spf1 -all'], ['google-site-verification=abc']])
    expect(await currentRecordSummary('getpaid.com')).toEqual([
      'a website address',
      'email (1 MX record)',
      '2 TXT records',
    ])
  })

  it('counts in the plural where there are several', async () => {
    answers.set('*|A:getpaid.com', ['76.76.21.21'])
    answers.set('*|MX:getpaid.com', [
      { exchange: 'mail.com', priority: 10 },
      { exchange: 'alt.mail.com', priority: 20 },
    ])
    answers.set('*|TXT:getpaid.com', [['v=spf1 -all']])
    expect(await currentRecordSummary('getpaid.com')).toEqual([
      'a website address',
      'email (2 MX records)',
      '1 TXT record',
    ])
  })

  it('has nothing to warn about for a name with no records', async () => {
    failures.set('*|*:new.ng', 'ENOTFOUND')
    expect(await currentRecordSummary('new.ng')).toEqual([])
  })
})

describe('DnsSkeleton', () => {
  it('draws placeholder rows hidden from screen readers', () => {
    const { container } = render(<DnsSkeleton />)
    const skeleton = container.firstElementChild
    expect(skeleton).toHaveAttribute('aria-hidden', 'true')
    expect(skeleton?.children).toHaveLength(3)
  })

  it('draws as many rows as the section will need', () => {
    const { container } = render(<DnsSkeleton rows={5} />)
    expect(container.firstElementChild?.children).toHaveLength(5)
  })
})
