'use client'

import { LogOut } from 'lucide-react'
import { useAction } from 'next-safe-action/hooks'
import { cn } from '@/lib/utils'
import { signOut } from '../actions/session'

export function SignOutButton({
  variant = 'button',
  className,
}: {
  variant?: 'button' | 'link' | 'menu'
  className?: string
}) {
  const action = useAction(signOut)
  return (
    <button
      type="button"
      onClick={() => action.execute()}
      disabled={action.isPending}
      className={cn(
        variant === 'link' &&
          'font-medium text-foreground underline-offset-4 hover:underline disabled:opacity-60',
        variant === 'button' &&
          'inline-flex h-10 items-center gap-2 rounded-full border border-border bg-background px-4 text-sm font-medium text-foreground transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98] disabled:opacity-60',
        variant === 'menu' &&
          'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-foreground hover:bg-muted disabled:opacity-60',
        className,
      )}
    >
      {variant !== 'link' ? <LogOut className="size-4" aria-hidden="true" /> : null}
      {action.isPending ? 'Signing out…' : variant === 'link' ? 'sign out' : 'Sign out'}
    </button>
  )
}
