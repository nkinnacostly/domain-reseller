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
| L5 | **DomainNameAPI OTE (sandbox) credentials** | Our keys are production-only. Registration, renewal and transfer are real-money writes and must be built and tested against the sandbox (N12). | DomainNameAPI support |
| L6 | **Top up the DomainNameAPI balance** | It is USD 0 — every registration would fail with `API_350`. Plan the float per PRD FR-FLOAT-4. | Owner |
| L7 | **GitHub Actions secrets for `.github/workflows/pricing.yml`** | Without them the daily FX update and weekly catalogue sync never run, and prices freeze. Needs `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `DNA_RESELLER_ID`, `DNA_API_KEY` (optionally `FX_PARALLEL_API_KEY`). | Owner, repo settings |
| L8 | **Revalidate prices after the jobs run** | Pricing is cached with `cacheTag('pricing')`; the jobs update the database but nothing tells the deployed site to refresh. Add a revalidation call once deployed. | Deployment |
| L9 | **Rotate the Supabase database password** | It was shared in a chat session. | Owner, Supabase dashboard |
| L10 | **Deploy the gateway** on infrastructure with a static egress IP (PRD ADR-004) | Allowlisting is not enforced today (V2), but the gateway is where credentials and rate limits live. Locally it runs with `DNA_ENV=production` for read-only availability — that must never carry write routes. | Hosting decision |
| L11 | **Flutterwave live keys and webhook secret hash** | Test keys only during the build. Set the secret hash in the dashboard and in `FLUTTERWAVE_WEBHOOK_HASH`. | Owner, after checkout is proven on test keys |

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
