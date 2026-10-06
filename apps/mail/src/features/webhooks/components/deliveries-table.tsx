import { StatusPill } from '@/components/common/status-pill'
import { DELIVERY_STATUS, describeAnswer, describeReason, EVENT_WORDS } from '../lib/words'
import type { Delivery, Webhook } from '../queries/webhooks'
import { ResendButton } from './resend-button'

const when = new Intl.DateTimeFormat('en-NG', {
  dateStyle: 'medium',
  timeStyle: 'medium',
  timeZone: 'Africa/Lagos',
})

const hostOf = (url: string | undefined) => {
  if (!url) return 'A deleted endpoint'
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * Recent deliveries (MAIL-SPEC §10 Webhooks): each message to each endpoint,
 * its state, what the endpoint answered last, every attempt, the payload we
 * sent — and "Resend" for a finished one to an endpoint that is on.
 */
export function DeliveriesTable({
  accountId,
  deliveries,
  webhooks,
  canManage,
}: {
  accountId: string
  deliveries: Delivery[]
  webhooks: Webhook[]
  canManage: boolean
}) {
  const byId = new Map(webhooks.map((w) => [w.id, w]))
  return (
    <div className="relative overflow-x-auto rounded-3xl border border-border bg-card">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">
          Recent webhook deliveries, newest first, in Lagos time
        </caption>
        <thead className="border-b border-border text-muted-foreground">
          <tr>
            <th scope="col" className="px-5 py-3 font-medium">
              Event
            </th>
            <th scope="col" className="px-5 py-3 font-medium">
              Endpoint
            </th>
            <th scope="col" className="px-5 py-3 font-medium">
              State
            </th>
            <th scope="col" className="px-5 py-3 font-medium">
              Last answer
            </th>
            <th scope="col" className="px-5 py-3 font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {deliveries.map((delivery) => {
            const webhook = byId.get(delivery.webhookId)
            const state = DELIVERY_STATUS[delivery.status]
            const reason = describeReason(delivery.statusReason)
            const at = when.format(new Date(delivery.createdAt))
            const finished = delivery.status === 'delivered' || delivery.status === 'failed'
            return (
              <tr key={delivery.id} data-delivery={delivery.messageId} className="align-top">
                <td className="px-5 py-3">
                  <p className="font-medium">{EVENT_WORDS[delivery.eventType].label}</p>
                  <p className="tabular-nums text-xs text-muted-foreground">{at}</p>
                  {delivery.resendOf ? (
                    <p className="text-xs text-muted-foreground">Resent by hand</p>
                  ) : null}
                  <details className="mt-1 text-xs">
                    <summary className="cursor-pointer rounded-sm py-1 font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                      Payload
                    </summary>
                    <p className="mt-1 text-muted-foreground">
                      <span className="font-mono">webhook-id: {delivery.messageId}</span>
                    </p>
                    <pre className="mt-1 max-w-[28rem] overflow-x-auto rounded-xl bg-muted p-3 font-mono text-xs">
                      {JSON.stringify(delivery.payload, null, 2)}
                    </pre>
                  </details>
                </td>
                <td className="max-w-[14rem] break-all px-5 py-3 font-mono text-xs">
                  {hostOf(webhook?.url)}
                </td>
                <td className="px-5 py-3">
                  <StatusPill tone={state.tone}>{state.label}</StatusPill>
                  {reason ? <p className="mt-1 text-xs text-muted-foreground">{reason}</p> : null}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {delivery.attempts === 1 ? '1 attempt' : `${delivery.attempts} attempts`}
                  </p>
                </td>
                <td className="px-5 py-3">
                  <p>{describeAnswer(delivery)}</p>
                  {delivery.lastResponse ? (
                    <p className="mt-1 max-w-[16rem] break-words font-mono text-xs text-muted-foreground">
                      {delivery.lastResponse}
                    </p>
                  ) : null}
                  {delivery.history.length > 1 ? (
                    <details className="mt-1 text-xs">
                      <summary className="cursor-pointer rounded-sm py-1 font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                        Every attempt
                      </summary>
                      <ol className="mt-1 space-y-0.5 text-muted-foreground">
                        {delivery.history.map((entry) => (
                          <li key={entry.at} className="tabular-nums">
                            {when.format(new Date(entry.at))}:{' '}
                            {describeAnswer({
                              lastStatusCode: entry.status,
                              lastError: entry.error,
                              lastDurationMs: entry.ms,
                              attempts: 1,
                            })}
                          </li>
                        ))}
                      </ol>
                    </details>
                  ) : null}
                </td>
                <td className="px-5 py-3">
                  {canManage && finished && webhook?.status === 'enabled' ? (
                    <ResendButton
                      accountId={accountId}
                      deliveryId={delivery.id}
                      label={`the ${EVENT_WORDS[delivery.eventType].label} event of ${at}`}
                    />
                  ) : null}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
