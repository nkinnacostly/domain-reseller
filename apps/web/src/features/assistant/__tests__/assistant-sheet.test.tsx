import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchRow } from '@/features/search/lib/rows'
import type { AskAssistantResult } from '../lib/conversation'

vi.mock('../actions/ask-assistant', () => ({ askAssistant: vi.fn() }))
vi.mock('@/features/cart/components/add-to-cart-button', () => ({
  AddToCartButton: ({ domain, addedVia }: { domain: string; addedVia?: string }) => (
    <button type="button" data-added-via={addedVia}>
      Add {domain}
    </button>
  ),
}))

const { askAssistant } = await import('../actions/ask-assistant')
const { AssistantSheet } = await import('../components/assistant-sheet')
const { SiteAssistant } = await import('../components/site-assistant')

const row = (domain: string, status: SearchRow['status'] = 'available'): SearchRow => ({
  domain,
  display: domain,
  name: domain.split('.')[0] ?? domain,
  tld: 'com',
  status,
  price: {
    register: '₦18,300',
    registerYears: 1,
    renew: '₦18,700',
    renewYears: 1,
    renewalIsHigher: true,
    includesIcannFee: true,
    maxPeriod: 10,
  },
})

const answers = (...results: AskAssistantResult[]) => {
  for (const result of results)
    vi.mocked(askAssistant).mockResolvedValueOnce({ data: result } as never)
}

const open = () => render(<AssistantSheet open onOpenChange={() => {}} />)
const conversation = () => screen.getByRole('log', { name: 'Conversation' })
const say = async (text: string) => {
  await userEvent.type(screen.getByRole('textbox', { name: 'Your message' }), text)
  await userEvent.click(screen.getByRole('button', { name: 'Send' }))
}

beforeEach(() => vi.resetAllMocks())

describe('AssistantSheet (AI phase 5)', () => {
  it('opens on starters, says where words go, and asks for more than a letter', async () => {
    open()
    expect(screen.getByRole('dialog', { name: 'Ask MyDomainsHub' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Is lagosbakes.com free?' })).toBeInTheDocument()
    expect(screen.getByText(/AI by DeepSeek/)).toHaveTextContent(
      'email addresses and phone numbers taken out',
    )
    await say('x')
    expect(screen.getByText('Type a few words first.')).toBeInTheDocument()
    expect(askAssistant).not.toHaveBeenCalled()
  })

  it('shows what went wrong, with somewhere else to go', async () => {
    answers({ ok: false, reason: 'unavailable' })
    open()
    await say('Is lagosbakes.com free?')
    expect(await within(conversation()).findByRole('alert')).toHaveTextContent(
      'Try again, or use search or the help centre.',
    )
  })

  it('lists checked names with both prices, and sends the memo back with the next message', async () => {
    answers(
      {
        ok: true,
        reply: {
          kind: 'check',
          rows: [row('lagosbakes.com'), row('taken.com', 'registered')],
          notSold: [],
        },
        memo: 'Checked: lagosbakes.com is free, taken.com is not free.',
      },
      { ok: true, reply: { kind: 'other' }, memo: 'Said what the assistant can help with.' },
    )
    open()
    await userEvent.click(screen.getByRole('button', { name: 'Is lagosbakes.com free?' }))
    const list = await within(conversation()).findByRole('list', { name: 'Names checked' })
    expect(list).toHaveTextContent('lagosbakes.com')
    expect(list).toHaveTextContent('₦18,300')
    expect(list).toHaveTextContent('₦18,700')
    expect(within(list).getByRole('button', { name: 'Add lagosbakes.com' })).toHaveAttribute(
      'data-added-via',
      'site_assistant',
    )

    await say('thanks')
    expect(askAssistant).toHaveBeenLastCalledWith({
      message: 'thanks',
      history: [
        { role: 'person', text: 'Is lagosbakes.com free?' },
        { role: 'assistant', text: 'Checked: lagosbakes.com is free, taken.com is not free.' },
      ],
    })
    expect(
      await within(conversation()).findByText(/I can find a name for your business/),
    ).toBeVisible()
  })

  it('shows name ideas in their language, and says when the extension was not sold', async () => {
    answers({
      ok: true,
      reply: {
        kind: 'names',
        ideas: [{ row: row('tailorwey.com'), why: 'Tailor wey sabi' }],
        checked: 20,
        tld: 'com',
        language: 'pcm',
        notSold: 'ng',
      },
      memo: 'Suggested available .com names: tailorwey.com.',
    })
    open()
    await say('Pidgin names for my tailor shop')
    expect(await screen.findByText('We don’t sell .ng, so these are .com names.')).toBeVisible()
    expect(screen.getByText('Tailor wey sabi')).toHaveAttribute('lang', 'pcm')
    expect(screen.getByRole('link', { name: 'name finder' })).toHaveAttribute('href', '/ideas')
  })

  it('gives a checked preset’s nameservers, or general steps for a host we hold none for', async () => {
    answers(
      {
        ok: true,
        reply: {
          kind: 'setup',
          host: 'vercel',
          preset: {
            provider: 'Vercel',
            nameservers: ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'],
            assignsPerZone: false,
            sourceUrl: 'https://vercel.com/docs',
          },
        },
        memo: 'Explained pointing a domain at Vercel.',
      },
      {
        ok: true,
        reply: { kind: 'setup', host: 'Wix', preset: null },
        memo: 'Explained pointing a domain at Wix.',
      },
    )
    open()
    await say('Point at vercel')
    expect(await screen.findByText('ns1.vercel-dns.com')).toBeVisible()
    expect(screen.getByRole('link', { name: 'Vercel’s own instructions' })).toHaveAttribute(
      'href',
      'https://vercel.com/docs',
    )
    await say('And Wix?')
    expect(await screen.findByText(/Ask Wix which nameservers to use/)).toBeVisible()
  })

  it('quotes prices with their renewal and VAT, and offers email when help has no answer', async () => {
    answers(
      {
        ok: true,
        reply: {
          kind: 'prices',
          prices: [{ tld: 'com', words: '₦18,300 for the first year, then ₦18,700 a year' }],
          notSold: ['.zz'],
          vatPct: 7.5,
        },
        memo: 'Showed prices for .com.',
      },
      {
        ok: true,
        reply: { kind: 'help', help: { answered: false } },
        memo: 'The help centre did not cover that question.',
      },
    )
    open()
    await say('How much is .com?')
    expect(
      await screen.findByText('— ₦18,300 for the first year, then ₦18,700 a year', {
        exact: false,
      }),
    ).toBeVisible()
    expect(screen.getByText('We don’t sell .zz.')).toBeVisible()
    expect(screen.getByText(/Before VAT \(7.5%\)/)).toBeVisible()
    await say('Can I pay in dollars?')
    expect(await screen.findByRole('link', { name: 'hello@mydomainshub.com' })).toHaveAttribute(
      'href',
      'mailto:hello@mydomainshub.com',
    )
  })
})

describe('SiteAssistant', () => {
  it('is one labelled button until pressed, then opens the conversation', async () => {
    render(<SiteAssistant />)
    const button = screen.getByRole('button', { name: 'Ask MyDomainsHub' })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await userEvent.click(button)
    expect(await screen.findByRole('dialog', { name: 'Ask MyDomainsHub' })).toBeInTheDocument()
  })
})
