import { describe, expect, it } from 'vitest'
import { createLogger } from './logger'

describe('the logger (N13, MR4)', () => {
  it('strikes out a password, an address, a subject or a body if one is ever passed', () => {
    const lines: string[] = []
    const log = createLogger('info', { write: (line: string) => lines.push(line) })
    log.info(
      {
        emailId: 'e-1',
        auth: { password: 'mdh_live_secret' },
        to: ['ada@example.com'],
        email: { subject: 'Your receipt', html: '<p>Hi</p>' },
      },
      'smtp queued',
    )
    const line = lines.join('')
    expect(line).toContain('e-1')
    for (const secret of ['mdh_live_secret', 'ada@example.com', 'Your receipt', '<p>Hi</p>']) {
      expect(line).not.toContain(secret)
    }
  })

  it('is built at the level asked for', () => {
    expect(createLogger('warn').level).toBe('warn')
  })
})
