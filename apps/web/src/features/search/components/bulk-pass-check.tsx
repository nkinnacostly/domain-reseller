'use client'

import { useBulkRun } from './bulk-run'
import { HumanCheck } from './human-check'

/**
 * The Turnstile check for bulk search (SEC-9), under the form while a run
 * waits for a search pass. Outside the form, so its token never rides along
 * in `?names=`; passing it carries the run on from the block that waited.
 */
export function BulkPassCheck() {
  const { awaitingPass, resume } = useBulkRun()
  if (!awaitingPass) return null
  return (
    <HumanCheck
      title="Confirm you’re a person to check this list"
      action="bulk-search"
      onPassed={resume}
      className="mt-4"
    >
      Bulk search asks the registry about many names, so Cloudflare checks that you’re a person
      first — usually without a click. Your list carries on as soon as it’s done.
    </HumanCheck>
  )
}
