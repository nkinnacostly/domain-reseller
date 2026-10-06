import type { Metadata } from 'next'
import { ComingSoon } from '@/features/accounts/components/coming-soon'

export const metadata: Metadata = { title: 'Suppressions' }

/** MAIL-SPEC §10, Suppressions: a placeholder until its package builds it (N9b). */
export default function SuppressionsPage() {
  return (
    <ComingSoon
      title="Suppressions"
      will="The addresses this account will not send to will be listed here, with why and when each was added, and a way to remove one, with a warning."
      arrives="before launch"
    />
  )
}
