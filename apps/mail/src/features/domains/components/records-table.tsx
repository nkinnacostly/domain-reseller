import { StatusPill } from '@/components/common/status-pill'
import { Spinner } from '@/components/ui/spinner'
import type { RecordCheck } from '../lib/dns-check'
import { type DnsRecord, hostLabel } from '../lib/records'
import { RECORD_STATE_LABEL, RECORD_STATE_WORDS } from '../lib/status'
import { CopyButton } from './copy-button'

/**
 * The records to add (MAIL-SPEC §5), each with copy buttons for its name and
 * value, and what public DNS says of it right now. Cards at every width, so a
 * long DKIM name wraps rather than scrolls the page (S5, S6).
 */

export type LiveState = RecordCheck[] | 'checking' | 'failed'

const TITLE: Record<DnsRecord['purpose'], string> = {
  dkim: 'DKIM',
  mail_from_mx: 'MAIL FROM: MX',
  mail_from_spf: 'MAIL FROM: SPF',
  dmarc: 'DMARC (suggested)',
}

function why(record: DnsRecord, zone: string): string {
  switch (record.purpose) {
    case 'dkim':
      return 'Signs your email, and proves to Amazon SES that the domain is yours. All three are needed to verify it.'
    case 'mail_from_mx':
      return `Bounces and complaints come back to ${record.name}, your own subdomain. Until it is in DNS, Amazon SES uses its own domain instead, so email still goes.`
    case 'mail_from_spf':
      return `Says Amazon SES may send for ${record.name}, so SPF passes for your domain, ${zone}.`
    case 'dmarc':
      return 'Tells mailboxes what to do with email that fails its checks; p=none only watches. A domain has one DMARC record: if it has one already, keep yours. To receive reports, add rua=mailto: and an address you read.'
  }
}

/** "DKIM record 2 of 3", "MAIL FROM: MX": how the page and the Cloudflare results name a record. */
export function recordTitle(record: DnsRecord, records: readonly DnsRecord[]): string {
  if (record.purpose !== 'dkim') return TITLE[record.purpose]
  const dkim = records.filter((r) => r.purpose === 'dkim')
  return `DKIM record ${dkim.indexOf(record) + 1} of ${dkim.length}`
}

const codeClass =
  'min-w-0 flex-1 rounded-lg bg-muted px-2.5 py-2 font-mono text-[0.8125rem]/5 break-all text-foreground'

function Live({ record, live }: { record: DnsRecord; live: LiveState }) {
  if (live === 'checking') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Spinner className="size-3.5" aria-hidden="true" />
        Checking public DNS…
      </span>
    )
  }
  if (live === 'failed') return <StatusPill tone="neutral">Could not check</StatusPill>
  const check = live.find((item) => item.id === record.id)
  if (!check) return null
  const { label, tone } = RECORD_STATE_LABEL[check.state]
  return <StatusPill tone={tone}>{label}</StatusPill>
}

export function RecordsTable({
  records,
  zone,
  live,
}: {
  records: DnsRecord[]
  zone: string
  live: LiveState
}) {
  return (
    <ol className="space-y-3" aria-label="DNS records">
      {records.map((record) => {
        const host = hostLabel(record.name, zone)
        const check = Array.isArray(live) ? live.find((item) => item.id === record.id) : undefined
        const name = recordTitle(record, records)
        return (
          <li
            key={record.id}
            data-record={record.id}
            className="rounded-2xl border border-border bg-card p-4 sm:p-5"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <h3 className="font-medium">
                {name}{' '}
                <span className="ml-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                  {record.type}
                </span>
              </h3>
              <Live record={record} live={live} />
            </div>
            <p className="mt-1.5 text-pretty text-sm/6 text-muted-foreground">
              {why(record, zone)}
            </p>
            <dl className="mt-3 grid gap-3 text-sm">
              <div>
                <dt className="font-medium">Name</dt>
                <dd className="mt-1 flex items-center gap-2">
                  <code className={codeClass}>{host}</code>
                  <CopyButton value={host} label={`Copy the name of ${name}`} />
                </dd>
                {host !== record.name ? (
                  <dd className="mt-1 text-xs/5 break-all text-muted-foreground">
                    In full: {record.name}
                  </dd>
                ) : null}
              </div>
              {record.priority !== undefined ? (
                <div>
                  <dt className="font-medium">Priority</dt>
                  <dd className="mt-1 font-mono">{record.priority}</dd>
                </div>
              ) : null}
              <div>
                <dt className="font-medium">{record.type === 'MX' ? 'Mail server' : 'Value'}</dt>
                <dd className="mt-1 flex items-center gap-2">
                  <code className={codeClass}>{record.value}</code>
                  <CopyButton value={record.value} label={`Copy the value of ${name}`} />
                </dd>
              </div>
            </dl>
            {check && check.state !== 'found' ? (
              <p className="mt-3 text-pretty text-xs/5 text-muted-foreground">
                {RECORD_STATE_WORDS[check.state]}
                {check.state === 'different' && check.seen.length > 0 ? (
                  <>
                    {' '}
                    Public DNS has:{' '}
                    <span className="font-mono break-all">{check.seen.join(', ')}</span>
                  </>
                ) : null}
              </p>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}
