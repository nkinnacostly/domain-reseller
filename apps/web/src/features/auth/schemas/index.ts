import { z } from 'zod'

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: 'Enter a valid email address' }))

/** 10 characters minimum; 72 is bcrypt's limit, past which characters are ignored. */
export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(72, 'Use 72 characters or fewer')

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password'),
  next: z.string().optional(),
})

export const signUpSchema = z.object({
  fullName: z.string().trim().min(2, 'Enter your name').max(100),
  email: emailSchema,
  password: passwordSchema,
  next: z.string().optional(),
})

export const emailOnlySchema = z.object({ email: emailSchema, next: z.string().optional() })

export const newPasswordSchema = z
  .object({ password: passwordSchema, confirm: z.string() })
  .refine((value) => value.password === value.confirm, {
    path: ['confirm'],
    error: "The passwords don't match",
  })

export const changePasswordSchema = z
  .object({
    current: z.string().min(1, 'Enter your current password'),
    password: passwordSchema,
    confirm: z.string(),
  })
  .refine((value) => value.password === value.confirm, {
    path: ['confirm'],
    error: "The passwords don't match",
  })

/** Authenticator codes are six digits; people paste them with spaces. */
export const totpCodeSchema = z
  .string()
  .transform((value) => value.replace(/\s+/g, ''))
  .pipe(z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from your app'))

export const profileSchema = z.object({
  fullName: z.string().trim().min(2, 'Enter your name').max(100),
  phone: z
    .string()
    .trim()
    .max(20)
    .regex(/^$|^\+?[\d\s-]{7,20}$/, 'Enter a phone number, for example +234 803 123 4567')
    .optional(),
})
