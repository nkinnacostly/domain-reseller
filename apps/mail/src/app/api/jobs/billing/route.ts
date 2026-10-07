import { handleBillingJobs } from '@/features/billing/server/jobs'

/**
 * POST /api/jobs/billing — the hourly look for duplicate Flutterwave
 * subscriptions, asked for by pg_cron (MAIL-SPEC §8; migration 56). Bearer
 * token from Supabase Vault, checked in SQL.
 */
export function POST(request: Request) {
  return handleBillingJobs(request)
}

/** A run looks at up to 100 accounts, three at a time, and stops starting new ones at 45 s. */
export const maxDuration = 60
