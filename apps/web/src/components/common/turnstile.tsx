'use client'

import { useEffect, useImperativeHandle, useRef, useState } from 'react'
import { env } from '@/lib/env'
import { cn } from '@/lib/utils'

/**
 * Cloudflare Turnstile (PRD SEC-9), drawn explicitly inside a form so its
 * token travels in the FormData, and verified on our server
 * (lib/turnstile.ts).
 *
 * `interaction-only`: most people never see it — it appears only when
 * Cloudflare needs a click. Its flexible size is at least 300 px wide, too
 * wide for a card at 320 px (S6), so a narrow container gets the compact one.
 * A token is spent by the server's check, so a form resets the widget after a
 * refused submit to get a fresh one. Without a site key it draws nothing and
 * the server checks nothing.
 */

/** Cloudflare's own name for the token field; the forms read it from here. */
export const TURNSTILE_FIELD = 'cf-turnstile-response'

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
const FLEXIBLE_MIN_PX = 300

type RenderOptions = {
  sitekey: string
  action: string
  appearance: 'interaction-only'
  theme: 'auto'
  size: 'compact' | 'flexible'
  'response-field': boolean
  callback: (token: string) => void
  'expired-callback': () => void
  'error-callback': () => void
  'before-interactive-callback': () => void
  'after-interactive-callback': () => void
}

export type TurnstileApi = {
  render: (container: HTMLElement, options: RenderOptions) => string | null | undefined
  reset: (widgetId: string) => void
  remove: (widgetId: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

let loading: Promise<TurnstileApi> | null = null

/** Cloudflare's script, loaded once however many widgets ask for it. */
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = SCRIPT_SRC
    script.async = true
    script.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile missing'))
    script.onerror = () => reject(new Error('Turnstile did not load'))
    document.head.append(script)
  }).catch((error: unknown) => {
    // A blocked request may not stay blocked: let the next widget try again.
    loading = null
    document.querySelector(`script[src="${SCRIPT_SRC}"]`)?.remove()
    throw error
  })
  return loading
}

/** Whether this build draws the widget at all. */
export function hasTurnstile(): boolean {
  return Boolean(env.NEXT_PUBLIC_TURNSTILE_SITE_KEY)
}

/** The token for an action's input, or nothing when there is none to send. */
export function turnstileInput(form: FormData): { turnstileToken?: string } {
  const token = form.get(TURNSTILE_FIELD)
  return typeof token === 'string' && token ? { turnstileToken: token } : {}
}

export type TurnstileHandle = {
  /** Ask for a fresh token — the last one was spent, or refused. */
  reset: () => void
}

export function Turnstile({
  ref,
  action,
  onToken,
  onError,
  className,
}: {
  ref?: React.Ref<TurnstileHandle>
  /** Names the form in Cloudflare's analytics. */
  action: string
  onToken?: (token: string) => void
  /** The script did not load, or Cloudflare could not finish the check. */
  onError?: () => void
  className?: string
}) {
  const siteKey = env.NEXT_PUBLIC_TURNSTILE_SITE_KEY
  const container = useRef<HTMLDivElement>(null)
  const widget = useRef<string | null>(null)
  const [token, setToken] = useState('')
  const [isInteractive, setIsInteractive] = useState(false)
  // Bumped to try the script again when it never loaded.
  const [attempt, setAttempt] = useState(0)
  const handlers = useRef({ onToken, onError })
  useEffect(() => {
    handlers.current = { onToken, onError }
  })

  useImperativeHandle(
    ref,
    () => ({
      reset() {
        setToken('')
        if (widget.current && window.turnstile) window.turnstile.reset(widget.current)
        else setAttempt((n) => n + 1)
      },
    }),
    [],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is how reset() loads a script that failed
  useEffect(() => {
    const element = container.current
    if (!siteKey || !element) return
    let isLive = true
    loadTurnstile().then(
      (turnstile) => {
        if (!isLive) return
        widget.current =
          turnstile.render(element, {
            sitekey: siteKey,
            action,
            appearance: 'interaction-only',
            theme: 'auto',
            size: element.clientWidth < FLEXIBLE_MIN_PX ? 'compact' : 'flexible',
            // Our own hidden field below carries the token, so a reset clears it.
            'response-field': false,
            callback: (value) => {
              setToken(value)
              handlers.current.onToken?.(value)
            },
            'expired-callback': () => setToken(''),
            'error-callback': () => {
              setToken('')
              handlers.current.onError?.()
            },
            'before-interactive-callback': () => setIsInteractive(true),
            'after-interactive-callback': () => setIsInteractive(false),
          }) ?? null
      },
      () => {
        if (isLive) handlers.current.onError?.()
      },
    )
    return () => {
      isLive = false
      if (widget.current) window.turnstile?.remove(widget.current)
      widget.current = null
    }
  }, [siteKey, action, attempt])

  if (!siteKey) return null
  return (
    <div data-interactive={isInteractive || undefined} className={cn('w-full', className)}>
      <div ref={container} />
      <input type="hidden" name={TURNSTILE_FIELD} value={token} />
    </div>
  )
}
