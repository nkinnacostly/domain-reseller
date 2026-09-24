import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TwoFactorNotice, TwoFactorRequired } from '../components/two-factor-notice'
import { getTwoFactorRequirement } from '../queries/two-factor'

// The query is this component's boundary; it is tested on its own.
vi.mock('../queries/two-factor', () => ({ getTwoFactorRequirement: vi.fn() }))

const region = () => screen.queryByRole('region', { name: 'Turn on two-factor authentication' })

beforeEach(() => vi.clearAllMocks())

describe('TwoFactorRequired (FR-A2)', () => {
  it('names the account’s own count, the rule, what is paused and what is not', () => {
    render(<TwoFactorRequired held={11} />)
    expect(region()).toHaveTextContent(
      'Your account holds 11 domains, and accounts holding more than 10 need two-factor authentication.',
    )
    expect(region()).toHaveTextContent(
      'you can’t order new domains, transfer more in, or make security changes',
    )
    expect(region()).toHaveTextContent('Renewals carry on as normal.')
  })

  it('links straight to the two-factor section of Settings', () => {
    render(<TwoFactorRequired held={11} />)
    expect(screen.getByRole('link', { name: 'Turn on two-factor' })).toHaveAttribute(
      'href',
      '/app/settings#two-factor',
    )
  })
})

describe('TwoFactorNotice — only for an account the rule applies to', () => {
  const show = async () => render(<div>{await TwoFactorNotice()}</div>)

  it('shows the notice above ten domains without two-factor', async () => {
    vi.mocked(getTwoFactorRequirement).mockResolvedValue({
      held: 12,
      required: true,
      hasFactor: false,
    })
    await show()
    expect(region()).toHaveTextContent('Your account holds 12 domains')
  })

  it.each([
    ['ten domains or fewer', { held: 10, required: false, hasFactor: false }],
    ['two-factor already on', { held: 30, required: true, hasFactor: true }],
    ['nothing it could read', null],
  ])('shows nothing with %s', async (_, requirement) => {
    vi.mocked(getTwoFactorRequirement).mockResolvedValue(requirement)
    await show()
    expect(region()).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Turn on two-factor' })).not.toBeInTheDocument()
  })
})
