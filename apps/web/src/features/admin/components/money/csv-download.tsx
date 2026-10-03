'use client'

import { Download } from 'lucide-react'
import { QUIET_BUTTON } from '@/components/common/action-parts'

/**
 * Saves a CSV the page already built (docs/ADMIN-SPEC.md §5.2 B7): nothing
 * is fetched and nothing is logged. A BOM leads the file so Excel reads it
 * as UTF-8.
 */
export function CsvDownload({
  fileName,
  csv,
  about,
}: {
  fileName: string
  csv: string
  /** What the file holds, read after the visible words: "Download CSV of …". */
  about: string
}) {
  const save = () => {
    const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    document.body.append(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }
  return (
    <button type="button" onClick={save} className={QUIET_BUTTON}>
      <Download className="size-4" aria-hidden="true" />
      Download CSV <span className="sr-only">of {about}</span>
    </button>
  )
}
