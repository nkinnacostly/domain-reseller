import { FlaskConical } from 'lucide-react'
import { type AdminSide, sideBanner } from '@/features/admin/lib/side'

/** Says, on every page, when the records shown are not live ones (ADMIN-SPEC §5.1). */
export function SideBanner({ admin, side }: { admin: { testOnly: boolean }; side: AdminSide }) {
  const words = sideBanner(admin, side)
  if (!words) return null
  return (
    <div
      role="note"
      data-testid="admin-side-banner"
      className="mx-4 mt-4 flex items-start gap-2.5 rounded-2xl border border-status-expiring/40 bg-status-expiring/15 px-4 py-3 text-sm text-foreground sm:mx-6 lg:mx-0 lg:mt-0 lg:mb-4"
    >
      <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p>{words}</p>
    </div>
  )
}
