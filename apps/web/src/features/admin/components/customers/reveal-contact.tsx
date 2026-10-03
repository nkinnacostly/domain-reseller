'use client'

import { EyeOff } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { QUIET_BUTTON } from '@/components/common/action-parts'
import { PANEL_HEADING } from '@/components/layout/panel'
import { revealCustomer } from '@/features/admin/actions/customers'
import { ConfirmAction } from '@/features/admin/components/confirm-action'
import { DlGrid } from '@/features/admin/components/dl-grid'
import {
  CONTACT_LABEL,
  NOT_GIVEN,
  REVEAL_BODY,
  REVEAL_DONE,
  REVEAL_HEADING,
  REVEAL_HIDE,
  REVEAL_NOTE,
  REVEAL_ROLE,
  REVEAL_SHOWN_NOTE,
  REVEAL_TITLE,
  REVEAL_TRIGGER,
  REVEAL_UNREADABLE,
} from '@/features/admin/lib/customers-copy'
import type { CustomerContact } from '@/features/admin/lib/customers-data'
import { type AdminResult, adminErrorWords, adminOutcome } from '@/features/admin/lib/errors'
import { adminHref } from '@/features/admin/lib/href'

/**
 * "Show contact details" (§5.2 B8): an audited, rate-limited reveal through
 * `admin_reveal_customer`, asked for in a dialog with an optional reason.
 * The details live in this component's state only — never a URL, a log or
 * storage — and are cleared when the page is left: Next keeps a left page in
 * the DOM, so the cleanup forgets them as it hides (D4, N13).
 */
export function RevealContact({ userId, canReveal }: { userId: string; canReveal: boolean }) {
  return (
    <section aria-labelledby="customer-contact-heading" className="space-y-3">
      {canReveal ? (
        <Reveal userId={userId} />
      ) : (
        <>
          <h2 id="customer-contact-heading" className={PANEL_HEADING}>
            {REVEAL_HEADING}
          </h2>
          <p className="text-sm text-muted-foreground">{REVEAL_ROLE}</p>
        </>
      )}
    </section>
  )
}

const shown = (value: string | null) => (value?.trim() ? value : NOT_GIVEN)

function Reveal({ userId }: { userId: string }) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  const [contact, setContact] = useState<CustomerContact | null>(null)
  // Whether focus should move to the heading: after the dialog unmounts, or
  // after Hide removes the button that had it.
  const [moved, setMoved] = useState(false)

  // Hidden or left: forget the details (the transfer code's rule, SEC-12).
  useEffect(
    () => () => {
      setContact(null)
      setMoved(false)
    },
    [],
  )

  useEffect(() => {
    if (moved) headingRef.current?.focus()
  }, [moved])

  async function run(extra: { reason?: string; requestKey: string }): Promise<AdminResult> {
    const outcome = adminOutcome(
      await revealCustomer({ userId, reason: extra.reason, requestKey: extra.requestKey }),
    )
    if (!outcome.ok) return outcome
    if (!outcome.data) {
      // A replayed key, or an answer that did not read: no details came, so
      // the dialog takes a new key and the next ask is a new, recorded view.
      return {
        ok: false,
        code: outcome.replayed ? 'REPLAYED' : 'UNREADABLE',
        message: outcome.replayed ? adminErrorWords('REPLAYED') : REVEAL_UNREADABLE,
      }
    }
    setContact(outcome.data)
    setMoved(true)
    // The dialog needs only that it went through; the details stay here.
    return { ok: true, auditId: outcome.auditId }
  }

  return (
    <>
      <h2
        id="customer-contact-heading"
        ref={headingRef}
        tabIndex={-1}
        className={`${PANEL_HEADING} rounded outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`}
      >
        {REVEAL_HEADING}
      </h2>
      {contact ? (
        <div className="space-y-4" data-revealed="">
          <DlGrid
            items={[
              { label: CONTACT_LABEL.email, value: shown(contact.email) },
              { label: CONTACT_LABEL.fullName, value: shown(contact.fullName) },
              { label: CONTACT_LABEL.phone, value: shown(contact.phone) },
              { label: CONTACT_LABEL.businessName, value: shown(contact.businessName) },
            ]}
          />
          <p className="text-xs text-muted-foreground">{REVEAL_SHOWN_NOTE}</p>
          <button
            type="button"
            onClick={() => {
              setContact(null)
              setMoved(false)
              // Focus the heading, not the body, once the button is gone.
              requestAnimationFrame(() => headingRef.current?.focus())
            }}
            className={QUIET_BUTTON}
          >
            <EyeOff className="size-4" aria-hidden="true" />
            {REVEAL_HIDE}
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{REVEAL_NOTE}</p>
          <ConfirmAction
            trigger={REVEAL_TRIGGER}
            title={REVEAL_TITLE}
            body={REVEAL_BODY}
            confirmLabel={REVEAL_TRIGGER}
            reason="optional"
            returnTo={adminHref.customer(userId)}
            successMessage={REVEAL_DONE}
            run={run}
          />
        </div>
      )}
    </>
  )
}
