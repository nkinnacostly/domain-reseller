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
| L3 | **Production `site_url` and redirect URLs** in `supabase/config.toml` | Both still point at `localhost`. | The production domain |
| L4 | **Ask DomainNameAPI to raise the concurrency limit** | They refuse a third concurrent request (PRD V4). A search is ~4 calls, so capacity is about one uncached search every 2 s across all users. | DomainNameAPI support |
| L5 | ~~DomainNameAPI OTE (sandbox) credentials~~ | Received 23 Sept 2026 (`DNA_API_TEST_KEY`); verified read-only: same reseller account, USD 1,000 sandbox balance. | Done |
| L6 | **Top up the DomainNameAPI balance** | It is USD 0 — every registration would fail with `API_350`. Plan the float per PRD FR-FLOAT-4. | Owner |
| L7 | **GitHub Actions secrets for `.github/workflows/pricing.yml`** | Without them the daily FX update and weekly catalogue sync never run, and prices freeze. Needs `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `DNA_RESELLER_ID`, `DNA_API_KEY` (optionally `FX_PARALLEL_API_KEY`). | Owner, repo settings |
| L8 | **Revalidate prices after the jobs run** | Pricing is cached with `cacheTag('pricing')`; the jobs update the database but nothing tells the deployed site to refresh. Add a revalidation call once deployed. | Deployment |
| L9 | **Rotate the Supabase database password** | It was shared in a chat session. | Owner, Supabase dashboard |
| L10 | **Deploy the gateway** on infrastructure with a static egress IP (PRD ADR-004) | Allowlisting is not enforced today (V2), but the gateway is where credentials and rate limits live. Locally it reads from production (`DNA_ENV=production`) for real availability; writes follow `DNA_WRITE_ENV`, which refuses production outside a production deployment. | Hosting decision |
| L11 | **Flutterwave live keys and webhook secret hash** | Test keys only during the build. Set the secret hash in the dashboard and in `FLUTTERWAVE_WEBHOOK_HASH`. | Owner, after checkout is proven on test keys |
| L12 | **Flutterwave: merchant bears the transaction fee** | By default Flutterwave adds its fee on top at payment, so the customer would pay more than the total we show — against FR-C5 and our no-hidden-fees promise. Switch fees to the merchant in the dashboard, or show the fee. | Owner, Flutterwave dashboard |
| L13 | **Register the webhook URL** (`/api/webhooks/flutterwave`) in the Flutterwave dashboard | Payments are confirmed when the customer returns; the webhook covers a closed tab. It needs a public URL (the deployment, or a tunnel for local testing). | Deployment |
| L14 | **First sandbox registrations** | The registration job is built (migration 13, `apps/gateway/src/provisioning`) and tested against the real SDK over a fake network, but no registration has yet been sent to the sandbox: the automated permission check stopped the first attempt. Set `DNA_WRITE_ENV=ote`, buy a domain with Flutterwave test keys, and confirm the register and nameserver responses match what `registrar.ts` expects (their shapes are read from the SDK source, not observed). | Owner |
| L15 | **Automatic refunds for failed lines** (FR-R3, I6) | The panel tells a live customer "We'll refund what you paid" for a failed line; today that refund is manual. Needs the wallet (FR-W1) or a Flutterwave refund call. Must exist before `DNA_WRITE_ENV=production`. | Wallet or refund API |
| L16 | **Alerts for stuck jobs** (I5, §13.5 orphan sweep) | A job in `needs_attention`, or an order in `provisioning` for over 15 minutes, is only logged at error level. Someone has to be told. `retry_job()` puts a job back once the registry has been checked. | Alerting channel |
| L17 | **Live registrations** | `DNA_WRITE_ENV=production` on the deployed gateway, after L6, L10, L14, L15 and L16. | Those |

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
- **Registrar renewal mode** (FR-R6) — the SDK has no `ModifyRenewalMode`, so the supplier's own auto-renew is left at its default. Check what that default is before live registrations: our renewal engine must be the only thing that renews.
- **Portfolio reconcile and deep sync** (§13.5) — nothing yet compares our `domains` rows with the registry after registration.
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
- **Gateway unit coverage** is below its 85% threshold: the pricing-script helpers (`fx-provider`, `http`, `db`, `env-file`) have no tests. A task is queued.
- **Coverage `PARSE_ERROR`** from the V8 provider on an uncovered file in `apps/web`.
- **Live dependencies in e2e**: transfer checks hit real registry RDAP servers, and pricing and account tests use the hosted Supabase project. Consider a local Supabase (needs Docker) for isolation.
