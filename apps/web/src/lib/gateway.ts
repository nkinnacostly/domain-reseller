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
}

export async function callGateway<T>({
  path,
  body,
  idempotencyKey,
  signal,
}: GatewayRequest): Promise<T> {
  const { url: baseUrl, sharedSecret } = requireGatewayEnv()
  const started = performance.now()
  const url = `${baseUrl}/v1/${path.replace(/^\//, '')}`

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${sharedSecret}`,
  }
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey

  const init: RequestInit = {
    // The same test as for the body below, so the two can never disagree.
    method: body !== undefined ? 'POST' : 'GET',
    headers,
    cache: 'no-store',
  }
  if (body !== undefined) init.body = JSON.stringify(body)
  if (signal) init.signal = signal

  let response: Response
  try {
    response = await fetch(url, init)
  } catch (cause) {
    logger.error({ path, cause }, 'gateway unreachable')
    throw new GatewayError('SUPPLIER_UNAVAILABLE', 'The registrar service is unreachable.', {
      retryable: true,
      cause,
    })
  }

  const durationMs = Math.round(performance.now() - started)
  const payload = (await response.json().catch(() => null)) as
    | { ok: true; data: T }
    | { ok: false; code: string; message: string; retryable?: boolean }
    | null

  if (!response.ok || !payload || payload.ok === false) {
    const code = payload && payload.ok === false ? payload.code : 'SUPPLIER_UNAVAILABLE'
    const message =
      payload && payload.ok === false ? payload.message : 'The registrar service failed.'
    const retryable = payload && payload.ok === false ? Boolean(payload.retryable) : true

    logger.warn({ path, code, durationMs, status: response.status }, 'gateway error')
    throw new GatewayError(code, message, { retryable })
  }

  logger.debug({ path, durationMs }, 'gateway ok')
  return payload.data
}
