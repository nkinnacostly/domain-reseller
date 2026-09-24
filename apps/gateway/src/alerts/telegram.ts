import { type JsonResponse, NoAnswer, requestJson } from '../lib/http'

/**
 * Delivers alerts to a Telegram chat through a bot (the owner's choice of
 * channel). Plain text, no parse mode: summaries hold domain names and codes,
 * and Markdown would need escaping to be safe.
 *
 * The bot token is in the request URL, so neither the URL nor the token is
 * ever logged — only Telegram's status and its short description.
 */

export interface Notifier {
  /** True once Telegram has accepted the message. */
  send(text: string): Promise<boolean>
}

/** Telegram refuses messages over 4096 characters. */
export const TELEGRAM_MAX_CHARS = 4096

type Request = (url: string, init: Parameters<typeof requestJson>[1]) => Promise<JsonResponse>
type Log = { warn(fields: object, message: string): void }

export function createTelegramNotifier(options: {
  token: string
  chatId: string
  log: Log
  request?: Request
  baseUrl?: string
}): Notifier {
  const {
    token,
    chatId,
    log,
    request = requestJson,
    baseUrl = 'https://api.telegram.org',
  } = options

  return {
    async send(text) {
      try {
        const { status, body } = await request(`${baseUrl}/bot${token}/sendMessage`, {
          method: 'POST',
          body: {
            chat_id: chatId,
            text: text.slice(0, TELEGRAM_MAX_CHARS),
            disable_web_page_preview: true,
          },
          timeoutMs: 15_000,
        })
        const reply = (body ?? {}) as { ok?: boolean; description?: unknown }
        if (status === 200 && reply.ok === true) return true
        log.warn(
          {
            status,
            description:
              typeof reply.description === 'string' ? reply.description.slice(0, 120) : undefined,
          },
          'telegram refused an alert',
        )
        return false
      } catch (error) {
        log.warn(
          { reason: error instanceof NoAnswer ? 'no answer' : 'request failed' },
          'telegram alert not delivered',
        )
        return false
      }
    },
  }
}
