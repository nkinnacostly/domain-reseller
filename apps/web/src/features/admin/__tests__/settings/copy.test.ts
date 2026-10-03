import { describe, expect, it } from 'vitest'
import {
  ADMINS_NOTE,
  discardCopy,
  featureCopy,
  hideCopy,
  LIMITS_COPY,
  limitsTitle,
  pauseCopy,
  pinnedWords,
  publishCopy,
  rankTakenWords,
  resumeCopy,
  saveDraftCopy,
  showCopy,
  sslOffCopy,
  sslOnCopy,
  unfeatureCopy,
} from '@/features/admin/lib/settings-copy'

/**
 * The Settings pages' words (docs/ADMIN-SPEC.md §5.2 B13), held exactly:
 * the owner signed this copy off, and N9b says copy describes what the code
 * does. Counts come from the database and are interpolated, never written.
 */

describe('the limits dialog', () => {
  it('counts the changes in its title', () => {
    expect(limitsTitle(1)).toBe('Change 1 limit?')
    expect(limitsTitle(2)).toBe('Change 2 limits?')
  })

  it('says what a rise and a fall in a refund limit do', () => {
    expect(LIMITS_COPY.raise).toBe(
      'Refunds already held stay held until someone approves them. Raising a refund limit sends a Telegram notice.',
    )
    expect(LIMITS_COPY.lower).toBe(
      'Refunds already queued are judged against the new limit when the worker picks them up.',
    )
    expect(LIMITS_COPY.confirm).toBe('Save limits')
    expect(LIMITS_COPY.cancel).toBe('Cancel')
  })
})

describe('the extension dialogs', () => {
  it('says what a pause does, with the held count from SQL', () => {
    expect(pauseCopy('africa', 37, 'live')).toEqual({
      title: 'Pause .africa?',
      body: "While .africa is paused the site has no price for it, so nobody can register, transfer in or renew a .africa domain here. 37 domains on the Live side are held on it; nothing changes for them at the registry. The site's prices refresh straight after this.",
    })
    expect(pauseCopy('ng', 1, 'test').body).toContain(
      '1 domain on the Test side is held on it; nothing changes for them at the registry.',
    )
    expect(pauseCopy('ng', null, 'live').body).toContain(
      'How many domains are held on it could not be read.',
    )
  })

  it('words resume, feature and stop featuring', () => {
    expect(resumeCopy('ng')).toEqual({
      title: 'Resume .ng?',
      body: ".ng is offered again at its current price once the site's prices refresh, which happens straight after this. Its pause reason is cleared.",
    })
    expect(featureCopy('africa', false).title).toBe('Feature .africa?')
    expect(featureCopy('africa', true).title).toBe('Change how .africa is featured?')
    expect(unfeatureCopy('co').title).toBe('Stop featuring .co?')
    expect(rankTakenWords(3, 'org')).toBe(
      "Rank 3 is .org's. Choose another rank, or move .org first.",
    )
    expect(rankTakenWords(3, null)).toBe(
      'Rank 3 is taken by another extension. Choose another rank.',
    )
  })
})

describe('the SSL product dialogs', () => {
  it('name the product and say prices refresh', () => {
    expect(sslOnCopy('Sectigo DV SSL').title).toBe('Put Sectigo DV SSL on sale?')
    expect(sslOffCopy('Sectigo DV SSL')).toEqual({
      title: 'Take Sectigo DV SSL off sale?',
      body: 'Customers stop seeing it once prices refresh, which happens straight after this. Certificates already bought are not touched.',
    })
  })
})

describe('the preset dialogs', () => {
  it('save a draft, in the signed-off words', () => {
    expect(saveDraftCopy('Vercel')).toEqual({
      title: "Save a draft of Vercel's nameservers?",
      body: "Customers keep seeing the current nameservers. The draft is checked in public DNS (now, or within 6 hours); then you publish it. The source must be Vercel's own documentation.",
    })
  })

  it('publish, in the signed-off words', () => {
    expect(publishCopy('Vercel')).toEqual({
      title: "Publish Vercel's new nameservers?",
      body: 'Every checkout, host pick and bulk change that uses Vercel sends domains to these nameservers from the next refresh. A Telegram notice is sent.',
    })
  })

  it('hide, with the domains on it from SQL', () => {
    expect(hideCopy('Hostinger', 12, 'live')).toEqual({
      title: 'Hide Hostinger?',
      body: '12 domains use it now on the Live side; they keep their nameservers. Customers stop seeing it as a choice within a minute.',
    })
    expect(hideCopy('Hostinger', 1, 'test').body).toMatch(/^1 domain uses it now on the Test side;/)
    expect(hideCopy('Hostinger', null, 'live').body).toMatch(/^Who uses it now could not be read;/)
  })

  it('show again and discard', () => {
    expect(showCopy('Hostinger').title).toBe('Show Hostinger again?')
    expect(showCopy('Hostinger').body).toContain('A Telegram notice is sent.')
    expect(discardCopy('Hostinger')).toEqual({
      title: "Discard the draft of Hostinger's nameservers?",
      body: 'The live preset stays as it is. The draft is kept on record as discarded.',
    })
  })
})

describe('the admins page', () => {
  it('says where admins are changed', () => {
    expect(ADMINS_NOTE).toBe(
      'Admins and their linked devices are changed in the SQL editor (DEPLOY.md §6b). Every change sends a Telegram alert.',
    )
  })

  it('says how many pinned devices are still active', () => {
    expect(pinnedWords(2, 2)).toBe('2 linked, 2 active')
    expect(pinnedWords(1, 1)).toBe('1 linked, 1 active')
    expect(pinnedWords(2, 1)).toBe('1 of 2 removed')
    expect(pinnedWords(3, 0)).toBe('3 of 3 removed')
  })
})
