import { Container } from '@/components/layout/container'
import { StateBanner } from '@/features/accounts/components/state-banner'
import { type AccountBanner, accountBanner } from '@/features/accounts/lib/state'
import { getUsage } from '@/features/accounts/queries/overview'
import { getCapNotice } from '../queries/cap-notices'

type Account = Parameters<typeof accountBanner>[0] & { id: string }

/** The banner in the page's gutter (S4), or nothing. */
export function BannerSlot({ banner }: { banner: AccountBanner | null }) {
  if (!banner) return null
  return (
    <Container className="pt-6 sm:pt-8 print:hidden">
      <StateBanner banner={banner} />
    </Container>
  )
}

/**
 * The account's banner with this day's and month's cap notice in it (MAIL-
 * SPEC §8: at 80% and at 100% of a cap, recorded by reserve_send). Its own
 * Suspense boundary in the dashboard layout, so the notice's read never
 * holds the page: until it answers, the banner without it shows.
 */
export async function AccountBannerWithCaps({
  account,
  billing,
  sandboxCap,
}: {
  account: Account
  billing: Parameters<typeof accountBanner>[1]
  sandboxCap: number | null
}) {
  const usage = await getUsage(account.id)
  const capNotice = usage ? await getCapNotice(account.id, usage) : null
  return <BannerSlot banner={accountBanner(account, billing, sandboxCap, capNotice)} />
}
