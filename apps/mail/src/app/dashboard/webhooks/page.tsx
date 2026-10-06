import type { Metadata } from 'next'
import { ComingSoon } from '@/features/accounts/components/coming-soon'

export const metadata: Metadata = { title: 'Webhooks' }

/** MAIL-SPEC §10, Webhooks: a placeholder until its package builds it (N9b). */
export default function WebhooksPage() {
  return (
    <ComingSoon
      title="Webhooks"
      will="The endpoints that receive this account’s email events will be here, with the events each wants, its signing secret (revealed once) and its recent deliveries and their answers, ready to resend."
      arrives="before launch"
    />
  )
}
