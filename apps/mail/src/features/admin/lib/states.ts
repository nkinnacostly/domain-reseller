/** The states Mail's admin filters by (migrations 43, 47): an account's, and a domain's. */
export const ACCOUNT_STATES = ['sandbox', 'active', 'paused', 'closed'] as const
export type AccountState = (typeof ACCOUNT_STATES)[number]

export const DOMAIN_STATUSES = ['pending', 'verified', 'failed', 'removed'] as const
export type DomainStatus = (typeof DOMAIN_STATUSES)[number]
