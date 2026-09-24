'use client'

import { usePathname } from 'next/navigation'
import { normaliseExtension } from '../lib/extension'

/**
 * The not-found page for /domains/{tld} gets no params, so it reads the
 * extension from the URL to name it — "We don't sell .ng" says more than
 * "Page not found" to someone looking for .ng.
 */
export function MissingExtensionTitle() {
  const segment = usePathname().split('/')[2] ?? ''
  const tld = normaliseExtension(segment)
  return <>{tld ? `We don't sell .${tld}` : "We don't sell that extension"}</>
}
