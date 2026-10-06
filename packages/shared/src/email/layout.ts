/**
 * One layout for every email we send: the auth emails (web) and the
 * notification emails (gateway). A plain white card on a pale ground, the
 * brand mark and name, a heading, the content, one action, then the fine
 * print — and a plain-text twin carrying everything the HTML does.
 *
 * Email clients are the web of 2005: tables, inline styles, no stylesheet.
 * Everything we did not write — an address, a domain, a name — is escaped.
 */

export const EMAIL_BRAND = {
  name: 'MyDomainsHub',
  site: 'https://www.mydomainshub.com',
  /** Hosted with the site (public/brand); text follows it for clients that block images. */
  markUrl: 'https://www.mydomainshub.com/brand/mydomainshub-mark-96.png',
  /** Replies go to a person. */
  supportEmail: 'hello@mydomainshub.com',
  /** The authenticated sending subdomain (SPF, DKIM, DMARC). */
  noReplyEmail: 'no-reply@notify.mydomainshub.com',
  blue: '#155dfc',
} as const

export type EmailAction = { label: string; href: string } | { code: string }

export type EmailBlock =
  | { kind: 'text'; text: string }
  /** Label and value on one line each — a receipt's lines and totals. */
  | { kind: 'rows'; rows: { label: string; detail?: string; value: string; strong?: boolean }[] }
  /** A short list, such as nameservers. */
  | { kind: 'list'; items: string[] }
  /** Set apart from the text: a warning, or "this was a test payment". */
  | { kind: 'note'; text: string }

export type EmailContent = {
  /**
   * The name beside the mark at the top: the company's by default, or one of
   * its products' (MyDomainsHub Mail, docs/MAIL-SPEC.md M5), so an email reads
   * as coming from the product the person signed up to.
   */
  product?: string
  heading: string
  blocks: EmailBlock[]
  action?: EmailAction
  /** Small print under the action: why you got this, what to do if it was not you. */
  footer?: string[]
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

const INK = '#0f1f24'
const BODY = '#4a5a5f'
const SMALL = '#6b7174'
const RULE = '#e6eaea'

function blockHtml(block: EmailBlock): string {
  switch (block.kind) {
    case 'text':
      return `<tr><td style="padding-top:12px;font-size:15px;line-height:22px;color:${BODY}">${escapeHtml(block.text)}</td></tr>`
    case 'note':
      return `<tr><td style="padding-top:16px"><div style="background:#f4f6f6;border-radius:12px;padding:12px 16px;font-size:14px;line-height:20px;color:${INK}">${escapeHtml(block.text)}</div></td></tr>`
    case 'list':
      return `<tr><td style="padding-top:12px;font-size:15px;line-height:22px;color:${INK};font-family:Menlo,Consolas,monospace">${block.items.map(escapeHtml).join('<br>')}</td></tr>`
    case 'rows': {
      const rows = block.rows
        .map(
          (row) =>
            `<tr><td style="padding:8px 0;border-bottom:1px solid ${RULE};font-size:14px;line-height:20px;color:${INK}${row.strong ? ';font-weight:bold' : ''}">${escapeHtml(row.label)}${row.detail ? `<br><span style="color:${SMALL};font-size:13px">${escapeHtml(row.detail)}</span>` : ''}</td><td align="right" style="padding:8px 0 8px 16px;border-bottom:1px solid ${RULE};font-size:14px;line-height:20px;color:${INK};white-space:nowrap;vertical-align:top${row.strong ? ';font-weight:bold' : ''}">${escapeHtml(row.value)}</td></tr>`,
        )
        .join('')
      return `<tr><td style="padding-top:16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr>`
    }
  }
}

function blockText(block: EmailBlock): string {
  switch (block.kind) {
    case 'text':
    case 'note':
      return block.text
    case 'list':
      return block.items.map((item) => `  ${item}`).join('\n')
    case 'rows':
      return block.rows
        .map((row) => `${row.label}${row.detail ? ` (${row.detail})` : ''}: ${row.value}`)
        .join('\n')
  }
}

export function renderEmail(content: EmailContent): { html: string; text: string } {
  const name = content.product ?? EMAIL_BRAND.name
  const action = content.action
    ? 'code' in content.action
      ? `<tr><td style="padding-top:24px;font-size:28px;font-weight:bold;letter-spacing:6px">${escapeHtml(content.action.code)}</td></tr>`
      : `<tr><td style="padding-top:24px"><a href="${escapeHtml(content.action.href)}" style="display:inline-block;background:${EMAIL_BRAND.blue};color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 24px;border-radius:999px">${escapeHtml(content.action.label)}</a></td></tr>`
    : ''
  const footer = (content.footer ?? [])
    .map(
      (line) =>
        `<tr><td style="padding-top:16px;font-size:13px;line-height:20px;color:${SMALL}">${escapeHtml(line)}</td></tr>`,
    )
    .join('')

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:32px 16px;background:#f4f6f6;font-family:Arial,Helvetica,sans-serif;color:${INK}">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;padding:32px">
            <tr><td style="font-size:18px;font-weight:bold;color:#0b1e24"><img src="${EMAIL_BRAND.markUrl}" width="32" height="32" alt="" style="vertical-align:middle;border:0;border-radius:7px;margin-right:8px">${escapeHtml(name)}</td></tr>
            <tr><td style="padding-top:24px;font-size:22px;line-height:28px;font-weight:bold">${escapeHtml(content.heading)}</td></tr>
            ${content.blocks.map(blockHtml).join('\n            ')}
            ${action}
            ${footer}
            <tr><td style="padding-top:16px;font-size:13px;line-height:20px;color:${SMALL}">Questions? Reply to this email, or write to ${escapeHtml(EMAIL_BRAND.supportEmail)}.</td></tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`
  const actionText = content.action
    ? 'code' in content.action
      ? `Your code: ${content.action.code}`
      : `${content.action.label}: ${content.action.href}`
    : null
  const text = [
    name,
    '',
    content.heading,
    '',
    ...content.blocks.flatMap((block) => [blockText(block), '']),
    ...(actionText ? [actionText, ''] : []),
    ...(content.footer ?? []).flatMap((line) => [line, '']),
    `Questions? Reply to this email, or write to ${EMAIL_BRAND.supportEmail}.`,
  ].join('\n')
  return { html, text }
}

/**
 * Addresses that must never receive mail (RFC 2606 / 6761 names) — where
 * e2e accounts live. The database skips them when queueing (migration 31);
 * the sender checks again.
 */
export function isReservedAddress(email: string): boolean {
  const at = email.lastIndexOf('@')
  if (at < 1) return true
  const host = email.slice(at + 1).toLowerCase()
  return (
    ['example.com', 'example.net', 'example.org', 'localhost'].includes(host) ||
    /\.(example|test|invalid|localhost)$/.test(host)
  )
}
