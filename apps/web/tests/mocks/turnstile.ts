import { act } from '@testing-library/react'
import { vi } from 'vitest'
import type { TurnstileApi } from '@/components/common/turnstile'

type Options = Parameters<TurnstileApi['render']>[1]

/**
 * A stand-in for Cloudflare's Turnstile script (SEC-9) — the browser-side
 * network boundary. Widgets render into it; a test then plays Cloudflare:
 * hands out a token, reports an error, or asks for a click.
 */
export function installTurnstile() {
  const widgets: { container: HTMLElement; options: Options }[] = []
  const api = {
    render: vi.fn((container: HTMLElement, options: Options) => {
      widgets.push({ container, options })
      return `widget-${widgets.length}`
    }),
    reset: vi.fn(),
    remove: vi.fn(),
  }
  window.turnstile = api

  const last = () => {
    const widget = widgets.at(-1)
    if (!widget) throw new Error('no Turnstile widget was rendered')
    return widget
  }

  return {
    api,
    widgets,
    /** The options the most recent widget was drawn with. */
    options: () => last().options,
    solve: (token = 'token-from-cloudflare') => act(() => last().options.callback(token)),
    fail: () => act(() => last().options['error-callback']()),
    expire: () => act(() => last().options['expired-callback']()),
    askForClick: () => act(() => last().options['before-interactive-callback']()),
    clicked: () => act(() => last().options['after-interactive-callback']()),
  }
}

export function uninstallTurnstile() {
  delete window.turnstile
  for (const script of document.querySelectorAll('script[src*="challenges.cloudflare.com"]')) {
    script.remove()
  }
}
