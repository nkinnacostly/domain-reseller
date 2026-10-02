import 'server-only'

import { GatewayError } from '@dr/shared/errors'
import { z } from 'zod'
import { callGateway } from '@/lib/gateway'
import { logger } from '@/lib/logger'

/**
 * The set-up's reads, through the gateway (N1: the web never calls the
 * supplier). Each says plainly when it could not be asked — the form shows
 * that, and nothing guesses past it.
 */

export type GatewayRead<T> = { ok: true; data: T } | { ok: false; code: string; retryable: boolean }

async function read<T>(
  path: string,
  schema: z.ZodType<T>,
  body?: unknown,
): Promise<GatewayRead<T>> {
  try {
    const data = await callGateway<unknown>({
      path,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(30_000),
    })
    const parsed = schema.safeParse(data)
    if (parsed.success) return { ok: true, data: parsed.data }
    logger.error({ path: path.split('?')[0] }, 'SSL gateway answer unreadable')
    return { ok: false, code: 'UNREADABLE', retryable: true }
  } catch (err) {
    if (err instanceof GatewayError) return { ok: false, code: err.code, retryable: err.retryable }
    return { ok: false, code: 'SUPPLIER_UNAVAILABLE', retryable: true }
  }
}

/** The addresses the CA can send the approval to, for the name and product. */
export function approverEmails(name: string, productCode: string) {
  const query = new URLSearchParams({ name, product: productCode })
  return read(`ssl/approvers?${query}`, z.object({ emails: z.array(z.string()) }))
}

export const csrSummarySchema = z.object({
  commonName: z.string(),
  alternativeNames: z.array(z.string()),
  isWildcard: z.boolean(),
  organization: z.string().nullable(),
  country: z.string().nullable(),
})
export type CsrSummary = z.infer<typeof csrSummarySchema>

/** What the CA reads in a CSR — the name it is for, above all. */
export function checkCsr(csr: string) {
  return read('ssl/csr/check', csrSummarySchema, { csr })
}

/**
 * A new key and CSR, made by the supplier. The key passes through here to
 * the browser and is kept nowhere: not logged, not stored, not cached (N13).
 */
export function generateCsr(input: {
  name: string
  alternativeNames: string[]
  country: string
  state: string
  locality: string
  organization: string
  organizationUnit: string
}) {
  return read('ssl/csr/generate', z.object({ csr: z.string(), privateKey: z.string() }), input)
}
