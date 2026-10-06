import 'server-only'

import { apiDeps } from '@/features/api/deps'
import { env } from '@/lib/env'
import { createServiceClient } from '@/lib/supabase/service'
import { createDomainApiStore } from '../queries/api-store'
import type { DomainApiDeps } from './handlers'

/** What a /api/v1/domains handler needs, per request: the key check, the domain functions, the SES region. */
export function domainApiDeps(): DomainApiDeps {
  return {
    ...apiDeps(),
    domains: createDomainApiStore(createServiceClient()),
    region: env.MAIL_SES_REGION ?? 'eu-west-2',
  }
}
