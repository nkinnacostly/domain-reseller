'use server'

import { NAME_IDEA_LANGUAGES } from '@dr/shared/ai'
import { z } from 'zod'
import { aiSettings } from '@/lib/ai'
import { actionClient } from '@/lib/safe-action'
import { DESCRIPTION_MAX, DESCRIPTION_MIN, type NameIdeasResult } from '../lib/name-ideas'
import { nameIdeasFor } from '../queries/name-ideas'

/**
 * The AI name finder's one request on /ideas (feature 1): a description and
 * an extension in, available names out — see `nameIdeasFor`, which the site
 * assistant shares.
 */
export const findNameIdeas = actionClient
  .inputSchema(
    z.object({
      description: z.string().trim().min(DESCRIPTION_MIN).max(DESCRIPTION_MAX),
      tld: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9-]{2,63}(\.[a-z0-9-]{2,63})*$/),
      // AI phase 4: the language the names draw on and the reasons are written in.
      language: z.enum(NAME_IDEA_LANGUAGES).default('en'),
    }),
  )
  .action(async ({ parsedInput }): Promise<NameIdeasResult> => {
    const settings = aiSettings()
    if (!settings) return { ok: false, reason: 'off' }
    return nameIdeasFor(settings, parsedInput)
  })
