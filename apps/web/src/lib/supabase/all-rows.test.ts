import { describe, expect, it, vi } from 'vitest'
import { allRows } from './all-rows'

const table = Array.from({ length: 5 }, (_, i) => ({ id: i }))
const pages = (rows = table) =>
  vi.fn(async (from: number, to: number) => ({ data: rows.slice(from, to + 1), error: null }))

describe('allRows', () => {
  it('reads past the page limit, in order', async () => {
    const page = pages()
    expect(await allRows(page, 2)).toEqual({ data: table, error: null })
    expect(page.mock.calls).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
    ])
  })

  it('asks once more when the last page is exactly full', async () => {
    const page = pages(table.slice(0, 4))
    expect((await allRows(page, 2)).data).toHaveLength(4)
    expect(page).toHaveBeenCalledTimes(3)
  })

  it('stops at the first error and returns no partial list', async () => {
    const page = vi
      .fn()
      .mockResolvedValueOnce({ data: table.slice(0, 2), error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'timeout' } })
    expect(await allRows(page, 2)).toEqual({ data: null, error: { message: 'timeout' } })
  })

  it('treats a missing page as the end', async () => {
    const page = vi.fn().mockResolvedValue({ data: null, error: null })
    expect(await allRows(page)).toEqual({ data: [], error: null })
  })
})
