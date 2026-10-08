import type { EnqueueInput } from './api'
import { type ApiError, apiError } from './errors'

/**
 * Content checks at queue time (MAIL-SPEC §7.6): cheap and certain only.
 * Refused before anything is queued or reserved —
 *
 *   - a From display name or domain that imitates a bank, a payments company
 *     or a government body we list, unless the domain is that body's own;
 *   - links to URL shorteners, which hide where a link goes;
 *   - attachments that are programs.
 *
 * Anything subtler is for review, not code. Pure: no I/O, so every way in —
 * the API's enqueue path for each email and batch item, and the SMTP relay
 * for each message — calls it, and it is tested case by case. A refusal says
 * which rule, never the address it read (N13).
 */

export type ContentRule = 'impersonation' | 'url_shortener' | 'executable_attachment'

export type ContentRefusal = { rule: ContentRule; message: string }

export type ContentInput = {
  /** The From mailbox as the API received it: `Name <a@b.ng>` or `a@b.ng`. */
  from: string
  html?: string | null | undefined
  text?: string | null | undefined
  attachments?:
    | readonly { filename?: string | null | undefined; content_type?: string | null | undefined }[]
    | undefined
}

/**
 * Bodies we will not let an account name itself after: Nigerian banks and
 * payment companies, and government bodies people are phished in the name
 * of. `words` are matched as whole words in the display name, and as whole
 * labels or hyphen-separated parts of the domain ("gtbank-alerts.com"), so
 * "Cuba" is never "UBA". Words that are also ordinary words or common names
 * are left out ("firs", a bare "uba"): this check is for the certain cases.
 * A government body may send as itself from a `.gov.ng` domain, which only it
 * can hold. A bank or payment company that wants to send through us as
 * itself writes to hello@mydomainshub.com first: letting its own domain
 * through is a change here, once a person has checked it.
 */
export const PROTECTED_NAMES: readonly {
  name: string
  words: readonly string[]
  government?: true
}[] = [
  { name: 'Access Bank', words: ['access bank', 'accessbank'] },
  { name: 'GTBank', words: ['gtbank', 'gtco', 'guaranty trust bank'] },
  { name: 'Zenith Bank', words: ['zenith bank', 'zenithbank'] },
  { name: 'First Bank', words: ['first bank of nigeria', 'firstbank', 'firstbanknigeria'] },
  { name: 'UBA', words: ['united bank for africa', 'uba bank', 'uba plc', 'ubagroup'] },
  { name: 'Fidelity Bank', words: ['fidelity bank', 'fidelitybank'] },
  { name: 'Union Bank', words: ['union bank of nigeria', 'unionbankng'] },
  { name: 'Sterling Bank', words: ['sterling bank', 'sterlingbank'] },
  { name: 'Stanbic IBTC', words: ['stanbic', 'stanbicibtc'] },
  { name: 'Ecobank', words: ['ecobank'] },
  { name: 'Wema Bank', words: ['wema bank', 'wemabank'] },
  { name: 'Polaris Bank', words: ['polaris bank', 'polarisbank'] },
  { name: 'Opay', words: ['opay'] },
  { name: 'Moniepoint', words: ['moniepoint'] },
  { name: 'Kuda', words: ['kuda bank', 'kudabank'] },
  { name: 'PalmPay', words: ['palmpay'] },
  { name: 'Flutterwave', words: ['flutterwave'] },
  { name: 'Paystack', words: ['paystack'] },
  { name: 'Central Bank of Nigeria', words: ['cbn', 'central bank of nigeria'], government: true },
  { name: 'FIRS', words: ['federal inland revenue'], government: true },
  { name: 'EFCC', words: ['efcc', 'economic and financial crimes commission'], government: true },
  { name: 'NIMC', words: ['nimc', 'national identity management commission'], government: true },
  { name: 'Nigeria Police', words: ['nigeria police', 'nigerian police'], government: true },
  { name: 'Nigeria Customs', words: ['nigeria customs', 'nigerian customs'], government: true },
  {
    name: 'Nigeria Immigration',
    words: ['nigeria immigration', 'nigerian immigration'],
    government: true,
  },
  { name: 'CAC', words: ['corporate affairs commission'], government: true },
  { name: 'JAMB', words: ['jamb'], government: true },
  { name: 'INEC', words: ['inec'], government: true },
]

/** Link shorteners: a link through one hides where it goes. */
export const URL_SHORTENERS: readonly string[] = [
  'bit.ly',
  'bitly.com',
  'tinyurl.com',
  't.co',
  'goo.gl',
  'ow.ly',
  'is.gd',
  'buff.ly',
  'rebrand.ly',
  'cutt.ly',
  'shorturl.at',
  'rb.gy',
  'tiny.cc',
  'bl.ink',
  'short.io',
  'lnkd.in',
  's.id',
  'v.gd',
  'shorte.st',
  'adf.ly',
]

/** Attachment endings that run code when opened. */
export const EXECUTABLE_EXTENSIONS: readonly string[] = [
  'exe',
  'scr',
  'com',
  'pif',
  'bat',
  'cmd',
  'msi',
  'msp',
  'msc',
  'cpl',
  'dll',
  'jar',
  'js',
  'jse',
  'vbs',
  'vbe',
  'wsf',
  'wsh',
  'ws',
  'ps1',
  'psm1',
  'hta',
  'lnk',
  'reg',
  'inf',
  'scf',
  'apk',
  'app',
  'appx',
  'msix',
  'gadget',
  'sys',
  'iso',
  'img',
]

const EXECUTABLE_TYPES: readonly string[] = [
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-ms-installer',
  'application/x-msi',
  'application/vnd.microsoft.portable-executable',
  'application/x-executable',
  'application/java-archive',
  'application/vnd.android.package-archive',
  'application/hta',
  'application/x-sh',
  'application/x-bat',
]

export const CONTENT_MESSAGES: Record<ContentRule, string> = {
  impersonation:
    'The From name or domain imitates a bank, a payments company or a government body. Send as your own business; if you are that body, email hello@mydomainshub.com.',
  url_shortener:
    'The email links through a URL shortener, which hides where the link goes. Link to the address itself.',
  executable_attachment:
    'An attachment is a program (such as .exe, .js or .apk), which we never send. Link to a download page instead.',
}

const refuse = (rule: ContentRule): ContentRefusal => ({ rule, message: CONTENT_MESSAGES[rule] })

/** `Name <a@b.ng>` → { name: 'Name', domain: 'b.ng' }. */
export function splitMailbox(mailbox: string): { name: string; domain: string } {
  const angle = /^(.*)<\s*([^<>]+?)\s*>\s*$/.exec(mailbox)
  const name = (angle ? (angle[1] ?? '') : '').trim().replace(/^"(.*)"$/, '$1')
  const address = (angle ? (angle[2] ?? '') : mailbox).trim().toLowerCase()
  return { name, domain: address.slice(address.lastIndexOf('@') + 1) }
}

const normalise = (text: string) =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** Whole words: `uba` in "UBA Alerts", never in "Cuba". */
function hasWords(haystack: string, words: string): boolean {
  return ` ${haystack} `.includes(` ${words} `)
}

/** Only a government body can hold a `.gov.ng` domain. */
const isGovernmentDomain = (domain: string) => domain === 'gov.ng' || domain.endsWith('.gov.ng')

/** The protected body a From name or domain imitates, if any. */
export function imitates(from: string): string | null {
  const { name, domain } = splitMailbox(from)
  const nameWords = normalise(name)
  // `gtbank-alerts.com` → "gtbank alerts com": each label and hyphen part a word.
  const domainWords = normalise(domain.replace(/[.-]/g, ' '))
  for (const body of PROTECTED_NAMES) {
    if (body.government && isGovernmentDomain(domain)) continue
    for (const words of body.words) {
      const plain = normalise(words)
      if (hasWords(nameWords, plain) || hasWords(domainWords, plain)) return body.name
    }
  }
  return null
}

const LINK = /\bhttps?:\/\/([^\s/"'<>?#:]+)/gi

/** Whether the html or text links through a shortener (hosts, as written). */
export function linksToShortener(...bodies: (string | null | undefined)[]): boolean {
  for (const body of bodies) {
    if (!body) continue
    for (const match of body.matchAll(LINK)) {
      const host = (match[1] ?? '').toLowerCase().replace(/\.$/, '')
      if (URL_SHORTENERS.some((short) => host === short || host.endsWith(`.${short}`))) return true
    }
  }
  return false
}

export function isExecutable(attachment: {
  filename?: string | null | undefined
  content_type?: string | null | undefined
}): boolean {
  const name = (attachment.filename ?? '')
    .trim()
    .toLowerCase()
    .replace(/[.\s]+$/, '')
  const dot = name.lastIndexOf('.')
  const extension = dot >= 0 ? name.slice(dot + 1) : ''
  const type = (attachment.content_type ?? '').toLowerCase().split(';')[0]?.trim() ?? ''
  return EXECUTABLE_EXTENSIONS.includes(extension) || EXECUTABLE_TYPES.includes(type)
}

/**
 * The first rule an email breaks, or null. MB3's enqueue path calls it before
 * enqueue_email and answers a refusal as `validation_error` (HTTP 422) with
 * its message.
 */
export function contentRefusal(input: ContentInput): ContentRefusal | null {
  if (imitates(input.from)) return refuse('impersonation')
  if (linksToShortener(input.html, input.text)) return refuse('url_shortener')
  if ((input.attachments ?? []).some(isExecutable)) return refuse('executable_attachment')
  return null
}

export type ContentProblem = { rule: ContentRule; index: number; error: ApiError }

/**
 * The first email of `emails` the check refuses, or null: asked before
 * enqueue_email or enqueue_batch, so a refused email reserves nothing. The
 * answer is `validation_error` (422) with the rule's own words; nothing it
 * read is quoted back or logged (N13).
 */
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
