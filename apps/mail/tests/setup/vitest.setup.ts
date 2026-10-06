import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, vi } from 'vitest'
import { server } from '../mocks/server'

// Env the app validates at import time — test values only; never a real key.
process.env.NEXT_PUBLIC_MAIL_URL ??= 'http://localhost:3001'
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321'
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'test-publishable-key'
process.env.SUPABASE_SECRET_KEY = 'sb_test'
process.env.MAIL_API_KEY_PEPPER = 'test-pepper-of-at-least-thirty-two-characters'
process.env.LOG_LEVEL = 'silent'
process.env.SKIP_ENV_VALIDATION = 'true'

// Unhandled requests fail loudly — a test must never reach the real network.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  cleanup()
  server.resetHandlers()
})
afterAll(() => server.close())

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})
