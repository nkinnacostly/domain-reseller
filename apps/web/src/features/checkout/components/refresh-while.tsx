'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

/**
 * Re-renders the page from the server every few seconds while `active`, so
 * an order moves from queued to registered without a reload. Stops by
 * itself once the server renders it inactive, and while the tab is hidden.
 */
export function RefreshWhile({ active, everyMs = 4_000 }: { active: boolean; everyMs?: number }) {
  const router = useRouter()

  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh()
    }, everyMs)
    return () => clearInterval(timer)
  }, [active, everyMs, router])

  return null
}
