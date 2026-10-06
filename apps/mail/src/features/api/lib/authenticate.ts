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

/**
 * All the key door needs: the store's `authenticate_key` and the pepper.
 * Kept this narrow so every v1 route — the domains package's too — can use
 * the same door with its own store.
 */
export type KeyDeps = { store: Pick<ApiStore, 'authenticateKey'>; pepper: string }

export async function authenticate(request: Request, deps: KeyDeps): Promise<Authenticated> {
  const key = bearerKey(request.headers.get('authorization'))
  if (!key || !isApiKey(key)) return { ok: false, error: MISSING_KEY }
  const answer = await deps.store.authenticateKey(await hashApiKey(key, deps.pepper))
  if (!answer.ok) return { ok: false, error: refusalToApiError(answer) }
  return { ok: true, key: answer.key }
}

/**
 * A sending key may only send (§9, MR7): reading the log, changing a queued
 * email and managing keys take a full-access key.
 */
export const FULL_KEY_ONLY = apiError(
  'forbidden',
  'This API key may only send. This request takes a full-access key.',
)

export async function authenticateFull(request: Request, deps: KeyDeps): Promise<Authenticated> {
  const auth = await authenticate(request, deps)
  if (auth.ok && auth.key.permission !== 'full') return { ok: false, error: FULL_KEY_ONLY }
  return auth
}
