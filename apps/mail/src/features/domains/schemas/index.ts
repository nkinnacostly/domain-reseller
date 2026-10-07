import { z } from 'zod'

/** The domains page's inputs (MAIL-SPEC §5). SQL checks each again (migration 47). */

export const addDomainSchema = z.object({
  accountId: z.uuid(),
  name: z
    .string()
    .trim()
    .min(1, 'Type a domain, such as acme.ng.')
    .max(260, 'That is too long to be a domain.'),
})

export const domainActionSchema = z.object({
  accountId: z.uuid(),
  domainId: z.uuid(),
})

/** POST /api/v1/domains: `{ "name": "acme.ng" }`. */
export const createDomainBodySchema = z.object({
  name: z.string().trim().min(1).max(260),
})

/**
 * "Add to Cloudflare" with a pasted token (§5.3): checked for shape only,
 * then used for one run and dropped. The words never repeat the value.
 */
export const cloudflareTokenSchema = z.object({
  accountId: z.uuid(),
  domainId: z.uuid(),
  token: z
    .string()
    .trim()
    .min(1, 'Paste the token Cloudflare showed you.')
    .regex(
      /^[A-Za-z0-9_-]{30,200}$/,
      'That does not look like a Cloudflare API token. Copy the whole token Cloudflare shows after Create Token — not the Global API Key.',
    ),
})
