'use client'

import { BulkAddSelected } from '@/features/search/components/bulk-add-selected'

/**
 * The add button on a cart link's page: the bulk add, which checks each name
 * again (FR-S6). The lines are marked as coming from an assistant's link, so
 * the AI page can count what assistants sold (AI phase 4).
 */
export function CartLinkAdd({ domains }: { domains: readonly string[] }) {
  return <BulkAddSelected domains={domains} onAdded={() => {}} addedVia="assistant_link" />
}
