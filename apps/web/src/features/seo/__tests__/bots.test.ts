import { HTML_LIMITED_BOT_UA_RE } from 'next/dist/shared/lib/router/utils/html-bots'
import { describe, expect, it } from 'vitest'
import { HTML_LIMITED_BOTS } from '../../../../next.config'

const AI_USER_AGENTS = [
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot',
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot',
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
  'Mozilla/5.0 (compatible; Claude-SearchBot/1.0)',
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
  'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
  'CCBot/2.0 (https://commoncrawl.org/faq/)',
]

describe('htmlLimitedBots (next.config.ts)', () => {
  it('sends AI crawlers — which run no script — the metadata in <head>', () => {
    for (const agent of AI_USER_AGENTS) expect(HTML_LIMITED_BOTS.test(agent), agent).toBe(true)
  })

  it('still covers every crawler Next lists itself', () => {
    expect(HTML_LIMITED_BOTS.source.startsWith(HTML_LIMITED_BOT_UA_RE.source)).toBe(true)
    for (const agent of [
      'Mozilla/5.0 (compatible; Bingbot/2.0)',
      'facebookexternalhit/1.1',
      'Twitterbot/1.0',
    ]) {
      expect(HTML_LIMITED_BOTS.test(agent), agent).toBe(true)
    }
  })

  it('streams to browsers as before', () => {
    expect(
      HTML_LIMITED_BOTS.test(
        'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36',
      ),
    ).toBe(false)
  })
})
