/**
 * One-off ops script (MAIL-SPEC §7.2): the shared sandbox sender's SES
 * identity, `sandbox.emails.mydomainshub.com`, made with the manager key
 * (§4.3), and the DNS records to add for it in Cloudflare.
 *
 * Read only, by default — it says what SES has and prints the records:
 *
 *   pnpm --filter @dr/gateway exec tsx --tsconfig ../mail/tsconfig.json \
 *     --env-file=../../.env ../mail/scripts/sandbox-identity.ts
 *
 * Add `--create` to make what is missing: the identity with Easy DKIM
 * (RSA 2048) and MAIL FROM on send.sandbox.emails.mydomainshub.com. It has no
 * default configuration set and joins no tenant here: provisioning joins it to
 * each sandbox account's own tenant once SES has verified it, and the job
 * route notices that by itself (migration 47). Nothing is written to the
 * database. Prints no key.
 */
import { awsAccountOf, createSesManager } from '@dr/shared/ses'
import { hostLabel } from '../src/features/domains/lib/records'
import { ensureSandboxIdentity, SANDBOX_NAME } from '../src/features/tenants/lib/sandbox'

const ZONE = 'mydomainshub.com'

function say(line = ''): void {
  process.stdout.write(`${line}\n`)
}

async function main(): Promise<number> {
  const create = process.argv.includes('--create')
  const region = process.env.MAIL_SES_REGION || 'eu-west-2'
  const accessKeyId = process.env.MAIL_SES_MANAGER_ACCESS_KEY_ID
  const secretAccessKey = process.env.MAIL_SES_MANAGER_SECRET_ACCESS_KEY
  const topicArn = process.env.MAIL_SES_EVENTS_TOPIC_ARN ?? ''
  const awsAccount = awsAccountOf(topicArn)
  if (!accessKeyId || !secretAccessKey || !awsAccount) {
    say(
      'Set MAIL_SES_MANAGER_ACCESS_KEY_ID, MAIL_SES_MANAGER_SECRET_ACCESS_KEY and MAIL_SES_EVENTS_TOPIC_ARN (the root .env).',
    )
    return 1
  }
  if (process.env.MAIL_SES_ENDPOINT) {
    say('MAIL_SES_ENDPOINT is set: that is for the e2e mock. Unset it to talk to SES.')
    return 1
  }

  const manager = createSesManager({ region, accessKeyId, secretAccessKey })
  const result = await ensureSandboxIdentity(
    manager,
    { name: SANDBOX_NAME, region, awsAccount },
    { create },
  )
  if (!result.ok) {
    say(`SES refused or did not answer: ${result.error}. Nothing else was done.`)
    return 1
  }

  say(`Sandbox sender: ${SANDBOX_NAME} in ${region}`)
  for (const line of result.did) say(`  - ${line}`)
  say(
    `  SES says: ${result.state.status}${result.state.mailFromStatus ? ` (MAIL FROM ${result.state.mailFromStatus})` : ''}`,
  )
  if (result.records.length === 0) return create ? 1 : 0

  say()
  say(`Add these in Cloudflare (zone ${ZONE}), DNS → Records. CNAMEs as “DNS only” (grey cloud).`)
  say('Name is as Cloudflare wants it, without the zone.')
  say()
  for (const record of result.records) {
    const value =
      record.priority !== undefined ? `${record.priority} ${record.value}` : record.value
    say(
      `${record.type.padEnd(5)}  ${hostLabel(record.name, ZONE).padEnd(56)}  ${value}${record.required ? '' : '   (suggested)'}`,
    )
  }
  say()
  say('SES checks for 72 hours. Run this again (without --create) to see whether it is verified;')
  say(
    'the job route also reads it every five minutes until it is, then joins it to sandbox accounts.',
  )
  return 0
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    say(`Failed: ${error instanceof Error ? error.message : 'unknown error'}`)
    process.exit(1)
  },
)
