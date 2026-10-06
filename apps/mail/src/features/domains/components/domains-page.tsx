import { Globe } from 'lucide-react'
import { Container } from '@/components/layout/container'
import { PartError } from '@/features/accounts/components/overview-parts'
import { getCurrentAccount } from '@/features/accounts/queries/accounts'
import { getSandboxSender, isTenantReady, listDomains } from '../queries/domains'
import { AddDomainForm } from './add-domain-form'
import { DomainsList } from './domains-list'
import { SandboxSender } from './sandbox-sender'

const card = 'rounded-3xl border border-border bg-card p-5 sm:p-6'

const MANAGERS = new Set(['owner', 'admin', 'developer'])

/**
 * The Domains page (MAIL-SPEC §5, §10): the account's domains with their
 * state, adding one, and the sandbox's sending address while there is one.
 * Each part fails on its own and says so (S11).
 */
export async function DomainsPage() {
  const data = await getCurrentAccount()
  if (!data) return null
  const { account, role } = data.current
  const canManage = MANAGERS.has(role)

  let listed: Awaited<ReturnType<typeof listDomains>> | null = null
  try {
    listed = await listDomains(account.id)
  } catch {
    listed = null
  }
  const [ready, sender] = await Promise.all([
    isTenantReady(account.id),
    listed?.sandbox ? getSandboxSender() : Promise.resolve(null),
  ])

  return (
    <Container className="space-y-6 py-6 sm:py-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Domains</h1>
        <p className="mt-1 text-pretty text-sm text-muted-foreground">
          Send from any address at a domain you have verified. Verifying takes three DNS records at
          your DNS host.
        </p>
      </div>

      {ready === false ? (
        <p
          role="status"
          className="rounded-2xl bg-tone-info px-4 py-3 text-pretty text-sm/6 text-tone-info-foreground"
        >
          Your account’s sending set-up with Amazon SES is being made. It usually takes a minute;
          you can add a domain meanwhile.
        </p>
      ) : null}

      {canManage ? (
        <section aria-labelledby="add-domain-heading" className={card}>
          <h2 id="add-domain-heading" className="font-semibold">
            Add a domain
          </h2>
          <div className="mt-4 max-w-xl">
            <AddDomainForm accountId={account.id} />
          </div>
        </section>
      ) : (
        <p className="text-pretty text-sm text-muted-foreground">
          Your role in this account can read its domains. Owners, admins and developers add and
          remove them.
        </p>
      )}

      {listed?.sandbox && sender ? <SandboxSender fromAddress={sender.fromAddress} /> : null}

      <section aria-labelledby="your-domains-heading" className="space-y-3">
        <h2 id="your-domains-heading" className="font-semibold">
          Your domains
        </h2>
        {listed === null ? (
          <PartError what="your domains" retryHref="/dashboard/domains" />
        ) : listed.domains.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-border px-5 py-8 text-center">
            <span className="mx-auto grid size-11 place-items-center rounded-2xl bg-brand-subtle text-brand-ink">
              <Globe className="size-5" aria-hidden="true" />
            </span>
            <p className="mt-3 font-medium">No domains yet</p>
            <p className="mt-1 text-pretty text-sm text-muted-foreground">
              {canManage
                ? 'Add the domain you send from, such as acme.ng. Its DNS records appear next.'
                : 'An owner, admin or developer of this account can add one.'}
            </p>
          </div>
        ) : (
          <DomainsList domains={listed.domains} />
        )}
      </section>
    </Container>
  )
}
