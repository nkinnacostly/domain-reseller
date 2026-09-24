/**
 * Every row a query matches, a page at a time. PostgREST answers at most
 * 1,000 rows per request (the project's `max_rows`), so a whole-table read
 * silently stops there — the catalogue passed 700 extensions in September
 * 2026. The query must be ordered, or pages can overlap or skip rows.
 */

export const PAGE_SIZE = 1000

type Page<T> = { data: T[] | null; error: { message: string } | null }

export async function allRows<T>(
  page: (from: number, to: number) => PromiseLike<Page<T>>,
  size = PAGE_SIZE,
): Promise<Page<T>> {
  const rows: T[] = []
  for (let from = 0; ; from += size) {
    const { data, error } = await page(from, from + size - 1)
    if (error) return { data: null, error }
    rows.push(...(data ?? []))
    if (!data || data.length < size) return { data: rows, error: null }
  }
}
