'use server'

import { bareName, extraNamesProblem, readCsr, SSL_WEB_SERVERS, sslContactSchema } from '@dr/shared'
import { z } from 'zod'
import { registrantFormSchema, toContact } from '@/features/checkout/lib/contact'
import { logger } from '@/lib/logger'
import { LIMITS, withinLimit } from '@/lib/rate-limit'
import { authAction } from '@/lib/safe-action'
import { createServiceClient } from '@/lib/supabase/service'
import { type CertificateRow, getMyCertificate } from '../queries/certificates'
import { approverEmails, type CsrSummary, checkCsr, generateCsr } from '../queries/supplier'

/**
 * The customer's side of a certificate (FR-SSL-4, FR-SSL-8): checking or
 * making the request, choosing who approves it, and asking for the set-up
 * or a reissue. Each reads the certificate as its owner first (RLS); the
 * set-up and reissue themselves are service-role functions that check
 * ownership again (migration 39), and a job sends them to the supplier.
 *
 * No private key is ever accepted, stored or logged here (N13): a key we
 * generate goes back to the browser in the answer and nowhere else.
 */

type Failure = { error: string; field?: string }
const NOT_YOURS = 'That certificate is not on your account.'
const TRY_AGAIN = 'We could not reach the certificate supplier just now. Try again in a moment.'

/** The certificate, read as its owner — or why it cannot be worked on. */
async function mine(
  certificateId: string,
  statuses: readonly string[],
): Promise<{ error: string } | { certificate: CertificateRow }> {
  const certificate = await getMyCertificate(certificateId)
  if (!certificate) return { error: NOT_YOURS }
  if (!statuses.includes(certificate.status)) {
    return {
      error: 'This certificate has moved on since the page loaded. Refresh it and try again.',
    }
  }
  return { certificate }
}

/** The name a CSR must be for: exactly the certificate's, `*.` and all. */
function csrMatches(summary: CsrSummary, commonName: string): boolean {
  return summary.commonName.toLowerCase() === commonName.toLowerCase()
}

export const loadApprovers = authAction
  .inputSchema(z.object({ certificateId: z.uuid() }))
  .action(async ({ parsedInput }): Promise<Failure | { emails: string[] }> => {
    const found = await mine(parsedInput.certificateId, ['awaiting_setup', 'issued'])
    if ('error' in found) return found
    const read = await approverEmails(found.certificate.common_name, found.certificate.product_code)
    if (!read.ok) return { error: TRY_AGAIN }
    if (read.data.emails.length === 0) {
      return {
        error: 'The certificate authority offered no approval address for this name. Contact us.',
      }
    }
    return { emails: read.data.emails }
  })

export const checkCertificateRequest = authAction
  .inputSchema(z.object({ certificateId: z.uuid(), csr: z.string().max(20_000) }))
  .action(async ({ parsedInput, ctx }): Promise<Failure | { summary: CsrSummary }> => {
    const csr = readCsr(parsedInput.csr)
    if (!csr.ok) return { error: csr.reason, field: 'csr' }
    const found = await mine(parsedInput.certificateId, ['awaiting_setup'])
    if ('error' in found) return found
    if (!(await withinLimit(`ssl_csr:${ctx.user.id}`, LIMITS.placeOrder))) {
      return { error: 'Too many checks in a few minutes. Wait a little, then try again.' }
    }
    const read = await checkCsr(csr.csr)
    if (!read.ok) {
      return read.code === 'CSR_INVALID'
        ? {
            error:
              'The certificate authority could not read that request. Make a new one and paste it whole.',
            field: 'csr',
          }
        : { error: TRY_AGAIN }
    }
    if (!csrMatches(read.data, found.certificate.common_name)) {
      return {
        error: `That request is for ${read.data.commonName}, but this certificate is for ${found.certificate.common_name}. Make a request for ${found.certificate.common_name}.`,
        field: 'csr',
      }
    }
    return { summary: read.data }
  })

const generateSchema = z.object({
  certificateId: z.uuid(),
  organization: z.string().trim().min(1, 'Enter your organisation, or your name').max(150),
  organizationUnit: z.string().trim().max(150).optional(),
  locality: z.string().trim().min(1, 'Enter a city').max(50),
  state: z.string().trim().min(1, 'Enter a state').max(50),
  country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'Choose a country'),
  extraNames: z.array(z.string().max(253)).max(250).default([]),
})

/**
 * FR-SSL-4: "make one for me". The supplier makes the key and request; the
 * key comes back to this browser once. Never logged — the log line says only
 * that one was made.
 */
export const generateCertificateRequest = authAction
  .inputSchema(generateSchema)
  .action(async ({ parsedInput, ctx }): Promise<Failure | { csr: string; privateKey: string }> => {
    const found = await mine(parsedInput.certificateId, ['awaiting_setup'])
    if ('error' in found) return found
    const { certificate } = found
    const problem = extraNamesProblem(
      certificate.common_name,
      parsedInput.extraNames,
      certificate.included_names,
    )
    if (problem) return { error: problem, field: 'extraNames' }
    if (!(await withinLimit(`ssl_generate:${ctx.user.id}`, LIMITS.placeOrder))) {
      return { error: 'Too many requests in a few minutes. Wait a little, then try again.' }
    }
    const made = await generateCsr({
      name: certificate.common_name,
      alternativeNames: parsedInput.extraNames.map((name) => name.trim().toLowerCase()),
      country: parsedInput.country,
      state: parsedInput.state,
      locality: parsedInput.locality,
      organization: parsedInput.organization,
      organizationUnit: parsedInput.organizationUnit || 'IT',
    })
    logger.info({ certificateId: certificate.id, ok: made.ok }, 'SSL key and CSR requested')
    if (!made.ok) return { error: TRY_AGAIN }
    return made.data
  })

const setupSchema = z.object({
  certificateId: z.uuid(),
  csr: z.string().max(20_000),
  approverEmail: z.email('Choose who approves it'),
  webServer: z.enum(SSL_WEB_SERVERS),
  extraNames: z.array(z.string().max(253)).max(250).default([]),
  contact: registrantFormSchema,
})

/** Postgres's answer from request_ssl_setup / request_ssl_reissue, in words. */
function refusal(code: string | undefined): string {
  switch (code) {
    case '42501':
      return NOT_YOURS
    case '55000':
      return 'This certificate has moved on since the page loaded. Refresh it and try again.'
    default:
      return 'We could not save that just now. Nothing was sent. Try again in a moment.'
  }
}

export const requestCertificateSetup = authAction
  .inputSchema(setupSchema)
  .action(async ({ parsedInput, ctx }): Promise<Failure | { ok: true }> => {
    const csr = readCsr(parsedInput.csr)
    if (!csr.ok) return { error: csr.reason, field: 'csr' }
    const found = await mine(parsedInput.certificateId, ['awaiting_setup'])
    if ('error' in found) return found
    const { certificate } = found

    const extraNames = [
      ...new Set(parsedInput.extraNames.map((name) => name.trim().toLowerCase())),
    ].filter(Boolean)
    if (certificate.is_wildcard && extraNames.length > 0) {
      return { error: 'A wildcard certificate takes no extra names.', field: 'extraNames' }
    }
    const problem = extraNamesProblem(
      certificate.common_name,
      extraNames,
      certificate.included_names,
    )
    if (problem) return { error: problem, field: 'extraNames' }

    const contact = sslContactSchema.safeParse(toContact(parsedInput.contact))
    if (!contact.success) {
      const issue = contact.error.issues[0]
      return {
        error: issue?.message ?? 'Check the contact details.',
        field: `contact.${String(issue?.path[0] ?? '')}`,
      }
    }

    // The CA's own reading of the request, and the address list it offers:
    // asked again here, so nothing the browser says is taken on trust.
    const [read, approvers] = await Promise.all([
      checkCsr(csr.csr),
      approverEmails(certificate.common_name, certificate.product_code),
    ])
    if (!read.ok) {
      return read.code === 'CSR_INVALID'
        ? { error: 'The certificate authority could not read that request.', field: 'csr' }
        : { error: TRY_AGAIN }
    }
    if (!csrMatches(read.data, certificate.common_name)) {
      return {
        error: `That request is for ${read.data.commonName}, but this certificate is for ${certificate.common_name}.`,
        field: 'csr',
      }
    }
    if (!approvers.ok) return { error: TRY_AGAIN }
    const approver = parsedInput.approverEmail.toLowerCase()
    if (!approvers.data.emails.includes(approver)) {
      return {
        error: `Choose an approval address at ${bareName(certificate.common_name)} from the list.`,
        field: 'approverEmail',
      }
    }

    const { error } = await createServiceClient().rpc('request_ssl_setup', {
      p_user_id: ctx.user.id,
      p_certificate_id: certificate.id,
      p_csr: csr.csr,
      p_approver_email: approver,
      p_web_server: parsedInput.webServer,
      p_san_names: extraNames,
      p_contact: contact.data,
    })
    if (error) {
      logger.error({ code: error.code, certificateId: certificate.id }, 'SSL set-up not saved')
      return { error: refusal(error.code) }
    }
    return { ok: true }
  })

export const requestCertificateReissue = authAction
  .inputSchema(z.object({ certificateId: z.uuid() }))
  .action(async ({ parsedInput, ctx }): Promise<Failure | { ok: true }> => {
    const found = await mine(parsedInput.certificateId, ['issued'])
    if ('error' in found) return found
    const { error } = await createServiceClient().rpc('request_ssl_reissue', {
      p_user_id: ctx.user.id,
      p_certificate_id: found.certificate.id,
    })
    if (error) {
      logger.error(
        { code: error.code, certificateId: found.certificate.id },
        'SSL reissue not saved',
      )
      return { error: refusal(error.code) }
    }
    return { ok: true }
  })
