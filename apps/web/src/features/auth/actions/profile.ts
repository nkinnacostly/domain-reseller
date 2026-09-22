'use server'

import { revalidatePath } from 'next/cache'
import { logger } from '@/lib/logger'
import { authAction } from '@/lib/safe-action'
import { FALLBACK_MESSAGE } from '../lib/messages'
import { profileSchema } from '../schemas'

export const updateProfile = authAction
  .inputSchema(profileSchema)
  .action(async ({ parsedInput, ctx }): Promise<{ error: string } | { ok: true }> => {
    // Runs as the user: RLS picks the row, and the column grant (migration 08)
    // limits it to contact details.
    const { error } = await ctx.supabase
      .from('profiles')
      .update({ full_name: parsedInput.fullName, phone: parsedInput.phone || null })
      .eq('id', ctx.user.id)
    if (error) {
      logger.error({ err: error }, 'profile update failed')
      return { error: FALLBACK_MESSAGE }
    }
    revalidatePath('/app/settings')
    return { ok: true }
  })
