import 'server-only'

import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { unicodeOf } from '../lib/names'
import type { DomainStatus } from '../lib/status'

/**
 * The account's domains as its members read them (RLS: `domains_member_read`,
 * migration 43), and the shared sandbox sender's state (migration 47). A read
 * that fails throws, so the page shows its error state rather than "no
 * domains" (S11).
 */

const COLUMNS =
  'id, name, kind, status, dkim_tokens, dkim_status, mail_from_domain, mail_from_status, failed_reason, missing_record, claimed_at, created_at, verified_at, last_checked_at, identity_created_at, mail_from_set_at, config_set_at, tenant_associated_at, released_at'

const row = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['customer', 'sandbox']),
  status: z.enum(['pending', 'verified', 'failed', 'removing', 'removed', 'sandbox']),
  dkim_tokens: z.array(z.string()),
  dkim_status: z.string().nullable(),
  mail_from_domain: z.string().nullable(),
  mail_from_status: z.string().nullable(),
  failed_reason: z.string().nullable(),
  missing_record: z.string().nullable(),
  claimed_at: z.string(),
  created_at: z.string(),
  verified_at: z.string().nullable(),
  last_checked_at: z.string().nullable(),
  identity_created_at: z.string().nullable(),
  mail_from_set_at: z.string().nullable(),
  config_set_at: z.string().nullable(),
  tenant_associated_at: z.string().nullable(),
  released_at: z.string().nullable(),
})

export type Domain = {
  id: string
  name: string
  /** The Unicode form of an international name, for people. */
  unicode: string | null
  kind: 'customer' | 'sandbox'
  status: DomainStatus
  settingUp: boolean
  dkimTokens: string[]
  dkimStatus: string | null
  mailFromDomain: string | null
  mailFromStatus: string | null
  failedReason: string | null
  missingRecord: string | null
  /** The end of the 72 hours a pending claim has to prove itself (§5). */
  deadline: string | null
  createdAt: string
  verifiedAt: string | null
  lastCheckedAt: string | null
  released: boolean
}

const HOURS_72 = 72 * 3_600_000

function toDomain(value: z.infer<typeof row>): Domain {
  const settingUp =
    value.status === 'pending' &&
    (!value.identity_created_at ||
      !value.mail_from_set_at ||
      !value.config_set_at ||
      !value.tenant_associated_at)
  return {
    id: value.id,
    name: value.name,
    unicode: unicodeOf(value.name),
    kind: value.kind,
    status: value.status,
    settingUp,
    dkimTokens: value.dkim_tokens,
    dkimStatus: value.dkim_status,
    mailFromDomain: value.mail_from_domain,
    mailFromStatus: value.mail_from_status,
    failedReason: value.failed_reason,
    missingRecord: value.missing_record,
    deadline:
      value.status === 'pending'
        ? new Date(new Date(value.claimed_at).getTime() + HOURS_72).toISOString()
        : null,
    createdAt: value.created_at,
    verifiedAt: value.verified_at,
    lastCheckedAt: value.last_checked_at,
    released: value.released_at !== null,
  }
}

/** Every domain the account has not removed, newest first; the sandbox row apart. */
export async function listDomains(
  accountId: string,
): Promise<{ domains: Domain[]; sandbox: Domain | null }> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('domains')
    .select(COLUMNS)
    .eq('account_id', accountId)
    .neq('status', 'removed')
    .order('created_at', { ascending: false })
  if (error) throw new Error(`domains could not be read: ${error.code ?? 'unknown'}`)
  const parsed = z
    .array(row)
    .parse(data ?? [])
    .map(toDomain)
  return {
    domains: parsed.filter((domain) => domain.kind === 'customer'),
    sandbox:
      parsed.find((domain) => domain.kind === 'sandbox' && domain.status === 'sandbox') ?? null,
  }
}

/** One of the account's customer domains, or null (not found, removed, or another account's). */
export async function getDomain(accountId: string, domainId: string): Promise<Domain | null> {
  if (!z.uuid().safeParse(domainId).success) return null
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('domains')
    .select(COLUMNS)
    .eq('account_id', accountId)
    .eq('id', domainId)
    .eq('kind', 'customer')
    .neq('status', 'removed')
    .maybeSingle()
  if (error) throw new Error(`domain could not be read: ${error.code ?? 'unknown'}`)
  return data ? toDomain(row.parse(data)) : null
}

export type SandboxSenderState = {
  fromAddress: string
  status: 'not_created' | 'pending' | 'verified' | 'failed'
}

/** The shared sandbox sender's address and state, or null when unreadable. */
export async function getSandboxSender(): Promise<SandboxSenderState | null> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('sandbox_identity')
    .select('from_address, status')
    .maybeSingle()
  if (error || !data) return null
  const status = z.enum(['not_created', 'pending', 'verified', 'failed']).safeParse(data.status)
  return status.success ? { fromAddress: data.from_address, status: status.data } : null
}

/** Whether the account's SES tenant is ready (§4.1); null when unreadable. */
export async function isTenantReady(accountId: string): Promise<boolean | null> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('accounts')
    .select('tenant_ready_at')
    .eq('id', accountId)
    .maybeSingle()
  if (error || !data) return null
  return data.tenant_ready_at !== null
}
