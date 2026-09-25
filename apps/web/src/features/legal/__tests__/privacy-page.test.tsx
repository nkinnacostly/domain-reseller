import { render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '@/lib/env'

vi.mock('next/navigation', () => ({ usePathname: () => '/legal/privacy' }))
vi.mock('next/server', () => ({ connection: async () => undefined }))
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
