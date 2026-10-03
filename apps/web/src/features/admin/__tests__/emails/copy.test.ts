import { NOTICE_TEMPLATES } from '@dr/shared/email'
import { describe, expect, it } from 'vitest'
import {
  COMPLIANCE_NOTE,
  EMAIL_KIND_LABEL,
  emailCount,
  kindLabel,
  NOT_SENT_AGAIN,
  NOTICE_WINDOW,
  noticeCount,
  noticeTypeLabel,
  noticeWindow,
  OUTBOX_STATUS_LABEL,
  SEND_AGAIN,
  STATUS_HINT,
  skipReasonText,
  tries,
} from '@/features/admin/lib/emails-copy'
import { NOTICE_TYPES, OUTBOX_STATUSES } from '@/features/admin/lib/emails-params'
import { ADMIN_ERROR_WORDS } from '@/features/admin/lib/errors'

/**
 * The emails page's words (ADMIN-SPEC §5.2 B11). They describe what the
 * outbox does and no more (N9b): the gateway sends, a notice is a record
 * nothing here changes, and "Send again" is never promised for a bounce or
 * a spam report.
 */

describe('what an email is', () => {
  it('names every kind @dr/shared/email has a template for', () => {
    for (const kind of Object.keys(NOTICE_TEMPLATES)) {
      expect(EMAIL_KIND_LABEL[kind], kind).toBeTruthy()
    }
    expect(kindLabel('order_receipt')).toBe('Order receipt')
    expect(kindLabel('expiry_notice')).toBe('Expiry notice (ERRP)')
    // A kind added later still shows, as itself.
    expect(kindLabel('brand_new_kind')).toBe('brand new kind')
    expect(kindLabel(null)).toBe('—')
  })

  it('words every status chip, and explains the ones that are not a plain status', () => {
    for (const status of OUTBOX_STATUSES) expect(OUTBOX_STATUS_LABEL[status], status).toBeTruthy()
    expect(OUTBOX_STATUS_LABEL.pending).toBe('Waiting')
    expect(OUTBOX_STATUS_LABEL.unconfirmed).toBe('No delivery report')
    expect(OUTBOX_STATUS_LABEL.complained).toBe('Reported as spam')
    expect(STATUS_HINT.unconfirmed).toBe(
      'Security and compliance emails sent over 24 hours ago with no delivery report. Not counted as delivered.',
    )
  })

  it('says why an email was skipped, never with an address', () => {
    expect(skipReasonText('reserved_address')).toBe(
      'A reserved address (example.com, .test …): never sent to',
    )
    expect(skipReasonText('no_template')).toBe('no template')
    expect(skipReasonText(null)).toBeNull()
  })

  it('counts in words', () => {
    expect(emailCount(1)).toBe('1 email')
    expect(emailCount(1200)).toBe('1,200 emails')
    expect(noticeCount(0)).toBe('0 notices')
    expect(tries(1)).toBe('1 try')
    expect(tries(3)).toBe('3 tries')
  })
})

describe('compliance notices', () => {
  it('words each notice and its window as the view does', () => {
    for (const type of NOTICE_TYPES) expect(NOTICE_WINDOW[type], type).toBeTruthy()
    expect(noticeTypeLabel('errp_pre_35')).toBe('One month before expiry')
    expect(noticeWindow('errp_pre_7')).toBe('4–10 days before expiry')
    expect(noticeWindow('errp_post')).toBe('within 5 days after expiry')
    expect(noticeTypeLabel('errp_other')).toBe('errp other')
    expect(noticeWindow(null)).toBeNull()
  })

  it('says the tab only reads compliance records', () => {
    expect(COMPLIANCE_NOTE).toBe(
      'Expiry notices (ERRP) are compliance records, kept for three years exactly as they were sent. Nothing on this page changes, deletes or sends them. A bounced notice means the registrant must be reached another way.',
    )
  })
})

describe('Send again', () => {
  it('says what happens, and that the gateway sends it — not the dashboard', () => {
    expect(SEND_AGAIN).toEqual({
      trigger: 'Send again',
      title: 'Send this email again?',
      body: "It goes back in the queue as Waiting, with its attempts reset, and the gateway's email sender takes it on its next run. If whatever stopped it is still wrong, it fails again and shows here as Failed.",
      confirmLabel: 'Send again',
      cancelLabel: 'Not now',
      done: 'Queued to send again. It shows as Waiting until the sender takes it.',
    })
  })

  it('agrees with the wrapper on why a failed email is not sent again', () => {
    expect(NOT_SENT_AGAIN.bounced).toBe('Bounced: never sent again.')
    expect(NOT_SENT_AGAIN.complained).toBe('Reported as spam: never sent again.')
    // The wrapper's refusals have words of their own (lib/errors.ts).
    expect(ADMIN_ERROR_WORDS.BOUNCED).toBe('This email bounced. It is not sent again.')
    expect(ADMIN_ERROR_WORDS.COMPLAINED).toBe(
      'The recipient reported this email as spam. It is not sent again.',
    )
    expect(ADMIN_ERROR_WORDS.NOT_FAILED).toBe('Only a failed email can be sent again.')
  })
})
