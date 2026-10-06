import { redirect } from 'next/navigation'
import { Suspense } from 'react'
import { Container } from '@/components/layout/container'
import { DashboardFrame } from '@/features/accounts/components/dashboard-frame'
import { DashboardSkeleton } from '@/features/accounts/components/dashboard-skeleton'
import { StateBanner } from '@/features/accounts/components/state-banner'
import { accountBanner } from '@/features/accounts/lib/state'
import { getCurrentAccount } from '@/features/accounts/queries/accounts'
import { getUsage } from '@/features/accounts/queries/overview'

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
  const sandboxCap =
    account.state === 'sandbox' ? ((await getUsage(account.id))?.caps.daily ?? null) : null
  // Billing standing arrives with the billing package; until then nothing is past due.
  const banner = accountBanner(account, null, sandboxCap)

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
      {banner ? (
        <Container className="pt-6 sm:pt-8">
          <StateBanner banner={banner} />
        </Container>
      ) : null}
      {children}
    </DashboardFrame>
  )
}
