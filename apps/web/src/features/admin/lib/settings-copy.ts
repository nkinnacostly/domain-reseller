import type { AdminSide } from '@/features/admin/lib/side'

/**
 * Every sentence on the Settings pages (docs/ADMIN-SPEC.md §5.2 B13), in one
 * place so the tests can hold them. Copy says what the code does and nothing
 * more (N9b): a limit's number is never written here — it is interpolated
 * from the row — and a preset is never named with its nameservers here
 * (N11): they come from the database.
 */

const plural = (count: number, one: string, many: string) =>
  `${count.toLocaleString('en-GB')} ${count === 1 ? one : many}`

export const SIDE_NAME: Record<AdminSide, string> = { live: 'Live', test: 'Test' }

// ── The pages ──────────────────────────────────────────────────────────────

export const SETTINGS_PAGES = {
  limits: {
    title: 'Settings',
    description: 'Refund, order, velocity and float limits: what the site does without a person.',
  },
  extensions: {
    title: 'Extensions',
    description:
      'Which extensions are paused or featured. Wholesale prices and what DomainNameAPI sells come from the weekly sync.',
  },
  ssl: {
    title: 'SSL products',
    description:
      "Which certificate products are on sale. The weekly sync owns everything else about them; on sale or not is the owner's choice.",
  },
  presets: {
    title: 'Nameserver presets',
    description:
      "Hosts' nameservers as customers pick them, their health in public DNS, and changes waiting to be published.",
  },
  admins: {
    title: 'Admins',
    description: 'Who can open the admin area, and their linked authenticator devices.',
  },
} as const

/** Who may change what on these pages, said where a control is offered to someone SQL will refuse. */
export const OWNER_ONLY = {
  limits: 'Only the owner changes limits.',
  extensions:
    'Only the owner pauses, resumes or features an extension. Anyone else can open a dialog to see what a change would do; the change itself is refused.',
  ssl: 'Only the owner puts a product on sale or takes it off. Anyone else can open a dialog; the change itself is refused.',
  presets:
    'Only the owner saves, publishes or shows a preset again; an operator may hide one. Anyone else can open a dialog; the change itself is refused.',
} as const

/** ops_settings has no side and holds the money limits: SQL refuses it to a test admin. */
export const LIMITS_HIDDEN = 'Limits are not shown to test administrators.'
export const LIMITS_UNREADABLE = "The limits couldn't be read."

// ── Limits ──────────────────────────────────────────────────────────────────

export const LIMITS_COPY = {
  intro:
    'Every number here is read by the site as it works: a refund over a limit is held for a person, an account past its daily cap is refused a new domain.',
  review: 'Review changes',
  confirm: 'Save limits',
  cancel: 'Cancel',
  done: 'Limits saved.',
  noChanges: 'Change a value to save it.',
  raise:
    'Refunds already held stay held until someone approves them. Raising a refund limit sends a Telegram notice.',
  lower: 'Refunds already queued are judged against the new limit when the worker picks them up.',
} as const

export function limitsTitle(count: number): string {
  return `Change ${plural(count, 'limit', 'limits')}?`
}

// ── Extensions ──────────────────────────────────────────────────────────────

export const EXTENSIONS_COPY = {
  manage: 'Change',
  close: 'Close',
  heldNote: (side: AdminSide) =>
    `Held domains: ${SIDE_NAME[side]}-side domains on the extension that are active, in grace, in redemption, pending deletion or waiting for verification.`,
  pauseConfirm: 'Pause',
  resumeConfirm: 'Resume',
  featureConfirm: 'Save featuring',
  unfeatureConfirm: 'Stop featuring',
  pausedDone: 'Paused. Prices on the site were refreshed.',
  resumedDone: 'Resumed. Prices on the site were refreshed.',
  featuredDone: 'Featuring saved. Prices on the site were refreshed.',
  unfeaturedDone: 'No longer featured. Prices on the site were refreshed.',
  pauseReasonLabel: 'Why it is paused',
  rankLabel: 'Rank',
  rankHint: '1 is shown first. Each rank belongs to one extension.',
  taglineLabel: 'Tagline (optional)',
  taglineHint: 'Up to 60 characters, shown beside it where the site lists popular extensions.',
  notSold:
    'DomainNameAPI does not sell this extension today, so it stays off sale whatever is set here, until the weekly sync lists it again.',
} as const

/** The pause dialog: what a pause does to customers, with the held count from SQL. */
export function pauseCopy(name: string, held: number | null, side: AdminSide) {
  const using =
    held === null
      ? 'How many domains are held on it could not be read.'
      : `${plural(held, 'domain', 'domains')} on the ${SIDE_NAME[side]} side ${held === 1 ? 'is' : 'are'} held on it; nothing changes for them at the registry.`
  return {
    title: `Pause .${name}?`,
    body: `While .${name} is paused the site has no price for it, so nobody can register, transfer in or renew a .${name} domain here. ${using} The site's prices refresh straight after this.`,
  }
}

export function resumeCopy(name: string) {
  return {
    title: `Resume .${name}?`,
    body: `.${name} is offered again at its current price once the site's prices refresh, which happens straight after this. Its pause reason is cleared.`,
  }
}

export function featureCopy(name: string, featured: boolean) {
  return {
    title: featured ? `Change how .${name} is featured?` : `Feature .${name}?`,
    body: 'Featured extensions are listed first, in rank order, where the site shows popular extensions. The site’s prices refresh straight after this.',
  }
}

export function unfeatureCopy(name: string) {
  return {
    title: `Stop featuring .${name}?`,
    body: `.${name} stays on sale; it is no longer listed among the popular extensions. The site's prices refresh straight after this.`,
  }
}

/** A featured rank another extension holds: the database allows each rank once. */
export function rankTakenWords(rank: number, holder: string | null): string {
  return holder
    ? `Rank ${rank} is .${holder}'s. Choose another rank, or move .${holder} first.`
    : `Rank ${rank} is taken by another extension. Choose another rank.`
}

// ── SSL products ────────────────────────────────────────────────────────────

export const SSL_COPY = {
  onConfirm: 'Put on sale',
  offConfirm: 'Take off sale',
  onDone: 'On sale. Prices on the site were refreshed.',
  offDone: 'Off sale. Prices on the site were refreshed.',
  noPrice: 'DomainNameAPI lists no price for this product yet.',
  incomplete: "This product's details are incomplete, so it can't be sold yet.",
} as const

export function sslOnCopy(name: string) {
  return {
    title: `Put ${name} on sale?`,
    body: "Customers can buy it at the site's price for it once prices refresh, which happens straight after this.",
  }
}

export function sslOffCopy(name: string) {
  return {
    title: `Take ${name} off sale?`,
    body: 'Customers stop seeing it once prices refresh, which happens straight after this. Certificates already bought are not touched.',
  }
}

// ── Presets ─────────────────────────────────────────────────────────────────

export const PRESET_COPY = {
  saveConfirm: 'Save draft',
  saveDone: 'Draft saved. Check it in public DNS, then publish it.',
  checkNow: 'Check now',
  publishConfirm: 'Publish',
  publishDone: 'Published. Customers see the new nameservers from the next refresh.',
  discardConfirm: 'Discard draft',
  discardDone: 'Draft discarded. The live preset is as it was.',
  hideConfirm: 'Hide',
  hideDone: 'Hidden. Customers no longer see it as a choice.',
  showConfirm: 'Show again',
  showDone: 'Shown again. Customers can choose it from the next refresh.',
  registrarDefault:
    "The registrar's default nameservers are changed in the SQL editor only (DEPLOY.md §6). They are never offered as a host.",
  sourceRule:
    "The source must be the provider's own documentation, on a site listed for it. New sites are added in the SQL editor (DEPLOY.md §6).",
  perZone:
    'The host gives each domain its own nameservers, so the preset holds none and there is nothing to check in DNS.',
  checkerHid:
    'The health check hid this preset. It shows again by itself once its nameservers resolve.',
} as const

export function saveDraftCopy(provider: string) {
  return {
    title: `Save a draft of ${provider}'s nameservers?`,
    body: `Customers keep seeing the current nameservers. The draft is checked in public DNS (now, or within 6 hours); then you publish it. The source must be ${provider}'s own documentation.`,
  }
}

export function publishCopy(provider: string) {
  return {
    title: `Publish ${provider}'s new nameservers?`,
    body: `Every checkout, host pick and bulk change that uses ${provider} sends domains to these nameservers from the next refresh. A Telegram notice is sent.`,
  }
}

export function discardCopy(provider: string) {
  return {
    title: `Discard the draft of ${provider}'s nameservers?`,
    body: 'The live preset stays as it is. The draft is kept on record as discarded.',
  }
}

/** Hide: who uses the preset now (admin_preset_usage, this side), and what they keep. */
export function hideCopy(provider: string, domains: number | null, side: AdminSide) {
  const using =
    domains === null
      ? 'Who uses it now could not be read; domains on it keep their nameservers.'
      : `${plural(domains, 'domain uses', 'domains use')} it now on the ${SIDE_NAME[side]} side; they keep their nameservers.`
  return {
    title: `Hide ${provider}?`,
    body: `${using} Customers stop seeing it as a choice within a minute.`,
  }
}

export function showCopy(provider: string) {
  return {
    title: `Show ${provider} again?`,
    body: 'Customers can choose it again — at checkout, on the Nameservers tab and in bulk changes — from the next refresh. A Telegram notice is sent.',
  }
}

// ── Admins ──────────────────────────────────────────────────────────────────

export const ADMINS_NOTE =
  'Admins and their linked devices are changed in the SQL editor (DEPLOY.md §6b). Every change sends a Telegram alert.'

export const ADMINS_TEST_NOTE = 'A test administrator sees only their own row.'

/** "2 linked, 2 active" — or "1 of 2 removed" once a pinned device is gone. */
export function pinnedWords(pinned: number, verified: number): string {
  if (verified >= pinned) return `${pinned} linked, ${verified} active`
  return `${pinned - verified} of ${pinned} removed`
}

export const ROLE_WORDS: Record<string, string> = {
  owner: 'Owner',
  operator: 'Operator',
  viewer: 'Viewer',
}
