import { verifyWebhook } from '@dr/shared/webhooks'
import { type NextRequest, NextResponse } from 'next/server'
import { authEmailPayloadSchema, planAuthEmail } from '@/features/auth/lib/auth-email'
import { sendEmail } from '@/lib/email/send'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'

/**
 * Supabase Auth's Send Email hook (L1). Sign-up, sign-in links, password
 * resets and email changes are sent here instead of over SMTP, so each goes
 * out from the no-reply address with Reply-To set to the support inbox — the
 * owner's choice (24 Sept 2026); Supabase's SMTP settings cannot set one.
 *
 * Only Supabase can call it: the body must carry a valid Standard Webhooks
 * signature made with SEND_EMAIL_HOOK_SECRET. Supabase shows the person an
 * error when this answers anything but 200, so a failed send is reported, not
 * swallowed. Addresses and tokens never reach a log line (N13).
 */

/** An auth hook payload is a few kilobytes. */
const MAX_BODY_BYTES = 64 * 1024

const failure = (status: number, message: string) =>
  NextResponse.json({ error: { http_code: status, message } }, { status })

export async function POST(request: NextRequest) {
  const secret = env.SEND_EMAIL_HOOK_SECRET
  if (!secret) {
    logger.error('SEND_EMAIL_HOOK_SECRET is not set: auth email cannot be sent')
    return failure(500, 'Email is not configured')
  }

  const body = await request.text()
  if (body.length > MAX_BODY_BYTES) return failure(413, 'Payload too large')

  const signed = await verifyWebhook(
    secret,
    {
      id: request.headers.get('webhook-id'),
      timestamp: request.headers.get('webhook-timestamp'),
      signature: request.headers.get('webhook-signature'),
    },
    body,
  )
  if (!signed) {
    logger.warn('auth email hook: signature refused')
    return failure(401, 'Invalid signature')
  }

  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return failure(400, 'Invalid payload')
  }
  const parsed = authEmailPayloadSchema.safeParse(json)
  if (!parsed.success) {
    logger.warn('auth email hook: payload not understood')
    return failure(400, 'Invalid payload')
  }

  const action = parsed.data.email_data.email_action_type
  const plan = planAuthEmail(parsed.data, env.NEXT_PUBLIC_APP_URL)
  if (plan.kind === 'skip') {
    logger.info({ action, reason: plan.reason }, 'auth email skipped')
    return NextResponse.json({})
  }

  for (const email of plan.emails) {
    const sent = await sendEmail(email)
    if (!sent.ok) {
      logger.error({ action, status: sent.status }, 'auth email not sent')
      return failure(502, 'The email could not be sent. Try again in a moment.')
    }
  }
  return NextResponse.json({})
}
