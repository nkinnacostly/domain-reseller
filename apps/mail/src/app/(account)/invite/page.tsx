import { MailOpen } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { AcceptInvite } from '@/features/accounts/components/accept-invite'
import { resultMessage } from '@/features/accounts/lib/results'
import { ROLE_LABEL, ROLE_SUMMARY } from '@/features/accounts/lib/roles'
import { previewInvite } from '@/features/accounts/queries/members'
import { getSessionUser } from '@/features/auth/queries/security'

export const metadata: Metadata = { title: 'Join an account' }

type Params = Promise<{ token?: string }>

const day = new Intl.DateTimeFormat('en-NG', { dateStyle: 'medium', timeZone: 'Africa/Lagos' })

const buttonClass =
  'inline-flex h-11 w-full items-center justify-center rounded-full border border-border bg-background px-6 text-sm font-medium transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98]'

/**
 * The invite page (MAIL-SPEC §9: "accept page"). The proxy sends anyone
 * signed out to sign in and back. Only the address the invite was sent to,
 * confirmed, may join; anyone else is told so and nothing more.
 */
async function Invite({ searchParams }: { searchParams: Params }) {
  const [{ token }, user] = await Promise.all([searchParams, getSessionUser()])
  const preview = await previewInvite(token ?? '')

  return (
    <div className="mx-auto max-w-md rounded-3xl border border-border bg-card p-6 sm:p-8">
      <span className="grid size-11 place-items-center rounded-2xl bg-brand-subtle text-brand-ink">
        <MailOpen className="size-5" aria-hidden="true" />
      </span>
      {preview.ok ? (
        <>
          <h1 className="mt-4 text-2xl font-semibold tracking-tight text-balance">
            Join {preview.accountName}
          </h1>
          <p className="mt-2 text-pretty text-sm/6 text-muted-foreground">
            You were invited as {ROLE_LABEL[preview.role].toLowerCase()}:{' '}
            {ROLE_SUMMARY[preview.role].charAt(0).toLowerCase()}
            {ROLE_SUMMARY[preview.role].slice(1)} The invite works until{' '}
            {day.format(new Date(preview.expiresAt))}.
          </p>
          <div className="mt-6">
            <AcceptInvite token={token ?? ''} accountName={preview.accountName} />
          </div>
        </>
      ) : (
        <>
          <h1 className="mt-4 text-2xl font-semibold tracking-tight text-balance">
            {preview.code === 'already_member'
              ? 'You are already a member'
              : 'This invite can’t be used'}
          </h1>
          <p className="mt-2 text-pretty text-sm/6 text-muted-foreground">
            {preview.code === 'already_member'
              ? 'You belong to this account already. Open the dashboard to find it in your accounts.'
              : preview.code === 'not_found'
                ? 'The link is not valid: it may have been revoked, or copied only in part. Ask whoever sent it for a new one.'
                : resultMessage({ code: preview.code })}
          </p>
          {preview.code === 'wrong_email' && user?.email ? (
            <p className="mt-2 text-pretty text-sm/6 text-muted-foreground">
              You are signed in as <span className="font-medium text-foreground">{user.email}</span>
              .
            </p>
          ) : null}
          <div className="mt-6">
            <Link href="/dashboard" className={buttonClass}>
              Go to the dashboard
            </Link>
          </div>
        </>
      )}
    </div>
  )
}

export default function InvitePage({ searchParams }: { searchParams: Params }) {
  return (
    <Suspense
      fallback={<Skeleton aria-hidden="true" className="mx-auto h-72 max-w-md rounded-3xl" />}
    >
      <Invite searchParams={searchParams} />
    </Suspense>
  )
}
