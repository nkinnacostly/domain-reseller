'use client'

import { Menu, ShieldCheck } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { Brand, PRODUCT_NAME } from '@/components/layout/brand'
import { Container } from '@/components/layout/container'
import { DashboardNav } from '@/components/layout/dashboard-nav'
import { ThemeToggle } from '@/components/layout/theme-toggle'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { SignOutButton } from '@/features/auth/components/sign-out-button'
import { SECURITY_PAGE } from '@/features/auth/lib/links'
import { AccountSwitcher, type SwitcherAccount } from './account-switcher'

type FrameProps = {
  accounts: SwitcherAccount[]
  currentId: string
  email: string | null
  children: React.ReactNode
}

/** What the sidebar and the drawer both hold: the switcher, the pages, and you. */
function SidebarBody({
  accounts,
  currentId,
  email,
  onNavigate,
}: Omit<FrameProps, 'children'> & { onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col gap-5">
      <AccountSwitcher accounts={accounts} currentId={currentId} />
      <DashboardNav onNavigate={onNavigate} className="flex-1" />
      <div className="space-y-1 border-t border-border pt-4">
        {email ? (
          <p className="truncate px-3 pb-1 text-xs text-muted-foreground">
            <span className="sr-only">Signed in as </span>
            {email}
          </p>
        ) : null}
        <Link
          href={SECURITY_PAGE}
          onClick={onNavigate}
          className="flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]"
        >
          <ShieldCheck className="size-4" aria-hidden="true" />
          Your security
        </Link>
        <div className="flex items-center justify-between gap-2">
          <SignOutButton variant="menu" className="min-h-11 flex-1 px-3" />
          <ThemeToggle />
        </div>
      </div>
    </div>
  )
}

/**
 * The dashboard's shell (MAIL-SPEC §10, S1, S13): a sidebar from `lg`, a top
 * bar with a drawer below it. The pages render in `<main>`; later packages
 * fill them without touching this.
 */
export function DashboardFrame({ accounts, currentId, email, children }: FrameProps) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <aside className="hidden border-r border-border bg-card print:hidden lg:sticky lg:top-0 lg:flex lg:h-dvh lg:w-76 lg:shrink-0 lg:flex-col lg:gap-6 lg:overflow-y-auto lg:px-4 lg:py-5">
        <Link
          href="/dashboard"
          aria-label={`${PRODUCT_NAME}, dashboard`}
          className="self-start rounded-md px-2 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
        >
          <Brand />
        </Link>
        <SidebarBody accounts={accounts} currentId={currentId} email={email} />
      </aside>

      <header className="sticky top-0 z-30 border-b border-border bg-background print:hidden lg:hidden">
        <Container className="flex h-16 items-center justify-between gap-3">
          <Link
            href="/dashboard"
            aria-label={`${PRODUCT_NAME}, dashboard`}
            className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          >
            <Brand compact />
          </Link>
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button type="button" variant="outline" className="min-h-11 gap-2 rounded-full px-4">
                <Menu aria-hidden="true" />
                <span>Menu</span>
                <span className="sr-only">, open the dashboard menu</span>
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-[min(20rem,85vw)] overflow-y-auto px-4 pb-6">
              <SheetHeader className="px-0 pb-0">
                <SheetTitle>Dashboard menu</SheetTitle>
                <SheetDescription className="sr-only">
                  Your accounts, the dashboard’s pages, and your sign-in.
                </SheetDescription>
              </SheetHeader>
              <SidebarBody
                accounts={accounts}
                currentId={currentId}
                email={email}
                onNavigate={() => setOpen(false)}
              />
            </SheetContent>
          </Sheet>
        </Container>
      </header>

      <main id="main" className="min-w-0 flex-1">
        {children}
      </main>
    </div>
  )
}
