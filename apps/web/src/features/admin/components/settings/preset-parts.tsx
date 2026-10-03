import { ExternalLink } from 'lucide-react'
import { FOCUS } from '@/components/layout/panel'
import { AdminStatusPill } from '@/features/admin/components/admin-status-pill'
import { formatCount } from '@/features/admin/lib/format'
import { SIDE_NAME } from '@/features/admin/lib/settings-copy'
import {
  type Health,
  type PresetRow,
  type PresetUsage,
  presetHealth,
  sourceHost,
} from '@/features/admin/lib/settings-presets'
import type { AdminSide } from '@/features/admin/lib/side'
import { cn } from '@/lib/utils'

/**
 * Small pieces the preset pages share (docs/ADMIN-SPEC.md §5.2 B13): a
 * nameserver list, a preset's health, who hid it, its source and who uses
 * it. Words carry every state; colour only tints (S8).
 */

export function Nameservers({ hosts, perZone }: { hosts: string[]; perZone: boolean }) {
  if (perZone || hosts.length === 0) {
    return <span className="text-muted-foreground">Per domain</span>
  }
  return (
    <ul className="space-y-0.5 font-mono text-sm break-all">
      {hosts.map((host) => (
        <li key={host}>{host}</li>
      ))}
    </ul>
  )
}

export function HealthPill({ health }: { health: Health }) {
  return (
    <AdminStatusPill
      value={health.key}
      tone={health.tone}
      labels={{ [health.key]: health.words }}
    />
  )
}

export function PresetHealth({ preset }: { preset: PresetRow }) {
  return <HealthPill health={presetHealth(preset)} />
}

/** Who hid it — the checker or a person — because that decides who can bring it back. */
export function hiddenWords(preset: PresetRow): string {
  if (preset.autoHiddenAt) return 'By the checker'
  if (preset.isHidden) return 'By a person'
  return 'No'
}

export function SourceLink({ url }: { url: string }) {
  if (!/^https:\/\//.test(url)) return <span className="break-all">{url || '—'}</span>
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className={cn(
        'inline-flex min-h-11 items-center gap-1 rounded break-all underline underline-offset-2',
        FOCUS,
      )}
    >
      {sourceHost(url)}
      <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="sr-only"> (opens the provider's page in a new tab)</span>
    </a>
  )
}

/** "3 domains · 1 order · 2 lines" on one side, or a dash when it could not be read. */
export function usageWords(usage: PresetUsage | null | undefined): string {
  if (!usage) return '—'
  const part = (count: number, one: string, many: string) =>
    `${formatCount(count)} ${count === 1 ? one : many}`
  return [
    part(usage.domains, 'domain', 'domains'),
    part(usage.orders, 'order', 'orders'),
    part(usage.lines, 'line', 'lines'),
  ].join(' · ')
}

export function usageHeader(side: AdminSide): string {
  return `In use (${SIDE_NAME[side]})`
}
