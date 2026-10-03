# After the build

Everything deliberately left for later, in one place. Agreed with the owner on
22 Sept 2026: finish the core build (search → cart → buy → manage), then come
back here. Each item says why it waited and what unblocks it.

---

## 1. Launch blockers — must be done before real customers

| # | Item | Why it matters | Unblocked by |
|---|---|---|---|
| L1 | ~~Custom SMTP for Supabase Auth~~ | Done 24 Sept 2026: Brevo, from `no-reply@notify.mydomainshub.com` (SPF, DKIM, DMARC on the subdomain); 100 auth emails an hour. The app's own emails — receipts, domain news, refunds, security notices, ERRP reminders and the undelegated nudge — are built (24 Sept 2026, migration 31) and sent by the gateway once `BREVO_API_KEY` is set on Fly. Amazon SES is built as the next provider (§1c). | Done |
| L2 | ~~Enable the any-device email templates~~ | Done 24 Sept 2026: token-hash links to `/auth/confirm`, in the MyDomainsHub brand. | Done |
| L3 | ~~Production `site_url` and redirect URLs~~ | Done 23 Sept 2026: the site runs on `https://www.mydomainshub.com` (the apex redirects there); Supabase Auth and `NEXT_PUBLIC_APP_URL` point at it. `mydomainshub.vercel.app` still serves, so Paidly's forward keeps working. | Done |
| L4 | ~~Ask DomainNameAPI to raise the concurrency limit~~ | Answered 25 Sept 2026: the hard limit is 2 requests per second account-wide and cannot be raised; past softer thresholds they slow answers down. The gateway holds to both (two in flight, two starts a second). Search capacity grows only through caching (PRD V4). | Done |
| L5 | ~~DomainNameAPI OTE (sandbox) credentials~~ | Received 23 Sept 2026 (`DNA_API_TEST_KEY`); verified read-only: same reseller account, USD 1,000 sandbox balance. | Done |
| L6 | **Top up the DomainNameAPI balance** | Topped up USD 15 on 23 Sept 2026 for the owner's purchase; USD 3.69 left, so live checkout refuses orders again (the float check works). Plan the real float per PRD FR-FLOAT-4. | Owner |
| L7 | ~~GitHub Actions secrets for `.github/workflows/pricing.yml`~~ | Done 23 Sept 2026: four secrets set; the first run activated ₦1,326.64 (both feeds within 0.26%). Daily FX at 08:00 WAT, catalogue Mondays 07:00 WAT. A real failure now fails the run; only a rate held for review (exit 3) passes. | Done |
| L8 | ~~Revalidate prices after the jobs run~~ | Done 24 Sept 2026: `pricing.yml` calls `POST /api/pricing/refresh` after the jobs, which refreshes the cached catalogue only when the prices actually changed (rate-limited, 12 an hour). | Done |
| L9 | **Rotate the Supabase database password** | It was shared in a chat session. | Owner, Supabase dashboard |
| L10 | ~~Deploy the gateway~~ | Done 23 Sept 2026: `mydomainshub-gateway` on Fly.io, one machine in London (`docs/DEPLOY.md`). **Still open:** a static egress IP before the supplier enforces its allowlist (V2, PRD ADR-004). Support asks for the gateway's outbound IP to be whitelisted (Settings → API Management → Allowed IP Addresses); it is not enforced for us yet. Once it is, calls from anywhere else are refused — including the weekly catalogue sync on GitHub's runners and local dev reads — so the sync must move into the gateway first, and a payment card on the Fly account — see L19. | Done |
| L11 | ~~Flutterwave live keys and webhook secret hash~~ | Done 23 Sept 2026: live keys and `FLUTTERWAVE_WEBHOOK_HASH` are set on Vercel; the owner's live purchase went through them. | Done |
| L12 | ~~Flutterwave transaction fee~~ | Decided 24 Sept 2026: the customer pays Flutterwave's processing fee, added on Flutterwave's page. Checkout, renewal and transfer payments, the pricing, extension and help pages say so; refunds return the order amount, not the fee (refund policy). | Done |
| L13 | ~~Register the webhook URL~~ | Done 23 Sept 2026: the account's webhook is Paidly's, which forwards `MDH-` notices here (solostack `feat/forward-mydomainshub-webhooks`, merged). | Done |
| L14 | ~~First sandbox registrations~~ | Done 23 Sept 2026: two sandbox registrations end to end (orders ND-001024, ND-001025). They showed the register answer is sparse (now read back), the supplier's dates are UTC+3, and 403 is an ordinary refusal — all fixed. **Still to confirm on live:** the sandbox refuses real hosts as nameservers ("'NS1.VERCEL-DNS.COM' ns not found" — its registry has no such host), so pointing a domain at a real host was first tested live — and worked: `mydomainshub.com` moved to Cloudflare's nameservers on 23 Sept 2026. | Done |
| L15 | ~~Automatic refunds for failed lines~~ (FR-R3, I6) | Built 23 Sept 2026 (migrations 15–16, `apps/gateway/src/refunds`), hardened after a security review 24 Sept 2026 (migrations 18–19): a failed line, a second charge, an overpayment or a short payment queues a refund to the card or account that paid, sent by the gateway through Flutterwave's refund API. The database refuses any refund that would exceed its charge; the worker first reads the charge back from Flutterwave and refuses one that is not provably the order's, then reads the registry, checks for chargebacks and reads Flutterwave's refunds back before sending, and hands anything uncertain to a person. Worker calls are fenced by claim, a bounced refund keeps its reference when retried, and a line is never both registered and refunded. Charges the webhook and redirect both missed — a payment, or a second charge — are found by a sweeper (`apps/gateway/src/payments/sweeper.ts`); every registration is confirmed with Flutterwave before the registry is touched; payment rows keep no customer or card details (migration 20). The live key and Telegram are set on Fly (24 Sept 2026). **Still open (owner):** the questions for Flutterwave support in `docs/DEPLOY.md` §6. | Done |
| L16 | ~~Alerts for stuck jobs and registry drift~~ (I5, §13.5) | Built 23 Sept 2026: the gateway checks every five minutes for jobs needing a person, orders paid but not settled after 15 minutes, refunds held or stuck, payment incidents, registry drift, a stale reconcile and a low float, and messages the owner on Telegram — once, then reminders until cleared. A GitHub Action (`gateway-watch.yml`, hourly) warns when the gateway itself goes quiet. The bot token and chat id are set on Fly and GitHub (24 Sept 2026). | Done |
| L17 | ~~Live registrations for customers~~ | Switched on 25 Sept 2026: the gateway writes to production (its start-up log says so) and `CHECKOUT_ALLOWLIST` is gone from Vercel, so anyone can pay. First live registration 23 Sept 2026: `mydomainshub.com`, order ND-001036, confirmed at Verisign (sponsoring registrar **Atak Domain Bilgi Teknolojileri A.S.** — the name CMP-1 needs on the registration agreement for .com). Until L6, every live order is refused before payment by the float check. | Done |
| L18 | ~~Switch off the supplier's own auto-renew~~ (FR-R6) | Answered 24 Sept 2026 (Ticket#36270966): automatic renewal "is currently not available" for our account, so the supplier never renews from our float — every renewal is one we make. The sandbox's `renewalMode: "AutoRenew"` is therefore only a label. Reconciliation still reports `supplier_renewed` if that ever changes. The flip side: a domain nobody renews expires, so expiry reminders (ERRP, needs L1) matter. | Done |
| L19 | **A payment card on the Fly account** | Without one, the trial stops the gateway machine after five minutes, so paid orders wait in the queue until someone wakes it. It stalled a nameserver change on 23 Sept 2026. | Owner, https://fly.io/trial |
| L21 | ~~`BREVO_API_KEY` on the gateway~~ | Done 24 Sept 2026: set on Fly; the gateway sends receipts, refunds, security notices and ERRP reminders. The first device an account signs in from is never announced, so a new-sign-in notice needs a second browser or computer (another Chrome on the same Mac counts as the same device). | Done |
| L20 | ~~Receive mail at `hello@mydomainshub.com`~~ | Done 24 Sept 2026: a Spaceship mailbox (MX, SPF, DKIM, autodiscover and DMARC `p=none` in Cloudflare). Automated email comes from `no-reply@notify.mydomainshub.com` with Reply-To hello@. | Done |

## 1b. Being found — owner steps

The site side is built (24 Sept 2026, `apps/web/src/features/seo`): robots.txt, sitemap, canonical addresses, structured data, `/llms.txt`, the extension directory, the About page and IndexNow. These need the owner's accounts:

| # | Item | Why it matters | Where |
|---|---|---|---|
| F1 | ~~Submit the sitemap in Google Search Console~~ | Done 24 Sept 2026: `sitemap.xml` submitted (domain property, verified by DNS). Watch Indexing → Pages for errors; the Generative AI report shows appearances in AI Overviews and AI Mode. | Done |
| F2 | ~~Add the site to Bing Webmaster Tools~~ | Done 24 Sept 2026: imported from Search Console. Bing's index feeds Copilot and ChatGPT search; its AI Performance report shows citations. All 709 URLs were also sent through IndexNow the same day. | Done |
| F3 | **Brand profiles elsewhere** | AI assistants recommend what other sites mention. Create the brand's profiles (X, LinkedIn, Instagram, Facebook) and list the site where Nigerian businesses look for services; send the links so the site's Organization data can name them (`sameAs`). Only real profiles — none are claimed today. | Owner |

## 1c. Email through Amazon SES — owner steps

Built 25 Sept 2026 (migration 34): `EMAIL_PROVIDER=ses` sends the auth emails and the outbox through SES in eu-west-2, and `/api/email/ses-events` records SES's delivery events from SNS. Brevo stays the default until these are done, in order — the checklist is `docs/DEPLOY.md` §5c.

| # | Item | Why it matters | Where |
|---|---|---|---|
| E1 | **SES production access** | The account is in the SES sandbox: it delivers only to verified addresses, one message a second. Customers' email cannot go through SES until AWS lifts that. Note the send rate AWS grants (it becomes `SES_MAX_SEND_RATE`). | Owner, AWS console → SES → Account dashboard |
| E2 | **SES SMTP credentials for Supabase Auth's fallback** | With the Send Email hook off, Supabase sends over SMTP; after the cutover that should be SES too (`email-smtp.eu-west-2.amazonaws.com:587`). `.env` already names `SES_SMTP_USERNAME` / `SES_SMTP_PASSWORD`: confirm they are SES SMTP credentials made for eu-west-2 (not the API key), then switch `[auth.email.smtp]` and push at cutover. | Owner, AWS console → SES → SMTP settings |
| E3 | **Cut over to SES** | Subscribe `/api/email/ses-events` to the `mydomainshub-ses-events` topic (HTTPS, raw delivery off) with `SES_EVENTS_TOPIC_ARN` on Vercel; then `EMAIL_PROVIDER=ses` and the `AWS_SES_*` values on Vercel and Fly, the SMTP fallback (E2), and a few days of watching deliveries. | Owner, `docs/DEPLOY.md` §5c |
| E4 | **Retire Brevo** | Once SES has run clean for a couple of weeks: remove `BREVO_*` from Vercel, Fly and `.env`, delete Brevo's DNS records on `notify.mydomainshub.com` (keeping SES's DKIM, MAIL FROM and DMARC) and close the account, so a second sender is not left authorised for the domain. | Owner, Vercel, Fly, Cloudflare, Brevo |

## 1d. SSL certificates — owner steps

Built 2 Oct 2026 (PRD E15, migrations 38–39): three Sectigo PositiveSSL products, bought, set up, approved, downloaded and reissued through the panel. Not live until these are done.

| # | Item | Why it matters | Where |
|---|---|---|---|
| C1 | **Apply migrations 38–39, then deploy the gateway, then the web** | In that order: the gateway must know the SSL job kinds and `/v1/ssl/*` routes before the web can queue or call them. Its first start prices the three products. | Owner, `docs/DEPLOY.md` §5b "SSL certificates" |
| C2 | **Confirm the term wording** | The site sells "a 1-year subscription" and says certificates last at most 200 days, reissued free before they expire, and never "valid for one year". Confirm that is how you want it put, and that a reissue near the end of the subscription is acceptable to customers (see C5, question 3). | Owner |
| C3 | **Confirm the refund rule** | As built: a certificate is refunded automatically only if the supplier will not sell it (the order fails); once bought, it is not refundable — the refund policy and checkout say so. If you want a window (e.g. before set-up), say so and it will be built. | Owner |
| C4 | **Lawyer review of the SSL terms** | New copy: the registration agreement's SSL section (`/legal/registration-agreement#ssl`), the refund policy's (`/legal/refunds#ssl`) and the privacy notice's SSL paragraphs (what Sectigo and DomainNameAPI receive; Certificate Transparency logs publish every issued certificate's names). | Owner, with the other legal review below |
| C5 | **Questions for DomainNameAPI support** | 1) A reissue takes no CSR: how does a customer who lost the key reissue with a new one? 2) Revoke answers `Ssl:10003` "Package is not supported" for PositiveSSL — how is one revoked? 3) Does a reissue late in the subscription run to the subscription's end or a full 200 days? 4) After the subscription ends, can a new certificate be bought for the same name while the old one is still listed (every call is by name)? 5) Their contact takes a 2-character phone country code — +234 does not fit; is the whole number in `phone` right? 6) Is HTTP or DNS (CNAME) validation available, and where are its instructions? Only email was accepted in the sandbox. 7) Does the Multi Domain's `defaultSanCount` of 4 include the main name (we assume it does), and may extra names be on other domains? 8) The sandbox returns empty certificate text once issued — confirm live returns the PEM and chain. | Owner, DomainNameAPI ticket |
| C6 | **Float for certificates** | A certificate is bought from the same USD float as domains (Wildcard USD 87.99); live orders are refused before payment while the float is short (L6). | Owner |

## 1e. The admin dashboard — owner steps

Package A built 3 Oct 2026 (ADR-006, `docs/ADMIN-SPEC.md`): admins checked in SQL, every admin action audited, the gateway's audited live reads, the hourly supplier-ledger mirror, and every `/admin` page as a placeholder for the B packages. Not live until these are done.

| # | Item | Why it matters | Where |
|---|---|---|---|
| A1 | **Sign off ADR-006, then deploy and enrol yourself** | Apply migrations 40–41, deploy the gateway, then the web; enrol, pinning **every** device you will use; set `GATEWAY_ADMIN_SECRET` (`openssl rand -hex 32`) on Fly and Vercel — type it in your terminal, never in a chat. | Owner, `docs/DEPLOY.md` §5b and §6b |
| A2 | **Confirm the legacy JWT secret is revoked** | Supabase → JWT Keys: the JWKS shows an ES256 key; check nothing still uses the legacy anon or service keys first, then confirm the legacy secret is revoked. Keep `SUPABASE_ACCESS_TOKEN` out of CI and Vercel. L9 (rotate the database password) still applies. | Owner, Supabase dashboard |
| A3 | **Questions for DomainNameAPI support** | 1) What do ledger `type`, `status`, `chargeType` and `productType` mean, and can an entry change after it is created? 2) Which zone is `creationTime` in (it reads as UTC+3)? 3) Is the $0.20 ICANN fee billed as its own entry? 4) What do renewal and transfer debits' descriptions look like? 5) What status words does `domains/transfers/query` return? The mirror classifies what it can and alerts on the rest until these are answered. | Owner, DomainNameAPI ticket |
| A4 | **Decide whether to count searches** | The overview's funnel counts cart adds, checkouts and payments. Counting searches too (a number per day, never the terms — FR-S7) needs your yes. | Owner |
| A5 | **Decide on the deferred modules** | Abuse, risk scores, impersonation, status override, manual supplier operations, force-refund, a DSAR queue, SSL revoke and CSV export of personal data stay out of the dashboard (D20); the SQL editor covers them. Say which, if any, you want built. | Owner, PRD §17 |

## 2. Deferred features

### Catalogue
- **The `.ng` family** (`.ng`, `.com.ng`, `.net.ng`, `.org.ng`) is paused (`tlds.is_paused`). DomainNameAPI charges USD 11.99 flat — 27–171% above market (PRD R17). Route back: a NiRA-accredited source such as Go54 (WHMCS reseller API, naira wallet, no price-list endpoint). Ask them for the reseller price sheet, API key and minimum deposit. Unpause with data, not code.

### Accounts (PRD E2)
- **Google sign-in** (FR-A1) — built 25 Sept 2026: "Continue with Google" on sign-in and sign-up, shown once Supabase Auth has the provider on. Switched on 25 Sept 2026: the OAuth client is in Google Cloud and the provider is on in Supabase (`docs/DEPLOY.md` §5f).
- **Security emails** (SEC-4) — built 24 Sept 2026 (migration 31): a new device, a password or two-factor change, and a domain's nameservers, lock, contacts or transfer code. Still to add: "transfer-out requested" once the supplier tells us about one.
- **MFA recovery codes** (FR-A2) — `supabase-js` supports them (experimental) but the hosted server returns `mfa_recovery_codes_enroll_not_enabled`, and the CLI cannot enable it. Settings currently advises adding a second device.
- **Mandatory 2FA** (FR-A2) — above 10 domains built 24 Sept 2026: a notice on every panel page, and new orders and transfers in wait until it is on (renewals never do). The wallet-balance trigger waits for the wallet (FR-W1).
- **Bot protection on sign-up and search** (SEC-9) — built 25 Sept 2026 with Cloudflare Turnstile, verified on our server: the four forms that send email, search past 30 in ten minutes per address (a pass cookie lifts it to 300), and bulk search before a list starts. Switched on 25 Sept 2026: the widget is in Cloudflare and both keys are on Vercel, Production (`docs/DEPLOY.md` §5e).
- **Contact profiles** (FR-A4) — the registrant/admin/tech/billing contacts; built with checkout, where registration needs them.

### Refunds and alerts (after L15, L16)
- **An admin screen for refunds and alerts** (PRD §16 "Order queue") — approving, retrying, cancelling and recording manual refunds is SQL today (`docs/DEPLOY.md` §6). Who is an admin and how they sign in is decided (ADR-006) and its foundation is built (§1e); the refund screens land with package B3, which removes this line.
- ~~**Refund policy wording**~~ — done 25 Sept 2026 (the owner: follow Flutterwave): the policy and help centre say we send a refund within 5 business days, usually within minutes, and that a card refund can take up to 15 business days to show — as the order page and refund emails already did.
- **Refund emails** (FR-R3) — built 24 Sept 2026: a failed line is explained by email, and each refund is announced when it is sent.

### Checkout and orders (PRD E3, E4)
- **Receipts by email** (FR-C5) — built 24 Sept 2026: sent when the payment is recorded, every line with its renewal price (N8), linking the printable receipt.
- **Tax invoices** (CMP-17/18) — done 25 Sept 2026: live receipts are headed "Tax invoice" and carry the company's RC number and TIN from its certificate of incorporation (`src/lib/business.ts`); test receipts still say they are not one. *Owner:* confirm with a tax adviser that the company is registered for VAT (we charge 7.5%, CMP-16) and how FIRS e-invoicing (FR-TAX-1) applies.
- **Wallet and mixed payment** (FR-C9, FR-W1/W2).

### Domain management (PRD E5 – E8, E10)
- **Ask DomainNameAPI** (*owner*) — does it apply ICANN's 60-day lock after a registrant change, and is there an opt-out (FR-DS2)? How is a restore from redemption ordered (FR-RN6)? Does a transfer in add a year (PRD V19)? Why does SaveContacts answer 204 in the sandbox without changing anything? The self-serve controls, transfers in and renewals are built (24 Sept 2026).
- **Try a contact change on a live domain** (*owner*) — change one detail (e.g. the billing contact's phone) on `mydomainshub.com`'s Contacts tab and check the DomainNameAPI panel shows it. Contact changes could not be confirmed in the sandbox (above); until one is seen on live, each goes to a person (`CONTACTS_NOT_VISIBLE`).
- **Privacy default** — the sandbox turned contact privacy on for a line bought without it. We record what the registry reports; confirm on live whether the flag we send is honoured.
- **Domain deep sync and drift review** (§13.5) — the hourly portfolio reconcile and the per-domain deep sync are built (the deep sync 24 Sept 2026: `GetDetails` for 25 domains an hour, least recently read first — every domain daily up to 600 of them — and soon after a change, corrected and flagged as the reconcile would); a screen to review and close `registry_drift` is not. The sandbox holds two test domains we no longer track, so it reports two `unknown_domain` rows by design.
- **`supplier_calls` retention** — rows accumulate; decide how long to keep them.
- **The one-time undelegated nudge** (FR-D8) — built 24 Sept 2026: once, three days after registration. Delegation is verified by the gateway every 30 minutes (FR-D5).
- **SMS and WhatsApp** (FR-NT1) — ERRP notices and security notices go by email only; a second channel, and the fallback for a bounced ERRP notice (FR-NT3), need an SMS/WhatsApp provider. Until then a bounce is an ops alert and the owner reaches the registrant by hand.
- **Automatic renewal and dunning** (FR-RN2, FR-RN3) — renewing without the customer present needs a way to charge them: saved cards (Flutterwave tokenisation) or the wallet (FR-W1). The ERRP reminders (§7.4) are built (24 Sept 2026, migration 31). Renew now (FR-RN1, FR-RN5, FR-RN7) is built: `/app/domains/{name}/renew`, migrations 22–24.
- **Restore from redemption** (FR-RN6) — the SDK has no restore call; ask DomainNameAPI how a restore is ordered. Until then the renew page sends people to email for a quote.
- **Labels and bulk actions** (FR-P3, FR-P4, FR-N2) and **revert to previous nameservers** (FR-N5) — built 24 Sept 2026 on migration 32: labels in Settings → Labels, on each domain and as a portfolio filter; bulk renew (one order), auto-renew, nameservers, privacy, transfer lock, labels and CSV export from the portfolio, each with a results page; the Nameservers tab's change history and one-click revert. **Glue records** (FR-N3) are still not built.
- **More nameserver presets** (FR-D2) — Go54 (WhoGoHost) and QServers still need their values from each provider's own documentation. Built 24 Sept 2026: the gateway checks every preset in public DNS every 6 hours, hides one whose nameservers fail for a day (a critical alert) and shows it again once they resolve; a preset not re-verified for 90 days raises an alert (the quarterly re-verification).

### Cart (PRD E3)
- **Contact privacy on country extensions** — offered on generic extensions only, where ICANN rules allow it. Confirm which ccTLDs the supplier can cover.
- **Velocity limits** (SEC-11) — built 24 Sept 2026 (migration 32): carts are capped at 50 domains, and registrations and transfers in at a tiered daily limit that rises with account age and paid orders; the refusal names the account's own numbers.

### Search (PRD E1)
- **Per-extension length rules** (FR-S9) — built, but the supplier's REST catalogue gives no length limits, so none apply; the supplier's refusal is shown instead. Bulk search and international names are built (24 Sept 2026).
- **Buying premium names** (FR-S3) — the supplier refuses them today ("please contact"); they are flagged, not sold.

### Transfers (PRD E9)
- **Cancelling a pending transfer** (FR-T4) — *owner decision first:* when a customer cancels a transfer the registry already has, do they get their money back? Transfers in are built (24 Sept 2026); they open per extension once the gateway's catalogue sync marks it transferable.

### Pages
- Built: `/domains/{tld}`, `/whois`, `/status` (24 Sept 2026), `/domains` (the A–Z directory) and `/about` (24 Sept 2026), and the legal, help, contact and abuse pages (23 Sept 2026). Facts they state live in `apps/web/src/lib/business.ts`.

### Legal follow-ups
- **Business identity on the legal pages** — the CAC number (RC 9771867) is on the footer, the registration agreement, the privacy notice and receipts (25 Sept 2026). *Owner:* send a business address to add; the certificate does not carry one.
- **Data protection officer and NDPC registration** (CMP-9, CMP-10) — name a DPO and register with the NDPC once the 200-data-subject threshold approaches.
- **Keep the agreement in step with the product (N9b)** — renewal, transfers in, the lock, privacy, registrant edits and the transfer code are self-serve (24 Sept 2026); restores are by email. Update the registration agreement, help centre and refund policy when automatic renewal ships and when expiry reminders (ERRP, §7.4) are sent.
- **Sponsoring registrar for other extensions** — verified for .com only (RDAP, IANA ID 1601). Confirm per TLD before the legal pages name it for others.
- **Lawyer review** of the registration agreement, privacy notice and refund policy before launch.

## 3. Quality debt

- **Hosted database in e2e**: pricing and account tests use the hosted Supabase project; a local Supabase (needs Docker) would isolate them. Registry RDAP is mocked in e2e since 24 Sept 2026.
- **Node version**: run the dev server and Playwright on Node 22 (`.nvmrc`) or 24. Node 26.8's `fetch` fails parallel TLS requests to Supabase (CLAUDE.md §15).
