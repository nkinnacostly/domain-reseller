import {
  type ApiError,
  apiError,
  bearerKey,
  hashApiKey,
  isApiKey,
  refusalToApiError,
} from '@dr/shared/mail'
import type { ApiKeyAuth, ApiStore } from '../store'

/**
 * `Authorization: Bearer mdh_live_…` (MAIL-SPEC §6, MR7). A key that is not
 * even shaped like one is refused without asking the database; otherwise
 * its hash — sha256(pepper ‖ key) — is looked up by `authenticate_key`,
 * which also refuses revoked keys and closed accounts, takes a token from
 * the key's rate-limit bucket and moves `last_used_at`.
 */

export const MISSING_KEY = apiError(
  'unauthorized',
  'The API key is missing, wrong or revoked. Send it as "Authorization: Bearer mdh_live_…".',
)

export type Authenticated = { ok: true; key: ApiKeyAuth } | { ok: false; error: ApiError }

export async function authenticate(
  request: Request,
  deps: { store: ApiStore; pepper: string },
): Promise<Authenticated> {
  const key = bearerKey(request.headers.get('authorization'))
  if (!key || !isApiKey(key)) return { ok: false, error: MISSING_KEY }
  const answer = await deps.store.authenticateKey(await hashApiKey(key, deps.pepper))
  if (!answer.ok) return { ok: false, error: refusalToApiError(answer) }
  return { ok: true, key: answer.key }
}
