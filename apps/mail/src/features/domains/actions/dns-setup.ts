'use server'

import { revalidatePath } from 'next/cache'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import { accountAction } from '@/lib/safe-action'
import { addCloudflareRecords, type RecordResult } from '../lib/cloudflare'
import { cloudflareRefusal, SETUP_FALLBACK, startRefusal, stoppedWords } from '../lib/dns-setup'
import { applyUrl, fitsTemplate, signingKey } from '../lib/domain-connect'
import { domainRecords } from '../lib/records'
import { cloudflareApiBase, dnsHostOf } from '../queries/dns-host'
import { cloudflareTokenSchema, domainActionSchema } from '../schemas'

/**
 * Adding a domain's records at Cloudflare for the customer (MAIL-SPEC §5.3).
 * SQL lets each try in first, as the person, and logs it
 * (`mail.start_dns_setup`, migration 57: role, domain, ten an hour); the
 * records are made from what SQL returns, never from the request.
 *
 * The token is used for this one run and dropped: never stored, logged or
 * sent back. The log lines carry ids and counts only (N13).
 */

type Failure = { error: string }

const MANAGERS = ['owner', 'admin', 'developer'] as const

type Started = { name: string; mailFromDomain: string | null; dkimTokens: string[] }

function started(data: unknown): Started | { refused: string | undefined } {
  const answer = (data ?? {}) as Record<string, unknown>
  if (answer.ok !== true)
    return { refused: typeof answer.code === 'string' ? answer.code : undefined }
  const tokens = Array.isArray(answer.dkimTokens)
    ? answer.dkimTokens.filter((t): t is string => typeof t === 'string')
    : []
  return {
    name: String(answer.name ?? ''),
    mailFromDomain: typeof answer.mailFromDomain === 'string' ? answer.mailFromDomain : null,
    dkimTokens: tokens,
  }
}

const region = () => env.MAIL_SES_REGION ?? 'eu-west-2'

export const addRecordsWithCloudflareToken = accountAction(cloudflareTokenSchema, MANAGERS).action(
  async ({
    parsedInput,
    ctx,
  }): Promise<
    Failure | { ok: true; zone: string; results: RecordResult[]; stopped: string | null }
  > => {
    const { data, error } = await ctx.supabase.rpc('start_dns_setup', {
      p_domain_id: parsedInput.domainId,
      p_provider: 'cloudflare',
      p_method: 'token',
    })
    if (error) throw new Error(`start_dns_setup failed: ${error.code ?? 'unknown'}`)
    const domain = started(data)
    if ('refused' in domain) return { error: startRefusal(domain.refused) }

    const records = domainRecords({ ...domain, region: region() })
    const answer = await addCloudflareRecords({
      token: parsedInput.token,
      domain: domain.name,
      records,
      apiBase: cloudflareApiBase(),
    })
    if (!answer.ok) {
      logger.info(
        { requestId: ctx.requestId, domainId: parsedInput.domainId, outcome: answer.code },
        'cloudflare dns setup refused',
      )
      // The zone for the words: the domain's own, or the parent Cloudflare serves.
      const host = answer.code === 'no_zone' ? await dnsHostOf(domain.name) : null
      const zone = host && host.provider !== 'unknown' ? host.zone : domain.name
      return { error: cloudflareRefusal(answer.code, zone) }
    }
    const counts: Record<string, number> = {}
    for (const result of answer.results) counts[result.outcome] = (counts[result.outcome] ?? 0) + 1
    logger.info(
      { requestId: ctx.requestId, domainId: parsedInput.domainId, counts, stopped: answer.stopped },
      'cloudflare dns setup done',
    )
    revalidatePath(`/dashboard/domains/${parsedInput.domainId}`)
    return {
      ok: true,
      zone: answer.zone,
      results: answer.results,
      stopped: answer.stopped ? stoppedWords(answer.stopped) : null,
    }
  },
)

/**
 * Domain Connect (§5.3): the signed address of Cloudflare's own page, where
 * the customer signs in and approves. The zone is read from public DNS here,
 * not taken from the page.
 */
export const startCloudflareConnect = accountAction(domainActionSchema, MANAGERS).action(
  async ({ parsedInput, ctx }): Promise<Failure | { ok: true; url: string }> => {
    const key = env.MAIL_DOMAIN_CONNECT_PRIVATE_KEY
    if (!key) return { error: SETUP_FALLBACK }
    const { data, error } = await ctx.supabase.rpc('start_dns_setup', {
      p_domain_id: parsedInput.domainId,
      p_provider: 'cloudflare',
      p_method: 'domain_connect',
    })
    if (error) throw new Error(`start_dns_setup failed: ${error.code ?? 'unknown'}`)
    const domain = started(data)
    if ('refused' in domain) return { error: startRefusal(domain.refused) }
    if (domain.dkimTokens.length !== 3 || !fitsTemplate(domain.name, domain.mailFromDomain)) {
      return { error: SETUP_FALLBACK }
    }
    const host = await dnsHostOf(domain.name)
    if (host.provider !== 'cloudflare') {
      return {
        error:
          'We could not confirm this domain’s DNS is on Cloudflare just now. Try again in a minute, or add the records by hand below.',
      }
    }
    const url = applyUrl({
      zone: host.zone,
      name: domain.name,
      dkimTokens: domain.dkimTokens,
      region: region(),
      redirectUri: `${env.NEXT_PUBLIC_MAIL_URL}/dashboard/domains/${parsedInput.domainId}?from=cloudflare`,
      key: signingKey(key),
    })
    logger.info(
      { requestId: ctx.requestId, domainId: parsedInput.domainId },
      'cloudflare domain connect started',
    )
    return { ok: true, url }
  },
)
