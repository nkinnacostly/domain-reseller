import { StatusPill } from '@/components/common/status-pill'

/**
 * The sandbox's sending address (MAIL-SPEC §7.2): while the account is in
 * the sandbox it may send from our shared address, only to its own members'
 * confirmed addresses. Shown only once it is joined to this account's own
 * tenant (its sandbox row is live, migration 47) — before that there is
 * nothing to say that is true for this account (N9b).
 */
export function SandboxSender({ fromAddress }: { fromAddress: string }) {
  return (
    <section
      aria-labelledby="sandbox-sender-heading"
      className="rounded-3xl border border-border bg-card p-5 sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="sandbox-sender-heading" className="font-semibold">
          Sandbox sending address
        </h2>
        <StatusPill tone="success">Ready</StatusPill>
      </div>
      <p className="mt-2 font-mono text-sm break-all">{fromAddress}</p>
      <p className="mt-2 text-pretty text-sm/6 text-muted-foreground">
        While this account is in the sandbox, you can send from this address to your account’s
        members’ confirmed email addresses, to try the API before your own domain is verified. It
        goes when the account leaves the sandbox.
      </p>
    </section>
  )
}
