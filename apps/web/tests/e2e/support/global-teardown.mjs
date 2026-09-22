import { deleteAllTestUsers } from './accounts.mjs'

/** Belt and braces: no test account outlives the run, even an interrupted one. */
export default async function globalTeardown() {
  await deleteAllTestUsers()
}
