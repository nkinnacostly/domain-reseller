import { redirect } from 'next/navigation'
import { Suspense } from 'react'
import { DashboardFrame } from '@/features/accounts/components/dashboard-frame'
import { DashboardSkeleton } from '@/features/accounts/components/dashboard-skeleton'
import { accountBanner } from '@/features/accounts/lib/state'
import { getCurrentAccount } from '@/features/accounts/queries/accounts'
import { getUsage } from '@/features/accounts/queries/overview'
import { billingStanding } from '@/features/billing/lib/standing'
import { getBillingOverview } from '@/features/billing/queries/billing'
import { AccountBannerWithCaps, BannerSlot } from '@/features/safety/components/account-banner'

/**
 * The signed-in area (MAIL-SPEC §10). The proxy sends anyone signed out to
 * sign in; someone with no account yet goes to onboarding. Everything here
 * reads the person's session, so it renders at request time, in Suspense.
 */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <Dashboard>{children}</Dashboard>
    </Suspense>
  )
}

async function Dashboard({ children }: { children: React.ReactNode }) {
  const data = await getCurrentAccount()
  if (!data) redirect('/onboarding')
  const { account } = data.current
  // The sandbox's cap is mail.settings' (N5b), as SQL applies it; never a number here.
  const [sandboxCap, billing] = await Promise.all([
    account.state === 'sandbox'
      ? getUsage(account.id).then((usage) => usage?.caps.daily ?? null)
      : Promise.resolve(null),
    // §8: past due shows above every page. An unreadable standing shows nothing.
    getBillingOverview(account.id).then(billingStanding),
  ])
  const banner = accountBanner(account, billing, sandboxCap)

  return (
    <DashboardFrame
      accounts={data.memberships.map((m) => ({
        id: m.account.id,
        name: m.account.name,
        role: m.role,
        state: m.account.state,
      }))}
      currentId={account.id}
      email={data.user.email ?? null}
    >
      {/* §8: the cap notice streams in on its own; until then, the banner without it. */}
      <Suspense fallback={<BannerSlot banner={banner} />}>
        <AccountBannerWithCaps account={account} billing={billing} sandboxCap={sandboxCap} />
      </Suspense>
      {children}
    </DashboardFrame>
  )
}
