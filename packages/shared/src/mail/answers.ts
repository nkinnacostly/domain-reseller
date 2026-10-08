import { z } from 'zod'
import { API_KEY_PERMISSIONS } from './resources'
import { EMAIL_STATUSES } from './status'

/**
 * What Mail's SQL answers when it accepts, for the two calls every way in
 * makes — the v1 API (apps/mail) and the SMTP relay (apps/mail-smtp): the key
 * check and the queue. A refusal is `sqlRefusalSchema` (errors.ts). A shape
 * neither expects is an error to its caller, never a guess.
 */

/** `authenticate_key` (migration 43): the key's account, permission and domain limit. */
export const sqlKeyAcceptedSchema = z.object({
  ok: z.literal(true),
  keyId: z.uuid(),
  accountId: z.uuid(),
  permission: z.enum(API_KEY_PERMISSIONS),
  domainId: z.uuid().nullable(),
})

export type ApiKeyAuth = Omit<z.infer<typeof sqlKeyAcceptedSchema>, 'ok'>

/** `enqueue_email` (migrations 44, 48, 54): the email's id and status, and whether it was a replay. */
export const sqlEnqueuedSchema = z.object({
  ok: z.literal(true),
  id: z.uuid(),
  status: z.enum(EMAIL_STATUSES),
  replayed: z.boolean(),
})
