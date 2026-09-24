import 'server-only'

import { logger } from '@/lib/logger'
import { createPublicClient } from '@/lib/supabase/public'
import { takesTransfers } from '../lib/start'

/**
 * Whether the catalogue says we take transfers for an extension — the same
 * rule the transfer checkout applies, so the check page never offers a start
 * the checkout would refuse. Public data, read without a session. A failed
 * read is a no: the link is withheld, never offered on a guess.
 */
export async function takesTransfersFor(tld: string): Promise<boolean> {
  const { data, error } = await createPublicClient()
    .from('tlds')
    .select('is_transferable, transfer_usd')
    .eq('name', tld)
    .maybeSingle()
  if (error) {
    logger.warn({ tld, err: error.message }, 'transfer flag could not be read')
    return false
  }
  return data ? takesTransfers(data) : false
}
