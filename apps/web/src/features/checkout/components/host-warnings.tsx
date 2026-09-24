import { TriangleAlert } from 'lucide-react'

/**
 * FR-D4 — a nameserver that exists but did not answer just now only warns:
 * it may be busy. placeOrder stops once, before creating anything, so the
 * warning is read before paying (FR-C10); paying again goes ahead with the
 * same choices.
 */
export function HostWarnings({ warnings }: { warnings: readonly string[] }) {
  return (
    <div
      role="status"
      className="flex gap-2.5 rounded-xl bg-muted/60 p-4 text-pretty text-sm/6 text-foreground"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
      <div className="min-w-0">
        <p className="font-medium">Check these nameservers before you pay:</p>
        <ul className="mt-1 list-disc pl-5 break-words">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
        <p className="mt-2">
          Nothing has been charged. Pay to continue with them as they are, or change them above.
        </p>
      </div>
    </div>
  )
}
