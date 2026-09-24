import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BulkSearchForm } from '../components/bulk-search-form'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

beforeEach(() => push.mockClear())

const form = (props: Partial<Parameters<typeof BulkSearchForm>[0]> = {}) =>
  render(
    <BulkSearchForm extensions={['com', 'net', 'africa']} defaultPicked={['com']} {...props} />,
  )

describe('BulkSearchForm (FR-S5)', () => {
  it('refuses an empty list and says what to do', async () => {
    const user = userEvent.setup()
    form()

    await user.click(screen.getByRole('button', { name: 'Check names' }))

    expect(push).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Type or paste at least one name.')
    expect(screen.getByLabelText('Names to check')).toHaveAttribute('aria-invalid', 'true')
  })

  it('refuses more names than a bulk search takes, and keeps what was typed', async () => {
    const user = userEvent.setup()
    form()
    const names = Array.from({ length: 21 }, (_, index) => `name${index}`).join(' ')

    await user.type(screen.getByLabelText('Names to check'), names)
    await user.click(screen.getByRole('button', { name: 'Check names' }))

    expect(push).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent("That's 21 names")
    expect(screen.getByLabelText('Names to check')).toHaveValue(names)
  })

  it('clears a stale error as soon as the list changes', async () => {
    const user = userEvent.setup()
    form()
    await user.click(screen.getByRole('button', { name: 'Check names' }))

    await user.type(screen.getByLabelText('Names to check'), 'g')

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('goes to the canonical bulk URL with the list and the extensions ticked', async () => {
    const user = userEvent.setup()
    form()

    await user.type(screen.getByLabelText('Names to check'), 'GetPaid{Enter}café.com')
    await user.click(screen.getByRole('checkbox', { name: '.africa' }))
    await user.click(screen.getByRole('button', { name: 'Check names' }))

    const url = new URL(push.mock.calls[0]?.[0] as string, 'https://example.test')
    expect(url.pathname).toBe('/search/bulk')
    expect(url.searchParams.get('names')).toBe('getpaid\ncafé.com')
    expect(url.searchParams.getAll('tld')).toEqual(['com', 'africa'])
  })

  it('works before hydration: a plain GET form carrying the same fields', () => {
    form({ defaultNames: 'getpaid' })

    const element = screen.getByRole('form', { name: 'Bulk search' })
    expect(element).toHaveAttribute('action', '/search/bulk')
    expect(element).toHaveAttribute('method', 'get')
    expect(element).toHaveAttribute('data-enhanced', 'true')
    expect(screen.getByLabelText('Names to check')).toHaveAttribute('name', 'names')
    expect(screen.getByRole('checkbox', { name: '.com' })).toHaveAttribute('name', 'tld')
  })

  it('ticks only the extensions it was given, so nothing is chosen for anyone (N9)', () => {
    form({ defaultPicked: ['net'] })

    expect(screen.getByRole('checkbox', { name: '.com' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: '.net' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: '.africa' })).not.toBeChecked()
  })
})
