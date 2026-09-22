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
      include: ['src/features/**/*.{ts,tsx}', 'src/lib/**/*.ts', 'src/components/common/**/*.tsx'],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/__tests__/**',
        '**/index.ts',
        'src/components/ui/**',
        'src/components/kibo-ui/**',
      ],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      'server-only': fileURLToPath(new URL('./tests/setup/server-only.ts', import.meta.url)),
      '@dr/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
      '@dr/db': fileURLToPath(new URL('../../packages/db/src/index.ts', import.meta.url)),
    },
  },
})
