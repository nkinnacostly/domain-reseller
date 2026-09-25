import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTurnstile, uninstallTurnstile } from '../../../../tests/mocks/turnstile'

// The server action is the component's network boundary.
vi.mock('../actions/human', () => ({ confirmHuman: vi.fn() }))

/** env.ts reads the site key once, at import — so each case loads the component fresh. */
async function load(siteKey: string | null = 'site-key') {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', siteKey ?? undefined)
  const { confirmHuman } = await import('../actions/human')
  const { HumanCheck } = await import('../components/human-check')
  return { confirmHuman: vi.mocked(confirmHuman), HumanCheck }
}

async function shown(options: { siteKey?: string | null; onPassed?: () => void } = {}) {
  const { confirmHuman, HumanCheck } = await load(options.siteKey)
  const cloudflare = installTurnstile()
  render(
    <HumanCheck
      title="Confirm you’re a person to keep searching"
      action="search"
      onPassed={options.onPassed}
    >
      This connection has searched a lot.
    </HumanCheck>,
  )
  return { confirmHuman, cloudflare }
}

beforeEach(() => uninstallTurnstile())
afterEach(() => vi.unstubAllEnvs())

describe('HumanCheck — refusals first (SEC-9)', () => {
  it('says the check was refused, and tries again with a fresh token', async () => {
    const { confirmHuman, cloudflare } = await shown()
    confirmHuman.mockResolvedValue({
      data: { error: "We couldn't confirm you're a person. Try again." },
    } as never)
    await vi.waitFor(() => expect(cloudflare.api.render).toHaveBeenCalled())

    cloudflare.solve('refused-token')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "We couldn't confirm you're a person",
    )
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }))
    expect(cloudflare.api.reset).toHaveBeenCalledWith('widget-1')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says when the check did not load, and what to do', async () => {
    const { confirmHuman, cloudflare } = await shown()
    await vi.waitFor(() => expect(cloudflare.api.render).toHaveBeenCalled())

    cloudflare.fail()

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "The check didn't load. If something on this device blocks challenges.cloudflare.com",
    )
    expect(confirmHuman).not.toHaveBeenCalled()
  })

  it('shows an unexpected server failure', async () => {
    const { confirmHuman, cloudflare } = await shown()
    confirmHuman.mockResolvedValue({ serverError: 'Something went wrong on our end.' } as never)
    await vi.waitFor(() => expect(cloudflare.api.render).toHaveBeenCalled())

    cloudflare.solve()

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on our end.')
  })

  it('treats a token the server would not read as refused', async () => {
    const { confirmHuman, cloudflare } = await shown()
    confirmHuman.mockResolvedValue({ validationErrors: { token: { _errors: ['bad'] } } } as never)
    await vi.waitFor(() => expect(cloudflare.api.render).toHaveBeenCalled())

    cloudflare.solve()

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "We couldn't confirm you're a person",
    )
  })

  it('without a site key there is no check to offer: it says to wait', async () => {
    const { confirmHuman } = await shown({ siteKey: null })

    expect(screen.getByText('Wait a few minutes, then try again.')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(confirmHuman).not.toHaveBeenCalled()
  })
})

describe('HumanCheck', () => {
  it('says why it is there, and that it is checking', async () => {
    await shown()

    expect(
      screen.getByRole('region', { name: 'Confirm you’re a person to keep searching' }),
    ).toHaveTextContent('This connection has searched a lot.')
    expect(screen.getByRole('status')).toHaveTextContent('Checking you’re a person…')
  })

  it('sends the token straight to the server, and carries on once it passes', async () => {
    const onPassed = vi.fn()
    const { confirmHuman, cloudflare } = await shown({ onPassed })
    confirmHuman.mockResolvedValue({ data: { passed: true } } as never)
    await vi.waitFor(() => expect(cloudflare.api.render).toHaveBeenCalled())
    expect(cloudflare.options().action).toBe('search')

    cloudflare.solve('good-token')

    await vi.waitFor(() => expect(onPassed).toHaveBeenCalledTimes(1))
    expect(confirmHuman).toHaveBeenCalledWith({ token: 'good-token' })
  })

  it('shows that it is confirming while the server checks', async () => {
    const { confirmHuman, cloudflare } = await shown()
    confirmHuman.mockReturnValue(new Promise(() => {}) as never)
    await vi.waitFor(() => expect(cloudflare.api.render).toHaveBeenCalled())

    cloudflare.solve()

    expect(await screen.findByText('Confirming…')).toBeInTheDocument()
  })
})
