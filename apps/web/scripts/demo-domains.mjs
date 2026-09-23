/**
 * Adds (or removes) demo domains on an account, so the management screens can
 * be tried before registration is switched on. Every row is `source = 'demo'`
 * and shows a "Demo" badge. Nothing here touches the registrar.
 *
 *   pnpm --filter @dr/web demo:domains -- you@example.com
 *   pnpm --filter @dr/web demo:domains -- you@example.com --remove
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { createDemoDomain } from '../tests/e2e/support/accounts.mjs'

const [email, flag] = process.argv.slice(2).filter((arg) => arg !== '--')
if (!email) {
  console.error('Usage: demo:domains -- <account email> [--remove]')
  process.exit(1)
}

for (const line of readFileSync(
  fileURLToPath(new URL('../../../.env', import.meta.url)),
  'utf8',
).split('\n')) {
  const [key, ...rest] = line.trim().split('=')
  if (key && !key.startsWith('#') && rest.length && !process.env[key])
    process.env[key] = rest.join('=')
}
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
})

const { data: profile } = await admin
  .from('profiles')
  .select('id')
  .eq('email', email.toLowerCase())
  .maybeSingle()
if (!profile) {
  console.error(`No account for ${email}`)
  process.exit(1)
}

if (flag === '--remove') {
  const { count } = await admin
    .from('domains')
    .delete({ count: 'exact' })
    .eq('user_id', profile.id)
    .eq('source', 'demo')
  console.log(`Removed ${count ?? 0} demo domains.`)
  process.exit(0)
}

const stem =
  email
    .split('@')[0]
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
    .slice(0, 20) || 'demo'
const made = [
  await createDemoDomain(profile.id, { name: `${stem}-demo.com`, expiresInDays: 240 }),
  await createDemoDomain(profile.id, {
    name: `${stem}-shop-demo.com`,
    expiresInDays: 12,
    autoRenew: false,
  }),
  await createDemoDomain(profile.id, { name: `${stem}-demo.africa`, expiresInDays: 70 }),
  await createDemoDomain(profile.id, {
    name: `${stem}-old-demo.com`,
    status: 'expired_grace',
    expiresInDays: -6,
  }),
]
console.log(`Added ${made.length} demo domains: ${made.map((domain) => domain.name).join(', ')}`)
