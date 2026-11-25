import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ReviewScreening } from '@/features/admin/components/screening/review-screening'
import { screenedSummary } from '@/features/admin/lib/screening-copy'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
vi.mock('@/features/admin/actions/screening', () => ({ reviewScreening: vi.fn() }))

describe('ReviewScreening', () => {
  it('offers "Looks fine" and "Abuse", each asking before it records', () => {
    render(
      <ReviewScreening
        orderItemId="3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f"
        domain="paypal-login.com"
        matched={['paypal', 'login']}
        note="Imitates a PayPal sign-in page"
      />,
    )
    expect(screen.getByRole('button', { name: 'Looks fine' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Abuse' })).toBeEnabled()
  })
})

describe('screenedSummary', () => {
  it('says how many were screened and cleared', () => {
    expect(screenedSummary(0, 0)).toBe('No names screened in the last 30 days.')
    expect(screenedSummary(1, 1)).toBe(
      '1 name screened in the last 30 days; 1 cleared without a person.',
    )
    expect(screenedSummary(30, 28)).toBe(
      '30 names screened in the last 30 days; 28 cleared without a person.',
    )
  })
})
