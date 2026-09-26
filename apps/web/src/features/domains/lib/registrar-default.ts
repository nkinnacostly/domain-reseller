/**
 * Which registry a domain's nameservers go to, so "Use default DNS" offers
 * that registry's default (migration 35: one default per side). A test-mode
 * domain is registered in the supplier's sandbox, which hands out its own
 * pair. A demo domain reaches no registry at all; the live pair is what a
 * real one would get.
 */
export type RegistrarSide = 'live' | 'sandbox'

export function registrarSide(domain: { source: string; testMode: boolean }): RegistrarSide {
  return domain.testMode && domain.source !== 'demo' ? 'sandbox' : 'live'
}
