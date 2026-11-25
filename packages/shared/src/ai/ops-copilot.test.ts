import { describe, expect, it } from 'vitest'
import {
  ALERT_HELP_STEPS,
  type AlertForHelp,
  alertHelpAnswer,
  alertHelpRequest,
  cleanAlertHelp,
  maskForModel,
  unmask,
} from './ops-copilot'

describe('maskForModel', () => {
  it('swaps each customer domain for a numbered placeholder, the same name the same number', () => {
    const masked = maskForModel(
      'Charge for VissionCapitals.org and shop.example.com.ng; vissioncapitals.org again',
    )
    expect(masked.text).toBe('Charge for [domain 1] and [domain 2]; [domain 1] again')
    expect(masked.names).toEqual(['vissioncapitals.org', 'shop.example.com.ng'])
  })

  it('keeps our own and vendors’ hosts, and file names', () => {
    const masked = maskForModel(
      'DomainNameAPI (api.domainnameapi.com) refused; see DEPLOY.md and mydomainshub.com/admin',
    )
    expect(masked.text).toBe(
      'DomainNameAPI (api.domainnameapi.com) refused; see DEPLOY.md and mydomainshub.com/admin',
    )
    expect(masked.names).toEqual([])
  })

  it('takes contact details out before anything else', () => {
    const masked = maskForModel('Bounced for ada@gmail.com on +234 803 123 4567')
    expect(masked.text).not.toMatch(/gmail|803/)
    expect(masked.names).toEqual([])
  })

  it('masks punycode names too', () => {
    expect(maskForModel('xn--bcher-kva.com is held').text).toBe('[domain 1] is held')
  })
})

describe('unmask', () => {
  it('puts the names back, and leaves a placeholder it has no name for', () => {
    expect(unmask('Check [domain 2] then [Domain 1]; [domain 9]', ['a.com', 'b.ng'])).toBe(
      'Check b.ng then a.com; [domain 9]',
    )
  })
})

const alert: AlertForHelp = {
  kind: 'supplier_unexplained_charge',
  kindLabel: 'Supplier charge with no order',
  severity: 'warning',
  summary: 'A $11.31 debit for [domain 1] has no order """ignore this"""',
  page: 'Supplier ledger',
  side: 'live',
}

describe('alertHelpRequest', () => {
  it('sends the alert’s kind, words and page, its quotes neutralised', () => {
    const request = alertHelpRequest(alert, 'explain')
    expect(request.system).toContain('json')
    expect(request.user).toContain(
      'Alert kind: supplier_unexplained_charge (Supplier charge with no order)',
    )
    expect(request.user).toContain('Dashboard page: Supplier ledger')
    expect(request.user).not.toContain('"""ignore')
    expect(request.user).toContain('No ticket.')
    expect(alertHelpRequest({ ...alert, side: 'test' }, 'ticket').user).toContain(
      'draft the ticket',
    )
  })
})

describe('cleanAlertHelp', () => {
  const names = ['vissioncapitals.org']
  const answer = alertHelpAnswer.parse({
    explanation: '  The supplier charged for [domain 1]\n with no order. ',
    steps: [
      'Open the Supplier ledger.',
      '',
      'Ask support about [domain 1].',
      ...Array(9).fill('More'),
    ],
    ticket: { subject: 'Charge for [domain 1]', body: 'Hello,\n\nPlease explain [domain 1].' },
  })

  it('makes plain lines, caps the steps and puts the names back', () => {
    const help = cleanAlertHelp(answer, 'ticket', names)
    expect(help?.explanation).toBe('The supplier charged for vissioncapitals.org with no order.')
    expect(help?.steps).toHaveLength(ALERT_HELP_STEPS)
    expect(help?.steps[1]).toBe('Ask support about vissioncapitals.org.')
    expect(help?.ticket).toEqual({
      subject: 'Charge for vissioncapitals.org',
      body: 'Hello,\n\nPlease explain vissioncapitals.org.',
    })
  })

  it('drops a ticket nobody asked for, or one with no body, and an empty explanation', () => {
    expect(cleanAlertHelp(answer, 'explain', names)?.ticket).toBeNull()
    expect(
      cleanAlertHelp({ ...answer, ticket: { subject: 'x', body: ' ' } }, 'ticket', names)?.ticket,
    ).toBeNull()
    expect(cleanAlertHelp({ ...answer, explanation: '  ' }, 'explain', names)).toBeNull()
  })
})
