import { beforeEach, describe, expect, it, vi } from 'vitest'

const answers = new Map<string, unknown>()
const failures = new Map<string, string>()

/** A resolver double keyed by "method:name", failing with a DNS error code when told to. */
class FakeResolver {
  setServers() {}
  async call(method: string, name: string) {
    const key = `${method}:${name}`
    const failure = failures.get(key) ?? failures.get(`*:${name}`)
    if (failure) throw Object.assign(new Error(failure), { code: failure })
    if (answers.has(key)) return answers.get(key)
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

// Other modules use the real one; only our Resolver is replaced.
vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>()
  return { ...actual, default: { ...actual, Resolver: FakeResolver }, Resolver: FakeResolver }
})

const { delegationViews, inspectDns, lookupHost } = await import('../queries/dns')

beforeEach(() => {
  answers.clear()
  failures.clear()
})

describe('lookupHost (FR-D4)', () => {
  it('resolves with either an IPv4 or an IPv6 address', async () => {
    answers.set('AAAA:ns1.v6only.com', ['2001:db8::1'])
    expect(await lookupHost('ns1.v6only.com')).toBe('resolves')
  })

  it('reports a name that does not exist as nxdomain — a typo', async () => {
    failures.set('*:ns1.whogohst.com', 'ENOTFOUND')
    expect(await lookupHost('ns1.whogohst.com')).toBe('nxdomain')
  })

  it('reports a timeout as no answer, not as a typo', async () => {
    failures.set('*:ns1.slow.com', 'ETIMEOUT')
    expect(await lookupHost('ns1.slow.com')).toBe('no-answer')
  })
})

describe('delegationViews (FR-D6)', () => {
  it('asks all three resolvers and sorts what each sees', async () => {
    answers.set('NS:getpaid.com', ['NS2.Vercel-DNS.com', 'ns1.vercel-dns.com'])
    const views = await delegationViews('getpaid.com')
    expect(views.map((view) => view.resolver)).toEqual(['Cloudflare', 'Google', 'Quad9'])
    expect(views[0]).toEqual({
      resolver: 'Cloudflare',
      state: 'answered',
      nameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'],
    })
  })

  it('says a domain is not in DNS rather than showing nothing', async () => {
    failures.set('NS:nowhere.com', 'ENOTFOUND')
    expect((await delegationViews('nowhere.com'))[0]).toEqual({
      resolver: 'Cloudflare',
      state: 'nxdomain',
    })
  })
})

describe('inspectDns (FR-N4)', () => {
  it('collects each record type, MX by priority, TXT chunks joined', async () => {
    answers.set('A:getpaid.com', ['76.76.21.21'])
    answers.set('MX:getpaid.com', [
      { exchange: 'backup.mail.com', priority: 20 },
      { exchange: 'mail.com', priority: 10 },
    ])
    answers.set('TXT:getpaid.com', [['v=spf1 ', 'include:mail.com ~all']])
    answers.set('CAA:getpaid.com', [{ critical: 0, issue: 'letsencrypt.org' }])

    const records = await inspectDns('getpaid.com')
    expect(records).toMatchObject({
      exists: true,
      a: ['76.76.21.21'],
      mx: [
        { exchange: 'mail.com', priority: 10 },
        { exchange: 'backup.mail.com', priority: 20 },
      ],
      txt: ['v=spf1 include:mail.com ~all'],
      caa: ['issue "letsencrypt.org"'],
    })
  })

  it('knows a domain with no records at all is not in DNS', async () => {
    failures.set('*:nowhere.com', 'ENOTFOUND')
    expect((await inspectDns('nowhere.com')).exists).toBe(false)
  })
})
