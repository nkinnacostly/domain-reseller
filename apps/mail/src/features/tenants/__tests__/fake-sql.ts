import { mockRpc } from '../../../../tests/mocks/supabase'

/**
 * Migration 47's job functions as PostgREST answers them, for the runner
 * tests: each claim hands out what the test gives it once, then nothing; each
 * record function answers as SQL does, and every call is kept so a test can
 * prove what reached the database.
 */

export const TOKEN = 'a'.repeat(64)
export const ACCOUNT_ID = '0b6c2a3e-6a1f-4c51-9d8e-1f2a3b4c5d6e'
export const DOMAIN_ID = '2c9e7f10-3b2a-4c4d-8e5f-6a7b8c9d0e1f'

export function provisioningItem(overrides: Record<string, unknown> = {}) {
  return {
    accountId: ACCOUNT_ID,
    shortId: '0a1b2c3d4e',
    tenant: 'mdm-0a1b2c3d4e',
    configSet: 'mdm-0a1b2c3d4e',
    state: 'sandbox',
    createdAt: '2026-10-06T09:00:00Z',
    tenantReady: false,
    tenantArn: null,
    policy: 'strict',
    steps: {
      tenant: false,
      suppression: false,
      configSet: false,
      eventDestination: false,
      configSetAssociated: false,
      strictPolicy: false,
      standardPolicy: false,
      sandboxAssociated: false,
    },
    work: ['provision'],
    sandbox: {
      name: 'sandbox.emails.mydomainshub.com',
      fromAddress: 'onboarding@sandbox.emails.mydomainshub.com',
      status: 'not_created',
      identityArn: null,
    },
    attempts: 0,
    ...overrides,
  }
}

export function domainItem(overrides: Record<string, unknown> = {}) {
  return {
    id: DOMAIN_ID,
    accountId: ACCOUNT_ID,
    name: 'acme.example',
    status: 'pending',
    work: 'setup',
    mailFromDomain: 'send.acme.example',
    identityArn: null,
    dkimTokens: [],
    steps: { identity: false, mailFrom: false, configSet: false, tenant: false },
    tenant: 'mdm-0a1b2c3d4e',
    configSet: 'mdm-0a1b2c3d4e',
    tenantReady: true,
    claimedAt: '2026-10-06T09:00:00Z',
    deadline: '2026-10-09T09:00:00Z',
    lastCheckedAt: null,
    attempts: 0,
    ...overrides,
  }
}

type Options = {
  accounts?: unknown[]
  domains?: unknown[]
  /** record_provisioning answers ready once this step is recorded. */
  readyAfter?: string
  /** What record_domain_check answers the domain's status as, given what SES said. */
  verifiedWhen?: 'ses_says' | 'never'
  /** Functions that refuse, with their code. */
  refuse?: Record<string, string>
  sandboxDue?: boolean
  sandboxStatus?: string
  sandboxArn?: string | null
}

export function fakeJobsSql(options: Options = {}) {
  const {
    accounts = [],
    domains = [],
    readyAfter = 'policy',
    verifiedWhen = 'ses_says',
    refuse = {},
    sandboxDue = false,
    sandboxStatus = 'not_created',
    sandboxArn = null,
  } = options
  let accountsLeft = [...accounts]
  let domainsLeft = [...domains]
  let ready = false
  const no = (fn: string) => (refuse[fn] ? { ok: false, code: refuse[fn] } : null)
  const calls = mockRpc({
    begin_ses_jobs: (body) =>
      body.p_token === TOKEN
        ? {
            ok: true,
            sandbox: {
              name: 'sandbox.emails.mydomainshub.com',
              fromAddress: 'onboarding@sandbox.emails.mydomainshub.com',
              status: sandboxStatus,
              identityArn: sandboxArn,
              due: sandboxDue,
            },
          }
        : { ok: false, code: 'unauthorized' },
    claim_provisioning_work: () => {
      const out = accountsLeft
      accountsLeft = []
      return out
    },
    record_provisioning: (body) => {
      const refused = no('record_provisioning')
      if (refused) return refused
      if (body.p_step === readyAfter) ready = true
      return { ok: true, ready }
    },
    record_provisioning_error: () => no('record_provisioning_error') ?? { ok: true, attempts: 1 },
    claim_domain_work: () => {
      const out = domainsLeft
      domainsLeft = []
      return out
    },
    record_domain_step: () => no('record_domain_step') ?? { ok: true },
    record_domain_check: (body) => {
      const refused = no('record_domain_check')
      if (refused) return refused
      const state = body.p_state as { found?: boolean; verifiedForSending?: boolean }
      return {
        ok: true,
        status:
          verifiedWhen === 'ses_says' && state.found && state.verifiedForSending
            ? 'verified'
            : 'pending',
      }
    },
    record_domain_failed: () => no('record_domain_failed') ?? { ok: true },
    record_domain_released: () => no('record_domain_released') ?? { ok: true, status: 'removed' },
    record_domain_error: () => no('record_domain_error') ?? { ok: true, attempts: 1 },
    record_sandbox_identity: (body) =>
      no('record_sandbox_identity') ?? {
        ok: true,
        status: (body.p_state as { status: string }).status,
      },
  })
  return {
    calls,
    /** The p_step values (or p_reason, p_error) each call to `fn` carried, in order. */
    args: (fn: string, key: string) =>
      calls.filter((call) => call.fn === fn).map((call) => call.body[key]),
  }
}
