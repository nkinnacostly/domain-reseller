import type { Fetch, FetchInit } from './platform'

/**
 * A recorded SES for the Mail tests: every request is kept, every answer is
 * scripted. No test ever reaches AWS (MAIL-SPEC §12, N12 for email).
 */

export type ScriptedAnswer = { status: number; body?: unknown; errorType?: string } | Error

export function recordingFetch(...answers: ScriptedAnswer[]) {
  const calls: { url: string; init: FetchInit }[] = []
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init })
    const answer = answers.length > 1 ? answers.shift() : answers[0]
    if (!answer) throw new Error('recordingFetch: no answer scripted')
    if (answer instanceof Error) throw answer
    return {
      status: answer.status,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'x-amzn-errortype' ? (answer.errorType ?? null) : null,
      },
      text: async () =>
        answer.body === undefined
          ? ''
          : typeof answer.body === 'string'
            ? answer.body
            : JSON.stringify(answer.body),
    }
  }
  return { fetch, calls }
}

/** AWS's documentation credentials: never a real key. */
export const EXAMPLE_CREDENTIALS = {
  region: 'eu-west-2',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  now: () => new Date('2026-10-06T09:30:00Z'),
}
