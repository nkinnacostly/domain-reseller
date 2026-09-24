import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { BulkResults, BulkSummary } from '../components/bulk-results'
import type { BulkLine } from '../lib/bulk'

const line = (domainName: string, overrides: Partial<BulkLine> = {}): BulkLine => ({
  domainId: domainName,
  domainName,
  outcome: 'queued',
  reason: null,
  jobStatus: 'queued',
  jobErrorCode: null,
  ...overrides,
})

const LINES = [
  line('applied.com', { jobStatus: 'succeeded' }),
  line('waiting.com', { jobStatus: 'running' }),
  line('held.com', { jobStatus: 'needs_attention' }),
  line('refused.com', { jobStatus: 'failed', jobErrorCode: 'DOMAIN_NOT_FOUND' }),
  line('same.com', { outcome: 'skipped', reason: 'unchanged', jobStatus: null }),
  line('sample.com', { outcome: 'skipped', reason: 'demo', jobStatus: null }),
]

describe('BulkResults (FR-P4)', () => {
  it('gives every domain its outcome in words, linked to its page', () => {
    render(
      <BulkResults kind="transfer_lock" params={{ locked: true }} lines={LINES} domains={{}} />,
    )
    const list = screen.getByRole('list', { name: 'Each domain' })
    const item = (name: string) => {
      const found = within(list)
        .getAllByRole('listitem')
        .find((entry) => entry.getAttribute('data-bulk-line') === name)
      if (!found) throw new Error(`no line for ${name}`)
      return found
    }
    expect(item('applied.com')).toHaveTextContent('Done. The registry confirmed it.')
    expect(item('waiting.com')).toHaveTextContent('Waiting. Being applied at the registry now.')
    expect(item('held.com')).toHaveTextContent('Needs a person. Held for a person to check')
    expect(item('refused.com')).toHaveTextContent(
      'Failed. The registry does not list this domain in our account.',
    )
    expect(item('same.com')).toHaveTextContent('Already set. It is already locked.')
    expect(item('sample.com')).toHaveTextContent('Skipped. A demo domain never reaches a registry.')
    expect(item('refused.com')).toHaveAttribute('data-state', 'failed')
    expect(within(item('applied.com')).getByRole('link', { name: 'applied.com' })).toHaveAttribute(
      'href',
      '/app/domains/applied.com',
    )
  })

  it('says a demo domain’s nameservers were saved but never sent', () => {
    render(
      <BulkResults
        kind="nameservers"
        params={{ nameservers: ['ns1.a.com', 'ns2.a.com'] }}
        lines={[line('sample.com', { outcome: 'done', jobStatus: null })]}
        domains={{ 'sample.com': { source: 'demo', status: 'active' } }}
      />,
    )
    expect(screen.getByRole('listitem')).toHaveTextContent(
      'Saved. This is a demo domain, so nothing is sent to a registry.',
    )
  })

  it('says so when no domain was changed at all', () => {
    render(<BulkResults kind="privacy" params={{ enabled: true }} lines={[]} domains={{}} />)
    expect(screen.getByText(/None of the domains chosen are on your account/)).toBeInTheDocument()
  })
})

describe('BulkSummary', () => {
  it('counts each outcome in words, leaving out the ones with none', () => {
    render(<BulkSummary lines={[...LINES, line('also.com', { jobStatus: 'succeeded' })]} />)
    const summary = screen.getByRole('list', { name: 'Summary' })
    expect(
      within(summary)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['2 done', '1 waiting', '1 needs a person', '1 failed', '1 already set', '1 skipped'])

    render(<BulkSummary lines={[line('a.com', { outcome: 'done' })]} />)
    expect(screen.getAllByRole('list', { name: 'Summary' })[1]).toHaveTextContent(/^1 done$/)
  })
})
