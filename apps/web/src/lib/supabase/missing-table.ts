/**
 * Whether a read failed because the table is not there yet: PostgREST's
 * PGRST205, or Postgres's 42P01. A feature whose migration is not applied
 * reads as "nothing yet" through this, so the rest of the site keeps working
 * (and building) on a database a step behind the code (docs/DEPLOY.md).
 * Any other failure is still a failure.
 */
export function isMissingTable(error: { code?: string | undefined } | null | undefined): boolean {
  return error?.code === 'PGRST205' || error?.code === '42P01'
}
