import { createDomainSchema, deletedDomainSchema, domainSchema } from '@dr/shared/mail'
import { describe, expect, it } from 'vitest'
import { domainJson } from '@/features/domains/api/handlers'
import type { DomainView } from '@/features/domains/queries/api-store'
import { createDomainBodySchema } from '@/features/domains/schemas'

/**
 * The OpenAPI document and the reference describe /domains from
 * `@dr/shared/mail`'s schemas; the domains package's handlers build the
 * answers. This holds the two together: every answer the handler can give
 * parses with the described schema, strictly — no field missing, none extra —
 * and the described body accepts and refuses what the handler does.
 */

const view = (over: Partial<DomainView> = {}): DomainView => ({
  id: '2c9e7f10-3b2a-4c4d-8e5f-6a7b8c9d0e1f',
  name: 'acme.ng',
  status: 'pending',
  dkimTokens: ['tok1', 'tok2', 'tok3'],
  dkimStatus: 'PENDING',
  mailFromDomain: 'send.acme.ng',
  mailFromStatus: 'PENDING',
  failedReason: null,
  missingRecord: null,
  settingUp: false,
  createdAt: '2026-10-06T09:00:00.000000Z',
  claimedAt: '2026-10-06T09:00:00.000000Z',
  deadline: '2026-10-09T09:00:00.000000Z',
  verifiedAt: null,
  lastCheckedAt: null,
  ...over,
})

const strict = domainSchema.strict()

describe('the /domains answers match their description', () => {
  it.each([
    ['pending, with its records', view()],
    ['still being set up, no records yet', view({ dkimTokens: [], settingUp: true })],
    [
      'verified',
      view({ status: 'verified', deadline: null, verifiedAt: '2026-10-06T10:00:00.000000Z' }),
    ],
    [
      'failed, with the missing record',
      view({ status: 'failed', failedReason: 'dkim_not_found', missingRecord: 'tok1._domainkey' }),
    ],
    ['being removed', view({ status: 'removing', deadline: null })],
  ])('%s', (_, one) => {
    const answer = domainJson(one, 'eu-west-2')
    expect(strict.safeParse(answer).error?.issues ?? []).toEqual([])
    for (const record of answer.records) {
      expect(domainSchema.shape.records.element.strict().safeParse(record).success).toBe(true)
    }
  })

  it('a removal answers the described shape', () => {
    expect(
      deletedDomainSchema
        .strict()
        .safeParse({ object: 'domain', id: '2c9e7f10-3b2a-4c4d-8e5f-6a7b8c9d0e1f', deleted: true })
        .success,
    ).toBe(true)
  })

  it('the described body takes what the handler takes', () => {
    for (const body of [
      { name: 'acme.ng' },
      { name: '  acme.ng ' },
      { name: '' },
      {},
      { name: 7 },
    ]) {
      expect(createDomainSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        createDomainBodySchema.safeParse(body).success,
      )
    }
    expect(createDomainSchema.safeParse({ name: 'x'.repeat(261) }).success).toBe(
      createDomainBodySchema.safeParse({ name: 'x'.repeat(261) }).success,
    )
  })
})
