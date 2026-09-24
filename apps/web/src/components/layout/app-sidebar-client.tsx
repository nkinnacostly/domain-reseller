'use client'

import { BookUser, ChevronUp, LogOut, Menu, Receipt, Settings } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useAction } from 'next-safe-action/hooks'
import { useEffect, useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { signOut } from '@/features/auth/actions/session'

/**
 * On phones and tablets the sidebar is a drawer. It closes when a link in it
 * is followed — including one to the page already open — and on any
 * navigation.
 */
export function MobileNav({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const pathname = usePathname()

  // biome-ignore lint/correctness/useExhaustiveDependencies: close whenever the page changes
  useEffect(() => setOpen(false), [pathname])

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label="Open menu"
          className="grid size-11 place-items-center rounded-full border border-border bg-background text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.97]"
        >
          <Menu className="size-5" aria-hidden="true" />
        </button>
      </SheetTrigger>
      <SheetContent
        side="left"
        className="w-[min(20rem,88vw)] gap-0 bg-background p-0"
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('a')) setOpen(false)
        }}
      >
        <SheetTitle className="sr-only">Menu</SheetTitle>
        <SheetDescription className="sr-only">Pages in your account</SheetDescription>
        {children}
      </SheetContent>
    </Sheet>
  )
}

/** The signed-in person, and what they can do with their account. */
export function AccountMenu({
  name,
  email,
  initials,
}: {
  name: string
  email: string
  initials: string
}) {
  const leave = useAction(signOut)

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5 rounded-2xl bg-foreground py-1 pr-1 pl-2 text-background">
      <span
        aria-hidden="true"
        className="grid size-9 shrink-0 place-items-center rounded-full bg-brand text-sm font-semibold text-brand-foreground"
      >
        {initials}
      </span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-sm font-medium">{name || email}</span>
        <span className="block truncate text-xs text-background/75">
          {name ? email : 'Signed in'}
        </span>
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Account menu"
            className="grid size-11 shrink-0 place-items-center rounded-xl transition-colors hover:bg-background/15 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-background active:scale-[0.97] data-[state=open]:bg-background/15"
          >
            <ChevronUp className="size-4" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" className="w-56">
          <DropdownMenuItem asChild>
            <Link href="/app/settings">
              <Settings aria-hidden="true" />
              Settings
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/app/settings/contacts">
              <BookUser aria-hidden="true" />
              Contacts
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/app/orders">
              <Receipt aria-hidden="true" />
              Orders
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={leave.isPending}
            onSelect={(event) => {
              event.preventDefault()
              leave.execute()
            }}
          >
            <LogOut aria-hidden="true" />
            {leave.isPending ? 'Signing out…' : 'Sign out'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
