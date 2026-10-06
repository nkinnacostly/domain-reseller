import { z } from 'zod'
import { GRANTABLE_ROLES } from '../lib/roles'

/**
 * Inputs for accounts, members and invites (MAIL-SPEC §7.1, §9). SQL checks
 * every one again (migrations 43, 46); these give the form its words first.
 */

export const accountIdSchema = z.uuid({ error: 'That account was not found.' })

/** "acme.ng" or "https://acme.ng/" — kept as a full https address, at most 200 characters. */
export const websiteSchema = z
  .string()
  .trim()
  .min(1, 'Enter your website, for example https://acme.ng')
  .max(200, 'Use 200 characters or fewer')
  .transform((value) => (/^https?:\/\//i.test(value) ? value : `https://${value}`))
  .pipe(
    z.url({
      protocol: /^https?$/,
      hostname: z.regexes.domain,
      error: 'Enter your website, for example https://acme.ng',
    }),
  )

/** "50,000" or "50000"; a whole number of emails a month. */
export const volumeSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s,]/g, ''))
  .pipe(
    z
      .string()
      .regex(/^\d{1,9}$/, 'Enter a whole number of emails a month, for example 5000')
      .transform(Number),
  )
  .pipe(z.number().int().min(0).max(100_000_000, 'Enter at most 100,000,000'))

export const profileFieldsSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Enter a name for the account')
    .max(100, 'Use 100 characters or fewer'),
  website: websiteSchema,
  useCase: z
    .string()
    .trim()
    .min(10, 'Say in a sentence what you will send, for example order receipts')
    .max(1000, 'Use 1,000 characters or fewer'),
  expectedMonthlyVolume: volumeSchema,
})

/** §7.1 and the Acceptable Use Policy's first rule: transactional email only in v1 (M1). */
export const onboardingSchema = profileFieldsSchema.extend({
  transactionalOnly: z.literal(true, {
    error:
      'Mail is for transactional email only. Tick the box to confirm that is what you will send.',
  }),
})

export const updateProfileSchema = profileFieldsSchema.extend({ accountId: accountIdSchema })

export const switchAccountSchema = z.object({ accountId: accountIdSchema })

const inviteEmail = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: 'Enter a valid email address' }).max(254))

export const grantableRoleSchema = z.enum(GRANTABLE_ROLES, { error: 'Choose a role' })

export const createInviteSchema = z.object({
  accountId: accountIdSchema,
  email: inviteEmail,
  role: grantableRoleSchema,
})

export const revokeInviteSchema = z.object({ accountId: accountIdSchema, inviteId: z.uuid() })

export const memberSchema = z.object({ accountId: accountIdSchema, userId: z.uuid() })

export const changeRoleSchema = memberSchema.extend({ role: grantableRoleSchema })

export const transferSchema = memberSchema.extend({
  /** The account's name, typed: handing an account over is not done by accident. */
  confirmName: z.string().trim().min(1, 'Type the account’s name to confirm'),
})

export const acceptInviteSchema = z.object({ token: z.string().min(1).max(100) })
