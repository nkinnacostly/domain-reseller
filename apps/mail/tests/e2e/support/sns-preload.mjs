/**
 * Loaded into the e2e server only (`NODE_OPTIONS=--import …` in
 * playwright.config.ts), never into a deployed one: the stand-in for SNS's
 * certificate host (MAIL-SPEC §4.2, §12). The route verifies every message
 * exactly as in production — the certificate only from
 * sns.eu-west-2.amazonaws.com — so the test serves its own public key at one
 * certificate name real SNS never uses, and leaves every other request alone.
 */
import { readFileSync } from 'node:fs'

const CERT_URL = 'https://sns.eu-west-2.amazonaws.com/SimpleNotificationService-mdme2e0000.pem'
const file = process.env.MAIL_E2E_SNS_PUBLIC_KEY_FILE

if (file) {
  const original = globalThis.fetch
  globalThis.fetch = async function e2eFetch(input, init) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url
    if (url === CERT_URL) {
      return new Response(readFileSync(file, 'utf8'), {
        status: 200,
        headers: { 'content-type': 'application/x-pem-file' },
      })
    }
    return original(input, init)
  }
}
