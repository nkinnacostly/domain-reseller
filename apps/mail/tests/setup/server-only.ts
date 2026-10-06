/**
 * Stand-in for `server-only` under Vitest. Next resolves the real package from
 * its own bundle, so Vite cannot find it; in a test, server-side is the only
 * side there is. The guard still applies to every real build.
 */
export {}
