import type { SslClient, SslContent } from './client'
import { sslState } from './status'
import type { CertificateToCheck, SslStore } from './store'

/**
 * Asks the supplier where each certificate stands (FR-SSL-7): those waiting
 * on their approver, and those issued whose text we do not have yet. The
 * supplier sends no webhooks, so this is the only way to know.
 *
 * Read-only, in the supplier slots' low lane — behind every search and job,
 * and never more than one of the two slots (the 2-a-second limit). Each
 * certificate is asked less often the longer it waits.
 */

type Log = {
  info(fields: object, message: string): void
  warn(fields: object, message: string): void
  error(fields: object, message: string): void
}

const MINUTE = 60
const HOUR = 60 * MINUTE

/**
 * When to ask again: every 5 minutes for the first hour after the set-up
 * (an approver often clicks at once), 15 for a day, hourly for a week, then
 * every 6 hours. Issued without its text: hourly.
 */
export function nextCheckSeconds(
  certificate: Pick<CertificateToCheck, 'configuredAt'>,
  state: string | null,
  hasText: boolean,
  now: Date,
): number {
  if (state === 'issued') return hasText ? 24 * HOUR : HOUR
  const waited = (now.getTime() - Date.parse(certificate.configuredAt ?? '')) / 1000
  if (!Number.isFinite(waited) || waited < HOUR) return 5 * MINUTE
  if (waited < 24 * HOUR) return 15 * MINUTE
  if (waited < 7 * 24 * HOUR) return HOUR
  return 6 * HOUR
}

/** The chain as one PEM file, intermediates first (most servers want it so). */
export function caBundle(content: SslContent): string {
  return [...content.intermediates, content.root].filter((pem) => pem.trim() !== '').join('\n')
}

export type SslPollerOptions = {
  store: SslStore
  client: SslClient
  testMode: boolean
  everyMs: number
  /** Certificates asked about per round. */
  batch?: number
  log: Log
  now?: () => Date
}

export function createSslPoller(options: SslPollerOptions) {
  const { store, client, testMode, everyMs, batch = 10, log, now = () => new Date() } = options

  async function check(certificate: CertificateToCheck): Promise<'recorded' | 'skipped'> {
    const status = await client.status(certificate.commonName)
    if (status.kind === 'unknown' || status.kind === 'blocked') {
      // Nothing learned: ask again next round. Never recorded as an answer.
      log.warn({ certificateId: certificate.id, code: status.code }, 'SSL status not read')
      return 'skipped'
    }
    if (status.kind === 'not_found') {
      // A certificate we bought that the supplier cannot find: a person looks.
      await store.recordStatus(certificate.id, {
        supplierStatus: 'NotFound',
        state: null,
        issuedAt: null,
        expiresAt: null,
        certificate: null,
        caBundle: null,
        nextCheckSeconds: HOUR,
      })
      return 'recorded'
    }

    const word = status.data.status
    const state = sslState(word)
    let text: SslContent | null = null
    let issuedAt: string | null = null
    let expiresAt = status.data.certificateExpiresAt
    if (state === 'issued') {
      const content = await client.content(certificate.commonName)
      if (content.kind === 'found' && content.data.certificate.includes('BEGIN CERTIFICATE')) {
        text = content.data
      }
      // A wildcard's details cannot be read (Appendix E): its dates come from check-status.
      if (!certificate.isWildcard) {
        const details = await client.details(certificate.commonName)
        if (details.kind === 'found') {
          issuedAt = details.data.issuedAt
          expiresAt = details.data.validUntil ?? expiresAt
        }
      }
    }
    await store.recordStatus(certificate.id, {
      supplierStatus: word,
      state,
      issuedAt,
      expiresAt,
      certificate: text?.certificate ?? null,
      caBundle: text ? caBundle(text) : null,
      nextCheckSeconds: nextCheckSeconds(certificate, state, text !== null, now()),
    })
    return 'recorded'
  }

  /** One round: every certificate due, one at a time. */
  async function runOnce(): Promise<{ checked: number; skipped: number }> {
    const due = await store.toCheck(testMode, batch)
    let checked = 0
    let skipped = 0
    for (const certificate of due) {
      try {
        if ((await check(certificate)) === 'recorded') checked += 1
        else skipped += 1
      } catch (error) {
        skipped += 1
        log.error({ err: error, certificateId: certificate.id }, 'SSL status check failed')
      }
    }
    if (due.length > 0) log.info({ checked, skipped }, 'SSL statuses checked')
    return { checked, skipped }
  }

  let timer: NodeJS.Timeout | null = null
  let current: Promise<void> | null = null
  let running = false

  async function cycle() {
    try {
      await runOnce()
    } catch (error) {
      log.error({ err: error }, 'SSL status round failed')
    }
    if (!running) return
    timer = setTimeout(() => {
      current = cycle()
    }, everyMs)
  }

  return {
    runOnce,
    start() {
      if (running) return
      running = true
      current = cycle()
    },
    async stop() {
      running = false
      if (timer) clearTimeout(timer)
      timer = null
      await current
    },
  }
}
