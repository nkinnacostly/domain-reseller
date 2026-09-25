export type OutgoingEmail = {
  to: string
  subject: string
  html: string
  text: string
  /** What kind of email this was, for the provider's delivery log: `[category, kind]`. */
  tags?: string[]
}

export type SendResult = { ok: true; messageId: string | null } | { ok: false; status: number }
