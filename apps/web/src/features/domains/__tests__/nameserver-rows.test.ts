import { describe, expect, it } from 'vitest'
import {
  joinRows,
  type NameserverRow,
  pastedNameservers,
  pasteInto,
  toRows,
} from '../lib/nameserver-rows'
import { registrarSide } from '../lib/registrar-default'

function keys() {
  let next = 100
  return () => {
    next += 1
    return next
  }
}

const values = (rows: readonly NameserverRow[]) => rows.map((row) => row.value)

describe('toRows (FR-D1)', () => {
  it('gives each nameserver on file its own row', () => {
    expect(values(toRows(['ns1.a.com', 'ns2.a.com', 'ns3.a.com'], keys()))).toEqual([
      'ns1.a.com',
      'ns2.a.com',
      'ns3.a.com',
    ])
  })

  it('pads to the two a registry needs, so there is always somewhere to type', () => {
    expect(values(toRows([], keys()))).toEqual(['', ''])
    expect(values(toRows(['ns1.a.com'], keys()))).toEqual(['ns1.a.com', ''])
  })

  it('keys every row apart', () => {
    const rows = toRows(['ns1.a.com'], keys())
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length)
  })
})

describe('pastedNameservers — a host’s email pasted into one row', () => {
  it('splits a list on lines, commas and spaces', () => {
    expect(pastedNameservers('ns1.host.ng\nns2.host.ng')).toEqual(['ns1.host.ng', 'ns2.host.ng'])
    expect(pastedNameservers('ns1.host.ng, ns2.host.ng; ns3.host.ng')).toEqual([
      'ns1.host.ng',
      'ns2.host.ng',
      'ns3.host.ng',
    ])
  })

  it('keeps the hostnames and drops the words around them', () => {
    expect(pastedNameservers('Nameserver 1: ns1.host.ng\r\nNameserver 2: ns2.host.ng')).toEqual([
      'ns1.host.ng',
      'ns2.host.ng',
    ])
  })

  it('leaves a single entry to the input, trailing newline and all', () => {
    expect(pastedNameservers('ns1.host.ng')).toBeNull()
    expect(pastedNameservers('  ns1.host.ng\n')).toBeNull()
    expect(pastedNameservers('')).toBeNull()
  })

  it('leaves words with no hostname in them to the input, for the check to explain', () => {
    expect(pastedNameservers('not a hostname')).toBeNull()
  })
})

describe('pasteInto', () => {
  const rows: NameserverRow[] = [
    { key: 1, value: 'ns1.old.com' },
    { key: 2, value: '' },
    { key: 3, value: 'ns9.keep.com' },
  ]

  it('fills the row pasted into and adds rows after it, empty ones making way', () => {
    const next = pasteInto(rows, 0, ['ns1.new.ng', 'ns2.new.ng', 'ns3.new.ng'], keys())
    expect(values(next)).toEqual(['ns1.new.ng', 'ns2.new.ng', 'ns3.new.ng', 'ns9.keep.com'])
    // The row pasted into keeps its key, so it keeps focus and identity.
    expect(next[0]?.key).toBe(1)
    expect(next.at(-1)?.key).toBe(3)
  })

  it('keeps the rows above the one pasted into', () => {
    expect(values(pasteInto(rows, 1, ['ns2.new.ng', 'ns3.new.ng'], keys()))).toEqual([
      'ns1.old.com',
      'ns2.new.ng',
      'ns3.new.ng',
      'ns9.keep.com',
    ])
  })

  it('changes nothing for a row that is not there', () => {
    expect(pasteInto(rows, 7, ['ns1.new.ng', 'ns2.new.ng'], keys())).toEqual(rows)
  })
})

describe('joinRows — what the action receives', () => {
  it('sends the filled rows one per line, as the old box did', () => {
    expect(
      joinRows([
        { key: 1, value: ' ns1.a.com ' },
        { key: 2, value: '' },
        { key: 3, value: '   ' },
        { key: 4, value: 'ns2.a.com' },
      ]),
    ).toBe('ns1.a.com\nns2.a.com')
  })

  it('sends an empty string when nothing is filled, for the action to refuse', () => {
    expect(joinRows(toRows([], keys()))).toBe('')
  })
})

describe('registrarSide (migration 35)', () => {
  it.each([
    [{ source: 'registration', testMode: false }, 'live'],
    [{ source: 'transfer', testMode: false }, 'live'],
    [{ source: 'registration', testMode: true }, 'sandbox'],
    [{ source: 'demo', testMode: false }, 'live'],
    [{ source: 'demo', testMode: true }, 'live'],
  ] as const)('%o takes the %s default', (domain, side) => {
    expect(registrarSide(domain)).toBe(side)
  })
})
