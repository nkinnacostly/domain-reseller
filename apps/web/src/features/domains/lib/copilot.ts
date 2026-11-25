import type { PortfolioIntent } from '@dr/shared/ai'
import { BULK_RENEW_MAX, bulkRenewHref } from '@/features/renewals/lib/renewal'
import { BULK_MAX } from './bulk'
import type { DomainLabel } from './labels'
import { daysUntilExpiry, type PortfolioDomain } from './portfolio'

/**
 * The portfolio copilot's engine half (feature 7): the model's intent, which
 * names no domain of the account, is resolved here against the account's own
 * domains, labels and the host presets, into a draft the customer confirms
 * through the existing bulk actions. Everything a draft says — how many, which
 * ones, which nameservers — comes from this code, never from the model.
 */

export type DraftAction = 'nameservers' | 'renew' | 'auto_renew' | 'transfer_lock' | 'privacy'

export type CopilotDraft =
  | { kind: 'question'; question: string }
  | { kind: 'refused'; reason: string }
  | {
      kind: 'draft'
      action: DraftAction
      /** For the on/off changes. */
      on: boolean | null
      summary: string
      domains: { id: string; name: string }[]
      /** Named in the words but not on the account. */
      notFound: string[]
      /** For nameservers: the set, and the preset it came from (N11 keeps the label only for a preset). */
      nameservers: string[] | null
      presetId: string | null
      /** For renew: the renewal page, which prices each domain before payment. */
      renewHref: string | null
    }

export type CopilotPreset = {
  id: string
  provider: string
  nameservers: string[]
  assignsPerZone: boolean
}

const CAN_DO =
  'I can point domains at a host, renew them, or turn auto-renew, the transfer lock or WHOIS privacy on or off.'
const WHICH =
  'Which domains? Name them, or say all of them, a label, an extension or an expiry window.'

const countText = (n: number) => (n === 1 ? '1 domain' : `${n} domains`)
const norm = (text: string) => text.trim().toLowerCase().replace(/s$/, '')

function findLabel(labels: readonly DomainLabel[], wanted: string): DomainLabel | null {
  const key = norm(wanted)
  return labels.find((label) => norm(label.name) === key) ?? null
}

/** A preset by its host's name: exact first, then a name that starts the same way. */
export function findPreset(presets: readonly CopilotPreset[], host: string): CopilotPreset | null {
  const key = host.trim().toLowerCase()
  return (
    presets.find((preset) => preset.provider.toLowerCase() === key) ??
    presets.find((preset) => preset.provider.toLowerCase().startsWith(key)) ??
    presets.find((preset) => key.startsWith(preset.provider.toLowerCase())) ??
    null
  )
}

export function resolveIntent(
  intent: PortfolioIntent,
  account: { domains: readonly PortfolioDomain[]; labels: readonly DomainLabel[] },
  presets: readonly CopilotPreset[],
  now: Date,
): CopilotDraft {
  if (intent.action === 'none') return { kind: 'question', question: intent.question ?? CAN_DO }
  const { select } = intent
  const named = select.domains.length > 0
  if (
    !named &&
    !select.all &&
    select.expiringWithinDays === null &&
    !select.label &&
    !select.extension
  ) {
    return { kind: 'question', question: intent.question ?? WHICH }
  }

  let chosen = [...account.domains]
  const notFound: string[] = []
  if (named) {
    const byName = new Map(
      account.domains.map((domain) => [domain.domainName.toLowerCase(), domain]),
    )
    chosen = []
    for (const name of select.domains) {
      const domain = byName.get(name)
      if (domain) chosen.push(domain)
      else notFound.push(name)
    }
  }
  if (select.label) {
    const label = findLabel(account.labels, select.label)
    if (!label) return { kind: 'refused', reason: `You have no label called “${select.label}”.` }
    chosen = chosen.filter((domain) => domain.labels.some((on) => on.id === label.id))
  }
  if (select.extension) {
    chosen = chosen.filter((domain) => domain.tld === select.extension)
  }
  if (select.expiringWithinDays !== null) {
    const within = select.expiringWithinDays
    chosen = chosen.filter((domain) => {
      const days = daysUntilExpiry(domain.expiresAt, now)
      return days !== null && days <= within
    })
  }
  if (chosen.length === 0) {
    return {
      kind: 'refused',
      reason:
        notFound.length > 0 && named && notFound.length === select.domains.length
          ? `None of those are on your account: ${notFound.join(', ')}.`
          : 'None of your domains match that.',
    }
  }

  const domains = chosen.map((domain) => ({ id: domain.id, name: domain.domainName }))
  const n = countText(domains.length)
  const base = {
    kind: 'draft' as const,
    domains,
    notFound,
    nameservers: null,
    presetId: null,
    renewHref: null,
    on: null,
  }

  if (intent.action === 'renew') {
    if (domains.length > BULK_RENEW_MAX) {
      return {
        kind: 'refused',
        reason: `That is ${n}; a renewal takes up to ${BULK_RENEW_MAX} at a time.`,
      }
    }
    return {
      ...base,
      action: 'renew',
      summary: `Renew ${n}. The next page shows each price before you pay.`,
      renewHref: bulkRenewHref(domains.map((domain) => domain.id)),
    }
  }
  if (domains.length > BULK_MAX) {
    return { kind: 'refused', reason: `That is ${n}; a change takes up to ${BULK_MAX} at a time.` }
  }

  if (intent.action === 'nameservers') {
    if (intent.host) {
      const preset = findPreset(presets, intent.host)
      if (preset?.assignsPerZone) {
        return {
          kind: 'refused',
          reason: `${preset.provider} gives each domain its own nameservers, so set them one domain at a time from its Nameservers tab.`,
        }
      }
      if (preset) {
        return {
          ...base,
          action: 'nameservers',
          summary: `Point ${n} at ${preset.provider} (${preset.nameservers.join(', ')}).`,
          nameservers: preset.nameservers,
          presetId: preset.id,
        }
      }
      if (intent.nameservers.length < 2) {
        return {
          kind: 'refused',
          reason: `We have no checked nameservers for “${intent.host}”. Type the nameservers your host gave you instead.`,
        }
      }
    }
    if (intent.nameservers.length < 2) {
      return { kind: 'question', question: 'Which host, or which nameservers (at least two)?' }
    }
    return {
      ...base,
      action: 'nameservers',
      summary: `Set ${n} to use ${intent.nameservers.join(', ')}.`,
      nameservers: intent.nameservers,
    }
  }

  if (intent.on === null) return { kind: 'question', question: 'On or off?' }
  const on = intent.on
  const summary =
    intent.action === 'auto_renew'
      ? `Turn auto-renew ${on ? 'on' : 'off'} for ${n}.`
      : intent.action === 'transfer_lock'
        ? `${on ? 'Lock' : 'Unlock'} ${n} against transfers.`
        : `Turn WHOIS privacy ${on ? 'on' : 'off'} for ${n}.`
  return { ...base, action: intent.action, on, summary }
}
