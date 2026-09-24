import { TRANSFER_LOCK_DAYS } from '@dr/shared'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import { PANEL_HEADING, Panel, PanelSkeleton } from '@/components/layout/panel'
import { getAccount } from '@/features/auth/queries/account'
import { PanelNote } from '@/features/domains/components/domain-badges'
import { PrivacyControl } from '@/features/domains/components/privacy-control'
import { TransferCode } from '@/features/domains/components/transfer-code'
import { TransferLockControl } from '@/features/domains/components/transfer-lock-control'
import {
  privacyOffered,
  settingsAvailability,
  transferCodeUnavailable,
  transferWindowEnds,
} from '@/features/domains/lib/settings'
import { getDomain } from '@/features/domains/queries/domains'
import { getDomainSettings } from '@/features/domains/queries/settings'

export const metadata: Metadata = { title: 'Security' }
type Params = Promise<{ domain: string }>

const dateFormat = new Intl.DateTimeFormat('en-NG', { dateStyle: 'long', timeZone: 'Africa/Lagos' })

/** FR-P6, E10 — lock, privacy and the transfer code, each applied at the registry. */
async function Security({ params }: { params: Params }) {
  const { domain: name } = await params
  const [domain, account] = await Promise.all([getDomain(name), getAccount()])
  if (!domain) notFound()
  const settings = await getDomainSettings(domain.id)
  const availability = settingsAvailability(domain)
  const hasTwoFactor = Boolean(account?.totpFactor)
  const windowEnds = transferWindowEnds([domain.registeredAt, settings.transferredInAt], new Date())

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {availability.note ? (
        <div className="xl:col-span-2">
          <PanelNote title={availability.note.title}>{availability.note.body}</PanelNote>
        </div>
      ) : null}

      <Panel labelledBy="lock-heading">
        <h2 id="lock-heading" className={PANEL_HEADING}>
          Transfer lock
        </h2>
        <p className="mt-1.5 text-pretty text-sm/6 text-muted-foreground">
          Stops anyone moving this domain to another registrar. It is on from registration.
        </p>
        <div className="mt-4">
          <TransferLockControl
            domainId={domain.id}
            domain={domain.domainName}
            locked={domain.transferLock}
            pending={settings.pendingTransferLock}
            editable={availability.editable}
            hasTwoFactor={hasTwoFactor}
          />
        </div>
      </Panel>

      <Panel labelledBy="privacy-heading">
        <h2 id="privacy-heading" className={PANEL_HEADING}>
          Contact privacy
        </h2>
        <p className="mt-1.5 text-pretty text-sm/6 text-muted-foreground">
          Keeps your name, email and phone out of public lookups. Free, on generic extensions.
        </p>
        <div className="mt-4">
          <PrivacyControl
            domainId={domain.id}
            domain={domain.domainName}
            tld={domain.tld}
            enabled={domain.privacyEnabled}
            pending={settings.pendingPrivacy}
            editable={availability.editable}
            offered={privacyOffered(domain.tld)}
          />
        </div>
      </Panel>

      <Panel labelledBy="transfer-heading" className="xl:col-span-2">
        <h2 id="transfer-heading" className={PANEL_HEADING}>
          Moving this domain to another registrar
        </h2>
        <ul className="mt-3 max-w-3xl list-disc space-y-1.5 pl-5 text-pretty text-sm/6 text-muted-foreground">
          <li>
            Your new registrar asks for the transfer code. ICANN rules give registrars five days to
            hand it over; here you get it straight away, after a two-factor check.
          </li>
          <li>
            The transfer lock must be off for the move to go through
            {domain.transferLock ? ' — it is on now.' : '.'}
          </li>
          <li>
            {windowEnds
              ? `The registry may refuse a transfer until ${dateFormat.format(windowEnds)}, ${TRANSFER_LOCK_DAYS} days after this domain was registered or last transferred.`
              : `Registries may refuse a transfer within ${TRANSFER_LOCK_DAYS} days of a registration, a previous transfer or a change of registrant.`}
          </li>
          <li>We never hold a domain back over an unpaid bill.</li>
        </ul>
        <div className="mt-5">
          <TransferCode
            domainId={domain.id}
            domain={domain.domainName}
            unavailable={transferCodeUnavailable(domain)}
            hasTwoFactor={hasTwoFactor}
            testMode={domain.testMode}
          />
        </div>
      </Panel>
    </div>
  )
}

export default function SecurityPage({ params }: { params: Params }) {
  return (
    <Suspense fallback={<PanelSkeleton height="h-96" />}>
      <Security params={params} />
    </Suspense>
  )
}
