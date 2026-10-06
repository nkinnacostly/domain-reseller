import { type ApiError, apiError, EMAIL_LIMITS, idempotencyKeySchema } from '@dr/shared/mail'

/**
 * Reading what a v1 request sends (MAIL-SPEC §6): the JSON body, refused
 * past 4 MB without reading it all (Vercel refuses past 4.5 MB anyway), and
 * the `Idempotency-Key` header.
 */

export const TOO_LARGE: ApiError = {
  ...apiError(
    'validation_error',
    'The request is larger than 4 MB. Send fewer or smaller attachments.',
  ),
  status: 413,
}

export const NOT_JSON = apiError(
  'validation_error',
  'The body must be JSON, sent with Content-Type: application/json.',
)

export const BAD_IDEMPOTENCY_KEY = apiError(
  'validation_error',
  'The Idempotency-Key header must be 1 to 256 printable ASCII characters, without spaces.',
)

export type Read<T> = { ok: true; value: T } | { ok: false; error: ApiError }

/** The body as text, refused past the limit without reading it all. */
async function readText(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > EMAIL_LIMITS.maxRequestBytes) return null
  const text = await request.text()
  return new TextEncoder().encode(text).length > EMAIL_LIMITS.maxRequestBytes ? null : text
}

export async function readJson(request: Request): Promise<Read<unknown>> {
  const text = await readText(request)
  if (text === null) return { ok: false, error: TOO_LARGE }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, error: NOT_JSON }
  }
}

/** The header's key, null when it was not sent, or the error when it is malformed. */
export function readIdempotencyKey(request: Request): Read<string | null> {
  const raw = request.headers.get('idempotency-key')
  if (raw === null) return { ok: true, value: null }
  const parsed = idempotencyKeySchema.safeParse(raw)
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: BAD_IDEMPOTENCY_KEY }
}
