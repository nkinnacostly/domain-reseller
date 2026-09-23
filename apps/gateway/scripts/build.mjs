/**
 * Production build: one bundled dist/server.js.
 *
 * `tsc` alone cannot produce a runnable gateway: the workspace packages
 * (@dr/shared, @dr/db) are TypeScript source, and its ESM output keeps
 * extensionless imports Node will not resolve. esbuild bundles our code and
 * the workspace packages, and leaves npm dependencies to node_modules.
 */
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const external = Object.keys(pkg.dependencies).filter((name) => !name.startsWith('@dr/'))

await build({
  entryPoints: [new URL('../src/server.ts', import.meta.url).pathname],
  outfile: new URL('../dist/server.js', import.meta.url).pathname,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external,
  sourcemap: true,
  logLevel: 'info',
})
