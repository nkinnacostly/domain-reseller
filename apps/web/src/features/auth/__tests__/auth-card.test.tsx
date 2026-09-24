import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AuthCard, AuthCardSkeleton } from '../components/auth-card'

describe('AuthCard', () => {
  it('states the page’s one job as its heading, with the form beneath', () => {
    render(
      <AuthCard
        title="Sign in"
        description="Welcome back."
        footer={<a href="/sign-up">Create an account</a>}
      >
        <form aria-label="Sign in form" />
      </AuthCard>,
    )
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument()
    expect(screen.getByText('Welcome back.')).toBeInTheDocument()
    expect(screen.getByRole('form', { name: 'Sign in form' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Create an account' })).toBeInTheDocument()
  })

  it('leaves out the description and footer when there are none', () => {
    const { container } = render(
      <AuthCard title="Check your email">
        <p>Body</p>
      </AuthCard>,
    )
    expect(container.querySelectorAll('p')).toHaveLength(1)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})

describe('AuthCardSkeleton', () => {
  it('holds the space while loading without being read out', () => {
    const { container } = render(<AuthCardSkeleton />)
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true')
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
  })
})
