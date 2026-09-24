import { ArrowRight } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'
import { FormMessage } from '@/components/common/form-parts'
import {
  FOCUS,
  PANEL,
  PANEL_HEADING,
  PanelHeader,
  PanelPage,
  PanelSkeleton,
} from '@/components/layout/panel'
import { SessionsSection, SessionsSkeleton } from '@/features/auth/components/sessions-section'
import { ChangePasswordForm, ProfileForm } from '@/features/auth/components/settings-forms'
import { TwoFactorPanel } from '@/features/auth/components/two-factor-panel'
import { describeHold, resetHoldUntil } from '@/features/auth/lib/security'
import { getAccount } from '@/features/auth/queries/account'
import { getTwoFactorRequirement } from '@/features/auth/queries/two-factor'
import { cn } from '@/lib/utils'

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
      className={cn(PANEL, 'grid scroll-mt-20 gap-6 p-5 sm:p-7 xl:grid-cols-[1fr_2fr] xl:gap-12')}
    >
      <div>
        <h2 id={`${id}-heading`} className={PANEL_HEADING}>
          {title}
        </h2>
        <p className="mt-1.5 text-pretty text-sm/6 text-muted-foreground">{description}</p>
      </div>
      <div className="max-w-xl">{children}</div>
    </section>
  )
}

async function Settings() {
  const [account, twoFactor] = await Promise.all([getAccount(), getTwoFactorRequirement()])
  if (!account) return null
  const hold = resetHoldUntil(account.passwordResetAt, new Date())

  return (
    <>
      {hold ? (
        <FormMessage tone="error">
          Your password was reset. {describeHold(hold)} If you didn't reset it, contact support now.
        </FormMessage>
      ) : null}

      <div className="space-y-4">
        <Section
          id="profile"
          title="Profile"
          description="Your name, and your business details if you buy as a business."
        >
          <ProfileForm email={account.email} fullName={account.fullName} phone={account.phone} />
        </Section>
        <Section
          id="contacts"
          title="Contacts"
          description="Saved details for your domains’ registrant and their administrative, technical and billing contacts."
        >
          <Link
            href="/app/settings/contacts"
            className={cn(
              'inline-flex h-11 items-center gap-2 rounded-full border border-border bg-background px-5 text-sm font-medium text-foreground transition hover:bg-muted active:scale-[0.98]',
              FOCUS,
            )}
          >
            Manage contacts
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </Section>
        <Section
          id="labels"
          title="Labels"
          description="Coloured tags to group your domains by client or project, and to filter your domains list by."
        >
          <Link
            href="/app/settings/labels"
            className={cn(
              'inline-flex h-11 items-center gap-2 rounded-full border border-border bg-background px-5 text-sm font-medium text-foreground transition hover:bg-muted active:scale-[0.98]',
              FOCUS,
            )}
          >
            Manage labels
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
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
          <TwoFactorPanel
            factorId={account.totpFactor?.id ?? null}
            requiredFor={twoFactor?.required ? twoFactor.held : null}
          />
        </Section>
        <Section
          id="sessions"
          title="Where you're signed in"
          description="Every device signed in to your account. Sign out any you don't recognise."
        >
          <Suspense fallback={<SessionsSkeleton />}>
            <SessionsSection />
          </Suspense>
        </Section>
      </div>
    </>
  )
}

export default function SettingsPage() {
  return (
    <PanelPage>
      <PanelHeader
        crumbs={[
          { label: 'Home', href: '/' },
          { label: 'Dashboard', href: '/app/domains' },
          { label: 'Settings' },
        ]}
        title="Settings"
        description="Your profile, your saved contacts and labels, your password, two-factor sign-in and your devices — what keeps your account, and your domains, yours."
      />
      <Suspense fallback={<PanelSkeleton height="h-96" />}>
        <Settings />
      </Suspense>
    </PanelPage>
  )
}
