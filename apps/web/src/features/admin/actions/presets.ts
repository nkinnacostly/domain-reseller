'use server'

import type { Database } from '@dr/db/types'
import {
  ADMIN_GATEWAY_ROUTES,
  type AdminPresetDraftCheck,
  adminNoteTarget,
  adminRouteSide,
} from '@dr/shared/admin'
import { GatewayError } from '@dr/shared/errors'
import { revalidateTag } from 'next/cache'
import {
  type AdminResult,
  adminAccessError,
  refusedResult,
  toAdminResult,
} from '@/features/admin/lib/errors'
import { adminGatewayConfigured, callAdminGateway } from '@/features/admin/queries/gateway'
import {
  checkDraftSchema,
  discardDraftSchema,
  hidePresetSchema,
  publishDraftSchema,
  saveDraftSchema,
  showPresetSchema,
} from '@/features/admin/schemas/settings'
import { adminAction, adminMoneyAction } from '@/lib/safe-action'

/**
 * Nameserver presets (docs/ADMIN-SPEC.md §3.1.2, §5.2 B13, D21, N11). A
 * preset steers customers' domains, so a change is a draft: saved (owner,
 * money), checked in public DNS by the gateway, then published (owner,
 * money). Hiding narrows what customers see and is an operator's; showing
 * widens it again and is the owner's. Every one is an `admin_*` wrapper
 * called as the admin; the check is an audit note the gateway claims first
 * (D22). The site caches the preset lists under `nameserver-presets`, so a
 * publish, hide or show that went through expires them at once.
 */

type Answer = { data: unknown; error: { message: string } | null }

function answered({ data, error }: Answer): AdminResult {
  if (error) throw adminAccessError(error.message)
  return toAdminResult(data)
}

/** A change customers see: the cached preset lists are expired straight away. */
function refreshed(result: AdminResult): AdminResult {
  if (result.ok) revalidateTag('nameserver-presets', { expire: 0 })
  return result
}

type SaveDraftArgs = Database['public']['Functions']['admin_save_preset_draft']['Args']

/** Save a draft (`preset.draft_save`): the live preset is unchanged until it is published. */
export const savePresetDraft = adminMoneyAction('preset.draft_save', saveDraftSchema).action(
  async ({ parsedInput, ctx }) => {
    const notes = parsedInput.notes ?? ''
    // A new host has no preset id, and empty notes are none: SQL takes both as null.
    const args = {
      p_preset_id: parsedInput.presetId,
      p_provider: parsedInput.provider ?? null,
      p_nameservers: parsedInput.assignsPerZone
        ? []
        : parsedInput.nameservers.map((host) => host.trim().toLowerCase()),
      p_source_url: parsedInput.sourceUrl,
      p_notes: notes === '' ? null : notes,
      p_assigns_per_zone: parsedInput.assignsPerZone,
      p_reason: parsedInput.reason,
      p_request_key: parsedInput.requestKey,
    }
    return answered(await ctx.db.rpc('admin_save_preset_draft', args as unknown as SaveDraftArgs))
  },
)

/**
 * Check a draft now (`preset.draft_check`, owner, standard): an intent note,
 * then the gateway — which claims the note before it looks anything up —
 * asks Cloudflare and Google for each host and records the verdict on the
 * draft, never on the live preset.
 */
export const checkPresetDraft = adminAction('preset.draft_check', checkDraftSchema).action(
  async ({ parsedInput, ctx }): Promise<AdminResult<AdminPresetDraftCheck>> => {
    if (!adminGatewayConfigured()) return refusedResult('ADMIN_DISABLED')
    const route = ADMIN_GATEWAY_ROUTES.presetDraftCheck
    const side = adminRouteSide('presetDraftCheck', 'live')
    const note = await ctx.db.rpc('admin_note', {
      p_action: route.action,
      p_side: side,
      p_target_type: 'preset_draft',
      p_target_id: adminNoteTarget('presetDraftCheck', { side, id: parsedInput.draftId }),
      p_detail: {},
    })
    if (note.error) throw adminAccessError(note.error.message)
    const noted = toAdminResult(note.data)
    if (!noted.ok) return noted
    try {
      const data = await callAdminGateway<AdminPresetDraftCheck>({
        admin: ctx.admin,
        auditId: noted.auditId,
        route: route.template,
        params: { id: parsedInput.draftId },
      })
      return { ok: true, auditId: noted.auditId, data }
    } catch (error) {
      if (error instanceof GatewayError) {
        const reason = (error as GatewayError & { reason?: string }).reason
        return refusedResult(
          error.code === 'ADMIN_NOTE_REFUSED' && reason ? reason : error.code,
          noted.auditId,
        )
      }
      throw error
    }
  },
)

/** Publish a checked draft (`preset.publish`): customers see the new nameservers from the next refresh. */
export const publishPresetDraft = adminMoneyAction('preset.publish', publishDraftSchema).action(
  async ({ parsedInput, ctx }) =>
    refreshed(
      answered(
        await ctx.db.rpc('admin_publish_preset_draft', {
          p_draft_id: parsedInput.draftId,
          p_reason: parsedInput.reason,
          p_request_key: parsedInput.requestKey,
        }),
      ),
    ),
)

type DiscardArgs = Database['public']['Functions']['admin_discard_preset_draft']['Args']
type HiddenArgs = Database['public']['Functions']['admin_set_preset_hidden']['Args']

/** Discard a draft (`preset.draft_discard`, owner, standard): the live preset is as it was. */
export const discardPresetDraft = adminAction('preset.draft_discard', discardDraftSchema).action(
  async ({ parsedInput, ctx }) =>
    answered(
      await ctx.db.rpc('admin_discard_preset_draft', {
        p_draft_id: parsedInput.draftId,
        p_reason: parsedInput.reason ?? null,
        p_request_key: parsedInput.requestKey,
      } as unknown as DiscardArgs),
    ),
)

/** Hide a preset (`preset.hide`, operator): fewer choices cannot point a domain anywhere. */
export const hidePreset = adminAction('preset.hide', hidePresetSchema).action(
  async ({ parsedInput, ctx }) =>
    refreshed(
      answered(
        await ctx.db.rpc('admin_set_preset_hidden', {
          p_id: parsedInput.presetId,
          p_hidden: true,
          p_reason: parsedInput.reason ?? null,
          p_request_key: parsedInput.requestKey,
        } as unknown as HiddenArgs),
      ),
    ),
)

/** Show a hidden preset again (`preset.show`, owner, money). One the checker hid comes back by itself. */
export const showPreset = adminMoneyAction('preset.show', showPresetSchema).action(
  async ({ parsedInput, ctx }) =>
    refreshed(
      answered(
        await ctx.db.rpc('admin_set_preset_hidden', {
          p_id: parsedInput.presetId,
          p_hidden: false,
          p_reason: parsedInput.reason,
          p_request_key: parsedInput.requestKey,
        }),
      ),
    ),
)
