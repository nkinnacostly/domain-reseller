import { describe, expect, it } from 'vitest'
import { addressIn, csvRows, IMPORT_LIMITS, importChunks, readSuppressionList } from '../lib/import'

/**
 * Reading another provider's suppression list (migration 68): their CSV
 * exports as they are written, quoting and all, or a plain list.
 */

describe('readSuppressionList', () => {
  it('reads each provider’s export by its address column', () => {
    const exports = {
      sendgrid:
        'email,created,reason,status\r\nada@example.com,1696000000,"550 5.1.1 no, such user",5.1.1\r\n',
      mailgun: 'address,code,error,created_at\nAda@Example.COM,550,"bounce, hard",Mon\n',
      postmark: 'Email;Reason;Origin\nada@example.com;HardBounce;Recipient\n',
      brevo: 'EMAIL\tBLOCKED_AT\nada@example.com\t2026-10-01\n',
      mailchimp: '"Email Address",First Name\n"ada@example.com",Ada\n',
    }
    for (const [provider, text] of Object.entries(exports)) {
      expect(readSuppressionList(text), provider).toEqual({
        addresses: ['ada@example.com'],
        skipped: 0,
        truncated: false,
      })
    }
  })

  it('uses only the address column when another column holds an address too', () => {
    const text = 'from,email\nsender@acme.example,ada@example.com\nsender@acme.example,\n'
    expect(readSuppressionList(text)).toEqual({
      addresses: ['ada@example.com'],
      skipped: 1,
      truncated: false,
    })
  })

  it('reads a plain list, a BOM, Name <address>, and counts what is not one', () => {
    const text = '﻿ada@example.com\nBola <BOLA@example.com>\n\nnot an address\nada@example.com\n'
    expect(readSuppressionList(text)).toEqual({
      addresses: ['ada@example.com', 'bola@example.com'],
      skipped: 1,
      truncated: false,
    })
  })

  it('without a heading it knows, takes each row’s first address', () => {
    const text = 'Contact,Status\nAda,ada@example.com\nBola,unsubscribed\n'
    expect(readSuppressionList(text)).toEqual({
      addresses: ['ada@example.com'],
      skipped: 1,
      truncated: false,
    })
  })

  it('stops at one import’s limit and says so', () => {
    const text = Array.from(
      { length: IMPORT_LIMITS.maxAddresses + 2 },
      (_, i) => `u${i}@example.com`,
    ).join('\n')
    const list = readSuppressionList(text)
    expect(list.addresses).toHaveLength(IMPORT_LIMITS.maxAddresses)
    expect(list.truncated).toBe(true)
  })

  it('finds nothing in an empty file or a heading alone', () => {
    expect(readSuppressionList('').addresses).toEqual([])
    expect(readSuppressionList('email\n').addresses).toEqual([])
  })
})

describe('csvRows and addressIn', () => {
  it('keeps quoted delimiters, doubled quotes and line breaks inside a cell', () => {
    expect(csvRows('a,"b, ""c""\nd",e\r\nf')).toEqual([['a', 'b, "c"\nd', 'e'], ['f']])
  })

  it('takes an address, lower-cased, and nothing that is not one', () => {
    expect(addressIn('  Ada.Obi@Example.com ')).toBe('ada.obi@example.com')
    expect(addressIn('nobody')).toBeNull()
    expect(addressIn('two@x.example three@y.example')).toBeNull()
  })
})

describe('importChunks', () => {
  it('splits by count and by size, keeping every address once, in order', () => {
    const many = Array.from({ length: 12_001 }, (_, i) => `u${i}@example.com`)
    const byCount = importChunks(many)
    expect(byCount.map((chunk) => chunk.length)).toEqual([5000, 5000, 2001])
    expect(byCount.flat()).toEqual(many)

    const long = Array.from({ length: 3000 }, (_, i) => `${'x'.repeat(240)}${i}@example.com`)
    const bySize = importChunks(long)
    expect(bySize.length).toBeGreaterThan(1)
    for (const chunk of bySize) {
      expect(chunk.join('","').length).toBeLessThanOrEqual(IMPORT_LIMITS.chunkChars)
    }
    expect(bySize.flat()).toEqual(long)
    expect(importChunks([])).toEqual([])
  })
})
