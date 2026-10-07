# MyDomainsHub Mail — product specification (v1: the sending API)

**Status:** approved by the owner, 6 Oct 2026 · building
**Where:** `emails.mydomainshub.com` · `apps/mail` in this monorepo · the shop's Supabase project, schema `mail`
**Engine:** the owner's Amazon SES account (eu-west-2), one SES **tenant** per customer account

This is a separate product from the domain shop. It shares the brand, the monorepo, some shared
code (`@dr/shared`) and — by the owner's choice (M5) — the shop's Supabase project, where it keeps
its own schema; its deploys, pages and customers' data stay apart. The
rules in `CLAUDE.md` (N5, N7, N9b, N13, S1–S13, testing, commits) apply to it as written; this
document adds the rules that are particular to sending other people's email.

---

## 0. Decisions already made (owner, 6 Oct 2026)

| # | Decision | Consequence |
|---|---|---|
| M1 | **v1 is a sending API for developers.** The newsletter tool (lists, editor, campaigns) is phase 2. | Transactional email only in v1: receipts, sign-in links, alerts. Bulk marketing is refused by the Acceptable Use Policy until phase 2 brings unsubscribe handling. |
| M2 | **Customers send through the current AWS account.** | Reputation is isolated per customer with SES tenants (§4), and MyDomainsHub's own email keeps the account's remaining send rate (§4.4). Trust & safety (§7) is a launch blocker, not an afterthought. |
| M3 | **Monthly plans**, paid in naira. | Flutterwave recurring card charges (§8). Each plan has hard monthly and daily caps; there is no overage billing in v1. |
| M4 | **A new app in this repo.** | `apps/mail` on its own Vercel project and a mail worker on Fly (§3). |
| M5 | **The shop's Supabase project, not a new one** (6 Oct 2026: the free plan allows two active projects and both are used). | Every Mail table lives in the `mail` schema, exposed to the API beside `public`, with RLS. Supabase Auth is shared: one `auth.users`, so a person can hold a shop account and a Mail account with one sign-in, and Mail access is by membership of a `mail.accounts` row, never by being a shop customer. Mail migrations join the shop's numbered series and its rules (schema-first, SQL checks, regenerated types with `--schema public,mail`). The admins table and gate (ADR-006) are shared, so hello@mydomainshub.com runs both admin areas. Moving Mail to its own project later is a dump of the `mail` schema plus its users. |

## 1. What we are building

A developer verifies their domain, creates an API key, and sends email with one HTTP call:

```bash
curl -X POST https://emails.mydomainshub.com/api/v1/emails \
  -H "Authorization: Bearer mdh_live_…" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-1042-receipt" \
  -d '{"from":"Acme <receipts@acme.ng>","to":["ada@example.com"],"subject":"Your receipt","html":"<p>Thanks!</p>"}'
```

Then they watch it in a dashboard: sent, delivered, bounced, complained, with webhooks to their
own systems, all priced in naira.

**Why it can win in Nigeria:** naira billing (no dollar card), local support, a sender that is not
a shared free tier everyone abuses, and the same honest-pricing promise as the domain shop.

**The API shape** follows the conventions developers already know from the popular email APIs
(`POST /emails` with `from`, `to`, `subject`, `html`, `text`, `reply_to`, `cc`, `bcc`,
`attachments`, `headers`, `tags`; `Idempotency-Key`; JSON errors with a `name` and `message`).
Copy and docs say only what we have tested (N9b): any claim of drop-in compatibility with
another company's SDK needs a test that runs that SDK against our API, and the owner's
sign-off on naming another brand.

### Out of scope for v1

Newsletter tool, contact lists and audiences, templates editor, SMTP relay, inbound email, dedicated
IPs, open and click tracking, a second AWS region, and sub-accounts or resellers.

---

## 2. Rules particular to this product

| # | Rule |
|---|---|
| **MR1** | **Every send names its tenant.** `SendEmail` always carries `TenantName` and the account's own configuration set. A send without both is a bug: it would land on the account-wide reputation that MyDomainsHub's own receipts depend on. |
| **MR2** | **No email leaves without passing the gate in SQL**: account active, domain verified and owned by that account, recipient not suppressed, plan quota reserved (`reserve_send`). The API route and the worker both ask; the worker re-checks at send time. |
| **MR3** | **A message body is kept 72 hours, then deleted** (owner, 6 Oct 2026). Bodies live in `email_payloads`; the dashboard's "View email" shows them to the account's members for 72 hours after sending, and `purge_payloads` deletes them on the hour after that. Nothing else ever copies a body (logs, events, webhooks, admin). |
| **MR4** | **Recipient addresses are personal data (NDPA).** They are stored for the plan's retention window, never logged (N13), shown in full only to the account's own members, and masked in our admin unless revealed with an audited reason. |
| **MR5** | **A pause by SES is final until a person looks.** We never call the unpause API from code; only an admin, with a reason, after reading the finding. |
| **MR6** | **Customer webhooks are signed and replay-safe** (Standard Webhooks: `webhook-id`, `webhook-timestamp`, `webhook-signature`, HMAC-SHA256, as our Supabase hook already verifies). |
| **MR7** | **API keys are shown once and stored as a hash** (`sha256(pepper ‖ secret)`), with a visible prefix (`mdh_live_ab12…`) to tell them apart. |
| **MR8** | **Sending rate is a shared budget.** The SES account has one send-rate limit for MyDomainsHub and every tenant together (§4.4). The worker paces against its share; it never bursts past it. |

---

## 3. Architecture

```
 customer app ──HTTPS──▶ emails.mydomainshub.com (Vercel, apps/mail)
                          ├─ /api/v1/*        public API: auth by key, validate, reserve quota, queue
                          ├─ /api/ses/events  SNS: SES events + tenant status (signature checked)
                          ├─ /api/billing/*   Flutterwave (via Paidly, tx_ref prefix MDM-)
                          └─ dashboard, docs, pricing, legal, /admin
                                   │
                         Supabase (the shop's project): schema mail (RLS, pg_cron)
                                   │  claim_sends / claim_webhook_deliveries (SKIP LOCKED)
                                   ▼
                          mail worker (Fly, apps/mail-worker, one machine)
                          ├─ sends: SES SendEmail (SigV4, TenantName, config set), paced
                          └─ webhooks: signed POSTs to customers, retries with backoff
                                   │
                          Amazon SES eu-west-2 ──events──▶ SNS ──▶ /api/ses/events
                          EventBridge (tenant status, findings) ──▶ SNS ──▶ /api/ses/events
```

- **apps/mail** (Next.js 16, same stack and rules as `apps/web`): marketing pages, docs, the
  dashboard, the API route handlers and `/admin`. The rule "`/api` is for webhooks only" does not
  apply here: the public API *is* this product. It is versioned (`/api/v1`) and every handler is
  thin (validate → SQL function → answer).
- **apps/mail-worker** (Node, like the gateway, bundled with esbuild): the only process that calls
  `SendEmail`, and the one that delivers customer webhooks. It holds the sending IAM key. The API
  routes on Vercel hold a separate key that can manage identities and tenants but **cannot send**,
  so a leaked web key cannot be used to spam.
- **The shop's Supabase project, schema `mail`** (M5): every table has RLS (N7); money tables are
  append-only, as in the shop. Auth is shared, so sign-in redirect URLs must allow
  `https://emails.mydomainshub.com/**`, and the shop's Send Email hook words a Mail sign-up's email
  as Mail's (it knows from the redirect host). A Mail account is a `mail.accounts` membership; the
  shop's `profiles` row every user gets is harmless and unused by Mail.
- **Shared code** in `@dr/shared`: the SES SigV4 signer (already there, proven against AWS's test
  vectors), SNS signature verification, Standard Webhooks signing, a `mail/` module for the API
  schemas (Zod), status precedence and plan maths. No AWS SDK, as in the shop.

### 3.1 Why a queue and a worker, not a send inside the API call

The SES account's send rate is shared and small (§4.4), attachments make calls slow, and a
customer's burst must not fail half-way. The API answers `202`-style with the email's id as soon as
the row is queued (sub-100 ms); the worker sends within seconds. The queue also gives scheduled
sends (`scheduled_at`) and cancel-before-send for free.

---

## 4. SES set-up

### 4.1 Tenants — one per customer account

Amazon SES tenant management (launched August 2025) isolates reputation per tenant, pauses a
tenant automatically on a reputation finding without touching other tenants, and lets AWS Trust &
Safety pause one tenant instead of the whole account.

On account creation (`create_account` → worker job `provision_tenant`):

1. `CreateTenant` — name `mdm-<account short id>`.
2. `CreateConfigurationSet` — `mdm-<account short id>`, with an **event destination** to the SNS topic
   `mail-ses-events` for SEND, DELIVERY, BOUNCE, COMPLAINT, REJECT, DELIVERY_DELAY,
   RENDERING_FAILURE. No open or click tracking in v1.
3. `CreateTenantResourceAssociation` for the configuration set.
4. Reputation policy: **Strict** for an account's first 30 days, then **Standard**
   (`UpdateReputationEntityPolicy`). New senders are the riskiest.
5. Tenant-level suppression list (`SuppressionScope = TENANT`, bounces and complaints), so one
   customer's bad addresses do not suppress another's, and theirs do not suppress ours.

Each customer domain's identity is associated with its account's tenant (§5). A send whose
identity or configuration set is not associated with the named tenant is refused by SES itself,
which is a second guard behind MR2.

**Cost:** $0.10 per 1,000 emails + $0.005 per 1,000 emails for tenants + $0.005 per tenant per
month (SES pricing page, read 6 Oct 2026). 100,000 emails ≈ $10.50.

### 4.2 Events

- Each tenant's configuration set publishes to SNS `mail-ses-events`; an HTTPS subscription
  delivers to `/api/ses/events`, which verifies the SNS signature exactly as the shop's
  `/api/email/ses-events` does (certificate host, topic ARN), then calls `record_send_event`.
- An EventBridge rule on `source = aws.ses` for `Sending Status Enabled|Disabled` and
  `Advisor Recommendation Status Open|Resolved` targets the same topic. These set the account's
  `ses_status` and open or close a finding, raise an admin alert, and email the account owner.

### 4.3 IAM — two users, least privilege

| User | Used by | May |
|---|---|---|
| `mdm-sender` | mail worker | `ses:SendEmail`, `ses:SendRawEmail` on customer identities and `mdm-*` configuration sets and tenants. Nothing else. |
| `mdm-manager` | apps/mail (Vercel) | Create, read and delete email identities; set MAIL FROM and default configuration sets; create tenants, configuration sets, event destinations and resource associations; set reputation policies and manage tenant suppression. **Not** `SendEmail`. |

Neither can touch `notify.mydomainshub.com` or the shop's `mydomainshub` configuration set
(resource ARNs and conditions in the policies).

### 4.4 The send-rate budget (MR8)

The account allows **14 emails a second** and 50,000 a day today, for everything. The shop's
gateway is paced at `SES_MAX_SEND_RATE=10`. Before launch:

- **Owner, 6 Oct 2026: launch on the quota AWS has given** (14 a second, 50,000 a day). Ask for more
  only when Mail's volume needs it. Until then **Scale is not offered** (`plans.is_offered = false`:
  its 60,000-a-day cap is above the whole account's), and the worker keeps an **account-wide daily
  budget**: Mail may use what the shop leaves of the 24-hour quota, and no single customer account
  may take more than half of what is left on a given day.
- Until it is raised, split the budget: shop **4/s**, mail **10/s**. The shop sends a few hundred a
  day, so 4/s is plenty.
- The worker paces with a token bucket at `MAIL_MAX_SEND_RATE`, and treats `Throttling` /
  `MaxSendRateExceeded` as "try again shortly" (never a failure). The daily total is watched; at 80%
  of the account's 24-hour quota, sending for free and sandbox plans pauses before paid ones.

---

## 5. Domains

A customer adds `acme.ng`:

1. `CreateEmailIdentity` with Easy DKIM (RSA 2048) → three DKIM CNAMEs.
2. `PutEmailIdentityMailFromAttributes` with `send.acme.ng` (behaviour on MX failure: use the default
   SES domain) → an MX and an SPF TXT on `send.acme.ng`.
3. `PutEmailIdentityConfigurationSetAttributes` → the account's configuration set as the default.
4. `CreateTenantResourceAssociation` → the identity joins the account's tenant.

The page lists the records to add — the three CNAMEs, the MX and TXT on `send.`, and a suggested
DMARC (`v=DMARC1; p=none; rua=…`) — each with a copy button, and checks them live from public DNS
(as the shop's DNS views do). "Check now" reads `GetEmailIdentity`; a scheduled job re-reads pending
identities every 10 minutes for 72 hours, then marks them failed with the record that is missing.

**Who owns a domain.** SES keeps one identity per name per account. A name already verified on
another customer's account is refused ("this domain is in use on another account; email us").
An **unverified** claim older than 72 hours is released, so nobody can squat a domain they cannot
prove. `mydomainshub.com` and its subdomains are reserved.

**Sending addresses.** Any address at a verified domain. A sending key may be limited to one
domain (MR7 table `api_keys.domain_id`).

---

## 6. The API (v1)

Base `https://emails.mydomainshub.com/api/v1`. Auth: `Authorization: Bearer <key>`. JSON in and out.
Errors: `{ "name": "validation_error" | "unauthorized" | "forbidden" | "not_found" |
"rate_limited" | "quota_exceeded" | "domain_not_verified" | "account_paused" | "internal_error",
"message": "…" }` with the matching status. Every response carries `x-request-id`.

| Method | Path | Does |
|---|---|---|
| POST | `/emails` | Queue one email. `Idempotency-Key` (24 h). Returns `{ id }`. |
| POST | `/emails/batch` | Up to 100 emails in one call, each validated; all or none queued. |
| GET | `/emails/{id}` | Status, timestamps, the last event. No body (MR3). |
| PATCH | `/emails/{id}` | Reschedule a scheduled email. |
| POST | `/emails/{id}/cancel` | Cancel a scheduled or still-queued email. |
| GET/POST/DELETE | `/domains`, `/domains/{id}`, `/domains/{id}/verify` | Add, list, check, remove. |
| GET/POST/DELETE | `/api-keys` | Full-access keys only. |
| GET/POST/PATCH/DELETE | `/webhooks` | Endpoints and the events each wants. |

**Limits per email:** up to 50 recipients across to/cc/bcc, 40 MB total (SES v2's message limit),
attachments base64 or by URL fetched once at queue time (size-checked, no private IPs),
custom headers allow-listed (no overriding `From`, `Return-Path`, DKIM or `X-SES-*`).

**Rate limits:** per key, 10 requests a second (burst 20), plus the plan's daily and monthly caps,
reserved atomically in SQL. Answers `429` with `retry-after`.

**Statuses:** `queued → sending → sent → delivered`, or `bounced` / `complained` / `failed` /
`suppressed` / `canceled`, and `delivery_delayed` as an event. Precedence when events arrive out of
order follows the shop's rule (bounced beats delivered beats deferred; a late bounce wins; a
complaint is recorded but is not a bounce).

**Webhook events to customers:** `email.sent`, `email.delivered`, `email.delivery_delayed`,
`email.bounced`, `email.complained`, `email.failed`, `domain.verified`, `domain.failed`. Retries
with backoff for 24 hours; an endpoint failing for 3 days is disabled and its owner emailed.

**Docs** live at `/docs`: quickstart (curl, Node, Python, PHP — plain HTTP, no SDK needed in v1),
the reference generated from the Zod schemas (OpenAPI 3.1, also published at `/api/v1/openapi.json`),
webhooks and signature checking, DNS set-up per host (Cloudflare, Truehost, Hostinger…),
deliverability basics, and limits.

---

## 7. Trust and safety (launch blocker, because of M2)

1. **Sign-up:** email and password or Google, Turnstile, email confirmation; business name,
   website, what they will send, and expected monthly volume.
2. **Sandbox first.** A new account can send only to its own members' confirmed addresses, 100 a
   day, until (a) a domain is verified, (b) the profile is complete, and (c) an admin approves it
   (review queue in `/admin`). Paid plans are reviewed within one business day; that promise
   appears on the pricing page only once someone is staffing it (N9b).
3. **Warm-up:** an approved account's daily cap starts at 1,000 (or its plan's, if lower) and doubles
   each day with a bounce rate under 2% and complaints under 0.05%, up to the plan's cap.
4. **Our own thresholds, below AWS's:** per account, over a rolling 7 days with at least 500 sends,
   a warning at bounce ≥ 2% or complaint ≥ 0.05%, and an automatic pause at bounce ≥ 4% or
   complaint ≥ 0.08% (`UpdateReputationEntityCustomerManagedStatus DISABLED`). SES's own policy
   (Strict, then Standard) runs on top. Unpausing is a person's decision (MR5).
5. **Suppression:** hard bounces and complaints go on the tenant's suppression list at once, and a
   send to a suppressed address is refused with `suppressed` before it costs anything.
6. **Content checks at queue time** (cheap and certain only): refuse a `From` display name or domain
   that imitates a bank or a government body we list, links to URL shorteners, and attachments that
   are executables. Anything subtler is for review, not code.
7. **Acceptable Use Policy:** transactional email only in v1; no purchased, rented or scraped lists;
   no phishing, malware or impersonation; the account is responsible for consent. Breach → pause,
   then close. `abuse@` route and an abuse report form.
8. **Account-wide watch:** an admin alert if the whole SES account's bounce rate passes 2% or
   complaints pass 0.05% (CloudWatch `Reputation.BounceRate` / `ComplaintRate`, read by the worker
   every 15 minutes), before AWS's own review levels (5% and 0.1%).

---

## 8. Plans and billing (M3)

| Plan | A month, before VAT | Emails a month | A day | Domains | Members | Log kept |
|---|---|---|---|---|---|---|
| Free | ₦0 | 3,000 | 100 | 1 | 1 | 7 days |
| Starter | ₦20,000 | 50,000 | 5,000 | 5 | 3 | 30 days |
| Pro | ₦55,000 | 150,000 | 20,000 | 20 | 10 | 30 days |
| Scale | ₦160,000 | 500,000 | 60,000 | 50 | 25 | 60 days |

Prices decided by the owner on 6 Oct 2026; they are seed rows in `plans`, not constants in code.

**Prices are the owner's** (open question Q2), stored in a `plans` table, never in code (N5b). Our
cost is about $0.105 per 1,000 emails plus $0.005 per tenant per month — about ₦140 per 1,000 at
₦1,329 to the dollar — so a plan must be priced for a customer who uses all of it: Starter's 50,000
cost ₦6,985, Pro's 150,000 ₦20,935, Scale's 500,000 ₦69,780. Fixed costs (Supabase Pro about $25,
the Fly worker about $5 a month) and Flutterwave's fee come on top. Because SES bills in dollars,
the admin shows each plan's margin at today's rate and alerts when one falls under 40%.

- Recurring charges through **Flutterwave payment plans** (card), monthly, VAT 7.5% added at
  checkout and shown on a tax invoice with CAC and TIN, as the shop's receipts do.
- The Flutterwave account is shared and its webhook goes through **Paidly**: Paidly must forward
  `tx_ref`s starting `MDM-` to `/api/billing/flutterwave` (owner task in the `solostack` repo).
  Every payment is re-read from Flutterwave before it counts, as in the shop (SEC-7).
- **One payment can start two Flutterwave subscriptions** (a live test-mode run, 7 Oct 2026: charge
  10534506 started 53194 and, three minutes later, 53195; both renewed on its `tx_ref`). After a first
  charge is recorded, after a second renewal in one month, and every hour (pg_cron →
  `/api/jobs/billing`), the subscriptions of the account's first charge are listed: the earliest-made
  is kept and the others cancelled, asked again each hour until Flutterwave confirms (a
  `duplicate_subscription` incident). A cancellation or downgrade stops every one of them. A second
  successful renewal within `billing_settings.duplicate_renewal_window_hours` (72) of the one that
  began the period is recorded once and never applied, as a `duplicate_charge` incident: Mail has no
  refund flow, so a person refunds it in Flutterwave (migration 56).
- A failed renewal gives 7 days `past_due` (sending continues, a banner and emails), then the account
  drops to the Free plan's caps. Upgrades take effect at once (prorated); downgrades and
  cancellations at the period's end. No refunds of part-months unless the service failed us.
- No overage in v1: at 80% of a cap, a dashboard notice; at 100%, `quota_exceeded` (and the notice says
  the cap is reached). The notice emails are not built yet (§15).

---

## 9. Data model (schema `mail` in the shop's project)

All tables have RLS (N7); customers read their own account's rows through membership.
Writes go through SQL functions, as in the shop.

| Table | Holds |
|---|---|
| `accounts` | name, plan, `state` (sandbox / active / paused / closed), `ses_tenant`, `config_set`, `ses_status`, caps, warm-up day, reviewed_by/at |
| `members` | account ↔ user, role (owner / admin / developer / viewer) |
| `invites` | pending invites, hashed token, 7-day expiry |
| `domains` | name, SES identity ARN, status, DKIM tokens, MAIL FROM, last checked |
| `api_keys` | name, prefix, hash, permission (full / sending), optional domain, last used, revoked |
| `emails` | public id, account, key, domain, from, recipients, subject, tags, status, SES message id, scheduled/sent/last-event times, idempotency key (unique per account) |
| `email_payloads` | body, attachments' storage paths — deleted once sent (MR3) |
| `email_events` | type, time, sanitised detail (bounce type, diagnostic code without addresses) |
| `suppressions` | mirror of the tenant's list: address, reason, source, time |
| `webhooks`, `webhook_deliveries` | endpoints (secret encrypted at rest), each attempt and its answer |
| `usage_daily` | per account per day: queued, sent, delivered, bounced, complained |
| `plans`, `subscriptions`, `payments`, `invoices` | billing; money tables append-only |
| `findings` | SES reputation findings and our own threshold findings per account |
| — | the admin area uses the shop's `public.admins`, gate and `admin_audit_log` (M5); Mail's admin actions are `admin_mail_*` wrappers with `mail.*` action names |
| `account_audit_log` | security events a customer can see: key created or revoked, member added, domain removed |

Retention by plan (§8) is enforced by a daily `purge_old_emails()`.

---

## 10. Pages

**Public** (prerendered, `pageMetadata()` as in the shop): home, pricing (N8 has no renewal price
here; instead every plan shows its caps and what happens at the cap), docs, status, legal (Terms,
Acceptable Use, Privacy, Data Processing Agreement, Sub-processors: AWS SES eu-west-2, Supabase,
Vercel, Fly, Flutterwave, Cloudflare), contact and abuse.

**Dashboard** (`/dashboard`, signed in, with an account switcher):

| Page | Shows |
|---|---|
| Overview | this month's usage against the plan, today's sends, delivery / bounce / complaint rates over 7 and 30 days with the warning and pause levels drawn on the chart, account state and anything that needs action |
| Emails | the log: search by id, recipient (exact), subject, tag, status, date; each row's events |
| Email | timeline of events, recipients, headers we set, the bounce reason in plain words |
| Domains | each domain's state; the DNS records with copy buttons and a live check |
| API keys | create (shown once), name, permission, domain, last used, revoke |
| Webhooks | endpoints, events, signing secret (reveal once), recent deliveries with their answer, resend one |
| Suppressions | addresses on the list, why and when; remove one (with a warning) |
| Billing | plan, period, invoices (tax invoices), change plan, card on file (last four only) |
| Settings | account profile, members and roles, your own security (password, two-factor), account log |

Every async surface has its four states (S11); mobile-first (S1); both themes (S3).

**Admin** (`/admin`, ADR-006 model, its own `admins` table; hello@mydomainshub.com as owner):
review queue (sandbox → active), accounts (usage, findings, tenant status, pause / resume with a
reason, plan override), domains, abuse reports, the account-wide SES health (quota used, send rate,
bounce and complaint), the audit log.

---

## 11. Operations

- **Alerts** (Telegram, as the shop's): a tenant paused by SES, our threshold pause, account-wide
  reputation near AWS's levels, the daily quota at 80%, the worker or the event endpoint silent for
  15 minutes, a webhook backlog over an hour, an open live billing incident, and the hourly
  duplicate-subscription check silent for three hours.
- **Heartbeats** for the worker's send loop, webhook loop, quota reader and pending-domain checker.
- **Logs:** ids and counts only; never an address, a subject or a key (N13, MR4).
- **Deploys:** apps/mail on Vercel (Root Directory `apps/mail`), the worker with
  `fly deploy --ha=false` (one machine: one pacing budget, MR8).

---

## 12. Testing

As `CLAUDE.md` §10, plus:

- **Unit:** plan caps and warm-up maths, status precedence, idempotency, header allow-list, key
  hashing, webhook signatures (against the Standard Webhooks vectors), SigV4 with `TenantName`.
- **Contract:** SES SendEmail / CreateEmailIdentity / tenant calls against recorded answers; SNS and
  EventBridge payloads from AWS's documented examples.
- **SQL checks** (`supabase/tests/mail_*.sql`): RLS per role, `reserve_send` under concurrency,
  money tables append-only, purges.
- **E2E:** sign up → sandbox send to self → verify a domain (mock DNS) → key → send → events → webhook
  received → cap reached; billing with a mock Flutterwave. A mock SES in the e2e worker — no e2e test
  ever calls real SES (N12's rule, for email).

---

## 13. Build order

| Phase | Delivers | Needs first |
|---|---|---|
| **P0 Set-up** | the `mail` schema exposed to the API, Vercel project and `emails.mydomainshub.com`, Fly app, IAM users, SNS topic, EventBridge rule, quota request | Owner tasks below |
| **P1 Core** | schema and RLS, sign-up and accounts, tenants, domains, API keys, `POST /emails` → worker → SES, events in, the emails log | P0 |
| **P2 Developers** | batch, scheduling and cancel, webhooks, suppressions, docs and OpenAPI | P1 |
| **P3 Money and safety** | plans and Flutterwave billing, caps and warm-up, sandbox review, thresholds and pauses, admin | P1 |
| **P4 Launch** | public pages, legal, status, load test at the send-rate budget, security review | P2, P3, lawyer |

## 14. Owner tasks

1. **AWS:** ~~IAM users, SNS topic, EventBridge rule~~ done 6 Oct 2026 (`infra/aws/`). A higher SES
   quota is deferred until Mail's volume needs it (§4.4).
2. **Supabase:** none now (M5). Before Mail's paid launch, consider the Pro plan for backups and
   no auto-pause — the shop needs them too.
3. **Vercel:** I can create the second project with the token; a Cloudflare CNAME for `emails`.
4. **Flutterwave and Paidly:** payment plans for each paid tier; Paidly forwards `MDM-` references.
5. **Legal:** Terms, Acceptable Use Policy, DPA and privacy notice for a processor of recipients'
   data (NDPA), reviewed by your lawyer before paid launch.

## 15. Open questions

| # | Question | Default if not answered |
|---|---|---|
| Q1 | ~~Product name~~ | **Decided:** MyDomainsHub Mail |
| Q2 | ~~Plan prices~~ | **Decided:** Starter ₦20,000, Pro ₦55,000, Scale ₦160,000 a month before VAT (§8) |
| Q3 | Free plan at 3,000 a month, 100 a day? | Yes |
| Q4 | ~~Body retention~~ | **Decided:** 72 hours (MR3) |
| Q5 | Say "works with the X SDK" in the docs (§1)? | No, until tested and approved |
| Q6 | ~~Send-rate split~~ | **Decided:** shop 4/s, Mail 10/s until AWS raises the quota |

### Not yet built: the Mail notifications package

The emails this spec promises to customers are not sent yet; the dashboard shows each state
instead. Copy must not promise them (N9b) until this package ships:

- **Invites:** the invitation email (an invite is a link the inviter copies and shares today).
- **Cap notices:** the emails at 80% and 100% of a cap (§8; the dashboard notice is built).
- **Past due:** the emails while a renewal is past due (§8; the banner is built).
- **Webhook disabled:** the owner's email when an endpoint is turned off for failing (§6; the
  Webhooks page and the account log show it).
- **Findings:** the owner's email when SES or our threshold opens a finding or pauses the account
  (§4.2, §7.4; the dashboard banner and Mail's admin show it).
