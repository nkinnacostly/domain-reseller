import { deleteAllTestUsers, deleteTestCarts, purgeTestLedgerEntries } from './accounts.mjs'

/**
 * Belt and braces: no test account, test cart or seeded test ledger row
 * outlives the run, even an interrupted one. E2E_KEEP_OTHERS=1 skips the
 * sweep, for when another run shares the database: it would delete that
 * run's accounts mid-test. Each test still removes its own.
 */
export default async function globalTeardown() {
  if (process.env.E2E_KEEP_OTHERS === '1') return
  await deleteTestCarts()
  await purgeTestLedgerEntries()
  await deleteAllTestUsers()
}
