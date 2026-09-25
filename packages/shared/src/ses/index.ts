// Server-only: never import `@dr/shared/ses` from a client component. It is
// deliberately not re-exported from the package root, which the browser uses.
export * from './client'
export type { Fetch, FetchInit, FetchResponse } from './platform'
export * from './sigv4'
