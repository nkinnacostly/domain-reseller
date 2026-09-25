import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTurnstile, uninstallTurnstile } from '../../../../tests/mocks/turnstile'
import type { BulkAnswer } from '../lib/bulk-run'

// The server actions are the page's network boundary.
vi.mock('../actions/bulk', () => ({ checkBulkNames: vi.fn() }))
vi.mock('../actions/human', () => ({ confirmHuman: vi.fn() }))

type Chunk = { names: string[]; tlds: string[] }

const checked = ({ names, tlds }: Chunk): { data: BulkAnswer } => ({
  data: {
    ok: true,
    results: names.flatMap((name) =>
      tlds.map((tld) => ({ domain: `${name}.${tld}`, status: 'available' as const })),
    ),
    prices: {},
  },
})
const unconfirmed = { data: { ok: false, reason: 'unconfirmed' } as BulkAnswer }

/** env.ts reads the site key once, at import — so the page is loaded fresh. */
async function page() {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', 'site-key')
  const { checkBulkNames } = await import('../actions/bulk')
  const { confirmHuman } = await import('../actions/human')
  const { BulkRunProvider } = await import('../components/bulk-run')
  const { BulkSearchForm } = await import('../components/bulk-search-form')
  const { BulkPassCheck } = await import('../components/bulk-pass-check')
  const { BulkResults } = await import('../components/bulk-results')
  const cloudflare = installTurnstile()
  // As the page lays them out: the form and its check on the hero, results below.
  render(
    <BulkRunProvider>
      <BulkSearchForm
        extensions={['com']}
        sold={['com']}
        featured={['com']}
        lengthRules={{}}
        defaultPicked={['com']}
      />
      <BulkPassCheck />
      <BulkResults />
    </BulkRunProvider>,
  )
  return {
    checkBulkNames: vi.mocked(checkBulkNames),
    confirmHuman: vi.mocked(confirmHuman),
    cloudflare,
  }
}

async function checkList(names: string) {
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('Names to check'), names)
  await user.click(screen.getByRole('button', { name: 'Check names' }))
  return user
}

const check = () =>
  screen.queryByRole('region', { name: 'Confirm you’re a person to check this list' })
const asked = (fn: { mock: { calls: unknown[][] } }) =>
  fn.mock.calls.map(([chunk]) => chunk as Chunk)

beforeEach(() => uninstallTurnstile())
afterEach(() => vi.unstubAllEnvs())

describe('bulk search and the search pass (SEC-9)', () => {
  it('pauses a list without a pass, shows the check, and carries on from the same block once passed', async () => {
    const { checkBulkNames, confirmHuman, cloudflare } = await page()
    checkBulkNames.mockResolvedValueOnce(unconfirmed as never)
    checkBulkNames.mockImplementation(async (chunk) => checked(chunk as Chunk) as never)
    confirmHuman.mockResolvedValue({ data: { passed: true } } as never)

    await checkList('getpaid')

    expect(
      await screen.findByRole('heading', { name: 'Confirm you’re a person to check this list' }),
    ).toBeInTheDocument()
    expect(check()).toHaveTextContent('Cloudflare checks that you’re a person first')
    expect(screen.getByRole('button', { name: /Checking/ })).toBeDisabled()
    expect(screen.queryByText(/weren’t checked|wasn’t checked/)).not.toBeInTheDocument()

    await vi.waitFor(() => expect(cloudflare.api.render).toHaveBeenCalled())
    expect(cloudflare.options().action).toBe('bulk-search')
    cloudflare.solve('good-token')

    await vi.waitFor(() => expect(check()).not.toBeInTheDocument())
    expect(confirmHuman).toHaveBeenCalledWith({ token: 'good-token' })
    expect(asked(checkBulkNames)).toEqual([
      { names: ['getpaid'], tlds: ['com'] },
      { names: ['getpaid'], tlds: ['com'] },
    ])
    expect(await screen.findByRole('button', { name: 'Check names' })).toBeEnabled()
  })

  it('stops at once when asked to while waiting for the check', async () => {
    const { checkBulkNames } = await page()
    checkBulkNames.mockResolvedValue(unconfirmed as never)

    const user = await checkList('getpaid')
    await screen.findByRole('heading', { name: 'Confirm you’re a person to check this list' })
    await user.click(screen.getByRole('button', { name: 'Stop checking' }))

    expect(check()).not.toBeInTheDocument()
    expect(await screen.findByText(/You stopped the search/)).toBeInTheDocument()
    expect(checkBulkNames).toHaveBeenCalledTimes(1)
  })

  it('refused again straight after a pass, stops and says why instead of asking forever', async () => {
    const { checkBulkNames, confirmHuman, cloudflare } = await page()
    checkBulkNames.mockResolvedValue(unconfirmed as never)
    confirmHuman.mockResolvedValue({ data: { passed: true } } as never)

    await checkList('getpaid')
    await vi.waitFor(() => expect(cloudflare.api.render).toHaveBeenCalled())
    cloudflare.solve()

    const notice = await screen.findByRole('region', { name: /wasn’t checked/ })
    expect(within(notice).getByText(/the next request didn’t carry its pass/)).toBeInTheDocument()
    expect(check()).not.toBeInTheDocument()
    expect(checkBulkNames).toHaveBeenCalledTimes(2)
  })
})
