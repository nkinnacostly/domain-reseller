import {
  type CertificateFetch,
  confirmSubscription,
  type SnsRefusal,
  verifySnsMessage,
} from '@dr/shared/sns'
import { parseSendEvent } from '../lib/ses-event'
import { parseTenantEvent } from '../lib/tenant-event'
import type { EventStore } from './store'

/**
 * POST /api/ses/events (MAIL-SPEC §3, §4.2): every account's configuration
 * set and the EventBridge rule for tenant status publish to SNS
 * `mail-ses-events`, whose HTTPS subscription delivers here.
 *
 * Every message's SNS signature is verified, for exactly
 * MAIL_SES_EVENTS_TOPIC_ARN, before anything is done — as the shop's
 * /api/email/ses-events, with the same verifier (`@dr/shared/sns`). SNS
 * retries anything but a 2xx or 4xx, so:
 *   200 — recorded, or safely ignorable (not ours, not an event we keep);
 *   4xx — not a message we can verify: SNS stops, a forger learns nothing;
 *   503 — the database could not record it (or the certificate host or our
 *         own settings were missing): SNS delivers it again later.
 * Log lines carry ids and codes only — never an address (N13, MR4).
 */

type Log = {
  info(fields: object, message: string): void
  warn(fields: object, message: string): void
  error(fields: object, message: string): void
}

export type SesEventsDeps = {
  topicArn: string | undefined
  store: () => EventStore
  log: Log
  fetchCertificate?: CertificateFetch
}

/** SNS messages are at most 256 KB; SES events with headers are far smaller. */
const MAX_BODY_BYTES = 300 * 1024

const REFUSED: Record<SnsRefusal, number> = {
  malformed: 400,
  wrong_topic: 403,
  bad_certificate_url: 403,
  bad_certificate: 403,
  bad_signature: 403,
  certificate_unreachable: 503,
}

const answer = (status: number, body: Record<string, unknown> = {}) =>
  Response.json({ ok: status === 200, ...body }, { status })

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const json: unknown = JSON.parse(text)
    return json && typeof json === 'object' && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export async function handleSesEvents(request: Request, deps: SesEventsDeps): Promise<Response> {
  const { topicArn, log } = deps
  if (!topicArn) {
    // Configuration, not the sender's fault: let SNS try again once it is set.
    log.error({}, 'MAIL_SES_EVENTS_TOPIC_ARN is not set: SES events cannot be verified')
    return answer(503)
  }

  const body = await request.text()
  if (body.length > MAX_BODY_BYTES) return answer(413)
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return answer(400)
  }

  const verdict = await verifySnsMessage(raw, {
    topicArn,
    ...(deps.fetchCertificate ? { fetchCertificate: deps.fetchCertificate } : {}),
  })
  if (!verdict.ok) {
    log.warn({ reason: verdict.reason }, 'SES events: SNS message refused')
    return answer(REFUSED[verdict.reason])
  }
  const { message, snsHost } = verdict
  const snsMessageId = message.MessageId

  if (message.Type === 'SubscriptionConfirmation') {
    const outcome = await confirmSubscription(message, snsHost)
    if (outcome === 'confirmed') {
      log.info({ snsMessageId }, 'SES events: SNS subscription confirmed')
      return answer(200)
    }
    log.error({ outcome }, 'SES events: SNS subscription not confirmed')
    return answer(outcome === 'refused' ? 400 : 502)
  }
  if (message.Type === 'UnsubscribeConfirmation') {
    log.warn({ snsMessageId }, 'SES events: SNS reports this endpoint was unsubscribed')
    return answer(200)
  }

  const json = parseJson(message.Message)
  const sendEvent = json ? parseSendEvent(json) : null
  const tenantEvent = json && !sendEvent ? parseTenantEvent(json) : null

  try {
    if (sendEvent) {
      const known = await deps.store().recordSendEvent(sendEvent, snsMessageId)
      const fields = {
        snsMessageId,
        event: sendEvent.event,
        messageId: sendEvent.messageId,
        emailId: sendEvent.emailId,
        known,
      }
      if (!known) {
        log.info(fields, 'SES events: an event for no email of ours, ignored')
        return answer(200, { ignored: true })
      }
      log.info(fields, 'SES events: send event recorded')
      return answer(200)
    }
    if (tenantEvent) {
      const outcome = await deps.store().recordTenantEvent(tenantEvent)
      const fields = {
        snsMessageId,
        eventId: tenantEvent.eventId,
        type: tenantEvent.type,
        tenant: tenantEvent.tenant,
        status: tenantEvent.status,
        ...outcome,
      }
      if (!outcome.known) {
        log.info(fields, 'SES events: a tenant event for no account of ours, ignored')
        return answer(200, { ignored: true })
      }
      log.info(fields, 'SES events: tenant event recorded')
      return answer(200)
    }
  } catch (error) {
    log.error(
      { snsMessageId, err: error instanceof Error ? error.message : 'error' },
      'SES events: could not record',
    )
    return answer(503)
  }

  log.info({ snsMessageId }, 'SES events: not an event we keep, ignored')
  return answer(200, { ignored: true })
}
