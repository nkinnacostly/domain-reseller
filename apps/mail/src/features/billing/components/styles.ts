/**
 * Billing's button and card looks: hover, focus-visible, pressed and
 * disabled states on every button (S12), 44px targets (S7), tokens only (S2).
 * A payment button that shows nothing when pressed gets pressed twice.
 */

const button =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-5 text-center text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-70'

export const primaryButtonClass = `${button} bg-primary text-primary-foreground hover:bg-primary/90`

export const secondaryButtonClass = `${button} border border-border bg-background text-foreground hover:bg-muted`

export const cardClass = 'rounded-3xl border border-border bg-card p-5 sm:p-6'

export const linkClass =
  'rounded-sm font-medium text-brand-ink underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
