import { PANEL, PanelHeader, PanelPage } from '@/components/layout/panel'
import { RouteTabs } from '@/features/admin/components/route-tabs'
import { SideSwitch } from '@/features/admin/components/shell/side-switch'
import type { AdminSide } from '@/features/admin/lib/side'
import { cn } from '@/lib/utils'

/**
 * The Settings pages' shared header (docs/ADMIN-SPEC.md §5.2 B13): where you
 * are, the Live/Test switch — it decides whose counts the pages show — and
 * the five pages as tabs, the current one marked with `aria-current` (S13).
 */

export const SETTINGS_TABS = [
  { href: '/admin/settings', label: 'Limits', exact: true },
  { href: '/admin/settings/extensions', label: 'Extensions' },
  { href: '/admin/settings/ssl-products', label: 'SSL products' },
  { href: '/admin/settings/presets', label: 'Presets' },
  { href: '/admin/settings/admins', label: 'Admins' },
] as const

export function SettingsHeader({
  title,
  description,
  side,
  testOnly,
  crumbs = [],
  titleAside,
}: {
  title: string
  description: string
  side: AdminSide
  testOnly: boolean
  /** Pages between Settings and this one, for a preset's own page. */
  crumbs?: { label: string; href: string }[]
  titleAside?: React.ReactNode
}) {
  const index = title === 'Settings'
  return (
    <PanelHeader
      crumbs={[
        { label: 'Admin', href: '/admin' },
        ...(index ? [] : [{ label: 'Settings', href: '/admin/settings' }]),
        ...crumbs,
        { label: title },
      ]}
      title={title}
      titleAside={titleAside}
      description={description}
      actions={<SideSwitch side={side} testOnly={testOnly} />}
    >
      <RouteTabs label="Settings pages" tabs={[...SETTINGS_TABS]} />
    </PanelHeader>
  )
}

/** A Settings page before the admin is known: the header's shape, then its cards. */
export function SettingsPageSkeleton({ cards = 1 }: { cards?: number }) {
  return (
    <PanelPage>
      <div aria-hidden="true" className={cn(PANEL, 'h-56 animate-pulse')} />
      {Array.from({ length: cards }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
        <div key={index} aria-hidden="true" className={cn(PANEL, 'h-80 animate-pulse')} />
      ))}
    </PanelPage>
  )
}

/** Who may change things here, said where a control is shown to someone SQL will refuse. */
export function RoleNote({ words }: { words: string | null }) {
  if (!words) return null
  return (
    <p className="max-w-2xl rounded-xl bg-muted/60 px-3.5 py-3 text-sm text-foreground">{words}</p>
  )
}
