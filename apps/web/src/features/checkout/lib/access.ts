/**
 * Pre-launch gate. With CHECKOUT_ALLOWLIST set (comma-separated emails), only
 * those accounts can pay — so a deployed site can take the owner's own order
 * before the legal pages, refunds and alerts every other customer needs exist.
 * Unset, checkout is open to everyone.
 */
export function checkoutOpenTo(email: string | null | undefined, allowlist: string | undefined) {
  if (!allowlist?.trim()) return true
  if (!email) return false
  const allowed = allowlist
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
  return allowed.includes(email.trim().toLowerCase())
}
