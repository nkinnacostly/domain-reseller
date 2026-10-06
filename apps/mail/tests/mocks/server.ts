import { setupServer } from 'msw/node'

/**
 * The network boundary for Mail's unit and integration tests. Each test
 * installs the Supabase answers it needs (`supabase.ts`); any request no
 * handler answers fails the test — a test never reaches a real service.
 */
export const server = setupServer()
