import { describe, expect, it } from 'vitest'
import {
  maskInstruction,
  portfolioIntentAnswer,
  portfolioIntentRequest,
  toPortfolioIntent,
} from './portfolio-copilot'

describe('portfolioIntentRequest', () => {
  it('sends the masked words and the host names only', () => {
    const masked = maskInstruction(
      'Point getpaid.ng and ShopWise.com.ng at Vercel, mail ada@gmail.com',
    )
    expect(masked.text).toBe('Point [domain 1] and [domain 2] at Vercel, mail [email]')
    const request = portfolioIntentRequest(masked.text, ['Vercel', 'Hostinger'])
    expect(request.user).toContain('Hosts: Vercel, Hostinger')
    expect(request.user).not.toMatch(/getpaid|shopwise|gmail/i)
    expect(request.system).toContain('json')
    expect(portfolioIntentRequest('x """ y', []).user).toContain('Hosts: none listed')
  })
})

describe('toPortfolioIntent', () => {
  const names = ['getpaid.ng', 'shopwise.com.ng', 'ns1.myhost.net']

  it('puts the names back and keeps only what the change uses', () => {
    const intent = toPortfolioIntent(
      portfolioIntentAnswer.parse({
        action: 'nameservers',
        on: true,
        host: '  Vercel ',
        nameservers: ['[domain 3]', '[domain 9]', 'NS2.MyHost.net.'],
        select: { domains: ['[domain 1]', '[Domain 2]', '[domain 1]'], extension: '.NG' },
      }),
      names,
    )
    expect(intent).toEqual({
      action: 'nameservers',
      on: null,
      host: 'Vercel',
      nameservers: ['ns1.myhost.net', 'ns2.myhost.net'],
      select: {
        domains: ['getpaid.ng', 'shopwise.com.ng'],
        all: false,
        expiringWithinDays: null,
        label: null,
        extension: 'ng',
      },
      question: null,
    })
  })

  it('keeps on/off for a toggle, and the question when unclear', () => {
    const toggle = toPortfolioIntent(
      portfolioIntentAnswer.parse({
        action: 'auto_renew',
        on: false,
        host: 'Vercel',
        select: { all: true, expiringWithinDays: 60, label: ' clients ' },
      }),
      [],
    )
    expect(toggle.on).toBe(false)
    expect(toggle.host).toBeNull()
    expect(toggle.select).toMatchObject({ all: true, expiringWithinDays: 60, label: 'clients' })
    const unclear = toPortfolioIntent(
      portfolioIntentAnswer.parse({ action: 'none', select: null, question: ' Which domains? ' }),
      [],
    )
    expect(unclear.question).toBe('Which domains?')
    expect(unclear.select.domains).toEqual([])
  })

  it('refuses an unknown change', () => {
    expect(portfolioIntentAnswer.safeParse({ action: 'delete' }).success).toBe(false)
  })
})
