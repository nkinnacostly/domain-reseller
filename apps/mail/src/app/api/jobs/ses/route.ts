import { handleSesJobs } from '@/features/tenants/api/jobs-route'

/**
 * POST /api/jobs/ses — SES provisioning, domain checks and the sandbox sender,
 * asked for by pg_cron every five minutes and by pg_net when an account is
 * made (MAIL-SPEC §4.1, §5; migration 47). Bearer token from Supabase Vault.
 */
export function POST(request: Request) {
  return handleSesJobs(request)
}

/** One run takes a few seconds per account or domain; the run itself stops claiming at 25. */
export const maxDuration = 60
