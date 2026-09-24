#!/usr/bin/env node
/**
 * The gateway's dead-man switch (backlog L16).
 *
 * The gateway registers domains, sends refunds and raises alerts. If it stops
 * — a crash, a failed deploy, the Fly trial halting the machine — it cannot
 * say so itself. It writes a heartbeat every few minutes; this runs on a
 * schedule elsewhere (.github/workflows/gateway-watch.yml) and messages the
 * owner on Telegram when the heartbeat goes quiet.
 *
 * No dependencies, so the scheduled run needs no install. It keeps no state:
 * it speaks on the first run after the heartbeat goes stale, then every six
 * hours while it stays stale.
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY, TELEGRAM_BOT_TOKEN and
 * TELEGRAM_CHAT_ID. Exits non-zero only when it could not check or could not
 * warn — so a broken watch shows up red, without paging on every run.
 */

// biome-ignore lint/suspicious/noUndeclaredEnvVars: run by a GitHub Action, not a Turborepo task
const HEARTBEAT = process.env.HEARTBEAT_NAME ?? 'gateway:production'
// biome-ignore lint/suspicious/noUndeclaredEnvVars: run by a GitHub Action, not a Turborepo task
const STALE_MINUTES = Number(process.env.STALE_MINUTES ?? 20)
/** How often the workflow runs. A stale heartbeat is reported once per window. */
// biome-ignore lint/suspicious/noUndeclaredEnvVars: run by a GitHub Action, not a Turborepo task
const RUN_EVERY_MINUTES = Number(process.env.RUN_EVERY_MINUTES ?? 30)
const REPEAT_MINUTES = 6 * 60

function required(name) {
  const value = process.env[name]
  if (!value) {
    console.error(`${name} is not set`)
    process.exit(2)
  }
  return value
}

/** Whether this run should speak, given how long the heartbeat has been quiet. */
export function shouldWarn(minutesQuiet, staleMinutes = STALE_MINUTES, every = RUN_EVERY_MINUTES) {
  if (minutesQuiet < staleMinutes) return false
  const since = minutesQuiet - staleMinutes
  return since < every || since % REPEAT_MINUTES < every
}

async function lastBeat(url, key) {
  const response = await fetch(
    `${url}/rest/v1/service_heartbeats?name=eq.${encodeURIComponent(HEARTBEAT)}&select=beat_at`,
    {
      headers: { apikey: key, authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    },
  )
  if (!response.ok) throw new Error(`heartbeat read failed: HTTP ${response.status}`)
  const rows = await response.json()
  return Array.isArray(rows) && rows[0]?.beat_at ? new Date(rows[0].beat_at) : null
}

async function warn(token, chatId, text) {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15_000),
  })
  // Never print the URL: it holds the bot token.
  if (!response.ok) throw new Error(`telegram refused the warning: HTTP ${response.status}`)
}

async function main() {
  const url = required('NEXT_PUBLIC_SUPABASE_URL')
  const key = required('SUPABASE_SECRET_KEY')
  const token = required('TELEGRAM_BOT_TOKEN')
  const chatId = required('TELEGRAM_CHAT_ID')

  const beat = await lastBeat(url, key)
  if (!beat) {
    // A gateway that has never run this version has nothing to miss yet.
    console.log(`no heartbeat recorded for ${HEARTBEAT}; nothing to compare`)
    return
  }
  const minutesQuiet = Math.floor((Date.now() - beat.getTime()) / 60_000)
  console.log(`${HEARTBEAT}: last heartbeat ${minutesQuiet} minutes ago`)
  if (!shouldWarn(minutesQuiet)) return

  const hours = minutesQuiet >= 120 ? ` (${Math.floor(minutesQuiet / 60)} hours)` : ''
  await warn(
    token,
    chatId,
    [
      '🚨 MyDomainsHub (live): the gateway has gone quiet.',
      `No heartbeat for ${minutesQuiet} minutes${hours}.`,
      'Until it is back, paid orders are not registered, refunds are not sent and no other alerts can reach you.',
      'Check it: fly status -a mydomainshub-gateway',
    ].join('\n'),
  )
  console.log('warning sent')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
