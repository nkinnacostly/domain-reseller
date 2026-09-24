import { ownNameservers } from '../lib/line-hosts'

/**
 * FR-C10 — on the order page, a domain given its own host at checkout shows
 * its nameservers; a domain that follows the order's shows nothing extra.
 */
export function LineNameservers({
  line,
  order,
}: {
  line: readonly string[] | null
  order: readonly string[] | null
}) {
  const own = ownNameservers(line, order)
  if (!own) return null
  return (
    <p className="mt-1 text-sm text-muted-foreground">
      Nameservers: <span className="font-mono text-xs break-all">{own.join(', ')}</span>
    </p>
  )
}
