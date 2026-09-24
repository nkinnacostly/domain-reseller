import { BRAND_NAME } from '@/components/layout/brand'

/**
 * The facts the legal and help pages state — change them here, nowhere else.
 * Every one is either the owner's answer (23 Sept 2026) or read from a live
 * record; copy must describe only what is true (N9b).
 */
export const BUSINESS = {
  brand: BRAND_NAME,
  /** The legal operator (the owner's answer; the supplier account is in this name). */
  operator: 'CLOOP UNIVERSE TECH',
  site: 'www.mydomainshub.com',
  /** One address for support, abuse and privacy requests (the owner's choice). */
  email: 'hello@mydomainshub.com',
  /**
   * Automated email comes from here — an authenticated subdomain, so its
   * reputation is kept apart — and every reply goes to `email` (the owner's
   * choice, 24 Sept 2026).
   */
  noReplyEmail: 'no-reply@notify.mydomainshub.com',
  /** Promise for refunding a paid line that fails to register (the owner's choice). */
  refundBusinessDays: 5,
  lastUpdated: '23 September 2026',
  /** The same date for machines (the sitemap's lastmod). */
  lastUpdatedOn: '2026-09-23',
} as const

/**
 * The ICANN-accredited registrar behind our supplier (CMP-1), read from the
 * .com registry's RDAP record for mydomainshub.com on 23 Sept 2026. Verified
 * for .com only: other extensions may differ, so pages point to the public
 * record rather than claim it for them.
 */
export const SPONSORING_REGISTRAR = {
  name: 'Atak Domain Bilgi Teknolojileri A.Ş.',
  country: 'Türkiye',
  ianaId: '1601',
  abuseEmail: 'domain@apiname.com',
  verifiedFor: '.com',
} as const

/** Official policy texts, at the addresses ICANN and the NDPC serve them from. */
export const POLICY_LINKS = {
  registrantBenefits: 'https://www.icann.org/resources/pages/benefits-2013-09-16-en',
  registrantEducation: 'https://www.icann.org/resources/pages/educational-2012-02-25-en',
  udrp: 'https://www.icann.org/en/contracted-parties/consensus-policies/uniform-domain-name-dispute-resolution-policy/uniform-domain-name-dispute-resolution-policy-25-02-2012-en',
  udrpRules:
    'https://www.icann.org/en/contracted-parties/consensus-policies/uniform-domain-name-dispute-resolution-policy/rules-for-uniform-domain-name-dispute-resolution-policy-the-rules-11-03-2015-en',
  transferPolicy:
    'https://www.icann.org/en/contracted-parties/accredited-registrars/transfer-policy-01-06-2016-en',
  tdrp: 'https://www.icann.org/en/contracted-parties/accredited-registrars/registrar-transfer-dispute-resolution-policy-01-06-2016-en',
  errp: 'https://www.icann.org/en/contracted-parties/consensus-policies/expired-registration-recovery-policy/expired-registration-recovery-policy-28-02-2013-en',
  registrationDataPolicy:
    'https://www.icann.org/en/contracted-parties/consensus-policies/registration-data-policy',
  icannLookup: 'https://lookup.icann.org/en',
  ndpc: 'https://ndpc.gov.ng/',
} as const
