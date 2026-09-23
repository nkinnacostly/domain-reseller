# After the build

Everything deliberately left for later, in one place. Agreed with the owner on
22 Sept 2026: finish the core build (search → cart → buy → manage), then come
back here. Each item says why it waited and what unblocks it.

---

## 1. Launch blockers — must be done before real customers

| # | Item | Why it matters | Unblocked by |
|---|---|---|---|
| L1 | **Custom SMTP for Supabase Auth** (e.g. Resend with a verified sending domain) | The built-in sender delivers only to members of the Supabase organisation, a few emails an hour. Sign-up confirmations, reset and sign-in links fail for everyone else. | A sending domain + SMTP credentials |
| L2 | **Enable the any-device email templates** in `supabase/config.toml` (`[auth.email.template.*]`, currently commented out) | Until then, email links only work in the browser that asked for them. The free tier refuses template changes on the built-in sender. | L1 |
| L3 | ~~Production `site_url` and redirect URLs~~ | Done 23 Sept 2026: the site runs on `https://www.mydomainshub.com` (the apex redirects there); Supabase Auth and `NEXT_PUBLIC_APP_URL` point at it. `mydomainshub.vercel.app` still serves, so Paidly's forward keeps working. | Done |
| L4 | **Ask DomainNameAPI to raise the concurrency limit** | They refuse a third concurrent request (PRD V4). A search is ~4 calls, so capacity is about one uncached search every 2 s across all users. | DomainNameAPI support |
| L5 | ~~DomainNameAPI OTE (sandbox) credentials~~ | Received 23 Sept 2026 (`DNA_API_TEST_KEY`); verified read-only: same reseller account, USD 1,000 sandbox balance. | Done |
| L6 | **Top up the DomainNameAPI balance** | Topped up USD 15 on 23 Sept 2026 for the owner's purchase; USD 3.69 left, so live checkout refuses orders again (the float check works). Plan the real float per PRD FR-FLOAT-4. | Owner |
| L7 | ~~GitHub Actions secrets for `.github/workflows/pricing.yml`~~ | Done 23 Sept 2026: four secrets set; the first run activated ₦1,326.64 (both feeds within 0.26%). Daily FX at 08:00 WAT, catalogue Mondays 07:00 WAT. A real failure now fails the run; only a rate held for review (exit 3) passes. | Done |
| L8 | **Revalidate prices after the jobs run** | Pricing is cached with `cacheTag('pricing')` and `cacheLife('hours')`, so a new rate reaches the site within about an hour. An immediate `revalidateTag('pricing')` after the jobs would close that gap. | Deployment |
| L9 | **Rotate the Supabase database password** | It was shared in a chat session. | Owner, Supabase dashboard |
| L10 | **Deploy the gateway** on infrastructure with a static egress IP (PRD ADR-004) — ready: `fly.toml`, Dockerfile and runbook in `docs/DEPLOY.md`; a Fly static egress IP can be added when the supplier enforces its allowlist | Allowlisting is not enforced today (V2), but the gateway is where credentials and rate limits live. Locally it reads from production (`DNA_ENV=production`) for real availability; writes follow `DNA_WRITE_ENV`, which refuses production outside a production deployment. | Hosting decision |
| L11 | **Flutterwave live keys and webhook secret hash** | Test keys only during the build. Set the secret hash in the dashboard and in `FLUTTERWAVE_WEBHOOK_HASH`. | Owner, after checkout is proven on test keys |
| L12 | **Flutterwave: merchant bears the transaction fee** | By default Flutterwave adds its fee on top at payment, so the customer would pay more than the total we show — against FR-C5 and our no-hidden-fees promise. Switch fees to the merchant in the dashboard, or show the fee. | Owner, Flutterwave dashboard |
| L13 | ~~Register the webhook URL~~ — the account's webhook is Paidly's, which forwards `MDH-` notices here (solostack branch `feat/forward-mydomainshub-webhooks`, live once merged) | Payments are confirmed when the customer returns; the webhook covers a closed tab. It needs a public URL (the deployment, or a tunnel for local testing). | Deployment |
| L14 | ~~First sandbox registrations~~ | Done 23 Sept 2026: two sandbox registrations end to end (orders ND-001024, ND-001025). They showed the register answer is sparse (now read back), the supplier's dates are UTC+3, and 403 is an ordinary refusal — all fixed. **Still to confirm on live:** the sandbox refuses real hosts as nameservers ("'NS1.VERCEL-DNS.COM' ns not found" — its registry has no such host), so pointing a domain at a real host was first tested live — and worked: `mydomainshub.com` moved to Cloudflare's nameservers on 23 Sept 2026. | Done |
| L15 | **Automatic refunds for failed lines** (FR-R3, I6) | The panel tells a live customer "We'll refund what you paid" for a failed line; today that refund is manual. Needs the wallet (FR-W1) or a Flutterwave refund call. Must exist before `DNA_WRITE_ENV=production`. | Wallet or refund API |
| L16 | **Alerts for stuck jobs and registry drift** (I5, §13.5) | A job in `needs_attention`, an order in `provisioning` for over 15 minutes, and open `registry_drift` rows (a supplier renewal, a domain missing at the registry) are only logged at error level and kept in the database. Someone has to be told. `retry_job()` puts a job back once the registry has been checked. | Alerting channel |
| L17 | **Live registrations for customers** — first live registration done 23 Sept 2026: `mydomainshub.com`, order ND-001036, confirmed at Verisign (sponsoring registrar **Atak Domain Bilgi Teknolojileri A.S.** — the name CMP-1 needs on the registration agreement for .com). | `DNA_WRITE_ENV=production` on the deployed gateway and `CHECKOUT_ALLOWLIST` removed, after L6, L10, L15, L16, L18 and the legal pages. The owner's own purchase runs earlier behind the allowlist (`docs/DEPLOY.md`). | Those |
| L18 | **Switch off the supplier's own auto-renew** (FR-R6) | The supplier registers with `renewalMode: "AutoRenew"` (seen in the sandbox, 23 Sept 2026) and the SDK has no `ModifyRenewalMode`, so it could renew a domain from our float after the customer turned auto-renew off. The REST API has no call for it (checked against their OpenAPI spec); SOAP `ModifyRenewalMode` may. A support message is drafted (23 Sept 2026). **Safety net in place:** reconciliation flags `supplier_may_renew` 45 days ahead and `supplier_renewed` after the fact — it detects, it does not prevent. | DomainNameAPI support |

## 2. Deferred features

### Catalogue
- **The `.ng` family** (`.ng`, `.com.ng`, `.net.ng`, `.org.ng`) is paused (`tlds.is_paused`). DomainNameAPI charges USD 11.99 flat — 27–171% above market (PRD R17). Route back: a NiRA-accredited source such as Go54 (WHMCS reseller API, naira wallet, no price-list endpoint). Ask them for the reseller price sheet, API key and minimum deposit. Unpause with data, not code.

### Accounts (PRD E2)
- **Google sign-in** (FR-A1) — needs Google Cloud OAuth credentials added in Supabase.
- **Active sessions list and revoke** (FR-A5) — needs admin access to `auth.sessions`.
- **Security emails** (SEC-4): new-device sign-in, password change, 2FA change, contact/nameserver/lock changes — needs L1.
- **MFA recovery codes** (FR-A2) — `supabase-js` supports them (experimental) but the hosted server returns `mfa_recovery_codes_enroll_not_enabled`, and the CLI cannot enable it. Settings currently advises adding a second device.
- **Mandatory 2FA** above 10 domains or a wallet threshold (FR-A2) — needs the portfolio and wallet.
- **Bot protection on sign-up and search** (SEC-9) — Cloudflare Turnstile keys.
- **Contact profiles** (FR-A4) — the registrant/admin/tech/billing contacts; built with checkout, where registration needs them.

### Checkout and orders (PRD E3, E4)
- **Expire unpaid orders** — orders abandoned on Flutterwave's page stay `awaiting_payment`; cancel them after a timeout.
- **Refunds** (FR-R3) for lines that fail to register — to the wallet, automatically; the wallet (FR-W1) is not built.
- **Receipts and invoices** (FR-C5, CMP-17/18) — email needs L1; invoice numbering and e-invoicing are not built.
- **Nameserver host presets at checkout** (FR-C10, N11) — the `nameserver_presets` catalogue exists (migration 12) and the domain Nameservers tab uses it; checkout still takes pasted nameservers only.
- **More registrant countries** — the form offers Nigeria, Africa and common diaspora countries; extend when needed.
- **Wallet and mixed payment** (FR-C9, FR-W1/W2).

### Domain management (PRD E5 – E8, E10)
- **Registry-side controls** — nameserver changes now reach the registry (an `apply_nameservers` job per domain). Transfer lock, auth code reveal, contacts and privacy are still read-only.
- **Privacy default** — the sandbox turned contact privacy on for a line bought without it. We record what the registry reports; confirm on live whether the flag we send is honoured.
- **Domain deep sync and drift review** (§13.5) — the hourly portfolio reconcile is built; a per-domain `GetDetails` deep sync, and a screen to review and close `registry_drift`, are not. The sandbox holds two test domains we no longer track, so it reports two `unknown_domain` rows by design.
- **`supplier_calls` retention** — rows accumulate; decide how long to keep them.
- **Delegation verification job** (FR-D5) and the one-time undelegated nudge (FR-D8, needs L1).
- **Renew now and restore** (FR-RN1, FR-RN5, FR-RN6) — a renewal checkout like registration's; the renewal engine and dunning (FR-RN2, FR-RN3).
- **Labels and bulk actions** (FR-P3, FR-P4, FR-N2), **glue records** (FR-N3), **revert to previous nameservers** (FR-N5).
- **More nameserver presets** — Go54 (WhoGoHost) and QServers once their own documentation confirms the values; quarterly re-verification and auto-hiding presets that stop resolving (FR-D2).

### Cart (PRD E3)
- **Contact privacy on country extensions** — offered on generic extensions only, where ICANN rules allow it. Confirm which ccTLDs the supplier can cover.
- **Clear out stale anonymous carts** — nothing removes an abandoned anonymous cart yet. Add a scheduled clean-up (e.g. older than the 60-day cookie).
- **Velocity limits** (SEC-11) — carts are capped at 50 domains; per-account daily limits come with checkout.

### Search (PRD E1)
- **Bulk search** (FR-S5), **IDN / Punycode** (FR-S8).
- **Per-extension length rules** (FR-S9) — the catalogue sync does not store min/max characters yet; the supplier's refusal is shown as "Not available" meanwhile.
- **Buying premium names** (FR-S3) — the supplier refuses them today ("please contact"); they are flagged, not sold.

### Transfers (PRD E9)
- **Starting a transfer** — auth code → `CheckTransfer` → payment → `Transfer`. The eligibility check is live; the rest needs the gateway write routes (L5) and checkout.

### Pages linked but not built
- `/domains/{tld}` (FR-PUB1), `/whois`, `/help`, `/contact`, `/abuse`, `/status`, `/legal/*` — footer and form links currently 404.

## 3. Quality debt

- **Web unit coverage** is below its 80% threshold (~56% lines): marketing and pricing components are covered only end to end. A task is queued.
- **CI never runs**: `.github/workflows/ci.yml` triggers on `main`, but the branch is `master`. Switching it on also needs the web coverage gap closed and e2e given a database, or it goes red at once.
- **Coverage `PARSE_ERROR`** from the V8 provider on an uncovered file in `apps/web`.
- **Live dependencies in e2e**: transfer checks hit real registry RDAP servers, and pricing and account tests use the hosted Supabase project. Consider a local Supabase (needs Docker) for isolation.
