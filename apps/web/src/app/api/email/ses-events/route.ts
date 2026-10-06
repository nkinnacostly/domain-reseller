import { confirmSubscription, type SnsRefusal, verifySnsMessage } from '@dr/shared/sns'
import { type NextRequest, NextResponse } from 'next/server'
import { parseSesEvent, recordSesEvent } from '@/lib/email/ses-events'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'

/**
 * Amazon SES delivery events, pushed by SNS from the `mydomainshub`
 * configuration set (L1, FR-NT3, migration 34). SES cannot be asked what
 * became of a message, so this is how deliveries, bounces and complaints of
 * the emails we send through it are recorded.
 *
 * Every message's SNS signature is verified, for exactly SES_EVENTS_TOPIC_ARN,
 * before anything is done. SNS retries anything but a 2xx or 4xx, so:
 *   200 — recorded, or safely ignorable (not ours, not an event we keep);
 *   4xx — not a message we can verify: SNS stops, a forger learns nothing;
 *   503 — the database could not record it (or the certificate host or our
 *         own settings were missing): SNS delivers it again later.
 * Nothing about a recipient reaches a log line (N13).
 */

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
  NextResponse.json({ ok: status === 200, ...body }, { status })

export async function POST(request: NextRequest) {
  const topicArn = env.SES_EVENTS_TOPIC_ARN
  if (!topicArn) {
    // Configuration, not the sender's fault: let SNS try again once it is set.
    logger.error('SES_EVENTS_TOPIC_ARN is not set: SES delivery events cannot be verified')
    return answer(503)
  }

  const body = await request.text()
  if (body.length > MAX_BODY_BYTES) return answer(413)
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return answer(400)
  }

  const verdict = await verifySnsMessage(json, { topicArn })
  if (!verdict.ok) {
    logger.warn({ reason: verdict.reason }, 'SES events: SNS message refused')
    return answer(REFUSED[verdict.reason])
  }
  const { message, snsHost } = verdict

  if (message.Type === 'SubscriptionConfirmation') {
    const outcome = await confirmSubscription(message, snsHost)
    if (outcome === 'confirmed') {
      logger.info({ snsMessageId: message.MessageId }, 'SES events: SNS subscription confirmed')
      return answer(200)
    }
    logger.error({ outcome }, 'SES events: SNS subscription not confirmed')
    return answer(outcome === 'refused' ? 400 : 502)
  }
  if (message.Type === 'UnsubscribeConfirmation') {
    logger.warn('SES events: SNS reports this endpoint was unsubscribed')
    return answer(200)
  }

  const event = parseSesEvent(message.Message)
  if (!event) {
    logger.info({ snsMessageId: message.MessageId }, 'SES events: not a delivery event, ignored')
    return answer(200, { ignored: true })
  }
  let known: boolean
  try {
    known = await recordSesEvent(event)
  } catch (error) {
    logger.error(
      { event: event.event, err: error instanceof Error ? error.message : 'error' },
      'SES events: could not record',
    )
    return answer(503)
  }
  logger.info(
    { event: event.event, messageId: event.messageId, known },
    'SES events: delivery event',
  )
  return answer(200, known ? {} : { ignored: true })
}
