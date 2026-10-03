import Link from 'next/link'
import { QUIET_BUTTON } from '@/components/common/action-parts'
import { RefreshWhile } from '@/components/common/refresh-while'
import { PanelHeader, PanelPage } from '@/components/layout/panel'
import { TestBadge } from '@/features/admin/components/admin-status-pill'
import { EmptyState } from '@/features/admin/components/empty-state'
import { ErrorState } from '@/features/admin/components/error-state'
import { SideSwitch } from '@/features/admin/components/shell/side-switch'
import { formatWat } from '@/features/admin/lib/format'
import type { AdminSide } from '@/features/admin/lib/side'
import {
  CERTIFICATE_ERROR,
  CERTIFICATE_NOT_FOUND,
  CERTIFICATE_NOT_FOUND_BODY,
} from '@/features/admin/lib/ssl-copy'
import { parseCertificateId } from '@/features/admin/lib/ssl-params'
import { type AdminPrincipal, getAdminSide, requireAdmin } from '@/features/admin/queries/session'
import { CALLS_SHOWN, type CertificateDetail, getCertificate } from '@/features/admin/queries/ssl'
import { CertificateBody } from './certificate-sections'
import { CertificatePill } from './ssl-parts'

const CRUMBS = [
  { label: 'Admin', href: '/admin' },
  { label: 'Certificates', href: '/admin/ssl' },
]

/** While something is moving, the page re-reads our records (never the supplier) every 10 s. */
export const CERTIFICATE_REFRESH_MS = 10_000

const SETTLING: ReadonlySet<string> = new Set(['pending', 'setting_up', 'reissuing'])

/** True while a job is queued or with a worker, or the certificate is between states. */
export function isSettling(detail: CertificateDetail): boolean {
  if (SETTLING.has(detail.certificate.status)) return true
  return detail.jobs.ok
    ? detail.jobs.data.some((job) => job.status === 'queued' || job.status === 'running')
    : false
}

function Header({
  admin,
  side,
  detail,
  now,
}: {
  admin: AdminPrincipal
  side: AdminSide
  detail: CertificateDetail | null
  now: Date
}) {
  const certificate = detail?.certificate
  return (
    <PanelHeader
      crumbs={[...CRUMBS, { label: certificate?.commonName ?? 'Certificate' }]}
      title={<span className="break-all">{certificate?.commonName ?? 'Certificate'}</span>}
      titleAside={
        certificate ? (
          <span className="inline-flex flex-wrap items-center gap-2">
            {certificate.testMode ? <TestBadge /> : null}
            <CertificatePill
              status={certificate.status}
              expiresAt={certificate.expiresAt}
              now={now}
            />
          </span>
        ) : null
      }
      description={
        certificate
          ? `${certificate.productName ?? 'Certificate'} · ordered ${formatWat(certificate.createdAt)}. Read only: a certificate moves through its jobs.`
          : undefined
      }
      actions={<SideSwitch side={side} testOnly={admin.testOnly} />}
    />
  )
}

/** `/admin/ssl/[id]` (B10): one certificate, read only, with a status read on a click. */
export async function CertificateView({ params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin()
  const side = await getAdminSide(admin)
  const id = parseCertificateId((await params).id)
  const now = new Date()
  let detail: CertificateDetail | null
  try {
    detail = id ? await getCertificate(admin, side, id) : null
  } catch {
    return (
      <PanelPage>
        <Header admin={admin} side={side} detail={null} now={now} />
        <ErrorState title={CERTIFICATE_ERROR} />
      </PanelPage>
    )
  }

  return (
    <PanelPage>
      <Header admin={admin} side={side} detail={detail} now={now} />
      {detail ? (
        <>
          <CertificateBody detail={detail} viewer={admin} now={now} callsShown={CALLS_SHOWN} />
          <RefreshWhile active={isSettling(detail)} everyMs={CERTIFICATE_REFRESH_MS} />
        </>
      ) : (
        <EmptyState
          title={CERTIFICATE_NOT_FOUND(side)}
          body={CERTIFICATE_NOT_FOUND_BODY}
          action={
            <Link href="/admin/ssl" className={QUIET_BUTTON}>
              Back to certificates
            </Link>
          }
        />
      )}
    </PanelPage>
  )
}
