/**
 * Production build: one bundled dist/server.js, as the gateway's and the mail worker's
 * (CLAUDE.md §15). The workspace packages are TypeScript source, so esbuild
 * bundles them with our code; npm dependencies stay in node_modules.
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
