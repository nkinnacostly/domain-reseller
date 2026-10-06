/**
 * The companies Mail's service runs on (MAIL-SPEC §10: AWS SES eu-west-2,
 * Supabase, Vercel, Fly, Flutterwave, Cloudflare), what each does for Mail,
 * what it receives and where. Locations are the ones our set-up uses
 * (docs/DEPLOY.md, MAIL-SPEC §4); one not yet fixed says so.
 */
export type SubProcessor = {
  name: string
  purpose: string
  data: string
  location: string
}

export const SUB_PROCESSORS: readonly SubProcessor[] = [
  {
    name: 'Amazon Web Services (Amazon SES)',
    purpose: 'Sends every email, and reports deliveries, bounces and complaints back to us.',
    data: 'Sender and recipient addresses, the message and its attachments, delivery events.',
    location: 'London, United Kingdom (region eu-west-2)',
  },
  {
    name: 'Supabase',
    purpose: 'Our database and sign-in provider.',
    data: 'Account and team details, the email log, message bodies for 72 hours, suppression lists.',
    location: 'London, United Kingdom',
  },
  {
    name: 'Vercel',
    purpose: 'Hosts this website, the dashboard and the API.',
    data: 'Requests as they pass through, including the emails you send to the API.',
    location: 'United States, with servers worldwide',
  },
  {
    name: 'Fly.io',
    purpose: 'Runs the mail worker, which hands queued emails to Amazon SES.',
    data: 'Each message on its way to Amazon SES.',
    location: 'Region to be confirmed before launch',
  },
  {
    name: 'Flutterwave',
    purpose: 'Takes card payments for paid plans, once they are on sale.',
    data: 'Account holders’ payment details. No recipients’ data.',
    location: 'Nigeria',
  },
  {
    name: 'Cloudflare',
    purpose: 'Runs the DNS for our domains.',
    data: 'The network addresses of resolvers that look our domains up. No recipients’ data.',
    location: 'United States, with servers worldwide',
  },
]
