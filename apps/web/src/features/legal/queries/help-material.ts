import 'server-only'

import { LLMS_PAGES } from '@/features/seo/lib/llms'
import { plainText } from '@/features/seo/lib/plain-text'
import { HELP_TOPICS } from '../components/help-topics'
import { type HelpTopic, helpCorpus, helpSources } from '../lib/help-assistant'

export type HelpMaterial = { corpus: string; sources: ReadonlyMap<string, string> }

let material: HelpMaterial | null = null

/**
 * The help centre as text, and the paths an answer may cite — built once per
 * server: it changes only with a deploy. The help assistant and the site
 * assistant answer from exactly this, and nothing else (N9b).
 */
export function helpMaterial(): HelpMaterial {
  if (!material) {
    const topics: HelpTopic[] = HELP_TOPICS.map((topic) => ({
      id: topic.id,
      title: topic.title,
      questions: topic.questions.map((item) => ({ q: item.q, a: plainText(item.a) })),
    }))
    material = { corpus: helpCorpus(topics, LLMS_PAGES), sources: helpSources(topics, LLMS_PAGES) }
  }
  return material
}
