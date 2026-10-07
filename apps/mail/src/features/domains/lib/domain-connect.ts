import { createPrivateKey, createSign, type KeyObject } from 'node:crypto'

/**
 * Domain Connect's one-click flow at Cloudflare (MAIL-SPEC §5.3): the
 * customer is sent to Cloudflare's dashboard with our template's variables,
 * signs in there, sees exactly which records will be added, and approves.
 * Cloudflare holds the template (infra/domain-connect/), so nothing but the
 * three DKIM tokens and the region travels in the address, and the request is
 * signed with our key so the variables cannot be changed on the way.
 *
 * From the Domain Connect specification (synchronous flow) and Cloudflare's
 * "Domain Connect" page, read on 8 Oct 2026: the signature is RSA-SHA256 over
 * the query string as sent, without `key` and `sig`; `key` names the TXT
 * record under our syncPubKeyDomain (mydomainshub.com) that holds the public
 * key; and `sig` must be the last parameter. Cloudflare ignores `state`.
 *
 * DMARC is not in the template: Domain Connect would replace a policy the
 * customer already has. The records table still suggests it.
 */

export const DOMAIN_CONNECT = {
  providerId: 'mydomainshub.com',
  serviceId: 'mail',
  /** TXT records at _dck1.mydomainshub.com: `p=1,a=RS256,d=…`, `p=2,…`. */
  keyHost: '_dck1',
  /** Cloudflare's own answers for every zone it serves (GET …/v2/{domain}/settings). */
  cloudflare: {
    urlSyncUX: 'https://dash.cloudflare.com/domainconnect',
    apiPath: '/dns/domainconnect',
  },
} as const

/** Our template's records are made on `send` for MAIL FROM; any other set-up uses the token way. */
export function fitsTemplate(name: string, mailFromDomain: string | null): boolean {
  return (mailFromDomain ?? `send.${name}`) === `send.${name}`
}

/** The private key, from base64 of its PKCS #8 DER (one line, so it fits an env var). */
export function signingKey(base64: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'pkcs8' })
}

export function sign(query: string, key: KeyObject): string {
  return createSign('RSA-SHA256').update(query).sign(key, 'base64')
}

/**
 * The public key as Domain Connect publishes it: base64 of the DER
 * SubjectPublicKeyInfo, in parts of at most 200 characters, one TXT record
 * each (`p` the part, `a` the algorithm, `d` the data).
 */
export function publicKeyRecords(spkiDerBase64: string, size = 200): string[] {
  const parts: string[] = []
  for (let i = 0; i < spkiDerBase64.length; i += size) parts.push(spkiDerBase64.slice(i, i + size))
  return parts.map((data, index) => `p=${index + 1},a=RS256,d=${data}`)
}

/**
 * Where to send the customer: Cloudflare's apply page for our template, on
 * the zone (`domain`) and, for a sending domain below it, `host` — so
 * `mail.example.com` in zone `example.com` is domain=example.com&host=mail.
 */
export function applyUrl({
  zone,
  name,
  dkimTokens,
  region,
  redirectUri,
  key,
}: {
  zone: string
  name: string
  dkimTokens: readonly string[]
  region: string
  redirectUri: string
  key: KeyObject
}): string {
  if (dkimTokens.length !== 3) throw new Error('Domain Connect needs the three DKIM tokens')
  if (name !== zone && !name.endsWith(`.${zone}`)) throw new Error('the domain is not in the zone')
  const params = new URLSearchParams({ domain: zone })
  if (name !== zone) params.set('host', name.slice(0, -(zone.length + 1)))
  dkimTokens.forEach((token, index) => {
    params.set(`dkim${index + 1}`, token)
  })
  params.set('region', region)
  params.set('redirect_uri', redirectUri)
  const query = params.toString()
  const signature = encodeURIComponent(sign(query, key))
  const { cloudflare, providerId, serviceId, keyHost } = DOMAIN_CONNECT
  return `${cloudflare.urlSyncUX}/v2/domainTemplates/providers/${providerId}/services/${serviceId}/apply?${query}&key=${keyHost}&sig=${signature}`
}
