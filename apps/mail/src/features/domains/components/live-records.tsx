import type { DnsRecord } from '../lib/records'
import { dnsLookup } from '../queries/dns'
import { type LiveState, RecordsTable } from './records-table'

/**
 * The records with what public DNS says of each, asked now (never cached,
 * CLAUDE.md §15). Rendered inside Suspense: the records show at once, and
 * their state follows when the resolvers answer.
 */
export async function LiveRecords({ records, zone }: { records: DnsRecord[]; zone: string }) {
  let live: LiveState
  try {
    live = await dnsLookup()(records)
  } catch {
    live = 'failed'
  }
  return <RecordsTable records={records} zone={zone} live={live} />
}
