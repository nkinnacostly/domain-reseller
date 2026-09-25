import { BRAND_NAME } from '@/components/layout/brand'

/**
 * The facts the legal and help pages state — change them here, nowhere else.
 * Every one is either the owner's answer (23 Sept 2026) or read from a live
 * record; copy must describe only what is true (N9b).
 */
export const BUSINESS = {
  brand: BRAND_NAME,
  /** The legal operator, as its certificate of incorporation names it (CAC, 13 Aug 2026). */
  operator: 'CLOOP UNIVERSE TECH LTD',
  /** Its Corporate Affairs Commission registration number, from the same certificate. */
  rcNumber: 'RC 9771867',
  /**
   * Its Tax Identification Number, from the same certificate — printed on
   * receipts as the supplier's TIN (CMP-17).
   */
  tin: '2622401595060',
  site: 'www.mydomainshub.com',
  /** One address for support, abuse and privacy requests (the owner's choice). */
  email: 'hello@mydomainshub.com',
  /**
   * Automated email comes from here — an authenticated subdomain, so its
   * reputation is kept apart — and every reply goes to `email` (the owner's
   * choice, 24 Sept 2026).
   */
  noReplyEmail: 'no-reply@notify.mydomainshub.com',
  /**
   * How soon we send a refund for a paid line that fails (the owner's
   * commitment); the refund worker usually sends it within minutes.
   */
  refundSendBusinessDays: 5,
  /**
   * How long Flutterwave says a card refund can take to reach the customer
   * once sent (the order page and refund emails say the same); bank refunds
   * are usually quicker (the owner's choice, 25 Sept 2026: follow Flutterwave).
   */
  cardRefundBusinessDays: 15,
  lastUpdated: '25 September 2026',
  /** The same date for machines (the sitemap's lastmod). */
  lastUpdatedOn: '2026-09-25',
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
