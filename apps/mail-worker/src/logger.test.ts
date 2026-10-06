import { describe, expect, it } from 'vitest'
import { createLogger } from './logger'
import { realClock } from './pacing'

describe('the logger (N13, MR4)', () => {
  it('strikes out an address, a subject or a body if one is ever passed', () => {
    const lines: string[] = []
    const log = createLogger('info', { write: (line: string) => lines.push(line) })
    log.info(
      {
        emailId: 'e-1',
        to: ['ada@example.com'],
        email: { subject: 'Your receipt', html: '<p>Hi</p>' },
      },
      'mail sent',
    )
    const line = lines.join('')
    expect(line).toContain('e-1')
    expect(line).not.toContain('ada@example.com')
    expect(line).not.toContain('Your receipt')
    expect(line).not.toContain('<p>Hi</p>')
  })

  it('is built at the level asked for', () => {
    expect(createLogger('warn').level).toBe('warn')
  })
})

describe('the real clock', () => {
  it('tells the time and waits', async () => {
    const before = realClock.now()
    await realClock.sleep(5)
    expect(realClock.now()).toBeGreaterThanOrEqual(before + 4)
  })
})
