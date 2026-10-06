import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The e2e run's stand-in for Amazon SNS's signing key (MAIL-SPEC §4.2,
 * §12). Made once per machine and port, outside the repo, so no private key
 * is ever committed: playwright.config.ts makes it before the server starts
 * and hands the public half to the server's fetch preload
 * (`sns-preload.mjs`), which serves it at E2E_SNS_CERT_URL — a certificate
 * name real SNS never uses. The spec signs with the private half. Nothing
 * here reaches AWS.
 */

export const E2E_SNS_TOPIC_ARN = 'arn:aws:sns:eu-west-2:123456789012:mail-ses-events-e2e'
export const E2E_SNS_CERT_URL =
  'https://sns.eu-west-2.amazonaws.com/SimpleNotificationService-mdme2e0000.pem'

/**
 * The e2e server seals webhook secrets with this (MR6), never with
 * production's key; the spec's delivery run opens them with it. 32 bytes of
 * 0x2a, base64: a test value, not a secret.
 */
export const E2E_WEBHOOK_KEY = 'KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio='

export function snsKeyFiles(port: number | string) {
  const dir = join(tmpdir(), `mdm-mail-e2e-sns-${port}`)
  const publicFile = join(dir, 'public.pem')
  const privateFile = join(dir, 'private.pem')
  if (!existsSync(publicFile) || !existsSync(privateFile)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    writeFileSync(privateFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    writeFileSync(publicFile, publicKey.export({ type: 'spki', format: 'pem' }))
  }
  return { publicFile, privateFile, privatePem: () => readFileSync(privateFile, 'utf8') }
}
