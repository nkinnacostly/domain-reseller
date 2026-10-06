import { BRAND_NAME, PRODUCT_NAME } from '@/components/layout/brand'

/**
 * The facts Mail's public and legal pages state — change them here, nowhere
 * else. Copied from the shop's `apps/web/src/lib/business.ts` (6 Oct 2026),
 * not imported: the two apps deploy apart and never import across apps.
 * Keep the operator's facts in step with that file when either changes.
 * Copy must describe only what is true (N9b).
 */
export const BUSINESS = {
  brand: BRAND_NAME,
  product: PRODUCT_NAME,
  /** The legal operator, as its certificate of incorporation names it (CAC, 13 Aug 2026). */
  operator: 'CLOOP UNIVERSE TECH LTD',
  /** Its Corporate Affairs Commission registration number, from the same certificate. */
  rcNumber: 'RC 9771867',
  /** Its Tax Identification Number, from the same certificate. */
  tin: '2622401595060',
  /** The shop, MyDomainsHub's other product. */
  shopSite: 'www.mydomainshub.com',
  shopUrl: 'https://www.mydomainshub.com',
  /** Where Mail lives (MAIL-SPEC header). */
  site: 'emails.mydomainshub.com',
  /** The v1 API's base address (MAIL-SPEC §6). */
  apiBase: 'https://emails.mydomainshub.com/api/v1',
  /** One address for support, abuse and privacy requests (the owner's choice, as the shop's). */
  email: 'hello@mydomainshub.com',
  /**
   * VAT on our supply, added at checkout (MAIL-SPEC §8: prices are before
   * VAT 7.5%). Words for the page only: no price is computed from it. Billing
   * (P3) charges from its own settings; when it lands, read this from there.
   */
  vatRate: '7.5%',
  /** The legal pages' date: when these drafts were written. */
  legalUpdated: '6 October 2026',
  /** The same date for machines (the sitemap's lastmod). */
  legalUpdatedOn: '2026-10-06',
} as const

/**
 * The legal pages are drafts until the owner's lawyer has reviewed them
 * (MAIL-SPEC §14.5). Every legal page says so on the page and in an HTML
 * comment; drop both together once the review is done.
 */
export const LEGAL_DRAFT_NOTICE = 'Draft — pending legal review'
