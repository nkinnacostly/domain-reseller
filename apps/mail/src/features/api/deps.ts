import 'server-only'

import { requireApiKeyPepper } from '@/lib/env'
import { createServiceClient } from '@/lib/supabase/service'
import { type ApiStore, createApiStore } from './store'

/**
 * What a v1 handler needs, built per request: the database (secret key,
 * functions only) and the API key pepper. A missing setting is an error the
 * handler answers as `internal_error` — never a request let through.
 */
export type ApiDeps = { store: ApiStore; pepper: string }

export function apiDeps(): ApiDeps {
  return { store: createApiStore(createServiceClient()), pepper: requireApiKeyPepper() }
}
