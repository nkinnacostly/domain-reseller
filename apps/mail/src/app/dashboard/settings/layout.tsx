import { Container } from '@/components/layout/container'
import { SettingsNav } from '@/features/accounts/components/settings-nav'

/** Settings (MAIL-SPEC §10): a heading, its sections as tabs, and the section. */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <Container className="py-6 sm:py-8">
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Settings</h1>
      <div className="mt-5">
        <SettingsNav />
      </div>
      <div className="mt-6">{children}</div>
    </Container>
  )
}
