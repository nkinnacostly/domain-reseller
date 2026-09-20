import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, vi } from 'vitest'
import { server } from '../mocks/server'

// Env the app validates at import time.
process.env.NEXT_PUBLIC_APP_URL ??= 'http://localhost:3000'
process.env.NEXT_PUBLIC_APP_NAME ??= 'Domain Reseller'
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://127.0.0.1:54321'
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??= 'test-anon-key'
process.env.LOG_LEVEL ??= 'silent'
process.env.SKIP_ENV_VALIDATION = 'true'

// Unhandled requests fail loudly — a test must never hit the real network.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  cleanup()
  server.resetHandlers()
})
afterAll(() => server.close())

// jsdom gaps that Radix and Base UI rely on.
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

window.HTMLElement.prototype.scrollIntoView = vi.fn()
window.HTMLElement.prototype.hasPointerCapture = vi.fn()
window.HTMLElement.prototype.releasePointerCapture = vi.fn()

global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
