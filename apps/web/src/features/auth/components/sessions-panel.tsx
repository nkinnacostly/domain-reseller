'use client'

import { LogOut, Monitor, Smartphone } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useAction } from 'next-safe-action/hooks'
import { useState } from 'react'
import { FormMessage, onSubmitWith, SubmitButton } from '@/components/common/form-parts'
import { revokeSession, signOutOtherSessions } from '../actions/sessions'

/** A session as the panel shows it; dates already in words, on the server. */
export type SessionView = {
  id: string
  device: string
  ip: string | null
  signedIn: string
  lastSeen: string
  isCurrent: boolean
}

const PHONE = /\b(iOS|iPadOS|Android)\b/

/**
 * Where this account is signed in (PRD FR-A5), with a way to sign any other
 * device out, or all of them. Signing out ends the session at once, but an
 * access token already issued stays valid until it expires — the copy says
 * so rather than promise an instant cut-off.
 */
export function SessionsPanel({ sessions }: { sessions: SessionView[] | null }) {
  const router = useRouter()
  const [notice, setNotice] = useState<string | null>(null)
  const others = sessions?.filter((session) => !session.isCurrent) ?? []

  const signOutAll = useAction(signOutOtherSessions, {
    onSuccess: ({ data }) => {
      if (data && 'ok' in data) {
        setNotice('Every other device has been signed out.')
        router.refresh()
      }
    },
  })
  const allError =
    signOutAll.result.data && 'error' in signOutAll.result.data
      ? signOutAll.result.data.error
      : signOutAll.result.serverError

  return (
    <div className="space-y-4">
      {notice ? <FormMessage tone="success">{notice}</FormMessage> : null}

      {sessions === null ? (
        <FormMessage tone="error">
          We couldn't load your devices just now. Refresh the page to try again — you can still sign
          out every other device below.
        </FormMessage>
      ) : (
        <ul
          aria-label="Signed-in devices"
          className="divide-y divide-border rounded-2xl border border-border"
        >
          {sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              onSignedOut={(device) => {
                setNotice(`${device} has been signed out.`)
                router.refresh()
              }}
            />
          ))}
        </ul>
      )}

      {sessions !== null && others.length === 0 ? (
        <p className="text-sm text-muted-foreground">This is the only device signed in.</p>
      ) : (
        <form onSubmit={onSubmitWith(() => signOutAll.execute())} className="space-y-3">
          {allError ? <FormMessage tone="error">{allError}</FormMessage> : null}
          <SubmitButton
            pending={signOutAll.isPending}
            pendingLabel="Signing out…"
            variant="secondary"
            className="sm:w-auto"
          >
            <LogOut className="size-4" aria-hidden="true" />
            Sign out of all other devices
          </SubmitButton>
        </form>
      )}

      <p className="text-pretty text-xs/5 text-muted-foreground">
        A device you sign out can keep working for up to an hour, until its current sign-in token
        expires. "Last seen" is when a device last renewed its sign-in, which it does about once an
        hour while in use. If you don't recognise a device, change your password too.
      </p>
    </div>
  )
}

function SessionRow({
  session,
  onSignedOut,
}: {
  session: SessionView
  onSignedOut: (device: string) => void
}) {
  const revoke = useAction(revokeSession, {
    onSuccess: ({ data }) => {
      if (data && 'ok' in data) onSignedOut(session.device)
    },
  })
  const error =
    revoke.result.data && 'error' in revoke.result.data
      ? revoke.result.data.error
      : revoke.result.serverError
  const Icon = PHONE.test(session.device) ? Smartphone : Monitor

  return (
    <li
      data-session={session.isCurrent ? 'current' : 'other'}
      className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:gap-4"
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-muted text-foreground">
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 font-medium text-foreground">
            {session.device}
            {session.isCurrent ? (
              <span className="rounded-full bg-accent/10 px-2.5 py-0.5 text-xs font-medium text-foreground">
                This device
              </span>
            ) : null}
          </p>
          <p className="mt-0.5 text-pretty text-sm text-muted-foreground">
            {[
              session.ip ? `IP ${session.ip}` : null,
              `Signed in ${session.signedIn}`,
              session.isCurrent ? 'Active now' : `Last seen ${session.lastSeen}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {error ? (
            <FormMessage tone="error" className="mt-2">
              {error}
            </FormMessage>
          ) : null}
        </div>
      </div>

      {session.isCurrent ? null : (
        <form
          onSubmit={onSubmitWith(() => revoke.execute({ sessionId: session.id }))}
          className="shrink-0"
        >
          <SubmitButton
            pending={revoke.isPending}
            pendingLabel="Signing out…"
            variant="secondary"
            className="sm:w-auto"
          >
            Sign out <span className="sr-only">{session.device}</span>
          </SubmitButton>
        </form>
      )}
    </li>
  )
}
