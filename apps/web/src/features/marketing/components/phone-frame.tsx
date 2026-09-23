import { BatteryFull, Signal, Wifi } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * A phone drawn in CSS, for showing the product on the home page.
 *
 * Always decorative: every fact on its screen is also stated in the page copy,
 * so the whole device is hidden from assistive tech. The screen uses the page's
 * own tokens, so in dark mode it shows the app in dark mode.
 */
export function PhoneFrame({
  children,
  className,
  testId,
}: {
  children: React.ReactNode
  className?: string
  /** For e2e checks that the mockup shows live prices. */
  testId?: string
}) {
  return (
    <div
      aria-hidden="true"
      data-testid={testId}
      className={cn(
        'pointer-events-none w-[16.5rem] select-none rounded-[2.6rem] bg-device p-2 shadow-[0_40px_80px_-30px_rgb(0_0_0/0.45)] sm:w-[17.5rem]',
        className,
      )}
    >
      <div className="relative min-h-[33rem] overflow-hidden rounded-[2.1rem] bg-background">
        <div className="absolute top-2 left-1/2 h-5 w-20 -translate-x-1/2 rounded-full bg-device" />
        <div className="flex items-center justify-between px-6 pt-2.5 text-[0.625rem] font-semibold text-foreground">
          <span>9:41</span>
          <span className="flex items-center gap-1">
            <Signal className="size-3" />
            <Wifi className="size-3" />
            <BatteryFull className="size-3.5" />
          </span>
        </div>
        <div className="px-4 pt-6 pb-6">{children}</div>
      </div>
    </div>
  )
}
