/**
 * Mail's legal documents (MAIL-SPEC §10), in the order the index and the
 * in-page list show them. All are drafts until the owner's lawyer has
 * reviewed them (§14.5); `LEGAL_DRAFT_NOTICE` marks each page.
 */
export const LEGAL_DOCUMENTS = [
  {
    href: '/legal/terms',
    title: 'Terms of Service',
    summary: 'The agreement for using MyDomainsHub Mail: accounts, plans, caps and payment.',
  },
  {
    href: '/legal/acceptable-use',
    title: 'Acceptable Use Policy',
    summary: 'What you may send through us, what you may not, and what happens if you do.',
  },
  {
    href: '/legal/privacy',
    title: 'Privacy Notice',
    summary: 'What personal data we hold, for you and for the people you email, and for how long.',
  },
  {
    href: '/legal/dpa',
    title: 'Data Processing Agreement',
    summary: 'How we process your recipients’ personal data on your behalf.',
  },
  {
    href: '/legal/sub-processors',
    title: 'Sub-processors',
    summary: 'The companies whose services we use to send your email, and where.',
  },
] as const
