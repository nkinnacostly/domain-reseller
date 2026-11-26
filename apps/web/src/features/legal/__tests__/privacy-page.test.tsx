import { render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '@/lib/env'

vi.mock('next/navigation', () => ({ usePathname: () => '/legal/privacy' }))
// The footer's year is a cached read (site-footer.tsx).
vi.mock('next/cache', () => ({ cacheLife: () => undefined }))
// The header asks Supabase whether this browser holds a session.
vi.mock('@supabase/ssr', () => ({
  createBrowserClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
    },
  }),
}))

const { default: PrivacyPage } = await import('@/app/(marketing)/legal/privacy/page')

const settings = env as { EMAIL_PROVIDER?: string }
let before: string | undefined
beforeEach(() => {
  before = settings.EMAIL_PROVIDER
})
afterEach(() => {
  settings.EMAIL_PROVIDER = before
})

const recipients = () => within(screen.getByRole('region', { name: 'Who receives it' }))
const abroad = () => screen.getByRole('region', { name: 'Transfers outside Nigeria' })

describe('the privacy notice names the email provider actually in use (N9b, CMP-14)', () => {
  it('names Brevo, in France, while Brevo sends — and not Amazon', () => {
    settings.EMAIL_PROVIDER = 'brevo'
    render(<PrivacyPage />)
    expect(recipients().getByText('Brevo')).toBeInTheDocument()
    expect(recipients().getByText('Brevo').closest('li')).toHaveTextContent(
      'France, European Union',
    )
    expect(screen.getByRole('main')).not.toHaveTextContent(/Amazon/)
    expect(abroad()).toHaveTextContent('the European Union (for our emails)')
  })

  it('names Brevo when nothing is chosen, as the gateway and the auth emails do', () => {
    settings.EMAIL_PROVIDER = undefined
    render(<PrivacyPage />)
    expect(recipients().getByText('Brevo')).toBeInTheDocument()
  })

  it('names Amazon SES, in London, once it sends — and no longer Brevo or the EU', () => {
    settings.EMAIL_PROVIDER = 'ses'
    render(<PrivacyPage />)
    const item = recipients().getByText('Amazon Web Services (Amazon SES)').closest('li')
    expect(item).toHaveTextContent('sends our emails')
    expect(item).toHaveTextContent('United Kingdom, London region')
    expect(screen.getByRole('main')).not.toHaveTextContent(/Brevo/)
    expect(abroad()).not.toHaveTextContent('European Union')
    expect(abroad()).toHaveTextContent(
      'Türkiye, the United Kingdom, the United States and the country of your extension’s registry',
    )
  })
})

describe('the privacy notice names DeepSeek only while the name finder is on (N9b, CMP-11)', () => {
  const ai = env as { DEEPSEEK_API_KEY?: string }
  let key: string | undefined
  beforeEach(() => {
    key = ai.DEEPSEEK_API_KEY
    settings.EMAIL_PROVIDER = 'ses'
  })
  afterEach(() => {
    ai.DEEPSEEK_API_KEY = key
  })

  it('leaves DeepSeek and China out while no AI key is set', () => {
    ai.DEEPSEEK_API_KEY = undefined
    render(<PrivacyPage />)
    expect(screen.getByRole('main')).not.toHaveTextContent(/DeepSeek|China/)
  })

  it('names DeepSeek, what it receives and where, and adds China to the transfers once it is on', () => {
    ai.DEEPSEEK_API_KEY = 'sk-test'
    render(<PrivacyPage />)
    const item = recipients().getByText('DeepSeek').closest('li')
    // AI phase 5: the site assistant is named, with the conversation it is sent.
    expect(item).toHaveTextContent(
      'only what you type in the name finder, the help centre or the assistant (with the conversation so far)',
    )
    expect(item).toHaveTextContent('with your domain’s name taken out')
    expect(item).toHaveTextContent('email addresses and phone numbers taken out first')
    expect(item).toHaveTextContent('servers in China')
    // Migration 73: a bought name that contains a listed brand, and only that name.
    expect(item).toHaveTextContent('that name alone is sent for a second opinion')
    expect(item).toHaveTextContent('your order is never held for it')
    expect(item).toHaveTextContent('Nothing that names you is sent')
    // Migration 74: the ops copilot sees an alert's text, masked.
    expect(item).toHaveTextContent('alert’s text with domain names and contact details taken out')
    // Feature 7: the portfolio copilot sees the instruction, masked, never the account.
    expect(item).toHaveTextContent('never your list of domains')
    expect(abroad()).toHaveTextContent(
      'Türkiye, the United Kingdom, the United States, China (for our AI features) and the country of your extension’s registry',
    )
  })
})
