import { EMAIL_BRAND } from '@dr/shared'
import { type JsonResponse, NoAnswer, requestJson } from '../lib/http'
import type { Delivery, Mailer } from './mailer'

/**
 * Brevo's transactional API (L1): send one message, and read back what
 * became of one (FR-NT3). From the no-reply address on the authenticated
 * subdomain, replies to the support inbox.
 *
 * Addresses and content never reach a log or an error string (N13): a
 * refusal is described by its status and Brevo's short code only. A 400 is
 * Brevo refusing the message itself, so it is permanent.
 */

type Request = (url: string, init: Parameters<typeof requestJson>[1]) => Promise<JsonResponse>

const PERMANENT_BOUNCE = new Set(['hardBounces', 'blocked', 'invalid', 'error'])
const STILL_TRYING = new Set(['softBounces', 'deferred'])

/** Brevo's event names, reduced to what a compliance notice needs to know. */
export function deliveryFrom(events: string[]): Delivery {
  if (events.some((event) => PERMANENT_BOUNCE.has(event))) return 'bounced'
  if (events.includes('delivered')) return 'delivered'
  if (events.some((event) => STILL_TRYING.has(event))) return 'deferred'
  return null
}

export function createBrevo(options: {
  apiKey: string
  request?: Request
  baseUrl?: string
}): Mailer & { delivery: NonNullable<Mailer['delivery']> } {
  const { apiKey, request = requestJson, baseUrl = 'https://api.brevo.com/v3' } = options
  const headers = { 'api-key': apiKey }

  return {
    provider: 'brevo',

    async send(message) {
      let response: JsonResponse
      try {
        response = await request(`${baseUrl}/smtp/email`, {
          method: 'POST',
          headers,
          timeoutMs: 15_000,
          body: {
            sender: { name: message.fromName ?? EMAIL_BRAND.name, email: EMAIL_BRAND.noReplyEmail },
            replyTo: { name: EMAIL_BRAND.name, email: EMAIL_BRAND.supportEmail },
            to: [{ email: message.to }],
            subject: message.subject,
            htmlContent: message.html,
            textContent: message.text,
            tags: message.tags,
          },
        })
      } catch (error) {
        // No answer: Brevo may have accepted it. Trying again risks a duplicate
        // email, which is better than a lost notice.
        return {
          ok: false,
          permanent: false,
          error: error instanceof NoAnswer ? 'no answer from Brevo' : 'could not reach Brevo',
        }
      }
      const body = (response.body ?? {}) as { messageId?: unknown; code?: unknown }
      if (response.status >= 200 && response.status < 300) {
        return { ok: true, messageId: typeof body.messageId === 'string' ? body.messageId : null }
      }
      const code = typeof body.code === 'string' ? ` ${body.code.slice(0, 40)}` : ''
      return {
        ok: false,
        permanent: response.status === 400,
        error: `HTTP ${response.status}${code}`,
      }
    },

    async delivery(messageId) {
      const query = new URLSearchParams({ messageId, days: '8', limit: '50' })
      const response = await request(`${baseUrl}/smtp/statistics/events?${query}`, {
        headers,
        timeoutMs: 15_000,
      })
      if (response.status !== 200) throw new Error(`Brevo events: HTTP ${response.status}`)
      const events = ((response.body ?? {}) as { events?: { event?: unknown }[] }).events ?? []
      return deliveryFrom(events.map((entry) => String(entry.event ?? '')))
    },
  }
}
