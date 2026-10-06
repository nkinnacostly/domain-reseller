import { API_KEY_PERMISSIONS } from '@dr/shared/mail'
import { z } from 'zod'

/** The dashboard's key forms (MAIL-SPEC §10 API keys). SQL checks every field again. */

export const createKeyInput = z
  .object({
    accountId: z.uuid(),
    name: z.string().trim().min(1, 'Give the key a name').max(60, 'At most 60 characters'),
    permission: z.enum(API_KEY_PERMISSIONS, 'Choose what the key may do'),
    /** "" from the form's "any domain" choice. */
    domainId: z
      .union([z.uuid(), z.literal('')])
      .optional()
      .transform((value) => value || null),
  })
  .superRefine((input, ctx) => {
    if (input.domainId && input.permission !== 'sending') {
      ctx.addIssue({
        code: 'custom',
        path: ['domainId'],
        message: 'Only a sending key can be limited to one domain',
      })
    }
  })

export type CreateKeyInput = z.input<typeof createKeyInput>

export const revokeKeyInput = z.object({ accountId: z.uuid(), keyId: z.uuid() })
