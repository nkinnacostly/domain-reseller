import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup/vitest.setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    css: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: [
        'src/features/**/*.{ts,tsx}',
        'src/lib/**/*.ts',
        'src/components/common/**/*.tsx',
        'src/components/layout/**/*.tsx',
        'src/proxy.ts',
      ],
      exclude: ['**/*.test.{ts,tsx}', '**/__tests__/**', '**/index.ts', 'src/components/ui/**'],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
  resolve: {
    // Subpaths (`@dr/shared/mail`) before the bare name, as in apps/web.
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      {
        find: 'server-only',
        replacement: fileURLToPath(new URL('./tests/setup/server-only.ts', import.meta.url)),
      },
      {
        find: /^@dr\/shared\/(.+)$/,
        replacement: fileURLToPath(
          new URL('../../packages/shared/src/$1/index.ts', import.meta.url),
        ),
      },
      {
        find: /^@dr\/shared$/,
        replacement: fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
      },
      {
        find: /^@dr\/db$/,
        replacement: fileURLToPath(new URL('../../packages/db/src/index.ts', import.meta.url)),
      },
    ],
  },
})
