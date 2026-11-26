'use client'

import { Sparkles } from 'lucide-react'
import dynamic from 'next/dynamic'
import { useState } from 'react'

// The conversation's code loads on the first press, not with the page (S10):
// most visits never open it, and the button itself is a few hundred bytes.
const AssistantSheet = dynamic(
  () => import('./assistant-sheet').then((module) => module.AssistantSheet),
  { ssr: false },
)

/**
 * The site assistant's button (AI phase 5), in the corner of every public
 * page and the panel. Rendered only while the AI features are on (N9b): the
 * layout decides, so with no key there is no button to press.
 */
export function SiteAssistant() {
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Ask MyDomainsHub"
        onClick={() => {
          setLoaded(true)
          setOpen(true)
        }}
        className="fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-40 inline-flex size-14 items-center justify-center gap-2 rounded-full bg-accent text-accent-foreground shadow-lg shadow-black/15 transition hover:bg-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.97] sm:right-6 sm:bottom-6 sm:h-12 sm:w-auto sm:px-5 print:hidden"
      >
        <Sparkles className="size-5 shrink-0" aria-hidden="true" />
        <span className="hidden text-sm font-semibold sm:inline">Ask MyDomainsHub</span>
      </button>
      {loaded ? <AssistantSheet open={open} onOpenChange={setOpen} /> : null}
    </>
  )
}
