import { describeStatus, formatWhoisDate, type WhoisRecord } from '../lib/whois'

/**
 * The public facts of a registered domain (PRD FR-PUB2). Owner details are
 * never among them: the record type carries none, so none can be shown.
 */
export function WhoisRecordDetails({ record }: { record: WhoisRecord }) {
  const dates = [
    { label: 'Registered on', value: record.registeredAt },
    { label: 'Expires on', value: record.expiresAt },
    { label: 'Last moved registrar', value: record.lastTransferredAt },
  ].filter((row): row is { label: string; value: string } => row.value !== null)

  return (
    <dl className="grid gap-x-10 gap-y-6 sm:grid-cols-2">
      <div className="min-w-0">
        <dt className="text-sm text-muted-foreground">Registrar</dt>
        <dd className="mt-1 font-medium break-words text-foreground">
          {record.registrar ?? 'Not published by the registry'}
        </dd>
      </div>

      {dates.map((row) => (
        <div key={row.label} className="min-w-0">
          <dt className="text-sm text-muted-foreground">{row.label}</dt>
          <dd className="mt-1 font-medium text-foreground">{formatWhoisDate(row.value)}</dd>
        </div>
      ))}

      <div className="min-w-0 sm:col-span-2">
        <dt className="text-sm text-muted-foreground">Nameservers</dt>
        <dd className="mt-1">
          {record.nameservers.length > 0 ? (
            <ul aria-label="Nameservers" className="flex flex-wrap gap-2">
              {record.nameservers.map((ns) => (
                <li
                  key={ns}
                  className="max-w-full rounded-full bg-muted px-3 py-1 font-mono text-sm break-all text-foreground"
                >
                  {ns}
                </li>
              ))}
            </ul>
          ) : (
            <span className="font-medium text-foreground">
              None listed, so it does not lead anywhere yet
            </span>
          )}
        </dd>
      </div>

      <div className="min-w-0 sm:col-span-2">
        <dt className="text-sm text-muted-foreground">Status codes</dt>
        <dd className="mt-2">
          {record.statuses.length > 0 ? (
            <ul aria-label="Status codes" className="divide-y divide-border/70">
              {record.statuses.map((status) => {
                const meaning = describeStatus(status)
                return (
                  <li key={status} className="py-3 first:pt-0">
                    <p className="font-medium text-foreground">{status}</p>
                    {meaning ? (
                      <p className="mt-0.5 text-pretty text-sm/6 text-muted-foreground">
                        {meaning}
                      </p>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          ) : (
            <span className="font-medium text-foreground">None published</span>
          )}
        </dd>
      </div>

      <div className="min-w-0 sm:col-span-2">
        <dt className="text-sm text-muted-foreground">Owner</dt>
        <dd className="mt-1 max-w-2xl text-pretty text-sm/6 text-foreground">
          Not shown. Most registries now withhold owners&apos; names and contact details, and we
          never display them even when a registry does publish them.{' '}
          {record.registrar
            ? `To reach the owner, contact ${record.registrar}.`
            : 'To reach the owner, contact the registrar.'}
        </dd>
      </div>
    </dl>
  )
}
