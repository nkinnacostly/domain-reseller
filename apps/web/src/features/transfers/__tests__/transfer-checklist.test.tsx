import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TransferChecklist } from '../components/transfer-checklist'
import type { TransferCheck } from '../lib/eligibility'

const checks: TransferCheck[] = [
  {
    id: 'extension',
    state: 'pass',
    title: 'We take transfers for .com',
    detail: 'Yes.',
    unblocksAt: null,
  },
  {
    id: 'unlocked',
    state: 'fail',
    title: 'Transfer lock is off',
    detail: 'It is locked.',
    unblocksAt: null,
  },
  {
    id: 'auth-code',
    state: 'manual',
    title: 'You have the auth code',
    detail: 'Ask.',
    unblocksAt: null,
  },
]

describe('TransferChecklist', () => {
  it('states every result in words, never by colour alone', () => {
    render(<TransferChecklist checks={checks} />)
    const items = within(screen.getByRole('list', { name: 'Transfer checklist' })).getAllByRole(
      'listitem',
    )

    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent('We take transfers for .comDone')
    expect(items[1]).toHaveTextContent('Transfer lock is offBlocked')
    expect(items[2]).toHaveTextContent('You have the auth codeCheck yourself')
  })

  it('shows the reason under each item', () => {
    render(<TransferChecklist checks={checks} />)
    expect(screen.getByText('It is locked.')).toBeInTheDocument()
  })
})
