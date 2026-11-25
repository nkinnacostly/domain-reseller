'use client'

import { BulkAddSelected } from '@/features/search/components/bulk-add-selected'

/** The add button on a cart link's page: the bulk add, which checks each name again (FR-S6). */
export function CartLinkAdd({ domains }: { domains: readonly string[] }) {
  return <BulkAddSelected domains={domains} onAdded={() => {}} />
}
