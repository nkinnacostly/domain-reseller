import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PageSkeleton } from '@/features/accounts/components/dashboard-skeleton'
import { InviteForm, PendingInvites } from '@/features/accounts/components/invites'
import { LeaveAccount, TransferOwnership } from '@/features/accounts/components/leave-transfer'
import { MembersList } from '@/features/accounts/components/members-list'
import { PartError } from '@/features/accounts/components/overview-parts'
import { canLeave, canManageMembers, canTransfer } from '@/features/accounts/lib/roles'
import { getCurrentAccount } from '@/features/accounts/queries/accounts'
import { getMembers, getPendingInvites } from '@/features/accounts/queries/members'
import { getPlan } from '@/features/accounts/queries/overview'

export const metadata: Metadata = { title: 'Members' }

const RETRY = '/dashboard/settings/members'

/**
 * Members and roles (MAIL-SPEC §10 Settings; migration 46): who is in the
 * account, invitations, handing it over and leaving — each offered only to
 * the roles SQL allows.
 */
async function Members() {
  const data = await getCurrentAccount()
  if (!data) return null
  const { account, role } = data.current
  const manager = canManageMembers(role)
  const [members, invites, plan] = await Promise.all([
    getMembers(account.id),
    manager ? getPendingInvites(account.id) : Promise.resolve(null),
    getPlan(account.planCode),
  ])
  const seatsTaken = (members?.length ?? 0) + (invites?.length ?? 0)

  return (
    <div className="space-y-10">
      <section aria-labelledby="members-heading" className="space-y-4">
        <div>
          <h2 id="members-heading" className="text-lg font-semibold">
            Members
          </h2>
          {plan && members ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {manager
                ? `${seatsTaken} of ${plan.maxMembers} ${plan.maxMembers === 1 ? 'seat' : 'seats'} on the ${plan.name} plan taken, counting invites waiting.`
                : `The ${plan.name} plan has ${plan.maxMembers} ${plan.maxMembers === 1 ? 'seat' : 'seats'}.`}
            </p>
          ) : null}
        </div>
        {members ? (
          <MembersList accountId={account.id} members={members} me={data.user.id} myRole={role} />
        ) : (
          <PartError what="the members" retryHref={RETRY} />
        )}
      </section>

      {manager ? (
        <section aria-labelledby="invite-heading" className="max-w-2xl space-y-4">
          <div>
            <h2 id="invite-heading" className="text-lg font-semibold">
              Invite someone
            </h2>
            <p className="mt-1 text-pretty text-sm text-muted-foreground">
              They join with the email address you invite, once they have signed in with it.
            </p>
          </div>
          <InviteForm accountId={account.id} myRole={role} />
        </section>
      ) : null}

      {manager ? (
        <section aria-labelledby="invites-heading" className="space-y-4">
          <h2 id="invites-heading" className="text-lg font-semibold">
            Invites waiting
          </h2>
          {invites ? (
            <PendingInvites accountId={account.id} invites={invites} myRole={role} />
          ) : (
            <PartError what="the invites" retryHref={RETRY} />
          )}
        </section>
      ) : null}

      {canTransfer(role) && members ? (
        <section aria-labelledby="transfer-heading" className="space-y-4">
          <div>
            <h2 id="transfer-heading" className="text-lg font-semibold">
              Hand the account over
            </h2>
            <p className="mt-1 text-pretty text-sm text-muted-foreground">
              Make another member the owner. You stay, as an admin.
            </p>
          </div>
          <TransferOwnership
            accountId={account.id}
            accountName={account.name}
            candidates={members.filter((member) => member.userId !== data.user.id)}
          />
        </section>
      ) : null}

      {canLeave(role) ? (
        <section aria-labelledby="leave-heading" className="space-y-4">
          <div>
            <h2 id="leave-heading" className="text-lg font-semibold">
              Leave this account
            </h2>
            <p className="mt-1 text-pretty text-sm text-muted-foreground">
              Your sign-in and your other accounts are not affected.
            </p>
          </div>
          <LeaveAccount accountId={account.id} accountName={account.name} />
        </section>
      ) : null}
    </div>
  )
}

export default function MembersPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Members />
    </Suspense>
  )
}
