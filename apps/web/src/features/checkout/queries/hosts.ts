import 'server-only'

import { lookupHost } from '@/features/domains/queries/dns'
import { logger } from '@/lib/logger'
import type { createServiceClient } from '@/lib/supabase/service'
import {
  ENTER_NAMESERVERS,
  type Host,
  type HostFailure,
  judgeTypedSets,
  type LineHost,
  type LineHostInput,
  storedHosts,
  typedHosts,
} from '../lib/line-hosts'
import {
  CHOOSE_HOST,
  type PresetRow,
  parseNameservers,
  presetNameservers,
} from '../lib/nameservers'

type Service = ReturnType<typeof createServiceClient>
type PresetRead = { data: PresetRow | null; error: { code?: string; message: string } | null }
/** One read per preset per checkout, however many domains pick it. */
type PresetReads = Map<string, Promise<PresetRead>>

const NOT_CHARGED = "You haven't been charged."

export type NameserverChoice =
  | { ok: true; nameservers: string[] | null; presetId: string | null }
  | { ok: false; error: string; field: 'nameservers' | 'presetId' }

/**
 * FR-C10 — the registrar's default (nothing sent), a host preset, or
 * nameservers typed in. A preset is re-read here and hidden or unverified
 * rows are refused in code (FR-D2), so the browser never decides which
 * nameservers a preset stands for (N11).
 */
export async function chooseNameservers(
  service: Service,
  input: { nameservers?: string | undefined; presetId?: string | null | undefined },
  reads: PresetReads = new Map(),
): Promise<NameserverChoice> {
  if (!input.presetId) {
    const typed = parseNameservers(input.nameservers)
    return typed.ok
      ? { ok: true, nameservers: typed.nameservers, presetId: null }
      : { ok: false, error: typed.error, field: 'nameservers' }
  }
  if (input.nameservers?.trim()) {
    return {
      ok: false,
      error: 'Choose your host or enter nameservers, not both.',
      field: 'presetId',
    }
  }
  const presetId = input.presetId
  const read =
    reads.get(presetId) ??
    Promise.resolve(
      service
        .from('nameserver_presets')
        .select('id, provider, nameservers, assigns_per_zone, verified_at, is_hidden')
        .eq('id', presetId)
        .maybeSingle(),
    )
  reads.set(presetId, read)
  const { data, error } = await read
  if (error) {
    // PostgREST's details can quote the row; the code and message are enough (N13).
    logger.error({ code: error.code, err: error.message }, 'nameserver preset could not be read')
    return {
      ok: false,
      error: `We couldn't check that host just now. ${NOT_CHARGED} Try again shortly.`,
      field: 'presetId',
    }
  }
  const chosen = presetNameservers(data)
  if (!chosen.ok) {
    if (chosen.reason === 'invalid') {
      logger.error({ presetId }, 'OPS: a visible nameserver preset fails validation')
    }
    return { ok: false, error: chosen.error, field: 'presetId' }
  }
  return { ok: true, nameservers: chosen.nameservers, presetId }
}

type Columns = { nameservers: string[] | null; nameserver_preset_id: string | null }

export type HostPlan =
  | {
      ok: true
      /** What the order row stores. */
      order: Host
      /** What each order line stores: its own host, or nothing to follow the order's. */
      columnsFor: (domain: string) => Columns
      /** FR-D4 — hosts that exist but did not answer. Shown before paying; they do not block. */
      warnings: string[]
    }
  | { ok: false; failure: HostFailure & { error: string } }

/**
 * FR-C10 with FR-D4 — every domain's host, decided before payment. Each
 * domain given its own is validated exactly like the order's choice, and
 * every typed set is looked up in DNS, so a typo is caught while it is still
 * free to fix. Presets are not looked up here: they are verified against the
 * provider's own documentation (FR-D2).
 */
export async function planHosts(
  service: Service,
  order: Host,
  requested: readonly LineHostInput[],
  domains: readonly string[],
): Promise<HostPlan> {
  const inCart = new Set(domains)
  const reads: PresetReads = new Map()
  const own = new Map<string, Host>()

  for (const line of requested) {
    if (!inCart.has(line.domain)) {
      return {
        ok: false,
        failure: {
          field: 'lineHosts',
          error: `Your cart changed while you were choosing hosts. ${NOT_CHARGED} Check each domain's host, then pay.`,
        },
      }
    }
    const chosen = await chooseLineHost(service, line, reads)
    if ('error' in chosen) {
      return {
        ok: false,
        failure: { field: 'lineHosts', domain: line.domain, error: chosen.error },
      }
    }
    own.set(line.domain, chosen)
  }

  const lines: LineHost[] = domains.map((domain) => ({
    domain,
    host: own.get(domain) ?? order,
    own: own.has(domain),
  }))
  const lookups = new Map(
    await Promise.all(
      typedHosts(lines).map(async (host) => [host, await lookupHost(host)] as const),
    ),
  )
  const verdict = judgeTypedSets(lines, lookups)
  if (verdict.failure) return { ok: false, failure: verdict.failure }

  const stored = storedHosts(order, lines)
  return {
    ok: true,
    order: stored.order,
    columnsFor: (domain) => {
      const host = stored.own.get(domain)
      return {
        nameservers: host?.nameservers ?? null,
        nameserver_preset_id: host?.presetId ?? null,
      }
    },
    warnings: verdict.warnings,
  }
}

/** One domain's own choice, validated as the order's is. */
async function chooseLineHost(
  service: Service,
  line: LineHostInput,
  reads: PresetReads,
): Promise<Host | { error: string }> {
  if (line.mode === 'default') return { nameservers: null, presetId: null }
  if (line.mode === 'preset' && !line.presetId) return { error: CHOOSE_HOST }
  const chosen = await chooseNameservers(
    service,
    line.mode === 'preset'
      ? { presetId: line.presetId, nameservers: line.nameservers }
      : { nameservers: line.nameservers },
    reads,
  )
  if (!chosen.ok) return { error: chosen.error }
  if (!chosen.nameservers) return { error: ENTER_NAMESERVERS }
  return { nameservers: chosen.nameservers, presetId: chosen.presetId }
}
