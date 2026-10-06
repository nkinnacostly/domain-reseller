'use client'

import { Printer } from 'lucide-react'
import { secondaryButtonClass } from './styles'

/** Prints the invoice: the dashboard's frame is hidden on paper. */
export function PrintButton() {
  return (
    <button type="button" onClick={() => window.print()} className={secondaryButtonClass}>
      <Printer className="size-4" aria-hidden="true" />
      Print or save as PDF
    </button>
  )
}
