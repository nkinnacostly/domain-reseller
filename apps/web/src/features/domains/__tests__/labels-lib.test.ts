import { describe, expect, it } from 'vitest'
import {
  asLabelColor,
  LABEL_COLORS,
  labelColorSchema,
  labelNameSchema,
  labelWriteError,
  parseLabelFilter,
  sortLabels,
  toLabel,
} from '../lib/labels'

describe('label names and colours (FR-P3, migration 32)', () => {
  it('refuses an empty name and one past 30 characters, as the database does', () => {
    expect(labelNameSchema.safeParse('   ').success).toBe(false)
    expect(labelNameSchema.safeParse('x'.repeat(31)).error?.issues[0]?.message).toBe(
      'Keep it to 30 characters.',
    )
    expect(labelNameSchema.parse('  Acme Ltd  ')).toBe('Acme Ltd')
    expect(labelNameSchema.parse('x'.repeat(30))).toHaveLength(30)
  })

  it('takes only the six named colours — never a hex from the browser (S2)', () => {
    expect(LABEL_COLORS).toEqual(['blue', 'green', 'amber', 'red', 'purple', 'slate'])
    expect(labelColorSchema.safeParse('#ff0000').success).toBe(false)
    expect(labelColorSchema.parse('amber')).toBe('amber')
  })

  it('shows an unknown stored colour as slate rather than breaking the page', () => {
    expect(asLabelColor('red')).toBe('red')
    expect(asLabelColor('magenta')).toBe('slate')
    expect(toLabel({ id: 'l1', name: 'Acme', color: 'teal' })).toEqual({
      id: 'l1',
      name: 'Acme',
      color: 'slate',
    })
  })

  it('sorts by name the way a person reads, whatever the case, numbers in order', () => {
    const sorted = sortLabels([
      { name: 'client 10' },
      { name: 'Acme' },
      { name: 'client 2' },
      { name: 'banks' },
    ])
    expect(sorted.map((label) => label.name)).toEqual(['Acme', 'banks', 'client 2', 'client 10'])
  })
})

describe('labelWriteError', () => {
  it('names the duplicate, when it knows it', () => {
    expect(labelWriteError({ code: '23505' }, 'Acme')).toBe(
      'You already have a label called “Acme”.',
    )
    expect(labelWriteError({ code: '23505' })).toBe('You already have a label with that name.')
  })

  it('says the account is at its 50-label limit', () => {
    expect(labelWriteError({ code: '23514' }, 'One more')).toBe(
      'An account can have up to 50 labels.',
    )
  })

  it('falls back to try again for anything else', () => {
    expect(labelWriteError({ code: '08006' })).toBe(
      'That label could not be saved. Please try again.',
    )
    expect(labelWriteError(null)).toBe('That label could not be saved. Please try again.')
  })
})

describe('parseLabelFilter (?label=)', () => {
  const labels = [{ id: 'label-1' }, { id: 'label-2' }]
  it('filters only by one of the account’s own labels', () => {
    expect(parseLabelFilter('label-2', labels)).toBe('label-2')
    expect(parseLabelFilter('someone-elses', labels)).toBeNull()
    expect(parseLabelFilter(undefined, labels)).toBeNull()
    expect(parseLabelFilter('', labels)).toBeNull()
  })
})
