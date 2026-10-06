import { render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTurnstile, uninstallTurnstile } from '../../../tests/mocks/turnstile'
import type { TurnstileHandle } from './turnstile'

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

/** env.ts reads the site key once, at import — so each case loads the component fresh. */
async function load(siteKey: string | null = 'site-key') {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', siteKey ?? undefined)
  return import('./turnstile')
}

const scripts = () => document.querySelectorAll(`script[src="${SCRIPT}"]`)
const tokenField = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]')

beforeEach(() => uninstallTurnstile())
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('Turnstile — without a site key (SEC-9)', () => {
  it('draws nothing and loads nothing, so forms work as before', async () => {
    const { Turnstile, hasTurnstile } = await load(null)
    const { container } = render(<Turnstile action="sign-up" />)

    expect(container).toBeEmptyDOMElement()
    expect(scripts()).toHaveLength(0)
    expect(hasTurnstile()).toBe(false)
  })
})

describe('Turnstile — loading Cloudflare’s script', () => {
  it('loads it once however many widgets ask, and draws each when it arrives', async () => {
    const { Turnstile } = await load()
    render(
      <>
        <Turnstile action="one" />
        <Turnstile action="two" />
      </>,
    )

    expect(scripts()).toHaveLength(1)
    const cloudflare = installTurnstile()
    scripts()[0]?.dispatchEvent(new Event('load'))

    await vi.waitFor(() => expect(cloudflare.api.render).toHaveBeenCalledTimes(2))
  })

  it('reports a script that did not load, and tries it again on reset', async () => {
    const { Turnstile } = await load()
    const onError = vi.fn()
    const handle = createRef<TurnstileHandle>()
    render(<Turnstile ref={handle} action="sign-up" onError={onError} />)

    scripts()[0]?.dispatchEvent(new Event('error'))
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    expect(scripts()).toHaveLength(0)

    handle.current?.reset()
    await vi.waitFor(() => expect(scripts()).toHaveLength(1))
  })

  it('treats a script that loaded without Turnstile in it as not loaded', async () => {
    const { Turnstile } = await load()
    const onError = vi.fn()
    render(<Turnstile action="sign-up" onError={onError} />)

    scripts()[0]?.dispatchEvent(new Event('load'))
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
  })
})

describe('Turnstile — the widget', () => {
  it('is drawn explicitly, out of sight unless Cloudflare wants a click, in the page’s theme', async () => {
    const { Turnstile } = await load()
    const cloudflare = installTurnstile()
    render(<Turnstile action="sign-up" />)

    await vi.waitFor(() => expect(cloudflare.api.render).toHaveBeenCalled())
    expect(cloudflare.options()).toMatchObject({
      sitekey: 'site-key',
      action: 'sign-up',
      appearance: 'interaction-only',
      theme: 'auto',
      'response-field': false,
    })
  })

  it.each([
    [280, 'compact'],
    [299, 'compact'],
    [300, 'flexible'],
    [640, 'flexible'],
  ])(
    'in a %ipx container uses the %s size, so nothing overflows at 320px (S6)',
    async (width, size) => {
      const { Turnstile } = await load()
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width)
      const cloudflare = installTurnstile()
      render(<Turnstile action="sign-up" />)

      await vi.waitFor(() => expect(cloudflare.api.render).toHaveBeenCalled())
      expect(cloudflare.options().size).toBe(size)
    },
  )

  it('puts the token in the form under Cloudflare’s field name, and hands it on', async () => {
    const { Turnstile, turnstileInput } = await load()
    const cloudflare = installTurnstile()
    const onToken = vi.fn()
    render(
      <form aria-label="Sign up">
        <Turnstile action="sign-up" onToken={onToken} />
      </form>,
    )
    await vi.waitFor(() => expect(cloudflare.api.render).toHaveBeenCalled())

    cloudflare.solve('token-1')

    const form = new FormData(screen.getByRole('form', { name: 'Sign up' }) as HTMLFormElement)
    expect(form.get('cf-turnstile-response')).toBe('token-1')
    expect(turnstileInput(form)).toEqual({ turnstileToken: 'token-1' })
    expect(onToken).toHaveBeenCalledWith('token-1')
  })

  it('asks for a fresh token on reset, and forgets the spent one', async () => {
    const { Turnstile } = await load()
    const cloudflare = installTurnstile()
    const handle = createRef<TurnstileHandle>()
    const { container } = render(<Turnstile ref={handle} action="sign-up" />)
    await vi.waitFor(() => expect(cloudflare.api.render).toHaveBeenCalled())
    cloudflare.solve('spent')

    handle.current?.reset()

    await vi.waitFor(() => expect(tokenField(container)).toHaveValue(''))
    expect(cloudflare.api.reset).toHaveBeenCalledWith('widget-1')
  })

  it('drops a token that expired', async () => {
    const { Turnstile } = await load()
    const cloudflare = installTurnstile()
    const { container } = render(<Turnstile action="sign-up" />)
    await vi.waitFor(() => expect(cloudflare.api.render).toHaveBeenCalled())
    cloudflare.solve('old')

    cloudflare.expire()

    expect(tokenField(container)).toHaveValue('')
  })

  it('reports a check Cloudflare could not finish, and sends no token', async () => {
    const { Turnstile } = await load()
    const cloudflare = installTurnstile()
    const onError = vi.fn()
    const { container } = render(<Turnstile action="sign-up" onError={onError} />)
    await vi.waitFor(() => expect(cloudflare.api.render).toHaveBeenCalled())
    cloudflare.solve('partial')

    cloudflare.fail()

    expect(onError).toHaveBeenCalledTimes(1)
    expect(tokenField(container)).toHaveValue('')
  })

  it('takes up room only while Cloudflare asks for a click', async () => {
    const { Turnstile } = await load()
    const cloudflare = installTurnstile()
    const { container } = render(<Turnstile action="sign-up" className="data-interactive:mb-4" />)
    await vi.waitFor(() => expect(cloudflare.api.render).toHaveBeenCalled())
    const wrapper = container.firstElementChild

    expect(wrapper).not.toHaveAttribute('data-interactive')
    cloudflare.askForClick()
    expect(wrapper).toHaveAttribute('data-interactive', 'true')
    cloudflare.clicked()
    expect(wrapper).not.toHaveAttribute('data-interactive')
  })

  it('removes its widget when it leaves the page', async () => {
    const { Turnstile } = await load()
    const cloudflare = installTurnstile()
    const { unmount } = render(<Turnstile action="sign-up" />)
    await vi.waitFor(() => expect(cloudflare.api.render).toHaveBeenCalled())

    unmount()

    expect(cloudflare.api.remove).toHaveBeenCalledWith('widget-1')
  })

  it('sends nothing for a form without a token', async () => {
    const { turnstileInput } = await load()
    expect(turnstileInput(new FormData())).toEqual({})
  })
})
