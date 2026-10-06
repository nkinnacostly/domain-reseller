import { handleSesEvents } from '@/features/events/api/ses-events'
import { createEventStore } from '@/features/events/api/store'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * SES events and tenant status, pushed by SNS `mail-ses-events` (MAIL-SPEC
 * §4.2): every signature verified for MAIL_SES_EVENTS_TOPIC_ARN, then
 * recorded by `record_send_event` or `record_tenant_event` (migration 49).
 */
export function POST(request: Request) {
  return handleSesEvents(request, {
    topicArn: env.MAIL_SES_EVENTS_TOPIC_ARN,
    store: () => createEventStore(createServiceClient()),
    log: logger,
  })
}
