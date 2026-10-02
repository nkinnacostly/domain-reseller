'use client'

import { RotateCw } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useAction } from 'next-safe-action/hooks'
import { useState } from 'react'
import { FormMessage } from '@/components/common/form-parts'
import { FOCUS } from '@/components/layout/panel'
import { cn } from '@/lib/utils'
import { requestCertificateReissue } from '../actions/setup'
import type { CertificateFile } from '../lib/files'
import { TextFile } from './text-file'

/**
 * FR-SSL-7, FR-SSL-8: the issued certificate to copy or download, and a
 * reissue — asked for, then confirmed, never on one tap.
 */
export function IssuedCertificate({
  certificateId,
  files,
  canReissue,
}: {
  certificateId: string
  files: CertificateFile[]
  canReissue: boolean
}) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const reissue = useAction(requestCertificateReissue, {
    onSuccess: ({ data }) => {
      if (data && 'ok' in data) router.refresh()
    },
  })
  const error =
    (reissue.result.data && 'error' in reissue.result.data ? reissue.result.data.error : null) ??
    reissue.result.serverError ??
    null

  return (
    <div className="space-y-6">
      {files.length === 0 ? (
        <FormMessage tone="success">
          The certificate authority has issued it. Its text is not available from our supplier yet —
          we ask every hour and show it here as soon as it is.
        </FormMessage>
      ) : (
        <div className="space-y-6">
          {files.map((file) => (
            <TextFile
              key={file.name}
              label={file.label}
              fileName={file.name}
              content={file.content}
            />
          ))}
        </div>
      )}

      {canReissue ? (
        <div className="space-y-3 border-border border-t pt-6">
          <h3 className="font-medium text-foreground">Reissue</h3>
          <p className="max-w-2xl text-pretty text-sm/6 text-muted-foreground">
            Before this certificate expires, or if you lost its key, ask the certificate authority
            for a new one for the same names. Reissues are free while the subscription lasts. If it
            needs a new request (CSR), this page takes you through the set-up again; either way the
            CA emails your approver again.
          </p>
          {confirming ? (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={reissue.isPending}
                aria-busy={reissue.isPending || undefined}
                onClick={() => reissue.execute({ certificateId })}
                className={cn(
                  'inline-flex h-11 items-center gap-2 rounded-full bg-accent px-5 text-sm font-medium text-accent-foreground transition hover:bg-accent/90 active:scale-[0.98] disabled:opacity-70',
                  FOCUS,
                )}
              >
                <RotateCw className="size-4" aria-hidden="true" />
                {reissue.isPending ? 'Asking…' : 'Yes, reissue it'}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className={cn(
                  'inline-flex h-11 items-center rounded-full border border-border bg-background px-5 text-sm font-medium text-foreground transition-colors hover:bg-muted active:scale-[0.98]',
                  FOCUS,
                )}
              >
                Not now
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className={cn(
                'inline-flex h-11 items-center gap-2 rounded-full border border-border bg-background px-5 text-sm font-medium text-foreground transition-colors hover:bg-muted active:scale-[0.98]',
                FOCUS,
              )}
            >
              <RotateCw className="size-4" aria-hidden="true" />
              Reissue this certificate
            </button>
          )}
          {error ? <FormMessage tone="error">{error}</FormMessage> : null}
        </div>
      ) : null}
    </div>
  )
}
