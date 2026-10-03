import { nameserverSetSchema } from '@dr/shared/schemas'
import { z } from 'zod'
import { LIMIT_FIELD, LIMIT_KEYS, type LimitKey } from '@/features/admin/lib/settings-limits'
import {
  codeSchema,
  optionalReasonSchema,
  reasonSchema,
  requestKeySchema,
  uuidSchema,
} from '@/features/admin/schemas/common'

/**
 * The Settings actions' inputs (docs/ADMIN-SPEC.md §3.1.2, §5.2 B13),
 * validated before anything else runs: no wrapper sees an unchecked value.
 * Each bound is the wrapper's own, so a value the form lets through is one
 * SQL would take — and SQL checks it again.
 */

const moneyWrite = z.object({ requestKey: requestKeySchema, code: codeSchema })

// ── Limits ──────────────────────────────────────────────────────────────────

const limitValue = (key: LimitKey) => {
  const field = LIMIT_FIELD[key]
  return z
    .number()
    .int('Whole units only.')
    .min(field.min, `${field.label}: too small.`)
    .max(field.max, `${field.label}: too large.`)
}

const limitChanges = z
  .object(
    Object.fromEntries(LIMIT_KEYS.map((key) => [key, limitValue(key).optional()])) as Record<
      LimitKey,
      z.ZodOptional<z.ZodNumber>
    >,
  )
  .strict()
  .refine((changes) => Object.values(changes).some((value) => value !== undefined), {
    message: 'Change a value to save it.',
  })

export const updateLimitsSchema = moneyWrite.extend({
  changes: limitChanges,
  reason: reasonSchema,
})

// ── Extensions ──────────────────────────────────────────────────────────────

const extensionSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9.-]{0,62}$/, 'Not an extension')

/** A pause's reason is shown with the extension and kept in the audit log: one text, 10–120 characters. */
export const PAUSE_REASON_MAX = 120

export const TAGLINE_MAX = 60
export const RANK_MAX = 50

export const extensionFlagsSchema = moneyWrite.extend({
  name: extensionSchema,
  change: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('pause'),
      why: z
        .string()
        .trim()
        .min(10, 'Say why in at least 10 characters.')
        .max(PAUSE_REASON_MAX, `Keep it under ${PAUSE_REASON_MAX} characters.`),
    }),
    z.object({ kind: z.literal('resume'), reason: reasonSchema }),
    z.object({
      kind: z.literal('feature'),
      rank: z.number().int().min(1, 'Rank 1 to 50.').max(RANK_MAX, 'Rank 1 to 50.'),
      tagline: z.string().trim().max(TAGLINE_MAX, `Keep it under ${TAGLINE_MAX} characters.`),
      reason: reasonSchema,
    }),
    z.object({ kind: z.literal('unfeature'), reason: reasonSchema }),
  ]),
})

export type ExtensionChange = z.infer<typeof extensionFlagsSchema>['change']

// ── SSL products ────────────────────────────────────────────────────────────

export const sslSellableSchema = moneyWrite.extend({
  productCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,40}$/, 'Not a product code'),
  sellable: z.boolean(),
  reason: reasonSchema,
})

// ── Presets ─────────────────────────────────────────────────────────────────

const sourceUrlSchema = z
  .string()
  .trim()
  .max(500, 'Keep the address under 500 characters.')
  .regex(
    /^https:\/\/[A-Za-z0-9.-]+(?:[/?#]|$)/,
    "Paste the https address of the provider's own page.",
  )

export const saveDraftSchema = moneyWrite
  .extend({
    /** The preset the draft changes; null for a new host. */
    presetId: uuidSchema.nullable(),
    provider: z.string().trim().max(60).optional(),
    nameservers: z.array(z.string()).max(13),
    sourceUrl: sourceUrlSchema,
    notes: z.string().trim().max(500, 'Keep the notes under 500 characters.').optional(),
    assignsPerZone: z.boolean(),
    reason: reasonSchema,
  })
  .superRefine((input, context) => {
    if (input.presetId === null && (input.provider ?? '').length < 2) {
      context.addIssue({
        code: 'custom',
        path: ['provider'],
        message: 'Name the provider in 2 to 60 characters.',
      })
    }
    if (input.assignsPerZone) {
      if (input.nameservers.length > 0) {
        context.addIssue({
          code: 'custom',
          path: ['nameservers'],
          message: 'A host that gives each domain its own nameservers has none here.',
        })
      }
      return
    }
    const set = nameserverSetSchema.safeParse(input.nameservers)
    if (!set.success) {
      context.addIssue({
        code: 'custom',
        path: ['nameservers'],
        message: set.error.issues[0]?.message ?? 'Give 2 to 13 nameservers.',
      })
    }
  })

export const publishDraftSchema = moneyWrite.extend({ draftId: uuidSchema, reason: reasonSchema })

export const discardDraftSchema = z.object({
  draftId: uuidSchema,
  reason: optionalReasonSchema,
  requestKey: requestKeySchema,
})

export const checkDraftSchema = z.object({ draftId: uuidSchema })

export const hidePresetSchema = z.object({
  presetId: uuidSchema,
  reason: optionalReasonSchema,
  requestKey: requestKeySchema,
})

export const showPresetSchema = moneyWrite.extend({ presetId: uuidSchema, reason: reasonSchema })
