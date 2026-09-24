import { describeLastSeen, formatSessionDate } from '../lib/sessions'
import { getSessions } from '../queries/sessions'
import { SessionsPanel } from './sessions-panel'

/**
 * The account's signed-in devices (PRD FR-A5), read as the user and put into
 * words here, so the browser gets text rather than timestamps to format.
 */
export async function SessionsSection() {
  const sessions = await getSessions()
  const now = new Date()
  return (
    <SessionsPanel
      sessions={
        sessions?.map((session) => ({
          id: session.id,
          device: session.device,
          ip: session.ip,
          signedIn: formatSessionDate(session.signedInAt),
          lastSeen: describeLastSeen(session.lastActiveAt, now),
          isCurrent: session.isCurrent,
        })) ?? null
      }
    />
  )
}

export function SessionsSkeleton() {
  return (
    <div aria-hidden="true" className="animate-pulse space-y-3">
      <div className="h-40 rounded-2xl bg-muted" />
      <div className="h-11 w-64 max-w-full rounded-full bg-muted" />
    </div>
  )
}
