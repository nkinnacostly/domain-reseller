import { Suspense } from 'react'
import { PANEL_HEADING, Panel, PanelPage } from '@/components/layout/panel'
import { canAct } from '@/features/admin/lib/actions'
import { formatWat } from '@/features/admin/lib/format'
import {
  CATALOGUE_NAME,
  type CatalogueKind,
  heartbeatWords,
} from '@/features/admin/lib/supplier-catalogue'
import { notOfferedWords, OWNER_ONLY } from '@/features/admin/lib/supplier-copy'
import { type AdminPrincipal, getAdminSide, requireAdmin } from '@/features/admin/queries/session'
import { getSyncHeartbeats } from '@/features/admin/queries/supplier'
import { CataloguePanel } from './catalogue-panel'
import { SupplierHeader } from './supplier-header'

const PREVIEW_ACTION = {
  tlds: 'supplier.catalogue_preview',
  ssl: 'supplier.ssl_catalogue_preview',
} as const

const APPLY_ACTION = {
  tlds: 'supplier.catalogue_apply',
  ssl: 'supplier.ssl_catalogue_apply',
} as const

const INTRO: Record<CatalogueKind, string> = {
  tlds: 'Wholesale prices, periods and extensions from DomainNameAPI. The gateway syncs them every week; preview to see what the next sync would change.',
  ssl: "SSL products and their wholesale prices from DomainNameAPI, synced every week. Which products are on sale stays the owner's choice, in Settings.",
}

/**
 * `/admin/supplier/catalogue` — the price lists (docs/ADMIN-SPEC.md §5.2 B6,
 * D19): when each weekly sync last ran, and, for the owner, a preview of
 * what it would change and an apply that runs it now. Everyone else is told
 * why it is not offered — a test administrator in SQL's own words.
 */
export async function CatalogueView() {
  const admin = await requireAdmin()
  const side = await getAdminSide(admin)
  return (
    <PanelPage>
      <SupplierHeader
        title="Price list"
        description="DomainNameAPI's catalogue, synced weekly by the gateway. Prices are the same on both sides."
        side={side}
        testOnly={admin.testOnly}
      />
      {(['tlds', 'ssl'] as const).map((kind) => (
        <Panel key={kind} labelledBy={`catalogue-${kind}-heading`}>
          <h2 id={`catalogue-${kind}-heading`} className={PANEL_HEADING}>
            {CATALOGUE_NAME[kind]}
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{INTRO[kind]}</p>
          <Suspense
            fallback={
              <p className="mt-3 h-5 w-64 animate-pulse rounded bg-muted" aria-hidden="true" />
            }
          >
            <LastSync admin={admin} kind={kind} />
          </Suspense>
          <div className="mt-4" data-catalogue={kind}>
            <CatalogueControls admin={admin} kind={kind} />
          </div>
        </Panel>
      ))}
    </PanelPage>
  )
}

export async function LastSync({ admin, kind }: { admin: AdminPrincipal; kind: CatalogueKind }) {
  const beats = await getSyncHeartbeats(admin)
  let words: string
  if (beats === 'hidden') words = 'The weekly sync’s last run is not shown to test administrators.'
  else if (beats === null) words = 'The weekly sync’s last run couldn’t be read. Try again.'
  else {
    const beat = beats[kind]
    words = beat
      ? heartbeatWords(beat, formatWat(beat.beatAt))
      : 'The weekly sync has not run from the gateway yet.'
  }
  return <p className="mt-3 text-sm text-foreground">{words}</p>
}

export function CatalogueControls({ admin, kind }: { admin: AdminPrincipal; kind: CatalogueKind }) {
  const words = notOfferedWords(admin, PREVIEW_ACTION[kind], OWNER_ONLY.catalogue)
  if (words) {
    return (
      <p className="max-w-2xl rounded-xl bg-muted/60 px-3.5 py-3 text-sm text-foreground">
        {words}
      </p>
    )
  }
  return <CataloguePanel kind={kind} mayApply={canAct(admin, APPLY_ACTION[kind])} />
}
