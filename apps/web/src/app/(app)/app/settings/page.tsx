import type { Metadata } from 'next'
import { Suspense } from 'react'
import { FormMessage } from '@/components/common/form-parts'
import { Container } from '@/components/layout/site-shell'
import { ChangePasswordForm, ProfileForm } from '@/features/auth/components/settings-forms'
import { TwoFactorPanel } from '@/features/auth/components/two-factor-panel'
import { describeHold, resetHoldUntil } from '@/features/auth/lib/security'
import { getAccount } from '@/features/auth/queries/account'

export const metadata: Metadata = { title: 'Settings' }

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-heading`}
      className="grid scroll-mt-8 gap-6 border-border border-t py-10 lg:grid-cols-[1fr_2fr] lg:gap-12"
    >
      <div>
        <h2 id={`${id}-heading`} className="text-lg font-semibold text-foreground">
          {title}
        </h2>
        <p className="mt-1.5 text-pretty text-sm/6 text-muted-foreground">{description}</p>
      </div>
      <div className="max-w-xl">{children}</div>
    </section>
  )
}

async function Settings() {
  const account = await getAccount()
  if (!account) return null
  const hold = resetHoldUntil(account.passwordResetAt, new Date())

  return (
    <>
      {hold ? (
        <FormMessage tone="error" className="mt-6">
          Your password was reset. {describeHold(hold)} If you didn't reset it, contact support now.
        </FormMessage>
      ) : null}

      <div className="mt-8">
        <Section id="profile" title="Profile" description="Who you are on invoices and reminders.">
          <ProfileForm email={account.email} fullName={account.fullName} phone={account.phone} />
        </Section>
        <Section
          id="password"
          title="Password"
          description="Changing it signs you out everywhere else."
        >
          <ChangePasswordForm />
        </Section>
        <Section
          id="two-factor"
          title="Two-factor authentication"
          description="A code from an app on your phone, needed to sign in and to make changes to your domains."
        >
          <TwoFactorPanel factorId={account.totpFactor?.id ?? null} />
        </Section>
      </div>
    </>
  )
}

export default function SettingsPage() {
  return (
    <Container className="py-10 sm:py-14">
      <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Settings</h1>
      <Suspense
        fallback={
          <div aria-hidden="true" className="mt-8 h-96 animate-pulse rounded-3xl bg-muted" />
        }
      >
        <Settings />
      </Suspense>
    </Container>
  )
}
