# Deploying

First target: a private production run, so the owner can buy **mydomainshub.com**
through the platform. `CHECKOUT_ALLOWLIST` keeps checkout closed to everyone
else until the launch blockers in `docs/BACKLOG.md` are done.

Two deployables:

| What | Where | Why |
|---|---|---|
| `apps/gateway` | Fly.io, one machine, London (`lhr`) | Holds the supplier keys, runs the registration worker and the hourly reconcile. Needs a static egress IP once the supplier enforces its allowlist (L10). |
| `apps/web` | Vercel | The storefront and panel. Talks to the gateway with a shared secret. |

Steps marked **you** need your accounts or your keys. Paste secrets into the
provider's own CLI or dashboard — never into a chat, a commit or an issue.

---

## 1. Gateway on Fly.io

0. **You:** add a payment card to the Fly account (https://fly.io/trial). A trial
   account stops every machine after 5 minutes; the proxy restarts it only when
   a request arrives, so queued registrations wait for the next visitor.
1. **You:** install the CLI and sign in (creates the account if needed):
   ```bash
   brew install flyctl
   fly auth login
   ```
2. **You:** create the app (name from `fly.toml`; change both if it is taken):
   ```bash
   fly apps create mydomainshub-gateway
   ```
3. **You:** generate a new shared secret for production (not the local one) and
   keep it for step 2.3:
   ```bash
   openssl rand -hex 32
   ```
4. **You:** set the secrets, from the repository root, values from your `.env`
   except the new shared secret:
   ```bash
   fly secrets set GATEWAY_SHARED_SECRET=… DNA_RESELLER_ID=… DNA_API_KEY=… DNA_API_TEST_KEY=… NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SECRET_KEY=… --stage
   ```
   Writes stay **off** (the default) until step 4.
5. **You:** deploy — one machine, never two:
   ```bash
   fly deploy --ha=false
   ```
6. Check: `https://mydomainshub-gateway.fly.dev/health` answers `healthy`.

## 2. Web on Vercel

1. **You:** in the Vercel dashboard, import the GitHub repository
   `nkinnacostly/domain-reseller`. Set **Root Directory** to `apps/web`
   (framework: Next.js; pnpm is detected).
2. **You:** before the first deploy, add these **Production** environment
   variables:

   | Variable | Value |
   |---|---|
   | `NEXT_PUBLIC_APP_URL` | `https://<project>.vercel.app` (the address Vercel shows) |
   | `NEXT_PUBLIC_SUPABASE_URL` | from `.env` |
   | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | from `.env` |
   | `SUPABASE_SECRET_KEY` | from `.env` |
   | `GATEWAY_URL` | `https://mydomainshub-gateway.fly.dev` |
   | `GATEWAY_SHARED_SECRET` | the new secret from step 1.3 |
   | `NEXT_PUBLIC_FLUTTERWAVE_PUBLIC_KEY`, `FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_ENCRYPTION_KEY`, `FLUTTERWAVE_WEBHOOK_HASH` | **test** keys first (step 3) |
   | `CHECKOUT_ALLOWLIST` | your account's email |

3. **You:** deploy, and send the `*.vercel.app` address to Claude.
4. **Claude:** add that address to Supabase Auth (site URL and redirect URLs,
   L3) so sign-in links work there.

## 3. Rehearse on the sandbox

1. **You:** `fly secrets set DNA_WRITE_ENV=ote`
2. **You:** on the Vercel site, sign in and buy any test name with the
   Flutterwave test card. The order should go Queued → Registered within a
   minute, in the supplier sandbox. This proves the whole deployed chain.

## 4. Buy mydomainshub.com for real

1. **You:** top up the DomainNameAPI balance — USD 15 covers a .com (L6).
2. **You:** in Flutterwave (the account must be approved for live payments):
   - copy the **live** keys into Vercel's four Flutterwave variables;
   - leave the webhook URL alone: the account is shared, and Paidly's webhook
     (repo `solostack`) forwards every notice whose `tx_ref` starts with `MDH-`
     to `https://mydomainshub.vercel.app/api/webhooks/flutterwave`. Our
     `FLUTTERWAVE_WEBHOOK_HASH` must equal the account's secret hash (Paidly's
     `FLW_WEBHOOK_SECRET`) — checked equal on 23 Sept 2026 (L11, L13);
   - redeploy on Vercel.
3. **You:** switch the gateway to live registrations:
   ```bash
   fly secrets set DNA_WRITE_ENV=production
   ```
4. **You:** buy `mydomainshub.com` on the site. Watch the order page; Claude
   can check the registration, the supplier call log and the next reconcile.

## 5. After the purchase

- Point the domain at a DNS host for email: add it to Cloudflare (free), copy
  the two nameservers Cloudflare gives you into the domain's **Nameservers**
  tab (it asks for your 2FA code), then add your email provider's records
  (SPF, DKIM, DMARC) in Cloudflare. That unblocks L1.
- `CHECKOUT_ALLOWLIST` stays set until launch; live writes can stay on, since
  only listed accounts can pay.

## 5b. Order of deploys

The gateway always ships **before** a web change that can queue a new kind of
job (transfers, lock/privacy/contact changes) or call a new gateway route
(`/v1/domains/:name/auth-code`, `/v1/transfers/check`). An older gateway holds
a job kind it does not know for a person, and answers 404 to a route it lacks.

```bash
fly deploy --ha=false -a mydomainshub-gateway   # first
git push                                         # then the web deploys on Vercel
```

The gateway's first start after 24 Sept 2026 syncs the supplier catalogue at
once (no earlier run is recorded) and writes `is_transferable` — until then
transfers in are closed. `APP_URL` (in `fly.toml`) lets it refresh the site's
prices afterwards. The pricing workflow no longer needs the `DNA_*` GitHub
secrets: `gh secret delete DNA_API_KEY` and `gh secret delete DNA_RESELLER_ID`.

## 5c. Email (L1)

Supabase Auth sends every email through our route `/api/auth/send-email`,
which uses Brevo's API: from `no-reply@notify.mydomainshub.com`, replies to
`hello@mydomainshub.com` (a Spaceship mailbox).

- **Vercel** needs `BREVO_API_KEY` and `SEND_EMAIL_HOOK_SECRET` (the value in
  `.env`, starting `v1,whsec_`) in Production. Deploy them **before** pushing
  the Supabase config that enables the hook, or auth email stops.
- **Supabase:** `set -a; . ./.env; set +a; supabase config push` — read the
  diff first (CLAUDE.md §15).
- **If sign-up emails stop:** set `enabled = false` under
  `[auth.hook.send_email]` and push the config again. Supabase falls back to
  Brevo's SMTP (without the Reply-To) while you look.
- Brevo's free plan sends 300 a day. Its delivery log is under Transactional →
  Logs.

## 5c-2. Notification emails (migration 31)

Receipts, domain news, refunds, security notices, ERRP renewal reminders and
the undelegated nudge are queued in the database (`email_outbox`) by the
thing that causes them, and sent by the gateway through Brevo.

- **Fly** needs `BREVO_API_KEY` (the same key as Vercel's):
  ```bash
  grep '^BREVO_API_KEY=' .env | fly secrets import -a mydomainshub-gateway
  ```
  Without it the gateway logs a warning and emails wait; after 30 minutes the
  `emails_waiting` alert reaches Telegram.
- The daily `email-notices` cron (08:05 WAT) queues ERRP reminders and nudges;
  `purge-email-records` clears outbox rows after 90 days. ERRP notices are
  logged in `compliance_notices` for three years, with delivery read back from
  Brevo every 30 minutes — a bounce is a critical alert: reach the registrant
  another way.
- Nothing is ever sent to example.com or another reserved address (e2e users).
- To see what went out: `select kind, status, sent_at, delivery_status from
  email_outbox order by created_at desc limit 20;`

## 5c-3. Preset checks and the deep sync (migration 32)

Both start with the gateway on its next deploy; there is nothing to set. Two
optional variables tune them — leave them unset on Fly unless there is a
reason:

- **Host presets (FR-D2)**, on the live gateway only (`DNA_WRITE_ENV=production`):
  every `PRESET_CHECK_HOURS` (default 6, 1–24) each preset's nameservers are
  looked up in public DNS. A failing preset raises `preset_failing`; after a
  day of failures it is hidden from customers and `preset_hidden` is
  critical; it comes back by itself once it resolves. A preset you hid stays
  hidden. When the resolvers do not answer at all, nothing is recorded.
- **Deep sync (§13.5)**, on whichever side writes are on: every
  `DEEP_SYNC_EVERY_MINUTES` (default 60, at least 15) the gateway reads 25
  domains with GetDetails — least recently read first, and again soon after
  a change — and corrects or flags them as the hourly reconcile does. Its reads
  wait behind searches and appear in `supplier_calls` as `GetDetails`.

## 5d. Search engines and AI assistants

Built into the site (`apps/web/src/features/seo`), nothing to configure:

- `/robots.txt` welcomes search engines and AI crawlers by name and keeps
  them off the panel and live lookups (a crawled search spends supplier
  capacity). `/sitemap.xml` lists every public page and extension page.
- Every public page has a canonical address and structured data; `/llms.txt`
  and `/llms-full.txt` give language models the site in Markdown.
- **IndexNow** tells Bing, Yandex and the others which pages changed. The
  daily pricing job announces the price pages whenever prices move; run
  **Actions → Pricing data → Run workflow → `indexnow-all`** after a change
  that touches the whole site. The key file is `public/{key}.txt`; the key is
  public by design.

The owner's steps (Search Console, Bing Webmaster Tools, brand profiles) are
in `docs/BACKLOG.md` §1b.

## 6. Refunds and alerts (L15, L16)

The gateway sends refunds for failed registrations, second charges and short
payments back to the card or account that paid, checks unpaid orders with
Flutterwave in case a payment's webhook and redirect were both lost, and
messages you on Telegram when money or a customer's domain needs a person.
These need secrets on Fly; the outside check that notices a stopped gateway
needs them on GitHub.

1. **You:** make a Telegram bot. In Telegram, message **@BotFather**, send
   `/newbot`, and follow the prompts; it replies with a token like
   `123456789:AA…`. Send your new bot any message, then open
   `https://api.telegram.org/bot<token>/getUpdates` in a browser — the number
   under `"chat":{"id":` is your chat id. Keep the token out of chats and
   screenshots: anyone with it can post as the bot.
2. **You:** give the gateway the live Flutterwave secret key (the same one
   Vercel has) and the bot. Type the values in your terminal, not here:
   ```bash
   fly secrets set FLUTTERWAVE_SECRET_KEY=… TELEGRAM_BOT_TOKEN=… TELEGRAM_CHAT_ID=… -a mydomainshub-gateway
   ```
   The gateway refuses a test key on the live side, a live key anywhere but
   production (N12), and a live key with `FLUTTERWAVE_API_URL` set to
   anything but Flutterwave's own address — leave that variable unset on Fly.
   Without the key, refunds wait and raise alerts and unpaid orders are not
   re-checked; without the bot, alerts are only logged.
3. **You:** the same two Telegram values on GitHub, for the gateway watch
   (`.github/workflows/gateway-watch.yml`, hourly):
   ```bash
   gh secret set TELEGRAM_BOT_TOKEN
   gh secret set TELEGRAM_CHAT_ID
   ```
   (`gh secret set` prompts for the value, so it never lands in your shell
   history.) It reuses the pricing jobs' `NEXT_PUBLIC_SUPABASE_URL` and
   `SUPABASE_SECRET_KEY`.
4. **Ask Flutterwave support** to enable refund webhooks (off by default),
   and confirm: the refund window, whether USSD payments can be refunded,
   whether part-refunds accept kobo (e.g. ₦19,672.50), and how a failed
   disbursement is reported. The worker is built to be safe whatever the
   answers — it reads refunds back rather than trusting any single reply —
   but the answers decide how often a refund needs you.

### When an alert arrives

Every alert names an order or a domain and a code. What they mean, and what
to do — the functions below run in the Supabase **SQL editor** (they are not
open to the service key, on purpose):

| Alert | What it means | What to do |
|---|---|---|
| Refund … is **held** — `OVER_SINGLE_LIMIT` / `OVER_DAILY_LIMIT` | Above the automatic limit (₦250,000 per refund, ₦1,000,000 per day) | Check the order, then `select approve_refund('<refund id>', 'your name');` |
| Refund … **needs attention** — `REGISTERED_AT_REGISTRY` | The line failed here, but the registry has the domain in our account (and no other customer here holds it) | Don't refund. Finish the registration for the customer (ask Claude), then `select cancel_refund('<id>', 'your name', 'registered after all');` |
| … `CHARGE_NOT_OURS` / `CHARGE_NOT_FOUND` | The charge at Flutterwave does not match our record — another reference, amount or currency, or no such charge for this key. The Flutterwave account is shared with other apps, so a refund is never sent to a charge that is not provably this order's | Don't refund. Compare the order with the charge in the Flutterwave dashboard. If the row looks tampered with, rotate `SUPABASE_SECRET_KEY` (Supabase → API keys, then Vercel, Fly and GitHub). `cancel_refund` once understood. |
| … `CHARGEBACK_ON_CHARGE` | The customer disputed the charge with their bank | Answer the dispute in Flutterwave; refunding as well could pay them twice. `cancel_refund` once settled. |
| … `REFUND_OUTCOME_UNKNOWN` / `UNTRACKED_REFUND_AT_PROVIDER` / `ALREADY_AT_PROVIDER` | A refund may already have been sent, or someone refunded by hand | Look at the charge in the Flutterwave dashboard. **Refunded** (by us or by hand): `select record_manual_refund('<id>', '<Flutterwave refund id>', 'your name');` — it is then shown to the customer as refunded. **Not refunded:** `select retry_refund('<id>', 'your name');` |
| … `AMOUNT_MISMATCH` | Flutterwave refunded a different amount from the one asked for; its reference is kept | Check the refund in the dashboard. If the right money went back, `record_manual_refund` with that refund's id; otherwise ask Claude before doing anything. |
| Refund … **failed** — `FLW_HTTP_…` / `PROVIDER_REFUND_FAILED` | Flutterwave refused it, or the money bounced | Read the code; fix the cause (often our Flutterwave balance), then `retry_refund`. A bounced refund's reference is kept on record and the retry gets a new one. |
| Refund … has waited … — `INSUFFICIENT_BALANCE` | Our Flutterwave balance can't cover it | Top up or wait for settlement; it retries by itself |
| Payment incident: **underpayment** | Someone paid less than the total; it is being refunded | Nothing, unless it repeats. `select resolve_payment_incident(<id>, 'your name');` |
| Payment incident: **tx ref mismatch** / **currency mismatch** | A transaction was presented for the wrong order, or not in naira | Check Flutterwave. Repeats for one account look like someone probing. Resolve when done. |
| Payment incident: **unrecorded payment** | Flutterwave has the money; we could not record it | Urgent: ask Claude to record it. Flutterwave also resends the webhook (we answer it 503 until it is recorded), and the gateway lists every charge on unpaid and recently paid orders every 5 minutes for 3 days. |
| Payment incident: **registered after refund** | A line registered after its refund had already gone to Flutterwave: the customer may have the domain and the money | Check both. Decide with the customer; nothing is undone automatically. |
| Payment incident: **mode mismatch** | A test payment was presented for a live order, or the reverse | Nothing was recorded. Check the order; repeats look like probing. |
| Registration of … needs a person (`PAYMENT_NOT_VERIFIED`) | A line was about to be registered, but Flutterwave does not confirm the charge behind it (no such charge, another reference, another amount). Nothing was registered and nothing refunded | Look at the order and the charge in the Flutterwave dashboard. A real payment the check misread: ask Claude. A payment row nobody can explain: rotate `SUPABASE_SECRET_KEY` (Supabase → API keys, then Vercel, Fly and GitHub). |
| Order … is still `paid`/`provisioning` (I5) | Paid over 15 minutes ago, not registered | Is the gateway running? `fly status -a mydomainshub-gateway` |
| The gateway has gone quiet | No heartbeat: nothing is being registered, refunded or alerted | `fly status -a mydomainshub-gateway`; add the card (L19) if the trial stopped it |
| Transfer of … needs a person (`TRANSFER_OVERDUE`) | A transfer the registry accepted has not landed or been refused in 10 days | Check the domain at DomainNameAPI. Landed: ask Claude to record it. Refused or stuck: ask the customer, then `fail_job` or `retry_job` with Claude. |
| Transfer lock / privacy / contact change of … needs a person | The registry's answer to a settings change could not be read after several tries | Read the domain at DomainNameAPI; `select retry_job('<job id>');` once it answers. The customer's newest request stays pending until then. |
| Contact change of … needs a person (`CONTACTS_NOT_VISIBLE`) | The registry accepted new contacts but does not show them. In the sandbox this always happens; on live it is unconfirmed | Look at the domain's contacts in the DomainNameAPI panel. Showing the new ones: `select retry_job('<job id>');` records them. Not showing: ask DomainNameAPI why SaveContacts did not apply, then retry. |
| Host preset … is not resolving / is hidden | Its nameservers stopped resolving in public DNS (FR-D2); after a day it is hidden from customers | Read the provider's own documentation. Changed: update the preset's nameservers and `verified_at` in the table editor — it is checked again within 6 hours and shown once it passes. Gone: leave it hidden. |
| Host preset … was last verified … | 90 days since it was checked against the provider's documentation | Check it again; update `verified_at`, and the nameservers if they changed. |
| The supplier catalogue sync failed / was refused / hasn't run for 8 days | The weekly sync in the gateway stopped updating costs; prices can drift from the supplier's | `fly logs -a mydomainshub-gateway` for `catalogue`. To run it now, set `CATALOGUE_SYNC_EVERY_HOURS=1` on Fly, wait for it, then unset it. |

`cancel_refund` means "no money went back and none will"; use
`record_manual_refund` whenever money did go back, so the customer's order
page tells the truth. Retrying a failed registration (`select retry_job('<job
id>');`) takes back its pending refund first, and is refused once that refund
has reached Flutterwave.

Limits and timings live in the `ops_settings` table (edit it in the Supabase
table editor). Refunds are refused anything that would take more than their
charge — that rule is in the database, so no setting changes it.
