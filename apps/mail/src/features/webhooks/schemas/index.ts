import { checkWebhookUrl, WEBHOOK_EVENTS } from '@dr/shared/mail'
import { z } from 'zod'
import { URL_REFUSAL } from '../lib/words'

/**
 * The Webhooks page's inputs (MAIL-SPEC §6). The URL is checked and put in
 * the form SQL stores (https, public, no credentials, no fragment) before
 * anything is sealed or saved; SQL checks it again.
 */

const uuid = z.uuid('That was not found.')

export const webhookUrlSchema = z.string().transform((value, ctx) => {
  const check = checkWebhookUrl(value)
  if (!check.ok) {
    ctx.addIssue({ code: 'custom', message: URL_REFUSAL[check.reason] })
    return z.NEVER
  }
  return check.url
})

const eventsSchema = z
  .array(z.enum(WEBHOOK_EVENTS))
  .min(1, 'Choose at least one event.')
  .max(WEBHOOK_EVENTS.length)
  .transform((events) => [...new Set(events)])

const descriptionSchema = z
  .string()
  .trim()
  .max(100, 'Keep the description under 100 characters.')
  .optional()
  .transform((value) => (value ? value : undefined))

export const createWebhookSchema = z.object({
  accountId: uuid,
  url: webhookUrlSchema,
  events: eventsSchema,
  description: descriptionSchema,
})

export const updateWebhookSchema = createWebhookSchema.extend({ webhookId: uuid })

export const webhookIdSchema = z.object({ accountId: uuid, webhookId: uuid })

export const setEnabledSchema = webhookIdSchema.extend({ enabled: z.boolean() })

export const resendSchema = z.object({
  accountId: uuid,
  deliveryId: z.number().int().positive(),
})
