'use client'

import { Printer } from 'lucide-react'
import { FOCUS } from '@/components/layout/panel'
import { cn } from '@/lib/utils'

/**
 * Opens the browser's print dialog, which also saves as PDF. The page's
 * print styles hide the panel around the receipt, so only the receipt prints.
 */
export function PrintButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className={cn(
        'inline-flex h-11 items-center justify-center gap-2 rounded-full bg-accent px-5 text-sm font-medium text-accent-foreground transition hover:bg-accent/90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-70',
        FOCUS,
        className,
      )}
    >
      <Printer className="size-4" aria-hidden="true" />
      Print or save as PDF
    </button>
  )
}
