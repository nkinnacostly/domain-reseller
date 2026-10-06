import { HttpResponse, http } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '../../../../tests/mocks/server'
import { mockRpc } from '../../../../tests/mocks/supabase'

/**
 * apps/mail's half of a pause (MAIL-SPEC §7.4, §4.3): the queued changes,
 * claimed with the secret key and applied with the manager key — against
 * PostgREST and SES as MSW answers them. No test reaches AWS.
 */

const env = vi.hoisted(() => ({
  NODE_ENV: 'test',
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_SECRET_KEY: 'sb_test',
  MAIL_SES_REGION: 'eu-west-2',
  MAIL_SES_MANAGER_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE' as string | undefined,
  MAIL_SES_MANAGER_SECRET_ACCESS_KEY: 'test manager secret, not real' as string | undefined,
  MAIL_SAFETY_SECRET: 'b'.repeat(40) as string | undefined,
  LOG_LEVEL: 'silent',
}))
vi.mock('@/lib/env', () => ({
  env,
  requireSesManagerEnv: () => ({
    region: env.MAIL_SES_REGION,
    accessKeyId: env.MAIL_SES_MANAGER_ACCESS_KEY_ID ?? '',
    secretAccessKey: env.MAIL_SES_MANAGER_SECRET_ACCESS_KEY ?? '',
  }),
}))

/** Leaves a setting out, as an environment without it would. */
const unset = (key: 'MAIL_SAFETY_SECRET' | 'MAIL_SES_MANAGER_ACCESS_KEY_ID') => {
  env[key] = undefined
}

const { applyDueTenantActions, sesTenantStatus } = await import('../queries/apply')
const { POST } = await import('@/app/api/safety/apply/route')

const SES = 'https://email.eu-west-2.amazonaws.com/v2/email'
const ARN = 'arn:aws:ses:eu-west-2:085568227110:tenant/mdm-0123456789/t-1'
const claimed = {
  id: 11,
  accountId: '0b6c2a3e-6a1f-4c51-9d8e-1f2a3b4c5d6e',
  accountShortId: '0123456789',
  tenant: 'mdm-0123456789',
  sendingStatus: 'DISABLED',
  why: 'threshold',
  requestedBy: 'system',
  attempt: 1,
}

function ses(options: { tenant?: number; status?: number } = {}) {
  const seen: { path: string; body: unknown; auth: string | null }[] = []
  server.use(
    http.post(`${SES}/tenants/get`, async ({ request }) => {
      seen.push({
        path: 'tenants/get',
        body: await request.json(),
        auth: request.headers.get('authorization'),
      })
      return options.tenant && options.tenant !== 200
        ? HttpResponse.json(
            { message: 'Tenant mdm-x for a@b.example not found' },
            {
              status: options.tenant,
              headers: { 'x-amzn-errortype': 'NotFoundException' },
            },
          )
        : HttpResponse.json({ Tenant: { TenantName: 'mdm-0123456789', TenantArn: ARN } })
    }),
    http.put(
      `${SES}/reputation/entities/RESOURCE/:arn/customer-managed-status`,
      async ({ request, params }) => {
        seen.push({
          path: `status:${decodeURIComponent(String(params.arn))}`,
          body: await request.json(),
          auth: null,
        })
        return options.status && options.status !== 200
          ? HttpResponse.json(
              {},
              {
                status: options.status,
                headers: { 'x-amzn-errortype': 'TooManyRequestsException' },
              },
            )
          : HttpResponse.json({})
      },
    ),
  )
  return seen
}

beforeEach(() => {
  env.MAIL_SES_MANAGER_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE'
  env.MAIL_SES_MANAGER_SECRET_ACCESS_KEY = 'test manager secret, not real'
  env.MAIL_SAFETY_SECRET = 'b'.repeat(40)
})

describe('applying what SQL queued', () => {
  it('claims with the secret key, pauses the tenant by its ARN, and records it applied', async () => {
    const seen = ses()
    const calls = mockRpc({
      claim_tenant_actions: () => [claimed],
      record_tenant_action: () => ({ ok: true, state: 'applied' }),
    })
    expect(await applyDueTenantActions()).toEqual({
      claimed: 1,
      applied: 1,
      retried: 0,
      unreadable: 0,
    })
    expect(calls.map((c) => [c.fn, c.schema])).toEqual([
      ['claim_tenant_actions', 'mail'],
      ['record_tenant_action', 'mail'],
    ])
    expect(calls[0]?.body).toEqual({ p_worker: 'mail-app:safety', p_limit: 10 })
    expect(calls[1]?.body).toEqual({
      p_action_id: 11,
      p_worker: 'mail-app:safety',
      p_outcome: 'applied',
    })
    expect(seen[0]).toMatchObject({ path: 'tenants/get', body: { TenantName: 'mdm-0123456789' } })
    expect(seen[0]?.auth).toMatch(/Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/eu-west-2\/ses\//)
    expect(seen[1]).toEqual({
      path: `status:${ARN}`,
      body: { SendingStatus: 'DISABLED' },
      auth: null,
    })
  })

  it('sends back a change SES did not take, with its status and type only', async () => {
    ses({ tenant: 404 })
    const calls = mockRpc({
      claim_tenant_actions: () => [claimed],
      record_tenant_action: () => ({ ok: true, state: 'pending' }),
    })
    expect(await applyDueTenantActions()).toMatchObject({ retried: 1 })
    expect(calls[1]?.body).toEqual({
      p_action_id: 11,
      p_worker: 'mail-app:safety',
      p_outcome: 'retry',
      p_error: 'HTTP 404 NotFoundException',
    })
  })

  it('claims nothing without the manager key: the changes wait, our gate holds', async () => {
    unset('MAIL_SES_MANAGER_ACCESS_KEY_ID')
    const calls = mockRpc({})
    expect(await applyDueTenantActions()).toEqual({ skipped: 'ses_not_configured' })
    expect(calls).toEqual([])
  })

  it('fails loudly when the claim or the record cannot be made', async () => {
    mockRpc({ claim_tenant_actions: () => ({ status: 500, body: { code: '08006' } }) })
    await expect(applyDueTenantActions()).rejects.toThrow('claim_tenant_actions failed')
    ses()
    mockRpc({
      claim_tenant_actions: () => [claimed],
      record_tenant_action: () => ({ status: 500, body: { code: '08006' } }),
    })
    await expect(applyDueTenantActions()).rejects.toThrow('record_tenant_action failed')
  })

  it('reads a tenant with no ARN in its answer as a failure', async () => {
    server.use(http.post(`${SES}/tenants/get`, () => HttpResponse.json({ Tenant: {} })))
    const setter = sesTenantStatus({
      region: 'eu-west-2',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'x'.repeat(20),
    })
    expect(await setter.tenantArn('mdm-0123456789')).toEqual({
      ok: false,
      status: 200,
      code: 'NoTenantArn',
    })
  })

  it('tells SES to resume with an admin’s reason, and passes on a refusal', async () => {
    const seen = ses({ status: 429 })
    const setter = sesTenantStatus({
      region: 'eu-west-2',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'x'.repeat(20),
    })
    expect(await setter.setStatus(ARN, 'ENABLED', 'Resumed in Mail’s admin by owner (1)')).toEqual({
      ok: false,
      status: 429,
      code: 'TooManyRequestsException',
    })
    expect(seen[0]?.body).toEqual({ SendingStatus: 'ENABLED' })
  })
})

describe('the route the worker pings (POST /api/safety/apply)', () => {
  const post = (authorization?: string) =>
    POST(
      new Request('https://emails.mydomainshub.com/api/safety/apply', {
        method: 'POST',
        headers: authorization ? { authorization } : {},
      }),
    )

  it('answers 503 until the secret is set, and 401 to the wrong one', async () => {
    unset('MAIL_SAFETY_SECRET')
    expect((await post(`Bearer ${'b'.repeat(40)}`)).status).toBe(503)
    env.MAIL_SAFETY_SECRET = 'b'.repeat(40)
    const refused = await post('Bearer wrong')
    expect(refused.status).toBe(401)
    expect(await refused.json()).toEqual({ ok: false, error: 'unauthorized' })
    expect((await post()).status).toBe(401)
  })

  it('applies what is due and answers the counts, uncached', async () => {
    ses()
    mockRpc({ claim_tenant_actions: () => [], record_tenant_action: () => ({ ok: true }) })
    const response = await post(`Bearer ${'b'.repeat(40)}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      ok: true,
      claimed: 0,
      applied: 0,
      retried: 0,
      unreadable: 0,
    })
  })

  it('answers 503 when applying failed, saying nothing of why', async () => {
    mockRpc({ claim_tenant_actions: () => ({ status: 500, body: { code: '08006' } }) })
    const response = await post(`Bearer ${'b'.repeat(40)}`)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ ok: false, error: 'failed' })
  })
})
