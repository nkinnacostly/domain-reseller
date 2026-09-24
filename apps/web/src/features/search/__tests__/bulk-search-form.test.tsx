import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { checkBulkNames } from '../actions/bulk'
import { BulkRunProvider } from '../components/bulk-run'
import { BulkSearchForm } from '../components/bulk-search-form'

// The server action is the page's network boundary.
vi.mock('../actions/bulk', () => ({ checkBulkNames: vi.fn() }))

type Chunk = { names: string[]; tlds: string[] }

beforeEach(() => {
  vi.mocked(checkBulkNames).mockReset()
  vi.mocked(checkBulkNames).mockImplementation(async (chunk) => {
    const { names, tlds } = chunk as Chunk
    return {
      data: {
        ok: true,
        results: names.flatMap((name) =>
          tlds.map((tld) => ({ domain: `${name}.${tld}`, status: 'available' as const })),
        ),
        prices: {},
      },
    }
  })
})

const asked = () => vi.mocked(checkBulkNames).mock.calls.map(([chunk]) => chunk as Chunk)

function form(props: Partial<Parameters<typeof BulkSearchForm>[0]> = {}) {
  return render(
    <BulkRunProvider>
      <BulkSearchForm
        extensions={['com', 'net', 'africa']}
        sold={['com', 'net', 'africa', 'io']}
        featured={['com', 'net', 'africa']}
        lengthRules={{}}
        defaultPicked={['com']}
        {...props}
      />
    </BulkRunProvider>,
  )
}

const csv = (text: string, name = 'brands.csv') => new File([text], name, { type: 'text/csv' })

describe('BulkSearchForm — refusals first (FR-S5)', () => {
  it('refuses an empty list and says what to do', async () => {
    const user = userEvent.setup()
    form()

    await user.click(screen.getByRole('button', { name: 'Check names' }))

    expect(checkBulkNames).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Type or paste at least one name, or upload a CSV file.',
    )
    expect(screen.getByLabelText('Names to check')).toHaveAttribute('aria-invalid', 'true')
  })

  it('refuses more than 500 names, and keeps what was typed', async () => {
    const user = userEvent.setup()
    form()
    const names = Array.from({ length: 501 }, (_, index) => `name${index}`).join('\n')
    const field = screen.getByLabelText('Names to check')

    await user.click(field)
    await user.paste(names)
    await user.click(screen.getByRole('button', { name: 'Check names' }))

    expect(checkBulkNames).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent("That's 501 names")
    expect(field).toHaveValue(names)
  })

  it('clears a stale error as soon as the list changes', async () => {
    const user = userEvent.setup()
    form()
    await user.click(screen.getByRole('button', { name: 'Check names' }))

    await user.type(screen.getByLabelText('Names to check'), 'g')

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('refuses a file too big to be a list of names, without reading it', async () => {
    const user = userEvent.setup()
    form()
    const big = csv('x'.repeat(1_000_001), 'huge.csv')

    await user.upload(screen.getByLabelText('Upload a CSV file'), big)

    expect(screen.getByText(/huge\.csv is larger than 1 MB/)).toBeInTheDocument()
    expect(screen.getByLabelText('Names to check')).toHaveValue('')
  })

  it('says so when a file has no names in it', async () => {
    const user = userEvent.setup()
    form()

    await user.upload(screen.getByLabelText('Upload a CSV file'), csv('domain\n\n', 'empty.csv'))

    expect(await screen.findByText(/We found no names in empty\.csv/)).toBeInTheDocument()
  })

  it('says so when a file cannot be read', async () => {
    const user = userEvent.setup()
    form()
    const broken = csv('domain\ngetpaid.com')
    Object.defineProperty(broken, 'text', { value: () => Promise.reject(new Error('gone')) })

    await user.upload(screen.getByLabelText('Upload a CSV file'), broken)

    expect(await screen.findByText(/We couldn't read brands\.csv/)).toBeInTheDocument()
  })

  it('warns straight away when a file holds more names than one search takes', async () => {
    const user = userEvent.setup()
    form()
    const rows = Array.from({ length: 612 }, (_, index) => `name${index}.com`).join('\n')

    await user.upload(screen.getByLabelText('Upload a CSV file'), csv(`domain\n${rows}`))

    expect(await screen.findByText(/Read 612 names .* That's 612 names\./)).toBeInTheDocument()
  })
})

describe('BulkSearchForm — checking a list', () => {
  it('checks names without an extension on each one ticked, never ticking one for you', async () => {
    const user = userEvent.setup()
    form()
    expect(screen.getByRole('checkbox', { name: '.com' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: '.net' })).not.toBeChecked()

    await user.type(screen.getByLabelText('Names to check'), 'GetPaid{Enter}café.com')
    await user.click(screen.getByRole('checkbox', { name: '.africa' }))
    await user.click(screen.getByRole('button', { name: 'Check names' }))

    await waitFor(() => expect(checkBulkNames).toHaveBeenCalled())
    expect(asked()).toEqual([{ names: ['getpaid', 'xn--caf-dma'], tlds: ['com', 'africa'] }])
  })

  it('reads a CSV into the list, says what it read, and checks it when asked', async () => {
    const user = userEvent.setup()
    form()

    await user.upload(
      screen.getByLabelText('Upload a CSV file'),
      csv('client,Domain\nAda,getpaid.com\nBola,\nChi,GETPAID.COM\nDayo,mybrand.africa\n'),
    )

    expect(await screen.findByText(/Read 2 names from the “Domain” column/)).toHaveTextContent(
      'Left out 1 blank row and 1 repeat.',
    )
    expect(screen.getByLabelText('Names to check')).toHaveValue('getpaid.com\nmybrand.africa')
    expect(checkBulkNames).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Check names' }))
    await waitFor(() => expect(checkBulkNames).toHaveBeenCalledOnce())
    expect(asked()[0]).toEqual({ names: ['getpaid', 'mybrand'], tlds: ['com', 'africa'] })
  })

  it('checks names that arrived in the address as soon as the page is ready, once', async () => {
    form({ defaultNames: 'getpaid\nother', autoRun: true })

    await waitFor(() => expect(checkBulkNames).toHaveBeenCalledOnce())
    expect(asked()[0]).toEqual({ names: ['getpaid', 'other'], tlds: ['com'] })
  })

  it('cannot be sent again while a list is being checked', async () => {
    let answer: () => void = () => {}
    vi.mocked(checkBulkNames).mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = () =>
            resolve({
              data: {
                ok: true,
                results: [{ domain: 'getpaid.com', status: 'available' }],
                prices: {},
              },
            })
        }),
    )
    const user = userEvent.setup()
    form()

    await user.type(screen.getByLabelText('Names to check'), 'getpaid')
    await user.click(screen.getByRole('button', { name: 'Check names' }))

    const busy = await screen.findByRole('button', { name: 'Checking…' })
    expect(busy).toBeDisabled()
    expect(busy).toHaveAttribute('aria-busy', 'true')

    answer()
    expect(await screen.findByRole('button', { name: 'Check names' })).toBeEnabled()
  })

  it('refuses to render outside the page that runs the search', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() =>
      render(
        <BulkSearchForm
          extensions={['com']}
          sold={['com']}
          featured={['com']}
          lengthRules={{}}
          defaultPicked={['com']}
        />,
      ),
    ).toThrow('useBulkRun needs a BulkRunProvider above it')
    vi.mocked(console.error).mockRestore()
  })

  it('marks the form as ready once it has hydrated', () => {
    form()
    expect(screen.getByRole('form', { name: 'Bulk search' })).toHaveAttribute(
      'data-enhanced',
      'true',
    )
  })
})
