import { type ApiError, apiError, type EnqueueInput } from '@dr/shared/mail'
import { type ContentRefusal, contentRefusal } from '@/features/safety/lib/content'

/**
 * MAIL-SPEC §7.6's content check (the safety package's `contentRefusal`),
 * asked of each email before enqueue_email or enqueue_batch — so a refused
 * email reserves nothing. The answer is `validation_error` (422) with the
 * rule's own words; nothing it read is quoted back or logged (N13).
 */

export type ContentProblem = { rule: ContentRefusal['rule']; index: number; error: ApiError }

/** The first email of `emails` the check refuses, or null. */
export function contentProblem(emails: readonly EnqueueInput[]): ContentProblem | null {
  for (const [index, { email, payload }] of emails.entries()) {
    const refused = contentRefusal({
      from: email.from,
      html: payload.html,
      text: payload.text,
      attachments: payload.attachments,
    })
    if (refused) {
      return { rule: refused.rule, index, error: apiError('validation_error', refused.message) }
    }
  }
  return null
}
