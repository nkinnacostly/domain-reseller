import 'server-only'

import { GatewayError } from '@dr/shared/errors'
import { requireGatewayEnv } from '@/lib/env'
import { logger } from '@/lib/logger'

/**
 * Typed client for the registrar gateway (apps/gateway).
 *
 * The web app NEVER calls DomainNameAPI directly — see PRD §6.4 (ADR-004).
 * The gateway holds the credentials and owns the static egress IP the supplier
 * allowlists (error API_301).
 */
type GatewayRequest = {
  path: string
  body?: unknown
  /** Idempotency key for write operations. Required for anything that costs money. */
  idempotencyKey?: string
  signal?: AbortSignal
  /** Extra headers: the admin routes' secret, audit note and label (ADMIN-SPEC §4.1). */
  headers?: Readonly<Record<string, string>>
  /** POST with a body and GET without, unless said otherwise (an admin POST read has none). */
  method?: 'GET' | 'POST'
  /**
   * What the logs name instead of `path` — a route template such as
   * `admin/supplier/domains/:name`, so a filled path with a domain name in
   * it never reaches a log line (N13).
   */
  logPath?: string
}

export async function callGateway<T>({
  path,
  body,
  idempotencyKey,
  signal,
  headers: extra,
  method,
  logPath,
}: GatewayRequest): Promise<T> {
  const { url: baseUrl, sharedSecret } = requireGatewayEnv()
  const started = performance.now()
  const url = `${baseUrl}/v1/${path.replace(/^\//, '')}`
  const logged = logPath ?? path

  const headers: Record<string, string> = {
    ...extra,
    'content-type': 'application/json',
    authorization: `Bearer ${sharedSecret}`,
  }
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey

  const init: RequestInit = {
    // The same test as for the body below, so the two can never disagree.
    method: method ?? (body !== undefined ? 'POST' : 'GET'),
    headers,
    cache: 'no-store',
  }
  if (body !== undefined) init.body = JSON.stringify(body)
  if (signal) init.signal = signal

  let response: Response
  try {
    response = await fetch(url, init)
  } catch (cause) {
    logger.error({ path: logged, cause }, 'gateway unreachable')
    throw new GatewayError('SUPPLIER_UNAVAILABLE', 'The registrar service is unreachable.', {
      retryable: true,
      cause,
    })
  }

  const durationMs = Math.round(performance.now() - started)
  const payload = (await response.json().catch(() => null)) as
    | { ok: true; data: T }
    | { ok: false; code: string; message?: string; reason?: string; retryable?: boolean }
    | null

  if (!response.ok || !payload || payload.ok === false) {
    const code = payload && payload.ok === false ? payload.code : 'SUPPLIER_UNAVAILABLE'
    const message =
      (payload && payload.ok === false ? payload.message : undefined) ??
      'The registrar service failed.'
    const retryable = payload && payload.ok === false ? Boolean(payload.retryable) : true

    logger.warn({ path: logged, code, durationMs, status: response.status }, 'gateway error')
    const error = new GatewayError(code, message, { retryable })
    // The admin routes say why a note was refused (ADMIN_NOTE_REFUSED).
    if (payload && payload.ok === false && payload.reason) {
      Object.assign(error, { reason: payload.reason })
    }
    throw error
  }

  logger.debug({ path: logged, durationMs }, 'gateway ok')
  return payload.data
}
