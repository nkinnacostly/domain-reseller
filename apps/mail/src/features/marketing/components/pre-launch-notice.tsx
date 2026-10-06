import { Info } from 'lucide-react'
import { Container } from '@/components/layout/container'
import { cn } from '@/lib/utils'
import { LAUNCH } from '../lib/site'

/**
 * Until Mail opens (MAIL-SPEC §13, P4), the public pages say so: they
 * describe the service as it is being built, and this is the line that keeps
 * that honest (N9b). Gone the day `LAUNCH.isOpen` is true.
 */
export function PreLaunchNotice({
  isOpen = LAUNCH.isOpen,
  className,
}: {
  isOpen?: boolean
  className?: string
}) {
  if (isOpen) return null
  return (
    <Container className={cn('pt-8 sm:pt-10', className)}>
      <aside
        aria-label="Not open yet"
        className="flex gap-3 rounded-2xl bg-tone-info p-4 text-sm/6 text-tone-info-foreground sm:p-5"
      >
        <Info aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
        <p>
          <strong className="font-semibold">Not open yet.</strong> MyDomainsHub Mail is still being
          built. Paid plans are not on sale, and new accounts stay in the sandbox until we open.
        </p>
      </aside>
    </Container>
  )
}
