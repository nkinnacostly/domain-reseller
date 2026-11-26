import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NameIdeasResult } from '../lib/name-ideas'
import type { SearchRow } from '../lib/rows'

vi.mock('../actions/name-ideas', () => ({ findNameIdeas: vi.fn() }))
vi.mock('@/features/cart/components/add-to-cart-button', () => ({
  AddToCartButton: ({ domain, addedVia }: { domain: string; addedVia?: string }) => (
    <button type="button" data-added-via={addedVia}>
      Add {domain}
    </button>
  ),
}))

const { findNameIdeas } = await import('../actions/name-ideas')
const { NameFinder } = await import('../components/name-finder')

const row = (name: string): SearchRow => ({
  domain: `${name}.com`,
  display: `${name}.com`,
  name,
  tld: 'com',
  status: 'available',
  price: {
    register: '₦18,400',
    registerYears: 1,
    renew: '₦20,100',
    renewYears: 1,
    renewalIsHigher: true,
    includesIcannFee: true,
    maxPeriod: 10,
  },
})

const answer = (data: NameIdeasResult) =>
  vi.mocked(findNameIdeas).mockResolvedValue({ data } as Awaited<ReturnType<typeof findNameIdeas>>)

async function describeIt(text: string, extension?: string) {
  const user = userEvent.setup()
  render(<NameFinder extensions={['com', 'ng']} />)
  await user.type(screen.getByRole('textbox', { name: 'Describe your business' }), text)
  if (extension)
    await user.selectOptions(screen.getByRole('combobox', { name: 'Extension' }), extension)
  await user.click(screen.getByRole('button', { name: 'Find names' }))
}

beforeEach(() => vi.resetAllMocks())

describe('NameFinder', () => {
  it("asks in the language picked, marks the reasons with it, and counts adds as the finder's (AI phase 4)", async () => {
    answer({ ok: true, ideas: [{ row: row('akaraoja'), why: 'Ó rọrùn láti rántí' }], checked: 24 })
    const user = userEvent.setup()
    render(<NameFinder extensions={['com']} />)
    const picker = screen.getByRole('combobox', { name: 'Ideas in' })
    expect(picker).toHaveValue('en')
    expect(
      within(picker)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['English', 'Pidgin', 'Yoruba', 'Igbo', 'Hausa'])
    expect(picker).toHaveAccessibleDescription(/without accents or tone marks/)
    await user.type(
      screen.getByRole('textbox', { name: 'Describe your business' }),
      'A buka in Lagos selling akara',
    )
    await user.selectOptions(picker, 'yo')
    await user.click(screen.getByRole('button', { name: 'Find names' }))

    expect(findNameIdeas).toHaveBeenCalledWith({
      description: 'A buka in Lagos selling akara',
      tld: 'com',
      language: 'yo',
    })
    expect(await screen.findByText('Ó rọrùn láti rántí')).toHaveAttribute('lang', 'yo')
    expect(screen.getByRole('button', { name: 'Add akaraoja.com' })).toHaveAttribute(
      'data-added-via',
      'name_finder',
    )
  })

  it("leaves English reasons in the page's own language", async () => {
    answer({ ok: true, ideas: [{ row: row('breadly'), why: 'Short and friendly' }], checked: 24 })
    await describeIt('A bakery in Ibadan that delivers')
    expect(await screen.findByText('Short and friendly')).not.toHaveAttribute('lang')
  })

  it('says where the description goes before anything is sent (NDPA, N9b)', () => {
    render(<NameFinder extensions={['com']} />)
    expect(screen.getByText(/Sent to DeepSeek, an AI provider/)).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Extension' })).toHaveValue('com')
  })

  it('asks for a sentence before sending a word', async () => {
    await describeIt('bread')
    expect(screen.getByText(/at least a few words/)).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Describe your business' })).toHaveAttribute(
      'aria-invalid',
      'true',
    )
    expect(findNameIdeas).not.toHaveBeenCalled()
  })

  it('shows the free names with their reason, price and renewal price', async () => {
    answer({ ok: true, ideas: [{ row: row('ibadanbakes'), why: 'Says the city' }], checked: 24 })
    await describeIt('A bakery in Ibadan that delivers', 'ng')

    expect(findNameIdeas).toHaveBeenCalledWith({
      description: 'A bakery in Ibadan that delivers',
      tld: 'ng',
      language: 'en',
    })
    const list = await screen.findByRole('list', { name: 'Available names' })
    expect(within(list).getByText('ibadanbakes.com')).toBeInTheDocument()
    expect(within(list).getByText('Says the city')).toBeInTheDocument()
    expect(within(list).getByText('₦18,400')).toBeInTheDocument()
    expect(list).toHaveTextContent('₦20,100')
    expect(screen.getByText(/1 of 24 names are free to register/)).toBeInTheDocument()
  })

  it('says when every name was taken, and what to try', async () => {
    answer({ ok: true, ideas: [], checked: 24 })
    await describeIt('A bakery in Ibadan that delivers')
    expect(await screen.findByText('All 24 names we thought of are taken.')).toBeInTheDocument()
    expect(screen.getByText(/Describe it another way/)).toBeInTheDocument()
  })

  it('words a refusal and offers search instead', async () => {
    answer({ ok: false, reason: 'limited' })
    await describeIt('A bakery in Ibadan that delivers')
    const section = screen.getByRole('region', { name: 'Name ideas' })
    expect(await within(section).findByText(/asked for a lot of ideas/)).toBeInTheDocument()
    expect(within(section).getByRole('link', { name: 'Search for a domain' })).toHaveAttribute(
      'href',
      '/search',
    )
  })

  it('treats no answer at all as unavailable', async () => {
    vi.mocked(findNameIdeas).mockResolvedValue(undefined as never)
    await describeIt('A bakery in Ibadan that delivers')
    expect(await screen.findByText(/couldn’t get ideas just now/)).toBeInTheDocument()
  })
})
