/**
 * Nameserver validation before a change (PRD FR-D4). Syntax is checked by the
 * shared schema; this decides what the DNS lookups mean.
 *
 * - a nameserver that does not exist blocks the change: it is a typo, and
 *   delegating to it takes the site down;
 * - one that exists but did not answer just now only warns: it may be busy;
 * - a nameserver inside the domain itself needs glue records (FR-N3), which
 *   we cannot set yet, so it blocks with that reason.
 */
export type HostLookup = 'resolves' | 'nxdomain' | 'no-answer'

export type NameserverVerdict = { blocking: string[]; warnings: string[] }

export function judgeNameservers(
  domain: string,
  lookups: ReadonlyMap<string, HostLookup>,
): NameserverVerdict {
  const blocking: string[] = []
  const warnings: string[] = []
  const apex = domain.toLowerCase()

  for (const [host, lookup] of lookups) {
    if (host === apex || host.endsWith(`.${apex}`)) {
      blocking.push(
        `${host} is inside ${domain} itself, so it needs glue records. That is not available yet — use your host's nameservers.`,
      )
    } else if (lookup === 'nxdomain') {
      blocking.push(`${host} doesn't exist — check the spelling.`)
    } else if (lookup === 'no-answer') {
      warnings.push(
        `${host} didn't answer just now. It may be busy; double-check it with your host.`,
      )
    }
  }
  return { blocking, warnings }
}

/** The same set, whatever the order or case — so "no change" is recognised. */
export function sameNameservers(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (!a || !b || a.length !== b.length) return false
  const normalise = (list: readonly string[]) =>
    [...list]
      .map((ns) => ns.toLowerCase())
      .sort()
      .join(',')
  return normalise(a) === normalise(b)
}
