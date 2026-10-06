'use client'

import type { AccountState } from '@dr/shared/mail'
import { ChevronsUpDown, Plus } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAction } from 'next-safe-action/hooks'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { MemberRole } from '@/lib/safe-action'
import { cn } from '@/lib/utils'
import { switchAccount } from '../actions/accounts'
import { ROLE_LABEL } from '../lib/roles'
import { STATE_LABEL } from '../lib/state'

export type SwitcherAccount = { id: string; name: string; role: MemberRole; state: AccountState }

/**
 * The account switcher (MAIL-SPEC §10): every account the person is a member
 * of, the current one ticked, and the way to make another. Switching only
 * changes which account the dashboard shows; membership decides the rest.
 */
export function AccountSwitcher({
  accounts,
  currentId,
  className,
}: {
  accounts: SwitcherAccount[]
  currentId: string
  className?: string
}) {
  const router = useRouter()
  const action = useAction(switchAccount, { onSuccess: () => router.refresh() })
  const current = accounts.find((account) => account.id === currentId) ?? accounts[0]
  if (!current) return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={action.isPending}
        className={cn(
          'flex min-h-12 w-full items-center gap-3 rounded-xl border border-border bg-background px-3 py-2 text-left transition-colors',
          'hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98] disabled:opacity-70',
          className,
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="sr-only">Current account:</span>{' '}
          <span className="block truncate text-sm font-semibold text-foreground">
            {current.name}
          </span>
          <span className="sr-only">, </span>
          <span className="block truncate text-xs text-muted-foreground">
            {action.isPending
              ? 'Switching…'
              : `${ROLE_LABEL[current.role]} · ${STATE_LABEL[current.state].label}`}
          </span>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-(--radix-dropdown-menu-trigger-width) min-w-64"
      >
        <DropdownMenuLabel>Your accounts</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={current.id}
          onValueChange={(accountId) => {
            if (accountId !== current.id) action.execute({ accountId })
          }}
        >
          {accounts.map((account) => (
            <DropdownMenuRadioItem key={account.id} value={account.id} className="min-h-11">
              <span className="min-w-0">
                <span className="block truncate">{account.name}</span>
                <span className="block text-xs text-muted-foreground">
                  {ROLE_LABEL[account.role]} · {STATE_LABEL[account.state].label}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild className="min-h-11">
          <Link href="/onboarding">
            <Plus aria-hidden="true" />
            Create another account
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
