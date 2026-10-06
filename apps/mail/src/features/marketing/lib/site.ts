/**
 * Where the public pages stand, and where their links go. One place, so the
 * day something opens is one change here (N9b: the pages say what is true
 * today, and no more).
 */

export const LAUNCH = {
  /**
   * MAIL-SPEC §13, P4: public pages are indexed only once Mail is open —
   * the legal pages are drafts, and sign-up, billing and the dashboard are
   * still being built. `pageMetadata` keeps every public page out of search
   * until this is true.
   */
  isOpen: false,
  /** Billing (§8, P3): until it lands, nobody can buy a paid plan. */
  paidPlansOnSale: false,
} as const

/**
 * The quickstart (§6 "Docs"), written by the docs package. Null until it
 * exists: /docs links to it the moment it is set (N9b: no link to nothing).
 */
export const QUICKSTART_PATH: string | null = null

export const ROUTES = {
  home: '/',
  pricing: '/pricing',
  docs: '/docs',
  /** Sign-in and sign-up are the auth package's pages. */
  signIn: '/sign-in',
  signUp: '/sign-up',
  contact: '/contact',
  abuse: '/abuse',
  legal: '/legal',
} as const

/**
 * Trust-and-safety numbers the pages state (MAIL-SPEC §7.2–§7.4). The caps
 * live in `mail.settings` (migration 43's defaults), which no API role may
 * read, and the thresholds are the spec's; so they are written here, once —
 * change them with the settings, never apart.
 */
export const SAFETY = {
  /** §7.2: a sandbox account's daily cap, to its own members only. */
  sandboxDailyCap: 100,
  /** §7.3: an approved account's first warm-up day. */
  warmupStartCap: 1000,
  /** §7.3: a day of warm-up counts only under these rates. */
  warmupBounce: '2%',
  warmupComplaint: '0.05%',
  /** §7.4: over a rolling window, once an account has sent this many. */
  windowDays: 7,
  minSends: 500,
  warnBounce: '2%',
  warnComplaint: '0.05%',
  pauseBounce: '4%',
  pauseComplaint: '0.08%',
} as const

/** The header's links: two pages, then the two account actions. */
export const HEADER_NAV = [
  { href: ROUTES.pricing, label: 'Pricing' },
  { href: ROUTES.docs, label: 'Docs' },
] as const
