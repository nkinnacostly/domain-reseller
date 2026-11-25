import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../actions/ask-help', () => ({ askHelp: vi.fn() }))

const { askHelp } = await import('../actions/ask-help')
const { HelpAssistant } = await import('../components/help-assistant')

const ask = async (question: string) => {
  render(<HelpAssistant supportEmail="hello@mydomainshub.com" />)
  await userEvent.type(screen.getByRole('textbox', { name: 'Ask a question' }), question)
  await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
}

beforeEach(() => vi.resetAllMocks())

describe('HelpAssistant', () => {
  it('says where a question goes, and asks for more than a word', async () => {
    await ask('hi')
    expect(screen.getByText('Ask your question in a few words.')).toBeInTheDocument()
    expect(askHelp).not.toHaveBeenCalled()
  })

  it('shows the answer with the pages it came from, and a person to email', async () => {
    vi.mocked(askHelp).mockResolvedValue({
      data: {
        ok: true,
        help: {
          answered: true,
          answer: 'Pick your host on the Nameservers tab.',
          sources: [{ path: '/help#pointing', title: 'Help: Pointing your domain' }],
        },
      },
    } as never)
    await ask('How do I point my domain?')
    expect(await screen.findByText('Pick your host on the Nameservers tab.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Help: Pointing your domain' })).toHaveAttribute(
      'href',
      '/help#pointing',
    )
    expect(screen.getByText(/Answered by AI from this help centre only/)).toBeInTheDocument()
  })

  it('offers a person when the help centre does not cover the question', async () => {
    vi.mocked(askHelp).mockResolvedValue({ data: { ok: true, help: { answered: false } } } as never)
    await ask('Can you build my website?')
    expect(await screen.findByText(/doesn’t cover that/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'hello@mydomainshub.com' })).toHaveAttribute(
      'href',
      'mailto:hello@mydomainshub.com',
    )
  })

  it('words a refusal, and no answer at all as unavailable', async () => {
    vi.mocked(askHelp).mockResolvedValueOnce({ data: { ok: false, reason: 'limited' } } as never)
    await ask('How do I renew?')
    expect(await screen.findByText(/asked a lot in a few minutes/)).toBeInTheDocument()
    vi.mocked(askHelp).mockResolvedValueOnce(undefined as never)
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    expect(await screen.findByText(/couldn’t get an answer just now/)).toBeInTheDocument()
  })
})
