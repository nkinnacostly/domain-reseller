import Link from 'next/link'
import { inputClass } from '@/components/common/form-parts'
import { FOCUS } from '@/components/layout/panel'
import { FilterChips } from '@/features/admin/components/table/filter-chips'
import { OUTCOME_CHIP, PREFIX_LABEL, SIDE_LABEL, WHO_LABEL } from '@/features/admin/lib/audit-copy'
import {
  AUDIT_OUTCOMES,
  AUDIT_PATH,
  AUDIT_PREFIXES,
  AUDIT_SIDES,
  AUDIT_SPEC,
  AUDIT_WHO,
  type AuditParams,
  auditHref,
  toggleOutcome,
} from '@/features/admin/lib/audit-params'
import { cn } from '@/lib/utils'

/**
 * The log's filters (docs/ADMIN-SPEC.md §5.2 B14), all in the URL: the action
 * family, the outcome, the side, who acted, then an admin's label and the
 * days as a GET form. A label is never an email: the field's pattern refuses
 * one before it can reach an address (N13).
 */

const SHOW_BUTTON = cn(
  'inline-flex h-11 items-center justify-center gap-2 rounded-full border border-border bg-background px-5 text-sm font-medium text-foreground transition hover:bg-muted active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-70',
  FOCUS,
)

const TEXT_LINK = cn(
  'inline-flex min-h-11 items-center rounded px-1 text-sm text-foreground underline underline-offset-4 hover:no-underline active:opacity-80',
  FOCUS,
)

export function AuditFilters({ params, testOnly }: { params: AuditParams; testOnly: boolean }) {
  return (
    <div className="space-y-3">
      <FilterChips
        label="Action"
        chips={AUDIT_PREFIXES.map((prefix) => ({ value: prefix, label: PREFIX_LABEL[prefix] }))}
        selected={params.prefix ? [params.prefix] : []}
        href={(prefix) =>
          auditHref(params, {
            prefix: params.prefix === prefix ? null : (prefix as AuditParams['prefix']),
          })
        }
        allHref={auditHref(params, { prefix: null })}
      />
      <FilterChips
        label="Result"
        chips={AUDIT_OUTCOMES.map((outcome) => ({ value: outcome, label: OUTCOME_CHIP[outcome] }))}
        selected={params.outcome}
        href={(outcome) => toggleOutcome(params, outcome as AuditParams['outcome'][number])}
        allHref={auditHref(params, { outcome: [] })}
      />
      <FilterChips
        label="Side"
        chips={AUDIT_SIDES.map((side) => ({ value: side, label: SIDE_LABEL[side] }))}
        selected={params.side ? [params.side] : []}
        href={(side) =>
          auditHref(params, {
            side: params.side === side ? null : (side as AuditParams['side']),
          })
        }
        allHref={auditHref(params, { side: null })}
      />
      {testOnly ? null : (
        <FilterChips
          label="Who"
          chips={AUDIT_WHO.map((who) => ({ value: who, label: WHO_LABEL[who] }))}
          selected={params.who ? [params.who] : []}
          href={(who) =>
            auditHref(params, { who: params.who === who ? null : (who as AuditParams['who']) })
          }
          allHref={auditHref(params, { who: null })}
        />
      )}
      <AdminAndDates params={params} />
      <OneOnly params={params} />
    </div>
  )
}

/** An admin's label and the Lagos days, as a GET form; the other filters ride along. */
function AdminAndDates({ params }: { params: AuditParams }) {
  const keep: Record<string, string | null> = {
    action: params.prefix,
    outcome: params.outcome.length > 0 ? params.outcome.join(',') : null,
    side: params.side,
    who: params.who,
    target: params.target,
    dir: params.list.dir === AUDIT_SPEC.defaultDir ? null : params.list.dir,
    per: params.list.per === AUDIT_SPEC.defaultPer ? null : String(params.list.per),
  }
  const narrowed = params.admin !== null || params.list.from !== null || params.list.to !== null
  return (
    <form
      action={AUDIT_PATH}
      method="get"
      aria-label="Admin and dates"
      className="flex flex-wrap items-end gap-3"
    >
      {Object.entries(keep).map(([name, value]) =>
        value ? <input key={name} type="hidden" name={name} value={value} /> : null,
      )}
      <div className="min-w-0">
        <label htmlFor="audit-admin" className="block text-sm text-muted-foreground">
          Admin label
        </label>
        <input
          id="audit-admin"
          name="admin"
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={31}
          pattern="[A-Za-z][A-Za-z0-9_\-]{1,30}"
          title="An admin's label, as the Admin column shows it — not an email."
          defaultValue={params.admin ?? undefined}
          className={cn(inputClass, 'mt-1 w-44')}
        />
      </div>
      <div className="min-w-0">
        <label htmlFor="audit-from" className="block text-sm text-muted-foreground">
          From (WAT)
        </label>
        <input
          id="audit-from"
          name="from"
          type="date"
          defaultValue={params.list.from ?? undefined}
          className={cn(inputClass, 'mt-1 w-44')}
        />
      </div>
      <div className="min-w-0">
        <label htmlFor="audit-to" className="block text-sm text-muted-foreground">
          to
        </label>
        <input
          id="audit-to"
          name="to"
          type="date"
          defaultValue={params.list.to ?? undefined}
          className={cn(inputClass, 'mt-1 w-44')}
        />
      </div>
      <button type="submit" className={SHOW_BUTTON}>
        Show
      </button>
      {narrowed ? (
        <Link href={auditHref(params, { admin: null, from: null, to: null })} className={TEXT_LINK}>
          Any admin, any date
        </Link>
      ) : null}
    </form>
  )
}

/** One entry (`?id=`), or one record's entries (`?target=`), said so with a way back. */
function OneOnly({ params }: { params: AuditParams }) {
  if (params.id !== null) {
    return (
      <p className="text-sm text-muted-foreground">
        Entry #{params.id} only.{' '}
        <Link href={auditHref(params, { id: null })} className={TEXT_LINK}>
          Show every entry
        </Link>
      </p>
    )
  }
  if (params.target !== null) {
    return (
      <p className="text-sm text-muted-foreground">
        Entries about one record only.{' '}
        <Link href={auditHref(params, { target: null })} className={TEXT_LINK}>
          Show every record
        </Link>
      </p>
    )
  }
  return null
}
