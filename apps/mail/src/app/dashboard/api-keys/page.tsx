import { KeyRound } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'
import { Container } from '@/components/layout/container'
import { PageSkeleton } from '@/features/accounts/components/dashboard-skeleton'
import { PartError } from '@/features/accounts/components/overview-parts'
import { getCurrentAccount } from '@/features/accounts/queries/accounts'
import { CreateKeyForm } from '@/features/api/components/create-key-form'
import { KeysList } from '@/features/api/components/keys-list'
import { canSeeKeys, permissionsFor } from '@/features/api/lib/keys'
import { getKeyDomains, getKeys } from '@/features/api/queries/keys'

export const metadata: Metadata = { title: 'API keys' }

const RETRY = '/dashboard/api-keys'
const card = 'rounded-3xl border border-border bg-card p-5 sm:p-6'
const LINK =
  'rounded-sm font-medium text-brand-ink underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

/**
 * API keys (MAIL-SPEC §10, MR7): make one — shown once — and see each key's
 * name, permission, domain and last use, with revoke. Viewers cannot read
 * keys (RLS), and the page says so rather than showing an empty list.
 */
async function ApiKeys() {
  const data = await getCurrentAccount()
  if (!data) return null
  const { account, role } = data.current

  if (!canSeeKeys(role)) {
    return (
      <p className={`${card} max-w-2xl text-pretty text-sm/6 text-muted-foreground`}>
        Viewers cannot see or make API keys. Ask the account’s owner or an admin to make you a
        developer if you build with this account.
      </p>
    )
  }

  const [keys, domains] = await Promise.all([getKeys(account.id), getKeyDomains(account.id)])
  const live = keys?.filter((key) => !key.revokedAt) ?? []
  const revoked = keys?.filter((key) => key.revokedAt) ?? []

  return (
    <div className="space-y-8">
      {permissionsFor(role).length > 0 ? (
        <section aria-labelledby="new-key-heading" className={`${card} max-w-3xl`}>
          <h2 id="new-key-heading" className="font-semibold">
            Make a key
          </h2>
          <div className="mt-4">
            <CreateKeyForm accountId={account.id} memberRole={role} domains={domains ?? []} />
          </div>
        </section>
      ) : null}

      <section aria-labelledby="keys-heading" className="space-y-4">
        <h2 id="keys-heading" className="text-lg font-semibold">
          Your keys
        </h2>
        {!keys || !domains ? (
          <PartError what="your keys" retryHref={RETRY} />
        ) : live.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-border px-5 py-8 text-center">
            <KeyRound className="mx-auto size-6 text-muted-foreground" aria-hidden="true" />
            <p className="mt-3 font-medium">No keys yet</p>
            <p className="mt-1 text-pretty text-sm text-muted-foreground">
              Make one above, then send your first email with it: the{' '}
              <Link href="/docs/quickstart" className={LINK}>
                quickstart
              </Link>{' '}
              shows the one request.
            </p>
          </div>
        ) : (
          <KeysList accountId={account.id} keys={live} domains={domains} memberRole={role} />
        )}
      </section>

      {keys && domains && revoked.length > 0 ? (
        <section aria-labelledby="revoked-heading" className="space-y-4">
          <h2 id="revoked-heading" className="text-lg font-semibold">
            Revoked keys
          </h2>
          <KeysList accountId={account.id} keys={revoked} domains={domains} memberRole={role} />
        </section>
      ) : null}
    </div>
  )
}

export default function ApiKeysPage() {
  return (
    <Container className="space-y-6 py-6 sm:py-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">API keys</h1>
        <p className="mt-1 max-w-2xl text-pretty text-sm text-muted-foreground">
          Your app sends with a key, as{' '}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
            Authorization: Bearer mdh_live_…
          </code>
          . A key is shown once, when it is made; we keep only a hash of it.
        </p>
      </div>
      <Suspense fallback={<PageSkeleton />}>
        <ApiKeys />
      </Suspense>
    </Container>
  )
}
