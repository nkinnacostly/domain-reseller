import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../actions/setup-help', () => ({ explainSetup: vi.fn() }))

const { explainSetup } = await import('../actions/setup-help')
const { SetupHelpPanel } = await import('../components/setup-help')

beforeEach(() => vi.resetAllMocks())

describe('SetupHelpPanel', () => {
  it('says what is sent, and asks only when pressed', () => {
    render(<SetupHelpPanel domain="getpaid.ng" />)
    expect(screen.getByText(/without your domain’s name/)).toBeInTheDocument()
    expect(explainSetup).not.toHaveBeenCalled()
  })

  it('shows the explanation and its numbered steps', async () => {
    vi.mocked(explainSetup).mockResolvedValue({
      data: { ok: true, help: { summary: 'It is taking effect.', steps: ['Wait an hour.'] } },
    } as never)
    render(<SetupHelpPanel domain="getpaid.ng" />)
    await userEvent.click(screen.getByRole('button', { name: 'Explain what’s happening' }))
    expect(explainSetup).toHaveBeenCalledWith({ domain: 'getpaid.ng' })
    expect(await screen.findByText('It is taking effect.')).toBeInTheDocument()
    expect(screen.getByRole('listitem')).toHaveTextContent('Wait an hour.')
  })

  it('words a refusal, and treats no answer as unavailable', async () => {
    vi.mocked(explainSetup).mockResolvedValueOnce({
      data: { ok: false, reason: 'limited' },
    } as never)
    render(<SetupHelpPanel domain="getpaid.ng" />)
    const button = screen.getByRole('button', { name: 'Explain what’s happening' })
    await userEvent.click(button)
    expect(await screen.findByText(/asked a lot in a few minutes/)).toBeInTheDocument()
    vi.mocked(explainSetup).mockResolvedValueOnce(undefined as never)
    await userEvent.click(button)
    expect(await screen.findByText(/couldn’t get an explanation just now/)).toBeInTheDocument()
  })
})
