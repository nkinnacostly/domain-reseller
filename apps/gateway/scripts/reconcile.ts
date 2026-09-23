/**
 * One reconciliation pass now (PRD §13.5), against the side DNA_WRITE_ENV
 * names: the sandbox for `ote`, production for `production`. Read-only at
 * the supplier; records drift in the database and prints it.
 *
 *   pnpm --filter @dr/gateway reconcile
 */
import { getDnaWriteClient } from '../src/dna/client'
import { env } from '../src/env'
import { logger } from '../src/lib/logger'
import { createDnaRegistrar } from '../src/provisioning/registrar'
import { createSupabaseStore } from '../src/provisioning/store'
import { createReconciler } from '../src/reconcile/reconciler'
import { createReconcileStore } from '../src/reconcile/store'

const target = env.DNA_WRITE_ENV
if (target === 'off') {
  console.error('DNA_WRITE_ENV is off: set it to ote (sandbox) or production to choose a side.')
  process.exit(1)
}

const calls = createSupabaseStore()
const reconciler = createReconciler({
  store: createReconcileStore(),
  reader: createDnaRegistrar({
    client: getDnaWriteClient(target),
    environment: target,
    audit: (call) => calls.recordCall(null, target, call),
  }),
  testMode: target === 'ote',
  everyMs: env.RECONCILE_EVERY_MINUTES * 60_000,
  log: logger,
})

const result = await reconciler.runOnce({ force: true })
if (result.status === 'done') {
  console.log(
    `\n${target}: ${result.seen} domains at the registry, ${result.findings.length} findings`,
  )
  for (const finding of result.findings) {
    console.log(
      `  ${finding.kind.padEnd(22)} ${finding.domainName}  ${JSON.stringify(finding.detail)}`,
    )
  }
} else {
  console.log(`\n${target}: ${result.status}${'reason' in result ? ` — ${result.reason}` : ''}`)
  process.exitCode = result.status === 'failed' ? 1 : 0
}
