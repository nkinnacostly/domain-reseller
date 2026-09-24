import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { HELP_TOPICS } from '../components/help-topics'

/** One answer's text, found by its question (N9b: copy says what the code does). */
function answer(question: string): string {
  const found = HELP_TOPICS.flatMap((topic) => topic.questions).find(
    (entry) => entry.q === question,
  )
  if (!found) throw new Error(`No help question "${question}"`)
  return render(<div>{found.a}</div>).container.textContent ?? ''
}

describe('help centre — limits and two-factor, as the code enforces them', () => {
  it('explains the daily limit without quoting numbers the database can change (SEC-11)', () => {
    const text = answer('Is there a limit on how many domains I can buy?')
    expect(text).toMatch(/registrations and transfers in count, over the last 24 hours/)
    expect(text).toMatch(/renewals never do/)
    expect(text).toMatch(/rises by itself after your first paid order/)
    expect(text).toMatch(/before you are charged anything/)
    expect(text).toContain('hello@mydomainshub.com')
    // The caps and ages live in ops_settings; checkout states them. Only the
    // 24-hour window is fixed (migration 32).
    expect(text.replace('24 hours', '')).not.toMatch(/\d/)
  })

  it('states when two-factor is required, and that renewals are never held up (FR-A2)', () => {
    const text = answer('Should I turn on two-factor authentication?')
    expect(text).toMatch(
      /required for sensitive changes: nameservers, turning the transfer lock off/,
    )
    expect(text).toMatch(/Once your account holds more than 10 domains it is required to add more/)
    expect(text).toMatch(/you cannot order new domains or transfer more in/)
    expect(text).toMatch(/Renewals are never held up/)
  })
})
