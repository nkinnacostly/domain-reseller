import type { Metadata } from 'next'
import { ComingSoon } from '@/features/accounts/components/coming-soon'

export const metadata: Metadata = { title: 'Billing' }

/** MAIL-SPEC §10, Billing: a placeholder until its package builds it (N9b). */
export default function BillingPage() {
  return (
    <ComingSoon
      title="Billing"
      will="This account’s plan and period, its tax invoices, changing plan, and the card on file — its last four digits only — will be here."
      arrives="before launch"
    />
  )
}
