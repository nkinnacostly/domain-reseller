import { z } from 'zod'
import {
  type HostLookup,
  judgeNameservers,
  sameNameservers,
} from '@/features/domains/lib/nameserver-check'
import { nameserverRequest } from './nameservers'

/**
 * FR-C10 — a host per domain at checkout. The order's choice applies to every
 * domain by default; in a mixed cart a domain can be given its own, by the
 * same three ways in (FR-D1). Pure: the checkout form, placeOrder and the
 * order page share it.
 */

/** A domain's choice. "same" follows the order's and is never sent. */
export type LineMode = 'same' | 'default' | 'preset' | 'manual'

/** The checkout form's field names for one domain's choice. */
export const lineField = (domain: string, part: 'mode' | 'presetId' | 'nameservers') =>
  `line:${domain}:${part}`

export const lineHostsSchema = z
  .array(
    z.object({
      domain: z.string().min(1).max(253),
      mode: z.enum(['default', 'preset', 'manual']),
      // Only a preset's id travels: its nameservers are read from our table (N11).
      presetId: z.uuid().nullish(),
      nameservers: z.string().max(2000).optional(),
    }),
  )
  .max(100)
  .refine(
    (lines) => new Set(lines.map((line) => line.domain)).size === lines.length,
    'Choose once for each domain',
  )
export type LineHostInput = z.infer<typeof lineHostsSchema>[number]

/** The fields a nameserver problem can belong to, so the form can show it there. */
export type HostField = 'nameservers' | 'presetId' | 'lineHosts'
export type HostProblem = { field: HostField; error: string; domain?: string }
/** A problem as placeOrder answers it: FR-D4's details listed with it. */
export type HostFailure = HostProblem & { details?: string[] }

export const ENTER_NAMESERVERS =
  'Enter the nameservers your host gave you, or choose another option.'
export const NEEDS_FIXING = 'Some nameservers need fixing before we can use them.'
const LINE_INPUT = 'Check the host chosen for each domain.'

const isHostField = (field: string | undefined): field is HostField =>
  field === 'nameservers' || field === 'presetId' || field === 'lineHosts'

export type HostRequest =
  | {
      ok: true
      input: { nameservers: string; presetId?: string; lineHosts?: LineHostInput[] }
    }
  | { ok: false; problem: HostProblem }

/**
 * What the checkout form sends for its nameserver choices: the order's, and
 * each domain given its own. Only the chosen way travels, and a choice that
 * cannot work is caught before the order is tried.
 */
export function hostRequest(
  read: (name: string) => string,
  domains: readonly string[],
  presets: { id: string; provider: string; assignsPerZone: boolean }[],
): HostRequest {
  const order = nameserverRequest(
    read('nameserverMode'),
    read('presetId'),
    read('nameservers'),
    presets,
  )
  if (!order.ok) return { ok: false, problem: { field: 'presetId', error: order.error } }

  const lineHosts: LineHostInput[] = []
  for (const domain of domains) {
    const mode = read(lineField(domain, 'mode'))
    if (mode !== 'default' && mode !== 'preset' && mode !== 'manual') continue
    const typed = read(lineField(domain, 'nameservers'))
    const line = nameserverRequest(mode, read(lineField(domain, 'presetId')), typed, presets)
    if (!line.ok) return { ok: false, problem: { field: 'lineHosts', domain, error: line.error } }
    // An empty box follows nothing: the domain was given its own on purpose.
    if (mode === 'manual' && !typed.trim()) {
      return { ok: false, problem: { field: 'lineHosts', domain, error: ENTER_NAMESERVERS } }
    }
    lineHosts.push({
      domain,
      mode,
      nameservers: line.nameservers,
      ...(line.presetId ? { presetId: line.presetId } : {}),
    })
  }

  return {
    ok: true,
    input: {
      nameservers: order.nameservers,
      ...(order.presetId ? { presetId: order.presetId } : {}),
      ...(lineHosts.length > 0 ? { lineHosts } : {}),
    },
  }
}

type Failure = { error: string; field?: string; domain?: string; details?: string[] }

/**
 * A nameserver problem from placeOrder — a refusal or a malformed field — in
 * the shape the form shows beside the field it belongs to. FR-D4's details
 * are said in full: "ns2.host.com doesn't exist — check the spelling."
 */
export function hostFailure(failure: Failure | null, errors: unknown): HostProblem | undefined {
  const invalid = (field: string) =>
    (errors as Record<string, { _errors?: string[] }> | undefined)?.[field]
  const typed = invalid('nameservers')?._errors?.[0]
  if (typed) return { field: 'nameservers', error: typed }
  const preset = invalid('presetId')?._errors?.[0]
  if (preset) return { field: 'presetId', error: preset }
  if (invalid('lineHosts')) return { field: 'lineHosts', error: LINE_INPUT }

  if (!failure || !isHostFailure(failure)) return undefined
  const error = failure.details?.length
    ? `${failure.error} ${failure.details.join(' ')}`
    : failure.error
  return { field: failure.field, error, ...(failure.domain ? { domain: failure.domain } : {}) }
}

export const isHostFailure = (failure: Failure): failure is HostFailure =>
  isHostField(failure.field)

/** Where a domain's nameservers come from: nothing (the registrar's default), a preset, or typed. */
export type Host = { nameservers: string[] | null; presetId: string | null }
export const NO_HOST: Host = { nameservers: null, presetId: null }

/** The same set, in any order, from the same preset — or both the registrar's default. */
export function sameHost(a: Host, b: Host): boolean {
  if (!a.nameservers || !b.nameservers) return !a.nameservers && !b.nameservers
  return a.presetId === b.presetId && sameNameservers(a.nameservers, b.nameservers)
}

/** A domain's host, and whether it is the order's or its own. */
export type LineHost = { domain: string; host: Host; own: boolean }

/**
 * How the choices are stored (migration 29): a line's own nameservers win
 * over the order's, and a line without them follows the order. A line cannot
 * say "the registrar's default" over an order's host — so when some domains
 * keep the default while others follow the order's host, the order stores
 * none and each domain with a host carries its own. The order also stores
 * none when no domain follows it, so the order page never lists a host
 * nothing uses.
 */
export function storedHosts(
  order: Host,
  lines: readonly LineHost[],
): { order: Host; own: Map<string, Host> } {
  const followed = lines.some((line) => sameHost(line.host, order))
  const keepsDefault = lines.some((line) => !line.host.nameservers)
  const base = followed && !(order.nameservers && keepsDefault) ? order : NO_HOST
  return {
    order: base,
    own: new Map(
      lines.filter((line) => !sameHost(line.host, base)).map((line) => [line.domain, line.host]),
    ),
  }
}

/** Every host name typed for the order or a domain — each is looked up once (FR-D4). */
export function typedHosts(lines: readonly LineHost[]): string[] {
  return [...new Set(lines.flatMap((line) => (isTyped(line.host) ? line.host.nameservers : [])))]
}

const isTyped = (host: Host): host is { nameservers: string[]; presetId: null } =>
  Boolean(host.nameservers) && !host.presetId

/**
 * FR-D4 for every typed set, judged per domain as the Nameservers tab does:
 * a host inside the domain itself needs glue, whichever set it came from.
 * A blocking problem belongs to the field it was typed in — the order's box
 * first, then the domains in cart order. Warnings do not block.
 */
export function judgeTypedSets(
  lines: readonly LineHost[],
  lookups: ReadonlyMap<string, HostLookup>,
): { failure: HostFailure | null; warnings: string[] } {
  const warnings = new Set<string>()
  const orderBlocking = new Set<string>()
  let lineFailure: HostFailure | null = null

  for (const { domain, host, own } of lines) {
    if (!isTyped(host)) continue
    const verdict = judgeNameservers(
      domain,
      new Map(host.nameservers.map((name) => [name, lookups.get(name) ?? 'no-answer'] as const)),
    )
    for (const warning of verdict.warnings) warnings.add(warning)
    if (verdict.blocking.length === 0) continue
    if (!own) for (const problem of verdict.blocking) orderBlocking.add(problem)
    else
      lineFailure ??= {
        field: 'lineHosts',
        domain,
        error: NEEDS_FIXING,
        details: verdict.blocking,
      }
  }

  if (orderBlocking.size > 0) {
    return {
      failure: { field: 'nameservers', error: NEEDS_FIXING, details: [...orderBlocking] },
      warnings: [],
    }
  }
  return lineFailure
    ? { failure: lineFailure, warnings: [] }
    : { failure: null, warnings: [...warnings] }
}

/**
 * The order page: a domain's own nameservers, when they differ from the
 * order's — the rest follow the order's.
 */
export function ownNameservers(
  line: readonly string[] | null,
  order: readonly string[] | null,
): readonly string[] | null {
  if (!line?.length) return null
  return sameNameservers(line, order) ? null : line
}
