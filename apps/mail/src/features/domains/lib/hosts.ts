/**
 * Where each DNS host keeps its records, as the host's own documentation
 * says — read on 6 Oct 2026, with the pages named, as the shop's nameserver
 * presets are (N11's spirit: no guessing). Where a host publishes no steps we
 * could read, the guide says so and says who can tell you, rather than invent
 * a menu path (N9b).
 */

export type HostGuide = {
  id: 'cloudflare' | 'truehost' | 'hostinger'
  name: string
  steps: string[]
  notes: string[]
  sources: { title: string; url: string }[]
  checkedOn: string
}

export const HOST_GUIDES: readonly HostGuide[] = [
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    steps: [
      'In the Cloudflare dashboard, open your domain, then DNS → Records, and select Add record.',
      'Choose the record’s type, type its name, paste its value, and save. Add each record below this way.',
    ],
    notes: [
      'For each CNAME, set Proxy status to “DNS only” (the grey cloud). Cloudflare says records that prove you own a domain should not be proxied; a proxied DKIM record cannot be read.',
      'Type the name without your domain (Cloudflare’s “subdomain”), or @ for the domain itself.',
      'MX and TXT records are always DNS only. Cloudflare adds the quotes around a TXT value if you leave them out.',
    ],
    sources: [
      {
        title: 'Create DNS records',
        url: 'https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/',
      },
      {
        title: 'Proxy status',
        url: 'https://developers.cloudflare.com/dns/proxy-status/',
      },
      {
        title: 'DNS record types',
        url: 'https://developers.cloudflare.com/dns/manage-dns-records/reference/dns-record-types/',
      },
    ],
    checkedOn: '2026-10-06',
  },
  {
    id: 'truehost',
    name: 'Truehost',
    steps: [
      'Truehost Nigeria publishes no step-by-step DNS guide we could read (checked 6 Oct 2026). Truehost’s own help centre puts DNS in the client area under Domains → Manage DNS, where you edit the domain’s zone.',
      'If your DNS is on a Truehost hosting plan with cPanel, open Zone Editor, choose Manage next to the domain, then + Add Record.',
    ],
    notes: [
      'cPanel’s Zone Editor adds your domain to the name you type, so type only the part before your domain.',
      'If neither matches what you see, Truehost support can show you where DNS records are edited on your plan.',
    ],
    sources: [
      {
        title: 'How to manage DNS zones in your client area (Truehost)',
        url: 'https://truehost.com/support/how-to-manage-dns-zones-in-your-client-area/',
      },
      { title: 'Zone Editor (cPanel)', url: 'https://docs.cpanel.net/cpanel/domains/zone-editor/' },
    ],
    checkedOn: '2026-10-06',
  },
  {
    id: 'hostinger',
    name: 'Hostinger',
    steps: [
      'In hPanel, choose Domains in the left sidebar, then DNS, and pick your domain: this is the DNS Zone Editor.',
      'Enter each record’s type, name and value (Hostinger calls the value “content” or “points to”), then Add Record.',
    ],
    notes: [
      'Hostinger adds your domain to the name automatically, so type only the part before your domain.',
      'The default TTL of 14400 seconds is fine.',
    ],
    sources: [
      {
        title: 'How to manage DNS records at Hostinger',
        url: 'https://www.hostinger.com/support/1583249-how-to-manage-dns-records-at-hostinger/',
      },
      {
        title: 'How to manage CNAME records at Hostinger',
        url: 'https://www.hostinger.com/support/4738777-how-to-manage-cname-records/',
      },
    ],
    checkedOn: '2026-10-06',
  },
]
