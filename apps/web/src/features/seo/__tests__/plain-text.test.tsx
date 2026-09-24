import { describe, expect, it } from 'vitest'
import { EmailLink } from '@/features/legal/components/legal-page'
import { plainText } from '../lib/plain-text'

describe('plainText', () => {
  it('reads nested markup as the words it shows, spaced as a browser would', () => {
    expect(
      plainText(
        <p>
          Type the name into the <a href="/">search</a>.{'  '}
          <strong>Then</strong> pay {5} {null} {false}
        </p>,
      ),
    ).toBe('Type the name into the search. Then pay 5')
  })

  it('renders a component that shows its own text, such as the contact address', () => {
    expect(
      plainText(
        <p>
          Email <EmailLink />.
        </p>,
      ),
    ).toBe('Email hello@mydomainshub.com.')
  })
})
