/**
 * Live or Test (docs/ADMIN-SPEC.md §5.1). The side is a cookie, scoped to
 * `/admin`: which records the pages show. A test administrator always sees
 * the test side, whatever the cookie says — SQL and adminDb enforce that,
 * this only words it.
 */

export type AdminSide = 'live' | 'test'

export const SIDE_COOKIE = 'dr_admin_side'

export const SIDE_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/admin',
  maxAge: 30 * 24 * 60 * 60,
}

export function parseSide(value: string | null | undefined): AdminSide {
  return value === 'test' ? 'test' : 'live'
}

/** The side a principal sees: a test admin is always on the test side (D15). */
export function sideFor(
  admin: { testOnly: boolean },
  cookie: string | null | undefined,
): AdminSide {
  return admin.testOnly ? 'test' : parseSide(cookie)
}

export const TEST_SIDE_BANNER = 'Showing test-mode records — no real money'
export const TEST_ADMIN_BANNER =
  "Test administrator: live records and customers' details are hidden, and live actions are refused."

/** What the side banner says, or nothing on the live side for a real admin. */
export function sideBanner(admin: { testOnly: boolean }, side: AdminSide): string | null {
  if (admin.testOnly) return TEST_ADMIN_BANNER
  return side === 'test' ? TEST_SIDE_BANNER : null
}
