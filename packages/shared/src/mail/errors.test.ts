import { describe, expect, it } from 'vitest'
import { sendEmailSchema } from './api'
import {
  API_ERROR_NAMES,
  API_ERROR_STATUS,
  apiError,
  apiErrorSchema,
  describeIssues,
  refusalToApiError,
  sqlRefusalSchema,
} from './errors'

const refused = (fields: Record<string, unknown>) =>
  sqlRefusalSchema.parse({ ok: false, ...fields })

describe('the error answer (§6)', () => {
  it('has the spec’s nine names, each with its status', () => {
    expect(API_ERROR_NAMES).toEqual([
      'validation_error',
      'unauthorized',
      'forbidden',
      'not_found',
      'rate_limited',
      'quota_exceeded',
      'domain_not_verified',
      'account_paused',
      'internal_error',
    ])
    expect(API_ERROR_STATUS.unauthorized).toBe(401)
    expect(API_ERROR_STATUS.quota_exceeded).toBe(429)
    expect(apiErrorSchema.safeParse({ name: 'forbidden', message: 'x' }).success).toBe(true)
    expect(apiErrorSchema.safeParse({ name: 'teapot', message: 'x' }).success).toBe(false)
  })

  it('rounds retry-after up to whole seconds, at least one', () => {
    expect(apiError('rate_limited', 'x', 0.2).retryAfter).toBe(1)
    expect(apiError('rate_limited', 'x', 12.1).retryAfter).toBe(13)
    expect(apiError('forbidden', 'x')).not.toHaveProperty('retryAfter')
  })
})

describe('SQL refusals in the API’s words', () => {
  it.each([
    [{ code: 'unauthorized' }, 'unauthorized', 401],
    [{ code: 'forbidden', reason: 'key_domain' }, 'forbidden', 403],
    [{ code: 'forbidden' }, 'forbidden', 403],
    [{ code: 'sandbox_recipient' }, 'forbidden', 403],
    [{ code: 'account_not_ready' }, 'forbidden', 403],
    [{ code: 'domain_not_verified' }, 'domain_not_verified', 403],
    [{ code: 'account_paused' }, 'account_paused', 403],
    [{ code: 'not_found' }, 'not_found', 404],
    [{ code: 'validation', field: 'subject' }, 'validation_error', 422],
    [{ code: 'validation', field: 'something new' }, 'validation_error', 422],
    [{ code: 'idempotency_conflict' }, 'validation_error', 409],
    [{ code: 'no_such_code' }, 'internal_error', 500],
  ])('%j → %s %i', (fields, name, status) => {
    const error = refusalToApiError(refused(fields))
    expect(error).toMatchObject({ name, status })
    expect(error.message.length).toBeGreaterThan(10)
  })

  it('a rate limit says when to come back', () => {
    expect(refusalToApiError(refused({ code: 'rate_limited', retryAfterMs: 1500 }))).toMatchObject({
      name: 'rate_limited',
      status: 429,
      retryAfter: 2,
    })
    expect(refusalToApiError(refused({ code: 'rate_limited' })).retryAfter).toBe(1)
  })

  it('the plan’s quota names the cap and the day or month; ours says it is ours', () => {
    const day = refusalToApiError(
      refused({ code: 'quota_exceeded', scope: 'day', cap: 5000, retryAfter: 3600 }),
    )
    expect(day).toMatchObject({ name: 'quota_exceeded', status: 429, retryAfter: 3600 })
    expect(day.message).toContain('5,000 emails for today')
    const month = refusalToApiError(
      refused({ code: 'quota_exceeded', scope: 'month', retryAfter: 86400 }),
    )
    expect(month.message).toContain('emails for this month')
    const ours = refusalToApiError(refused({ code: 'budget_exceeded', retryAfter: 600 }))
    expect(ours).toMatchObject({ name: 'quota_exceeded', status: 429, retryAfter: 600 })
    expect(ours.message).toContain('our limit, not your plan’s')
    expect(refusalToApiError(refused({ code: 'budget_exceeded' })).retryAfter).toBe(3600)
  })

  it('describes Zod issues by path and rule, never by value', () => {
    const parsed = sendEmailSchema.safeParse({
      from: 'secret-person@example.com',
      to: 'nobody',
      subject: '',
    })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      const words = describeIssues(parsed.error)
      expect(words).toContain('to:')
      expect(words).not.toContain('secret-person')
      expect(words).not.toContain('nobody')
    }
  })
})
