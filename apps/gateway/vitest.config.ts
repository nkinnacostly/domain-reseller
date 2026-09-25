import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/test-setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/server.ts', 'src/test-setup.ts'],
      thresholds: { lines: 85, functions: 85, branches: 80, statements: 85 },
    },
  },
  resolve: {
    // Subpaths (`@dr/shared/ses`) first, so the bare name does not swallow them.
    alias: [
      {
        find: /^@dr\/shared\/(.+)$/,
        replacement: new URL('../../packages/shared/src/$1/index.ts', import.meta.url).pathname,
      },
      {
        find: /^@dr\/shared$/,
        replacement: new URL('../../packages/shared/src/index.ts', import.meta.url).pathname,
      },
    ],
  },
})
