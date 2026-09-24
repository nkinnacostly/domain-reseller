import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { addDomainsToCart } from '@/features/cart/actions/cart'
import { checkBulkNames } from '../actions/bulk'
import { BulkResults } from '../components/bulk-results'
import { BulkRunProvider } from '../components/bulk-run'
import { BulkSearchForm } from '../components/bulk-search-form'
import type { BulkAnswer, BulkPrice } from '../lib/bulk-run'

// Server actions are the page's network boundary.
vi.mock('../actions/bulk', () => ({ checkBulkNames: vi.fn() }))
vi.mock('@/features/cart/actions/cart', () => ({ addDomainsToCart: vi.fn() }))

type Chunk = { names: string[]; tlds: string[] }
type Status = 'available' | 'registered' | 'premium' | 'restricted' | 'unknown'

const price = (registerKobo: number, renewKobo: number): BulkPrice => ({
  register: `₦${(registerKobo / 100).toLocaleString('en-NG')}`,
  renew: `₦${(renewKobo / 100).toLocaleString('en-NG')}`,
  renewalIsHigher: renewKobo > registerKobo,
  includesIcannFee: true,
  maxPeriod: 10,
  registerKobo,
  renewKobo,
})
const PRICES: Record<string, BulkPrice> = {
  com: price(1_820_000, 1_900_000),
  net: price(2_000_000, 2_000_000),
  io: price(5_000_000, 5_000_000),
}

/** The fixed answers the tests share: a few names are taken, premium or unanswered. */
const STATUS: Record<string, Status> = {
  takenbrand: 'registered',
  hotel: 'premium',
  flaky: 'unknown',
}
const answerFor = ({ names, tlds }: Chunk): BulkAnswer => ({
  ok: true,
  results: names.flatMap((name) =>
    tlds.map((tld) => ({ domain: `${name}.${tld}`, status: STATUS[name] ?? 'available' })),
  ),
  prices: Object.fromEntries(tlds.map((tld) => [tld, PRICES[tld] as BulkPrice])),
})

/** Answers each request with `reply(chunk, call)`, or the fixed answers. */
function registry(reply?: (chunk: Chunk, call: number) => BulkAnswer | Promise<BulkAnswer>) {
  let call = 0
  vi.mocked(checkBulkNames).mockImplementation(async (input) => {
    const chunk = input as Chunk
    const data = await (reply ? reply(chunk, call++) : answerFor(chunk))
    return { data }
  })
}

const asked = () => vi.mocked(checkBulkNames).mock.calls.map(([chunk]) => chunk as Chunk)
const numbered = (count: number) => Array.from({ length: count }, (_, index) => `n${index}`)

beforeEach(() => {
  vi.mocked(checkBulkNames).mockReset()
  vi.mocked(addDomainsToCart).mockReset()
  registry()
})

function page() {
  render(
    <BulkRunProvider>
      <BulkSearchForm
        extensions={['com', 'net']}
        sold={['com', 'net', 'io']}
        featured={['com', 'net']}
        lengthRules={{}}
        defaultPicked={['com']}
      />
      <BulkResults />
    </BulkRunProvider>,
  )
}

async function search(names: string[]) {
  const user = userEvent.setup()
  page()
  await user.click(screen.getByLabelText('Names to check'))
  await user.paste(names.join('\n'))
  await user.click(screen.getByRole('button', { name: 'Check names' }))
  return user
}

const rows = () =>
  within(screen.getByRole('list', { name: 'Results, one row per name' })).getAllByRole('listitem')
const row = (name: string) => {
  const found = rows().find((item) => within(item).queryByText(name, { exact: true }))
  if (!found) throw new Error(`no row for ${name}`)
  return found
}
const done = () => screen.findByRole('button', { name: 'Check names' })

describe('bulk results — before a search', () => {
  it('says what bulk search does, and that searches are never shared (FR-S7)', () => {
    page()
    expect(screen.getByText('Paste a list to check it in one go')).toBeInTheDocument()
    expect(screen.getByText(/Up to 500 names, one per line, or a CSV file/)).toBeInTheDocument()
    expect(screen.getByText(/We never sell or share what you search for/)).toHaveTextContent(
      'a CSV file you upload is read on your device',
    )
  })
})

describe('bulk results — failures first (FR-S5)', () => {
  it('says which names a failed block left unchecked, and retries just those', async () => {
    registry((chunk, call) =>
      call === 0 ? { ok: false, reason: 'unavailable' } : answerFor(chunk),
    )
    const user = await search(numbered(60))
    await done()

    const notice = screen.getByRole('region', { name: '20 names weren’t checked' })
    expect(notice).toHaveTextContent("The registry didn't answer for them this time.")
    expect(notice).toHaveTextContent('n0.com, n1.com, n2.com and 17 more')
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('40 of 60 available')

    await user.click(within(notice).getByRole('button', { name: 'Check these 20 again' }))
    await waitFor(() => expect(checkBulkNames).toHaveBeenCalledTimes(4))
    expect(asked()[3]).toEqual({ names: numbered(20), tlds: ['com'] })
    expect(await screen.findByRole('heading', { level: 2 })).toHaveTextContent('60 of 60 available')
    expect(screen.queryByRole('region', { name: /weren’t checked/ })).not.toBeInTheDocument()
  })

  it('stops at the address limit, and asks nothing more (FR-S5 rate limit)', async () => {
    registry((chunk, call) => (call === 1 ? { ok: false, reason: 'limited' } : answerFor(chunk)))
    await search(numbered(120))
    await done()

    expect(checkBulkNames).toHaveBeenCalledTimes(2)
    const notice = screen.getByRole('region', { name: '100 names weren’t checked' })
    expect(notice).toHaveTextContent(
      'This connection has checked a lot of names in the last few minutes',
    )
    expect(screen.getByText('20 of 120 names checked')).toBeInTheDocument()
  })

  it('says the registry is busy when too many bulk searches run at once', async () => {
    registry(() => ({ ok: false, reason: 'busy' }))
    await search(['getpaid'])
    await done()

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      "We couldn't check these names",
    )
    expect(screen.getByRole('region', { name: '1 name wasn’t checked' })).toHaveTextContent(
      'A lot of bulk searches are running right now.',
    )
    expect(screen.getByRole('button', { name: 'Check it again' })).toBeEnabled()
  })

  it('treats a request that never arrived as unanswered', async () => {
    vi.mocked(checkBulkNames).mockRejectedValue(new Error('offline'))
    await search(['getpaid'])
    await done()
    expect(screen.getByRole('region', { name: '1 name wasn’t checked' })).toBeInTheDocument()
  })

  it('treats an empty answer from the server as unanswered', async () => {
    vi.mocked(checkBulkNames).mockResolvedValue(undefined as never)
    await search(['getpaid'])
    await done()
    expect(row('getpaid.com')).toHaveTextContent('Not checked')
  })

  it('stops after the block in flight when asked, leaving the rest to check later', async () => {
    let release: () => void = () => {}
    registry(
      (chunk, call) =>
        new Promise((resolve) => {
          if (call === 0) release = () => resolve(answerFor(chunk))
          else resolve(answerFor(chunk))
        }),
    )
    const user = await search(numbered(120))

    await user.click(await screen.findByRole('button', { name: 'Stop checking' }))
    release()
    await done()

    expect(checkBulkNames).toHaveBeenCalledOnce()
    expect(screen.getByRole('region', { name: '100 names weren’t checked' })).toHaveTextContent(
      'You stopped the search before they were checked.',
    )
  })

  it('says when none of the names checked are free', async () => {
    registry((chunk, call) =>
      call === 0
        ? {
            ok: true,
            results: chunk.names.map((name) => ({ domain: `${name}.com`, status: 'registered' })),
            prices: {},
          }
        : { ok: false, reason: 'unavailable' },
    )
    await search(numbered(60))
    await done()
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      'None of the names checked are available',
    )
  })

  it('says plainly when nothing is free', async () => {
    await search(['takenbrand', 'hotel'])
    await done()
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      'None of these are available',
    )
  })
})

describe('bulk results — progress and partial results', () => {
  it('shows "20 of 120 checked" and the first rows while the rest are still coming', async () => {
    const releases: (() => void)[] = []
    registry(
      (chunk) =>
        new Promise((resolve) => {
          releases.push(() => resolve(answerFor(chunk)))
        }),
    )
    await search(numbered(120))

    expect(await screen.findByRole('heading', { level: 2 })).toHaveTextContent(
      'Checking 120 names…',
    )
    const bar = screen.getByRole('progressbar', { name: 'Names checked' })
    expect(bar).toHaveAttribute('aria-valuenow', '0')

    await waitFor(() => expect(releases).toHaveLength(1))
    releases[0]?.()
    expect(await screen.findByText('20 of 120 names checked')).toBeInTheDocument()
    expect(bar).toHaveAttribute('aria-valuenow', '20')
    expect(row('n0.com')).toHaveTextContent('Available')
    expect(row('n60.com')).toHaveTextContent('Checking')

    // Six blocks of twenty, one after another.
    for (let block = 1; block < 6; block += 1) {
      await waitFor(() => expect(releases).toHaveLength(block + 1))
      releases[block]?.()
    }
    await done()

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('120 of 120 available')
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('draws a hundred rows at a time', async () => {
    const user = await search(numbered(120))
    await done()

    expect(rows()).toHaveLength(100)
    await user.click(screen.getByRole('button', { name: 'Show 20 more of 20 not shown' }))
    expect(rows()).toHaveLength(120)
  })

  it('answers a list with nothing to ask straight away', async () => {
    await search(['not_a_name'])
    expect(await screen.findByRole('heading', { level: 2 })).toHaveTextContent(
      'None of these are available',
    )
    expect(row('not_a_name')).toHaveTextContent('Not a domain')
    expect(checkBulkNames).not.toHaveBeenCalled()
  })
})

describe('bulk results — rows, filters and order', () => {
  it('shows every free name with its first-year and renewal price (N8)', async () => {
    await search(['getpaid', 'takenbrand', 'hotel', 'café.com'])
    await done()

    expect(row('getpaid.com')).toHaveTextContent(/₦18,200\s*then ₦19,000\/yr/)
    expect(row('takenbrand.com')).toHaveTextContent('Taken')
    expect(row('takenbrand.com')).not.toHaveTextContent('₦')
    expect(row('hotel.com')).toHaveTextContent('Premium')
    expect(row('hotel.com')).not.toHaveTextContent('₦')
    expect(row('café.com')).toHaveTextContent('xn--caf-dma.com')
  })

  it('filters by available, taken, premium and not checked', async () => {
    const user = await search(['getpaid', 'takenbrand', 'hotel', 'flaky', 'other'])
    await done()

    await user.click(screen.getByRole('radio', { name: /^Taken/ }))
    expect(rows().map((item) => item.dataset.status)).toEqual(['taken'])
    await user.click(screen.getByRole('radio', { name: /^Premium/ }))
    expect(rows().map((item) => item.dataset.status)).toEqual(['premium'])
    await user.click(screen.getByRole('radio', { name: /^Not checked/ }))
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toHaveTextContent('flaky.com')
    await user.click(screen.getByRole('radio', { name: /^Available/ }))
    expect(rows()).toHaveLength(2)
    await user.click(screen.getByRole('radio', { name: /^All/ }))
    expect(rows()).toHaveLength(5)
  })

  it('says so when a filter has nothing in it', async () => {
    const user = await search(['getpaid'])
    await done()
    await user.click(screen.getByRole('radio', { name: /^Premium/ }))
    expect(screen.getByText('None of these are premium names.')).toBeInTheDocument()
  })

  it('shows only the names not checked when asked', async () => {
    const user = await search(['getpaid', 'flaky'])
    await done()
    await user.click(screen.getByRole('button', { name: 'Show only these' }))
    expect(screen.getByRole('radio', { name: /^Not checked/ })).toBeChecked()
    expect(rows()).toHaveLength(1)
  })

  it('orders by name or by price', async () => {
    const user = await search(['zeta.com', 'alpha.io', 'mid.net', 'takenbrand.com'])
    await done()
    const order = () =>
      rows().map((item) => within(item).getByText(/^[a-z]+\.(com|io|net)$/).textContent)

    await user.selectOptions(screen.getByRole('combobox', { name: 'Order' }), 'name')
    expect(order()).toEqual(['alpha.io', 'mid.net', 'takenbrand.com', 'zeta.com'])
    await user.selectOptions(screen.getByRole('combobox', { name: 'Order' }), 'price')
    expect(order()).toEqual(['zeta.com', 'mid.net', 'alpha.io', 'takenbrand.com'])
    await user.selectOptions(screen.getByRole('combobox', { name: 'Order' }), 'list')
    expect(order()).toEqual(['zeta.com', 'alpha.io', 'mid.net', 'takenbrand.com'])
  })
})

describe('bulk results — to the cart (FR-S5, N9)', () => {
  it('ticks nothing for anyone, and adds only what was selected', async () => {
    vi.mocked(addDomainsToCart).mockResolvedValue({
      data: { count: 1, added: ['getpaid.com'], notAdded: [] },
    } as never)
    const user = await search(['getpaid', 'other', 'takenbrand'])
    await done()

    const boxes = screen.getAllByRole('checkbox', { name: /^Select / })
    expect(boxes).toHaveLength(2)
    for (const box of boxes) expect(box).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Add selected to cart' })).toBeDisabled()

    await user.click(screen.getByRole('checkbox', { name: 'Select getpaid.com' }))
    expect(screen.getByText('1 selected')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add 1 to cart' }))

    expect(addDomainsToCart).toHaveBeenCalledWith({ domains: ['getpaid.com'] })
    expect(await screen.findByText('Added 1 name to your cart.')).toBeInTheDocument()
    // What went in is unticked, so it is not added twice.
    expect(screen.getByRole('checkbox', { name: 'Select getpaid.com' })).not.toBeChecked()
  })

  it('selects every available name in one press, and clears them in another', async () => {
    const user = await search(['getpaid', 'other', 'takenbrand'])
    await done()

    await user.click(screen.getByRole('button', { name: 'Select all 2 available' }))
    expect(screen.getByRole('checkbox', { name: 'Select getpaid.com' })).toBeChecked()
    expect(screen.getByRole('button', { name: 'Add 2 to cart' })).toBeEnabled()

    await user.click(screen.getByRole('checkbox', { name: 'Select other.com' }))
    expect(screen.getByText('1 selected')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Select all 2 available' }))
    await user.click(screen.getByRole('button', { name: 'Clear selection' }))
    expect(screen.getByText('0 selected')).toBeInTheDocument()
  })

  it('offers no cart when nothing is available', async () => {
    await search(['takenbrand'])
    await done()
    expect(screen.queryByRole('region', { name: 'Add to cart' })).not.toBeInTheDocument()
  })
})

describe('bulk results — CSV download (FR-S5, N8)', () => {
  const created: Blob[] = []
  beforeEach(() => {
    created.length = 0
    URL.createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob)
      return 'blob:bulk'
    })
    URL.revokeObjectURL = vi.fn()
  })

  it('downloads the rows shown, with both prices for each free name', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const user = await search(['getpaid', 'takenbrand'])
    await done()

    await user.click(screen.getByRole('button', { name: 'Download 2 as CSV' }))

    expect(click).toHaveBeenCalledOnce()
    const link = click.mock.contexts[0] as HTMLAnchorElement
    expect(link.download).toMatch(/^bulk-search-\d{4}-\d{2}-\d{2}\.csv$/)
    expect(link.href).toBe('blob:bulk')
    const text = await created[0]?.text()
    expect(text?.split('\r\n')).toEqual([
      expect.stringMatching(/name,extension,status,first_year_price_ngn,renewal_price_ngn/),
      'getpaid.com,com,available,18200.00,19000.00,getpaid.com',
      'takenbrand.com,com,taken,,,takenbrand.com',
      '',
    ])

    await user.click(screen.getByRole('radio', { name: /^Taken/ }))
    await user.click(screen.getByRole('button', { name: 'Download 1 as CSV' }))
    expect(await created[1]?.text()).not.toContain('getpaid.com')
    click.mockRestore()
  })

  it('cannot download while names are still being checked', async () => {
    registry(() => new Promise(() => {}))
    await search(['getpaid'])
    expect(await screen.findByRole('button', { name: 'Download 1 as CSV' })).toBeDisabled()
  })
})
