import { deleteAllTestUsers, deleteTestCarts } from './accounts.mjs'

/** Belt and braces: no test account or test cart outlives the run, even an interrupted one. */
export default async function globalTeardown() {
  await deleteTestCarts()
  await deleteAllTestUsers()
}
