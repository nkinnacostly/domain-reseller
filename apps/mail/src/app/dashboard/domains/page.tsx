import type { Metadata } from 'next'
import { ComingSoon } from '@/features/accounts/components/coming-soon'

export const metadata: Metadata = { title: 'Domains' }

/** MAIL-SPEC §10, Domains: a placeholder until its package builds it (N9b). */
export default function DomainsPage() {
  return (
    <ComingSoon
      title="Domains"
      will="The domains this account sends from will be here, each with its state, the DNS records to add — each with a copy button — and a live check of them in public DNS."
      arrives="before launch"
    />
  )
}
