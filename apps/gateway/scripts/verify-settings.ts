/**
 * Confirms the registry-side settings calls against the SANDBOX (OTE) only
 * (FR-DS1, FR-DS3, FR-DS4, FR-DS5): the shapes the gateway reads, and that
 * each write shows up when the record is read back.
 *
 *   pnpm --filter @dr/gateway exec tsx --env-file-if-exists=../../.env \
 *     scripts/verify-settings.ts [e2ecart…-sandbox-domain.com]
 *
 * Without a name it lists the sandbox portfolio's names and stops. With one
 * — a test domain of ours, so its name starts with e2ecart — it turns the
 * transfer lock off and on, flips privacy and flips it back, reads the
 * transfer code (printing only its length), and saves the registrant's own
 * details again. Nothing here uses the production key, and nothing prints a
 * contact detail or a code (N13): field names, flags and lengths only.
 */
import { getDnaWriteClient } from '../src/dna/client'
import { withExchanges } from '../src/dna/transport'
import { env } from '../src/env'
import {
  type CallRecord,
  createDnaRegistrar,
  type RegistryContact,
  sameContact,
} from '../src/provisioning/registrar'

if (!env.DNA_API_TEST_KEY) {
  console.error('DNA_API_TEST_KEY is not set: this script runs against the sandbox only.')
  process.exit(1)
}

/** Supplier messages can quote what was sent: mask addresses and long numbers. */
const scrub = (text: string) =>
  text.replace(/\S+@\S+/g, '<email>').replace(/\+?\d[\d .-]{5,}\d/g, '<number>')

const client = getDnaWriteClient('ote')
const registrar = createDnaRegistrar({
  client,
  environment: 'ote',
  audit: async (call: CallRecord) => {
    const status = call.httpStatus === null ? 'no answer' : `HTTP ${call.httpStatus}`
    const detail = call.message ? ` — ${scrub(call.message)}` : ''
    console.log(`    ${call.operation}: ${call.outcome} (${status})${detail}`)
  },
})

const name = process.argv[2]?.toLowerCase()

if (!name) {
  const page = await registrar.listPage(0, 50)
  if (page.kind !== 'ok') {
    console.error(`Could not list the sandbox portfolio: ${page.kind}`)
    process.exit(1)
  }
  console.log(`Sandbox portfolio (${page.data.total}):`)
  for (const item of page.data.items) console.log(`  ${item.domainName}  ${item.status}`)
  console.log('\nRun again with one of the e2ecart… names to exercise its settings.')
  process.exit(0)
}

if (!name.startsWith('e2ecart')) {
  console.error('Only our own sandbox test domains (e2ecart…) are changed by this script.')
  process.exit(1)
}

// ── The raw record: which fields exist, never their values ─────────────────
console.log(`\n1. The record for ${name}`)
const { exchanges } = await withExchanges(() => client.GetDetails(name))
const body = (exchanges.at(-1)?.body ?? {}) as Record<string, unknown>
console.log(`    fields: ${Object.keys(body).sort().join(', ')}`)
console.log(
  `    lockStatus: ${String(body.lockStatus)}, privacy: ${String(body.privacyProtectionStatus)}`,
)
const code = typeof body.authCode === 'string' ? body.authCode : ''
console.log(`    authCode: ${code ? `${code.length} characters` : 'absent or empty'}`)
const contactRows = Array.isArray(body.contacts) ? (body.contacts as Record<string, unknown>[]) : []
console.log(`    contacts: ${contactRows.length}`)
for (const row of contactRows) {
  const filled = Object.entries(row)
    .filter(([, value]) => value !== null && value !== '' && value !== undefined)
    .map(([key]) => key)
    .sort()
  console.log(`      ${String(row.contactType ?? row.type)}: ${filled.join(', ')}`)
}

async function flag(field: 'transferLock' | 'privacy') {
  const read = await registrar.lookup(name as string)
  return read.kind === 'found' ? read.domain[field] : `unreadable (${read.kind})`
}

// ── Transfer lock ───────────────────────────────────────────────────────────
console.log('\n2. Transfer lock')
const lockBefore = await flag('transferLock')
console.log(`    before: ${lockBefore}`)
for (const locked of [false, true]) {
  console.log(`    set ${locked ? 'on' : 'off'}:`)
  await registrar.setTransferLock(name, locked)
  console.log(`    read back: ${await flag('transferLock')}`)
}

// ── Privacy ─────────────────────────────────────────────────────────────────
console.log('\n3. Privacy')
const privacyBefore = await flag('privacy')
console.log(`    before: ${privacyBefore}`)
if (typeof privacyBefore === 'boolean') {
  for (const enabled of [!privacyBefore, privacyBefore]) {
    console.log(`    set ${enabled ? 'on' : 'off'}:`)
    await registrar.setPrivacy(name, enabled)
    console.log(`    read back: ${await flag('privacy')}`)
  }
}

// ── Transfer code ───────────────────────────────────────────────────────────
console.log('\n4. Transfer code')
const auth = await registrar.authCode(name)
console.log(auth.kind === 'found' ? `    ${auth.data.length} characters` : `    ${auth.kind}`)

// ── Contacts: the same details, saved again ────────────────────────────────
console.log('\n5. Contacts')
const before = await registrar.contacts(name)
if (before.kind !== 'found' || !before.data.registrant) {
  console.log(`    could not read the registrant (${before.kind})`)
} else {
  const held: RegistryContact = before.data.registrant
  console.log(`    roles: ${Object.keys(before.data).join(', ')}`)
  await registrar.updateContacts(name, {
    firstName: held.firstName,
    lastName: held.lastName,
    ...(held.company ? { company: held.company } : {}),
    email: held.email,
    phoneCountryCode: held.phoneCountryCode,
    phone: held.phone,
    addressLine1: held.address,
    city: held.city,
    state: held.state,
    zipCode: held.zipCode,
    country: held.country,
  })
  const after = await registrar.contacts(name)
  if (after.kind !== 'found' || !after.data.registrant) {
    console.log(`    could not read them back (${after.kind})`)
  } else {
    const same = sameContact(held, after.data.registrant)
    const changed = (Object.keys(held) as (keyof RegistryContact)[]).filter(
      (field) => held[field] !== after.data.registrant?.[field],
    )
    console.log(`    read back the same: ${same}`)
    if (changed.length) console.log(`    fields formatted differently: ${changed.join(', ')}`)
  }
}
