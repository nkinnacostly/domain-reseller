import 'server-only'

import { z } from 'zod'
import { type AdminPrincipal, type AdminSide, adminDb } from '@/features/admin/queries/session'
import { logger } from '@/lib/logger'

/**
 * The name checks page's reads (migration 73), through adminDb with the side
 * applied: what waits for a person, what was reviewed in the last 30 days,
 * and how many names were screened. The order each line belongs to comes
 * from `order_items`, by id.
 */

export type ScreeningRow = {
  orderItemId: string
  orderId: string | null
  domain: string
  matched: string[]
  note: string | null
  model: string | null
  screenedAt: string
  decision: 'fine' | 'abuse' | null
  reviewNote: string | null
  reviewedBy: string | null
  reviewedAt: string | null
}

export type Screenings = {
  open: ScreeningRow[]
  reviewed: ScreeningRow[]
  screened: number
  cleared: number
}

const record = z.object({
  order_item_id: z.string(),
  domain: z.string(),
  matched: z.array(z.string()).nullable(),
  note: z.string().nullable(),
  model: z.string().nullable(),
  screened_at: z.string(),
  decision: z.enum(['fine', 'abuse']).nullable(),
  review_note: z.string().nullable(),
  reviewed_by: z.string().nullable(),
  reviewed_at: z.string().nullable(),
})

const LIST_MAX = 100
const WINDOW_DAYS = 30

function failed(what: string, error: unknown) {
  logger.error({ err: error, what }, 'admin screening read failed')
}

export async function getScreenings(
  admin: AdminPrincipal,
  side: AdminSide,
  now: Date = new Date(),
): Promise<Screenings | null> {
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString()
  const db = adminDb(admin, side)
  const [open, reviewed, screened, cleared] = await Promise.all([
    db
      .from('order_screenings')
      .select(
        'order_item_id, domain, matched, note, model, screened_at, decision, review_note, reviewed_by, reviewed_at',
      )
      .eq('verdict', 'review')
      .is('reviewed_at', null)
      .order('screened_at', { ascending: true })
      .limit(LIST_MAX),
    db
      .from('order_screenings')
      .select(
        'order_item_id, domain, matched, note, model, screened_at, decision, review_note, reviewed_by, reviewed_at',
      )
      .gte('reviewed_at', since)
      .order('reviewed_at', { ascending: false })
      .limit(LIST_MAX),
    db
      .from('order_screenings')
      .select('order_item_id', { count: 'exact', head: true })
      .gte('screened_at', since),
    db
      .from('order_screenings')
      .select('order_item_id', { count: 'exact', head: true })
      .eq('verdict', 'clear')
      .gte('screened_at', since),
  ])
  const error = open.error ?? reviewed.error ?? screened.error ?? cleared.error
  if (error) {
    failed('screenings', error)
    return null
  }
  const parse = (rows: unknown[] | null) =>
    (rows ?? []).flatMap((row) => {
      const parsed = record.safeParse(row)
      return parsed.success ? [parsed.data] : []
    })
  const openRows = parse(open.data)
  const reviewedRows = parse(reviewed.data)
  const orders = await orderIds(
    admin,
    side,
    [...openRows, ...reviewedRows].map((row) => row.order_item_id),
  )
  const toRow = (row: z.infer<typeof record>): ScreeningRow => ({
    orderItemId: row.order_item_id,
    orderId: orders.get(row.order_item_id) ?? null,
    domain: row.domain,
    matched: row.matched ?? [],
    note: row.note,
    model: row.model,
    screenedAt: row.screened_at,
    decision: row.decision,
    reviewNote: row.review_note,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
  })
  return {
    open: openRows.map(toRow),
    reviewed: reviewedRows.map(toRow),
    screened: screened.count ?? 0,
    cleared: cleared.count ?? 0,
  }
}

/** Each line's order, for the link; a line that cannot be read keeps no link. */
async function orderIds(
  admin: AdminPrincipal,
  side: AdminSide,
  lineIds: string[],
): Promise<Map<string, string>> {
  if (lineIds.length === 0) return new Map()
  const { data, error } = await adminDb(admin, side)
    .from('order_items')
    .select('id, order_id')
    .in('id', [...new Set(lineIds)])
  if (error) {
    failed('screening orders', error)
    return new Map()
  }
  return new Map(
    (data ?? []).flatMap((row) => {
      const parsed = z.object({ id: z.string(), order_id: z.string() }).safeParse(row)
      return parsed.success ? [[parsed.data.id, parsed.data.order_id] as const] : []
    }),
  )
}
