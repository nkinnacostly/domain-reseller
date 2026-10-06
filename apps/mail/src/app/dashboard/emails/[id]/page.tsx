import { ArrowLeft } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'
import { EmailStatusPill } from '@/components/common/email-status'
import { Container } from '@/components/layout/container'
import { PageSkeleton } from '@/features/accounts/components/dashboard-skeleton'
import { PartError } from '@/features/accounts/components/overview-parts'
import { getCurrentAccount } from '@/features/accounts/queries/accounts'
import {
  BodyView,
  card,
  HeadersList,
  Recipients,
  Timeline,
} from '@/features/emails/components/email-detail'
import { lagosTime } from '@/features/emails/lib/format'
import { timeline } from '@/features/emails/lib/timeline'
import { reasonWords } from '@/features/emails/lib/words'
import { getEmailPage } from '@/features/emails/queries/log'

export const metadata: Metadata = { title: 'Email' }

type Params = Promise<{ id: string }>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const BACK =
  'inline-flex min-h-11 items-center gap-1.5 rounded-sm text-sm font-medium text-brand-ink underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

/**
 * One email (MAIL-SPEC §10 Email): its timeline of events, its recipients,
 * the headers we set, any bounce reason in plain words, and its body while it
 * is kept (MR3: 72 hours after sending). Read as the member (RLS).
 */
async function Email({ params }: { params: Params }) {
  const [data, { id }] = await Promise.all([getCurrentAccount(), params])
  if (!data) return null
  const page = UUID.test(id)
    ? await getEmailPage(data.current.account.id, id.toLowerCase())
    : 'missing'

  if (page === 'missing') {
    return (
      <div className={card}>
        <h1 className="text-2xl font-semibold tracking-tight">No such email</h1>
        <p className="mt-2 text-pretty text-sm/6 text-muted-foreground">
          No email with that id belongs to this account. If you have more than one account, switch
          to the one that sent it.
        </p>
      </div>
    )
  }
  if (!page) {
    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight">Email</h1>
        <PartError what="this email" retryHref={`/dashboard/emails/${id}`} />
      </>
    )
  }

  const { email, events, payload } = page
  const why = reasonWords(email.status_reason)
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <EmailStatusPill status={email.status} />
          <span className="text-sm text-muted-foreground">
            Queued {lagosTime(email.created_at)}
          </span>
        </div>
        <h1 className="break-words text-2xl font-semibold tracking-tight sm:text-3xl">
          {email.subject}
        </h1>
        <p className="break-all font-mono text-xs text-muted-foreground">{email.public_id}</p>
        {why ? <p className="max-w-2xl text-pretty text-sm/6">{why}</p> : null}
      </div>

      <div className="grid gap-6 xl:grid-cols-[3fr_2fr]">
        <section aria-labelledby="timeline-heading" className={card}>
          <h2 id="timeline-heading" className="font-semibold">
            What happened
          </h2>
          <div className="mt-4">
            <Timeline items={timeline(email, events)} />
          </div>
        </section>
        <section aria-labelledby="recipients-heading" className={card}>
          <h2 id="recipients-heading" className="font-semibold">
            Recipients
          </h2>
          <div className="mt-4">
            <Recipients email={email} />
          </div>
        </section>
      </div>

      <section aria-labelledby="headers-heading" className={card}>
        <h2 id="headers-heading" className="font-semibold">
          Headers we set
        </h2>
        <div className="mt-4">
          <HeadersList email={email} payload={payload} />
        </div>
      </section>

      <section aria-labelledby="body-heading" className={card}>
        <h2 id="body-heading" className="font-semibold">
          Body
        </h2>
        <div className="mt-4">
          <BodyView email={email} payload={payload} memberRole={data.current.role} />
        </div>
      </section>
    </div>
  )
}

export default function EmailPage({ params }: { params: Params }) {
  return (
    <Container className="space-y-4 py-6 sm:py-8">
      <Link href="/dashboard/emails" className={BACK}>
        <ArrowLeft className="size-4" aria-hidden="true" />
        All emails
      </Link>
      <Suspense fallback={<PageSkeleton />}>
        <Email params={params} />
      </Suspense>
    </Container>
  )
}
