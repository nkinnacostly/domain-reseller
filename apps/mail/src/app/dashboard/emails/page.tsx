import type { Metadata } from 'next'
import { ComingSoon } from '@/features/accounts/components/coming-soon'

export const metadata: Metadata = { title: 'Emails' }

/** MAIL-SPEC §10, Emails: a placeholder until its package builds it (N9b). */
export default function EmailsPage() {
  return (
    <ComingSoon
      title="Emails"
      will="The email log will be here: every email this account sends, searchable by id, exact recipient, subject, tag, status and date, each with its events — and a page per email with its timeline, its recipients, the headers we set and any bounce reason in plain words."
      arrives="before launch"
    />
  )
}
