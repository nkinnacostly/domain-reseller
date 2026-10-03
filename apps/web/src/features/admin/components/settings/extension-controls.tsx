'use client'

import { useId, useState } from 'react'
import { describedBy, Field, inputClass } from '@/components/common/form-parts'
import { setExtensionFlags } from '@/features/admin/actions/extensions'
import { ConfirmAction } from '@/features/admin/components/confirm-action'
import { adminOutcome } from '@/features/admin/lib/errors'
import {
  EXTENSIONS_COPY,
  featureCopy,
  pauseCopy,
  rankTakenWords,
  resumeCopy,
  SIDE_NAME,
  unfeatureCopy,
} from '@/features/admin/lib/settings-copy'
import type { AdminSide } from '@/features/admin/lib/side'
import { PAUSE_REASON_MAX, RANK_MAX, TAGLINE_MAX } from '@/features/admin/schemas/settings'
import { cn } from '@/lib/utils'

/**
 * One extension's Pause, Resume and Feature dialogs (docs/ADMIN-SPEC.md §5.2
 * B13). Each is the owner's and money tier: a reason and the code from the
 * authenticator app; a pause also wants the extension's name typed back,
 * because it takes a whole extension off sale. SQL decides who may — anyone
 * else is told so by the dialog — and the site's prices refresh after.
 */

export type ControlledExtension = {
  name: string
  isPaused: boolean
  pausedReason: string | null
  featuredRank: number | null
  featuredTagline: string | null
}

export function ExtensionControls({
  extension,
  held,
  side,
  ranks,
  returnTo,
}: {
  extension: ControlledExtension
  /** Domains held on it on this side; null when it could not be read. */
  held: number | null
  side: AdminSide
  /** Every featured extension's rank, to refuse one already taken before asking. */
  ranks: { name: string; rank: number }[]
  returnTo: string
}) {
  const { name } = extension
  const heldWords = held === null ? '—' : held.toLocaleString('en-GB')
  const featuredWords = extension.featuredRank === null ? 'No' : `Rank ${extension.featuredRank}`

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-3">
        {extension.isPaused ? (
          <ConfirmAction
            trigger={`Resume .${name}`}
            title={resumeCopy(name).title}
            rows={[{ label: 'Paused because', value: extension.pausedReason ?? '—' }]}
            body={resumeCopy(name).body}
            confirmLabel={EXTENSIONS_COPY.resumeConfirm}
            reason="required"
            needsCode
            returnTo={returnTo}
            successMessage={EXTENSIONS_COPY.resumedDone}
            run={async ({ reason, requestKey, code }) =>
              adminOutcome(
                await setExtensionFlags({
                  name,
                  change: { kind: 'resume', reason: reason ?? '' },
                  requestKey,
                  code: code ?? '',
                }),
              )
            }
          />
        ) : (
          <ConfirmAction
            trigger={`Pause .${name}`}
            title={pauseCopy(name, held, side).title}
            rows={[
              { label: `Held domains (${SIDE_NAME[side]} side)`, value: heldWords },
              { label: 'Featured', value: featuredWords },
            ]}
            body={pauseCopy(name, held, side).body}
            typeToConfirm={`.${name}`}
            confirmLabel={EXTENSIONS_COPY.pauseConfirm}
            reason="required"
            reasonLabel={EXTENSIONS_COPY.pauseReasonLabel}
            reasonMax={PAUSE_REASON_MAX}
            destructive
            needsCode
            returnTo={returnTo}
            successMessage={EXTENSIONS_COPY.pausedDone}
            run={async ({ reason, requestKey, code }) =>
              adminOutcome(
                await setExtensionFlags({
                  name,
                  change: { kind: 'pause', why: reason ?? '' },
                  requestKey,
                  code: code ?? '',
                }),
              )
            }
          />
        )}
        {extension.featuredRank !== null ? (
          <ConfirmAction
            trigger={`Stop featuring .${name}`}
            title={unfeatureCopy(name).title}
            rows={[
              { label: 'Rank', value: String(extension.featuredRank) },
              { label: 'Tagline', value: extension.featuredTagline ?? '—' },
            ]}
            body={unfeatureCopy(name).body}
            confirmLabel={EXTENSIONS_COPY.unfeatureConfirm}
            reason="required"
            destructive
            needsCode
            returnTo={returnTo}
            successMessage={EXTENSIONS_COPY.unfeaturedDone}
            run={async ({ reason, requestKey, code }) =>
              adminOutcome(
                await setExtensionFlags({
                  name,
                  change: { kind: 'unfeature', reason: reason ?? '' },
                  requestKey,
                  code: code ?? '',
                }),
              )
            }
          />
        ) : null}
      </div>
      <FeatureForm extension={extension} ranks={ranks} returnTo={returnTo} />
    </div>
  )
}

/** The lowest rank nobody holds, as a starting point for a new feature. */
function freeRank(ranks: { rank: number }[]): number {
  const taken = new Set(ranks.map((entry) => entry.rank))
  for (let rank = 1; rank <= RANK_MAX; rank++) if (!taken.has(rank)) return rank
  return RANK_MAX
}

function FeatureForm({
  extension,
  ranks,
  returnTo,
}: {
  extension: ControlledExtension
  ranks: { name: string; rank: number }[]
  returnTo: string
}) {
  const id = useId()
  const { name } = extension
  const featured = extension.featuredRank !== null
  const [rankText, setRankText] = useState(String(extension.featuredRank ?? freeRank(ranks)))
  const [tagline, setTagline] = useState(extension.featuredTagline ?? '')

  const rank = /^\d{1,2}$/.test(rankText.trim()) ? Number(rankText.trim()) : Number.NaN
  const holder = ranks.find((entry) => entry.rank === rank && entry.name !== name)
  const rankError =
    Number.isNaN(rank) || rank < 1 || rank > RANK_MAX
      ? `Enter a rank from 1 to ${RANK_MAX}.`
      : holder
        ? rankTakenWords(rank, holder.name)
        : undefined
  const taglineError =
    tagline.trim().length > TAGLINE_MAX ? `Keep it under ${TAGLINE_MAX} characters.` : undefined
  const unchanged =
    featured &&
    rank === extension.featuredRank &&
    tagline.trim() === (extension.featuredTagline ?? '')
  const copy = featureCopy(name, featured)

  return (
    <form
      aria-labelledby={`${id}-heading`}
      className="space-y-4 rounded-2xl border border-border p-4"
      onSubmit={(event) => event.preventDefault()}
      noValidate
    >
      <h3 id={`${id}-heading`} className="text-sm font-semibold text-foreground">
        {featured ? 'Featuring' : `Feature .${name}`}
      </h3>
      <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
        <Field
          id={`${id}-rank`}
          label={EXTENSIONS_COPY.rankLabel}
          error={rankError}
          hint={EXTENSIONS_COPY.rankHint}
        >
          <input
            id={`${id}-rank`}
            value={rankText}
            onChange={(event) => setRankText(event.target.value)}
            inputMode="numeric"
            autoComplete="off"
            aria-invalid={rankError ? true : undefined}
            aria-describedby={describedBy(`${id}-rank`, rankError, EXTENSIONS_COPY.rankHint)}
            className={cn(inputClass, 'w-24 tabular-nums')}
          />
        </Field>
        <Field
          id={`${id}-tagline`}
          label={EXTENSIONS_COPY.taglineLabel}
          error={taglineError}
          hint={EXTENSIONS_COPY.taglineHint}
        >
          <input
            id={`${id}-tagline`}
            value={tagline}
            onChange={(event) => setTagline(event.target.value)}
            maxLength={TAGLINE_MAX + 20}
            autoComplete="off"
            aria-invalid={taglineError ? true : undefined}
            aria-describedby={describedBy(
              `${id}-tagline`,
              taglineError,
              EXTENSIONS_COPY.taglineHint,
            )}
            className={inputClass}
          />
        </Field>
      </div>
      <ConfirmAction
        trigger={featured ? EXTENSIONS_COPY.featureConfirm : `Feature .${name}`}
        disabled={Boolean(rankError || taglineError || unchanged)}
        title={copy.title}
        rows={[
          {
            label: 'Rank',
            value: featured ? `${extension.featuredRank} → ${rank}` : String(rank),
          },
          {
            label: 'Tagline',
            value: featured
              ? `${extension.featuredTagline || '—'} → ${tagline.trim() || '—'}`
              : tagline.trim() || '—',
          },
        ]}
        body={copy.body}
        confirmLabel={EXTENSIONS_COPY.featureConfirm}
        reason="required"
        needsCode
        returnTo={returnTo}
        successMessage={EXTENSIONS_COPY.featuredDone}
        run={async ({ reason, requestKey, code }) =>
          adminOutcome(
            await setExtensionFlags({
              name,
              change: { kind: 'feature', rank, tagline: tagline.trim(), reason: reason ?? '' },
              requestKey,
              code: code ?? '',
            }),
          )
        }
      />
    </form>
  )
}
