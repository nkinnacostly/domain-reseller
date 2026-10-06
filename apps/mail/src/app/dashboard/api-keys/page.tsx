import type { Metadata } from 'next'
import { ComingSoon } from '@/features/accounts/components/coming-soon'

export const metadata: Metadata = { title: 'API keys' }

/** MAIL-SPEC §10, API keys: a placeholder until its package builds it (N9b). */
export default function ApiKeysPage() {
  return (
    <ComingSoon
      title="API keys"
      will="Keys for your app will be made here, each shown once, and listed with their name, permission, domain and last use, ready to revoke."
      arrives="before launch"
    />
  )
}
