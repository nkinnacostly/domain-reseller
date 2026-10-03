'use server'

import { cookies } from 'next/headers'
import { z } from 'zod'
import { SIDE_COOKIE, SIDE_COOKIE_OPTIONS } from '@/features/admin/lib/side'
import { sideSchema } from '@/features/admin/schemas/common'
import { adminAction } from '@/lib/safe-action'

/**
 * Live or Test (docs/ADMIN-SPEC.md §5.1). Only which records the pages show:
 * not audited and not in admin_tier. A test admin may switch, but SQL and
 * adminDb keep them on the test side whatever the cookie says (D15).
 */
export const switchAdminSide = adminAction('side.switch', z.object({ side: sideSchema })).action(
  async ({ parsedInput, ctx }) => {
    const side = ctx.admin.testOnly ? 'test' : parsedInput.side
    const store = await cookies()
    store.set(SIDE_COOKIE, side, SIDE_COOKIE_OPTIONS)
    return { ok: true as const, side }
  },
)
