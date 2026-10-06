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
