import 'server-only'

import { cacheLife, cacheTag } from 'next/cache'
import { z } from 'zod'
import { logger } from '@/lib/logger'
import { createPublicClient } from '@/lib/supabase/public'
import { WORD_IDEAS_SHOWN } from '../lib/plan'

const WORD = /^[a-z0-9]{2,20}$/
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const ideasSchema = z.array(z.object({ label: z.string() }))

/**
 * The pre-built name ideas for a searched word, when it is one of the curated
 * words (feature 2, migration 72) — a table read, never a model call, so no
 * model sits in a search (ADR-002). Anything that cannot be read is no ideas:
 * the affix suggestions still answer.
 */
export async function getWordIdeas(stem: string): Promise<string[]> {
  if (!WORD.test(stem)) return []
  try {
    return await loadWordIdeas(stem)
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'word ideas unavailable — affix suggestions only',
    )
    return []
  }
}

/** Identical for everyone, so cookie-free and cached; a failed read throws and is not cached. */
export async function loadWordIdeas(word: string): Promise<string[]> {
  'use cache'
  cacheTag('name-ideas')
  cacheLife('hours')
  const { data, error } = await createPublicClient()
    .from('name_idea_words')
    .select('ideas')
    .eq('word', word)
    .maybeSingle()
  if (error) throw new Error(`name_idea_words: ${error.message}`)
  const parsed = ideasSchema.safeParse(data?.ideas ?? [])
  if (!parsed.success) return []
  return parsed.data
    .map((idea) => idea.label)
    .filter((label) => LABEL.test(label) && label !== word)
    .slice(0, WORD_IDEAS_SHOWN)
}
