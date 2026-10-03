import { RENEW_CHECK_ENABLED } from '@dr/shared/admin'
import { PANEL_HEADING, Panel, PanelPage } from '@/components/layout/panel'
import type { AdminActionId } from '@/features/admin/lib/actions'
import { notOfferedWords } from '@/features/admin/lib/supplier-copy'
import { type AdminPrincipal, getAdminSide, requireAdmin } from '@/features/admin/queries/session'
import { DomainLookup, PriceCheck, RegistryListing, SslLookup } from './lookup-panels'
import { SupplierHeader } from './supplier-header'

/**
 * `/admin/supplier/lookup` (docs/ADMIN-SPEC.md §5.2 B6): one domain, one
 * transfer, renewability, a registrant's verification, one certificate, one
 * price, or our listing — each read live from DomainNameAPI on a press,
 * audited, through the gateway (D10, D22). Nothing is read on render, and no
 * name goes in the address. For a test administrator, the price check says
 * what SQL would: they cannot read live prices (D15).
 */
export async function LookupView() {
  const admin = await requireAdmin()
  const side = await getAdminSide(admin)
  return (
    <PanelPage>
      <SupplierHeader
        title="Registry lookup"
        description={`Read one domain, a transfer, a certificate or a price from DomainNameAPI now, on the ${side} side. Every read is written to the audit log.`}
        side={side}
        testOnly={admin.testOnly}
      />
      <LookupPanel
        id="lookup-domain"
        heading="A domain at the registry"
        admin={admin}
        action="supplier.domain_lookup"
      >
        <DomainLookup renewCheckEnabled={RENEW_CHECK_ENABLED} />
      </LookupPanel>
      <LookupPanel
        id="lookup-ssl"
        heading="A certificate"
        admin={admin}
        action="supplier.ssl_lookup"
      >
        <SslLookup />
      </LookupPanel>
      <LookupPanel
        id="lookup-price"
        heading="A price"
        admin={admin}
        action="supplier.price_check"
        intro="DomainNameAPI's price for one operation, against the wholesale cost our prices are built from. Prices are the same on both sides."
      >
        <PriceCheck />
      </LookupPanel>
      <LookupPanel
        id="lookup-listing"
        heading="Our domains at the registry"
        admin={admin}
        action="supplier.domains_page"
        intro="The domains in our DomainNameAPI account on this side, as the registry lists them."
      >
        <RegistryListing />
      </LookupPanel>
    </PanelPage>
  )
}

function LookupPanel({
  id,
  heading,
  intro,
  admin,
  action,
  children,
}: {
  id: string
  heading: string
  intro?: string
  admin: AdminPrincipal
  action: AdminActionId
  children: React.ReactNode
}) {
  const words = notOfferedWords(admin, action)
  return (
    <Panel labelledBy={`${id}-heading`}>
      <h2 id={`${id}-heading`} className={PANEL_HEADING}>
        {heading}
      </h2>
      {intro ? <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{intro}</p> : null}
      <div className="mt-4" data-lookup={id}>
        {words ? (
          <p className="max-w-2xl rounded-xl bg-muted/60 px-3.5 py-3 text-sm text-foreground">
            {words}
          </p>
        ) : (
          children
        )}
      </div>
    </Panel>
  )
}
