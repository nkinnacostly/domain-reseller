import 'server-only'

import { isTestSecretKey } from '@dr/shared'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * Whether a certificate for this supplier name is already ours (FR-SSL-6):
 * any account's, on the side payments are taken on — test keys buy in the
 * sandbox, live keys in production. The supplier reaches only the first
 * certificate on a name, so a second could never be set up (Appendix E).
 * Null when it could not be asked: then nothing is sold.
 */
export async function sslNameInUse(commonName: string): Promise<boolean | null> {
  const key = env.FLUTTERWAVE_SECRET_KEY
  const testMode = !key || isTestSecretKey(key)
  const { data, error } = await createServiceClient().rpc('ssl_name_in_use', {
    p_common_name: commonName,
    p_test_mode: testMode,
  })
  if (error) {
    logger.error({ code: error.code, err: error.message }, 'SSL name check failed')
    return null
  }
  return data === true
}
