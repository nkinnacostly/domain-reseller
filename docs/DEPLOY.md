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

**The admin dashboard (ADR-006)** goes out in this order, each step after the
last has finished:

1. Migrations 40 and 41 (`supabase db push`), then `pnpm db:types`. Run
   `supabase/tests/admin.sql` and `admin_data.sql` against the project.
2. The gateway, with `GATEWAY_ADMIN_SECRET` set on Fly (§6b) — it serves
   `/v1/admin/*` and starts the hourly supplier-ledger sync.
3. The web, with the same `GATEWAY_ADMIN_SECRET` on Vercel.
4. Enrol yourself (§6b).

The gateway's first start after 24 Sept 2026 syncs the supplier catalogue at
once (no earlier run is recorded) and writes `is_transferable` — until then
transfers in are closed. `APP_URL` (in `fly.toml`) lets it refresh the site's
prices afterwards. The pricing workflow no longer needs the `DNA_*` GitHub
secrets: `gh secret delete DNA_API_KEY` and `gh secret delete DNA_RESELLER_ID`.

### Multi-year terms (.ai) — migration 37

Extensions whose registry sells only blocks of years (.ai: 2, 4, 6, 8 or 10)
reach the storefront once the catalogue sync writes their periods:

1. **Push migration 37 first** (`supabase db push`), then run
   `supabase db query --linked -f supabase/tests/multi_year_terms.sql`. The
   gateway's weekly sync writes the new `tlds` period columns and fails —
   raising the catalogue alert — until they exist. The web can deploy before
   or after: it reads every column (a row without periods sells every year,
   as before) and writes `order_items.renewal_years` only for a line that
   renews in blocks, which cannot exist until the sync has written one.
2. `pnpm --filter @dr/gateway sync:catalogue` (report only) lists what will
   change: the extensions sold in blocks, and every period left out because
   the supplier prices it off the per-year rate (e.g. .me for 2–10 years) or
   does not sell it (.ai renewals of 3, 5, 7, 9 years). Read it before step 3 —
   a left-out period stops being offered in carts and renewals.
3. Deploy the gateway; its next sync applies it (or set
   `CATALOGUE_SYNC_EVERY_HOURS=1` on Fly, wait for the run, then unset it).
   Prices reach the site on the refresh that follows.

### SSL certificates — migrations 38–39 (PRD E15)

Strictly in this order — **migrations, then the gateway, then the web**:

1. **Push migrations 38 and 39** (`supabase db push`). 38 only adds the
   refund reason `ssl_failed`; Postgres cannot use a new enum value in the
   transaction that adds it, so it must be committed before 39. Then check
   them: `supabase db query --linked -f supabase/tests/ssl_certificates.sql`
   (rolled back; 18 checks). Until 39 is applied the web sells no
   certificates and still builds: a missing SSL table reads as "nothing yet".
2. **Deploy the gateway** (`fly deploy --ha=false -a mydomainshub-gateway`).
   It must know the three new job kinds (`ssl_initialize`, `ssl_configure`,
   `ssl_reissue`) and serve `/v1/ssl/*` (approvers, CSR check, CSR
   generation) before any web change can queue one or call them — an older
   gateway answers 404 to the routes, and never sees the `ssl_jobs` queue at
   all. Its first start syncs the SSL product list at once (no earlier
   `ssl_catalogue:production` run is recorded), prices the three products
   migration 39 marks `is_sellable` (351, 352, 371), and refreshes the
   site's prices. New, optional: `SSL_CHECK_MINUTES` (default 5), how often
   the poller reads certificates waiting on the CA.
3. **Deploy the web** (`git push`). The `/ssl` page, the cart lines and the
   panel's Certificates page go live with it.
4. To see the sync's report before the gateway applies it:
   `pnpm --filter @dr/gateway sync:ssl` (report only; `-- --apply` writes).
   Which products are sold is `ssl_products.is_sellable` — the owner's, never
   written by the sync.

Certificates follow the queue's sides: with `DNA_WRITE_ENV=ote`, test
payments buy in the supplier's sandbox (which issues at once and returns
empty certificate text); with `production`, live payments buy from the float.
The float check at checkout counts certificates at their USD cost.

## 5c. Email (L1)

Supabase Auth sends every email through our route `/api/auth/send-email`,
which uses the API of the provider `EMAIL_PROVIDER` names — Brevo today, Amazon
SES after the cutover below: from `no-reply@notify.mydomainshub.com`, replies to
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

### Amazon SES — what is set up, and the cutover

`EMAIL_PROVIDER=ses` sends the auth emails (web) and the outbox (gateway)
through SES instead of Brevo — same From, same Reply-To, same templates. Brevo
stays the default until AWS lets the account out of the SES sandbox, which
only delivers to verified addresses, one message a second.

Already in AWS (do not change): region **eu-west-2**; identity
`notify.mydomainshub.com` with Easy DKIM and custom MAIL FROM
`mail.notify.mydomainshub.com`; configuration set **`mydomainshub`**, whose
event destination publishes DELIVERY, BOUNCE, COMPLAINT, REJECT,
DELIVERY_DELAY and RENDERING_FAILURE to the SNS topic
**`mydomainshub-ses-events`**; account-level suppression of bounces and
complaints. The key in `AWS_SES_*` should be a sending-only IAM user's (`.env`
notes `mydomainshub-ses-sender`), allowed `ses:SendEmail` on the identity and
the configuration set and nothing else.

SES cannot be asked what became of a message, so delivery reports come to us:
SNS posts every event to `https://www.mydomainshub.com/api/email/ses-events`,
which verifies the SNS signature — the certificate must come from
`sns.eu-west-2.amazonaws.com` and the topic must be `SES_EVENTS_TOPIC_ARN` —
and records it with `record_email_event` (migration 34). With SES the
gateway's Brevo read-back loop does not run. An ERRP or security email with no
final report a day after sending raises `email_unconfirmed` (critical for an
ERRP notice); a spam complaint raises `email_complaint`.

| Variable | Vercel (Production) | Fly (gateway) | Notes |
|---|---|---|---|
| `EMAIL_PROVIDER` | `ses` at cutover | `ses` at cutover | `brevo` or unset keeps Brevo. Read at build on Vercel (the privacy notice names the provider), so redeploy after changing it. |
| `AWS_SES_REGION` | `eu-west-2` | `eu-west-2` | |
| `AWS_SES_ACCESS_KEY_ID` | the sending user's key | same | Secret. Never logged. |
| `AWS_SES_SECRET_ACCESS_KEY` | the sending user's secret | same | Secret. |
| `AWS_SES_CONFIGURATION_SET` | `mydomainshub` | `mydomainshub` | Without it no events are published. |
| `SES_EVENTS_TOPIC_ARN` | the topic's ARN | — | Not secret. Set it before subscribing (step 2). |
| `SES_MAX_SEND_RATE` | — | the account's rate | Messages a second; 1 until AWS raises it. |
| `SES_SMTP_USERNAME`, `SES_SMTP_PASSWORD` | — | — | `.env` only, for `supabase config push` (step 5). |

**Cutover checklist**

1. **You:** AWS grants production access (SES → Account dashboard shows
   *Production*). Note the maximum send rate it shows.
2. **You:** subscribe the webhook — possible before the cutover, and harmless
   while Brevo still sends:
   - add `SES_EVENTS_TOPIC_ARN` on Vercel (Production) and redeploy;
   - SNS → topic `mydomainshub-ses-events` → *Create subscription*: protocol
     **HTTPS**, endpoint `https://www.mydomainshub.com/api/email/ses-events`,
     **raw message delivery off** (the route needs SNS's signed envelope). The
     route confirms the subscription itself; it shows *Confirmed* within a
     minute (Vercel's log: `SES events: SNS subscription confirmed`);
   - check: SES → *Send test email* with configuration set `mydomainshub` to
     `success@simulator.amazonses.com`. The route logs `SES events: delivery
     event` with `known: false` — not one of ours, answered 200.
3. **You:** on Vercel (Production) set `EMAIL_PROVIDER=ses` and the four
   `AWS_SES_*` values, then redeploy. Sign up or ask for a password reset with
   a real address: the email arrives from `no-reply@notify.mydomainshub.com`,
   and replying goes to hello@. The privacy notice now names Amazon SES.
4. **You:** on Fly:
   ```bash
   grep -E '^(AWS_SES_(REGION|ACCESS_KEY_ID|SECRET_ACCESS_KEY|CONFIGURATION_SET))=' .env | fly secrets import -a mydomainshub-gateway
   fly secrets set EMAIL_PROVIDER=ses SES_MAX_SEND_RATE=<the rate from step 1> -a mydomainshub-gateway
   ```
   The gateway restarts and logs `email sender started` with `provider: ses`
   and `deliveryReports: pushed to the web` (never a key). Without all four
   values it logs `email provider not configured` with the missing names, and
   emails wait — it never falls back to Brevo.
5. **You:** point Supabase Auth's SMTP fallback at SES: in
   `supabase/config.toml`, `[auth.email.smtp]` becomes
   `host = "email-smtp.eu-west-2.amazonaws.com"`, `port = 587`,
   `user = "env(SES_SMTP_USERNAME)"`, `pass = "env(SES_SMTP_PASSWORD)"`
   (SES SMTP credentials, generated for eu-west-2 — not the API key); then
   `set -a; . ./.env; set +a; supabase config push`, reading the diff first.
6. **Watch deliveries** for a few days:
   ```sql
   select kind, category, sent_at, delivery_status, delivery_detail, complained_at
     from email_outbox where sent_at > now() - interval '1 day' order by sent_at desc;
   ```
   SES's message ids look like `0102019…-000000`. `delivery_status` should
   reach `delivered` within minutes. Telegram carries `email_unconfirmed`,
   `email_complaint` and `compliance_notice_bounced`; SES → *Reputation
   metrics* shows bounce and complaint rates (keep them under 5% and 0.1%).
   Notices sent through Brevo in the last day before the switch are no longer
   read back and may raise `email_unconfirmed`: look them up in Brevo's log.
7. **Rolling back** is `EMAIL_PROVIDER=brevo` on Vercel (redeploy) and Fly,
   and the Brevo SMTP lines back in `config.toml` — as long as Brevo is kept.
8. **Later, you:** retire Brevo once a couple of weeks have been clean: remove
   `BREVO_API_KEY` from Vercel and Fly and `BREVO_*` from `.env`; in
   Cloudflare delete Brevo's records on `notify.mydomainshub.com` (its DKIM
   keys, the `brevo-code` TXT and `include:spf.brevo.com`), keeping SES's
   three DKIM CNAMEs, the `mail.notify` MX and SPF, and DMARC; close the Brevo
   account. The Brevo code can then go in its own change.

## 5c-2. Notification emails (migration 31)

Receipts, domain news, refunds, security notices, ERRP renewal reminders and
the undelegated nudge are queued in the database (`email_outbox`) by the
thing that causes them, and sent by the gateway through `EMAIL_PROVIDER` —
Brevo until the SES cutover in §5c.

- **Fly** needs `BREVO_API_KEY` (the same key as Vercel's) while Brevo sends:
  ```bash
  grep '^BREVO_API_KEY=' .env | fly secrets import -a mydomainshub-gateway
  ```
  Without the chosen provider's credentials the gateway logs a warning naming
  the missing variables and emails wait; after 30 minutes the `emails_waiting`
  alert reaches Telegram.
- The daily `email-notices` cron (08:05 WAT) queues ERRP reminders and nudges;
  `purge-email-records` clears outbox rows after 90 days. ERRP notices are
  logged in `compliance_notices` for three years, with delivery read back from
  Brevo every 30 minutes, or pushed by SES as it happens — a bounce is a
  critical alert: reach the registrant another way. So is a notice with no
  final report a day after sending (`email_unconfirmed`, migration 34).
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
  The registrar's default nameservers (migration 35, the rows named
  "Registrar default (live)" and "(sandbox)") are checked the same way; while
  one is hidden, the Nameservers tab offers no "Use default DNS" on that side.
  Push migration 35 before deploying the web that reads it — until then the
  tab offers no default and the web logs the missing column on each view.
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

## 5e. Bot protection — Cloudflare Turnstile (SEC-9)

Sign-up, the sign-in link, password reset and "send the link again" ask
Turnstile before sending an email; search asks after 30 searches in ten
minutes from one address, and bulk search before a list starts. Until both
keys are set none of this runs (the site works as before, and production logs
an error once per process), and the privacy notice does not mention Cloudflare.

1. **You:** Cloudflare dashboard → Turnstile → **Add widget**: hostnames
   `www.mydomainshub.com`, `mydomainshub.com` (and `mydomainshub.vercel.app`
   while it serves), widget mode **Managed**. Copy the site key and the secret.
2. **You:** Vercel → Settings → Environment Variables, **Production**:

   | Variable | Value |
   |---|---|
   | `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | the site key (public; built into the page) |
   | `TURNSTILE_SECRET_KEY` | the secret key |

   Both or neither: a secret without a site key would refuse every sign-up,
   so the code treats that as off. Redeploy — the site key is read at build
   time. Preview deployments can use Cloudflare's test keys
   (`1x00000000000000000000AA` / `1x0000000000000000000000000000000AA`),
   which always pass.
3. **Check:** open `/sign-up` in a private window: the form works with no
   visible widget (one appears only if Cloudflare wants a click), and
   `/legal/privacy` now lists Cloudflare Turnstile and `dr_search_pass`.

Playwright always uses the test keys (`apps/web/playwright.config.ts`), so a
real secret in `.env` never reaches e2e.

## 5f. Google sign-in (FR-A1)

1. **Google Cloud Console** → new project *MyDomainsHub* → APIs & Services →
   **OAuth consent screen**: External; app name MyDomainsHub; support email
   hello@mydomainshub.com; authorised domain `mydomainshub.com`; scopes
   `email`, `profile`, `openid`; then **Publish app** (basic scopes need no
   Google review).
2. **Credentials → Create OAuth client ID → Web application**:
   - Authorised JavaScript origin: `https://www.mydomainshub.com`
   - Authorised redirect URI: `https://zorqxevikrismmqxxsyp.supabase.co/auth/v1/callback`
3. Put the id and secret in the root `.env` as `GOOGLE_OAUTH_CLIENT_ID` and
   `GOOGLE_OAUTH_CLIENT_SECRET` (they go to Supabase, not Vercel).
4. `set -a; . ./.env; set +a; supabase config push` — read the diff: it should
   add only `[auth.external.google]`. From now on every config push needs both
   variables set.
5. The button appears on `/sign-in` and `/sign-up` within the hour (the
   providers read is cached), or at once after a deploy.

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

Every alert names an order or a domain and a code, and links to its page in
the admin dashboard (`/admin`, ADR-006). What they mean, and what to do: the
**In the dashboard** column names the page and the button, each audited and
each money button asking for your authenticator code. The functions in the
last column run in the Supabase **SQL editor** (they are not open to the
service key, on purpose) — that stays the fallback whenever the dashboard is
down, and is the only way for the rows marked **SQL editor only**:

| Alert | What it means | In the dashboard | What to do in the SQL editor |
|---|---|---|---|
|  Refund … is **held** — `OVER_SINGLE_LIMIT` / `OVER_DAILY_LIMIT` | Above the automatic limit (₦250,000 per refund, ₦1,000,000 per day) | Refunds → the refund → **Approve** (reason and code) | Check the order, then `select approve_refund('<refund id>', 'your name');`  |
|  Refund … **needs attention** — `REGISTERED_AT_REGISTRY` | The line failed here, but the registry has the domain in our account (and no other customer here holds it) | Queue → the job → **Retry**: it reads the registry, records the domain and cancels the refund | Don't refund. Finish the registration for the customer (ask Claude), then `select cancel_refund('<id>', 'your name', 'registered after all');`  |
|  … `CHARGE_NOT_OURS` / `CHARGE_NOT_FOUND` | The charge at Flutterwave does not match our record — another reference, amount or currency, or no such charge for this key. The Flutterwave account is shared with other apps, so a refund is never sent to a charge that is not provably this order's | Refunds → the refund → **Cancel** (owner; reason, checks and code) | Don't refund. Compare the order with the charge in the Flutterwave dashboard. If the row looks tampered with, rotate `SUPABASE_SECRET_KEY` (Supabase → API keys, then Vercel, Fly and GitHub). `cancel_refund` once understood.  |
|  … `CHARGEBACK_ON_CHARGE` | The customer disputed the charge with their bank | Refunds → the refund → **Cancel** (owner), once the dispute is settled | Answer the dispute in Flutterwave; refunding as well could pay them twice. `cancel_refund` once settled.  |
|  … `REFUND_OUTCOME_UNKNOWN` / `UNTRACKED_REFUND_AT_PROVIDER` / `ALREADY_AT_PROVIDER` | A refund may already have been sent, or someone refunded by hand | Refunds → the refund → **Check with Flutterwave**, then **Record a Flutterwave refund**; not refunded: **Retry** | Look at the charge in the Flutterwave dashboard. **Refunded** (by us or by hand): `select record_manual_refund('<id>', '<Flutterwave refund id>', 'your name');` — it is then shown to the customer as refunded. **Not refunded:** `select retry_refund('<id>', 'your name');`  |
|  … `AMOUNT_MISMATCH` | Flutterwave refunded a different amount from the one asked for; its reference is kept | Refunds → the refund → **Check with Flutterwave**, then **Record a Flutterwave refund** when it matches | Check the refund in the dashboard. If the right money went back, `record_manual_refund` with that refund's id; otherwise ask Claude before doing anything.  |
|  Refund … **failed** — `FLW_HTTP_…` / `PROVIDER_REFUND_FAILED` | Flutterwave refused it, or the money bounced | Refunds → the refund → **Retry** | Read the code; fix the cause (often our Flutterwave balance), then `retry_refund`. A bounced refund's reference is kept on record and the retry gets a new one.  |
|  Refund … has waited … — `INSUFFICIENT_BALANCE` | Our Flutterwave balance can't cover it | Refunds → the refund (read only); nothing to press | Top up or wait for settlement; it retries by itself  |
|  Payment incident: **underpayment** | Someone paid less than the total; it is being refunded | Refunds → Incidents → **Mark resolved** | Nothing, unless it repeats. `select resolve_payment_incident(<id>, 'your name');`  |
|  Payment incident: **tx ref mismatch** / **currency mismatch** | A transaction was presented for the wrong order, or not in naira | Refunds → Incidents → **Mark resolved** | Check Flutterwave. Repeats for one account look like someone probing. Resolve when done.  |
|  Payment incident: **unrecorded payment** | Flutterwave has the money; we could not record it | **SQL editor only** to record it (`record_order_payment`); then Refunds → Incidents → **Mark resolved** | Urgent: ask Claude to record it. Flutterwave also resends the webhook (we answer it 503 until it is recorded), and the gateway lists every charge on unpaid and recently paid orders every 5 minutes for 3 days.  |
|  Payment incident: **registered after refund** | A line registered after its refund had already gone to Flutterwave: the customer may have the domain and the money | Refunds → Incidents → **Mark resolved**, once decided | Check both. Decide with the customer; nothing is undone automatically.  |
|  Payment incident: **mode mismatch** | A test payment was presented for a live order, or the reverse | Refunds → Incidents → **Mark resolved** | Nothing was recorded. Check the order; repeats look like probing.  |
|  Registration of … needs a person (`PAYMENT_NOT_VERIFIED`) | A line was about to be registered, but Flutterwave does not confirm the charge behind it (no such charge, another reference, another amount). Nothing was registered and nothing refunded | Queue → the job → **Retry** only. Closing it for good: **SQL editor only** | Look at the order and the charge in the Flutterwave dashboard. A real payment the check misread: ask Claude. A payment row nobody can explain: rotate `SUPABASE_SECRET_KEY` (Supabase → API keys, then Vercel, Fly and GitHub).  |
|  Order … is still `paid`/`provisioning` (I5) | Paid over 15 minutes ago, not registered | Orders → "Stuck only"; Alerts → Health | Is the gateway running? `fly status -a mydomainshub-gateway`  |
|  The gateway has gone quiet | No heartbeat: nothing is being registered, refunded or alerted | Alerts → Health | `fly status -a mydomainshub-gateway`; add the card (L19) if the trial stopped it  |
|  Transfer of … needs a person (`TRANSFER_OVERDUE`) | A transfer the registry accepted has not landed or been refused in 10 days | Queue → the job → **Read the transfer state**; refused: **Fail**. Landed: **SQL editor only** (`complete_transfer`) | Check the domain at DomainNameAPI. Landed: ask Claude to record it. Refused or stuck: ask the customer, then `fail_job` or `retry_job` with Claude.  |
|  Transfer lock / privacy / contact change of … needs a person | The registry's answer to a settings change could not be read after several tries | Queue → the job → **Read the registry now**, then **Retry** | Read the domain at DomainNameAPI; `select retry_job('<job id>');` once it answers. The customer's newest request stays pending until then.  |
|  Contact change of … needs a person (`CONTACTS_NOT_VISIBLE`) | The registry accepted new contacts but does not show them. In the sandbox this always happens; on live it is unconfirmed | Queue → the job → **Read the registry now**, then **Retry** | Look at the domain's contacts in the DomainNameAPI panel. Showing the new ones: `select retry_job('<job id>');` records them. Not showing: ask DomainNameAPI why SaveContacts did not apply, then retry.  |
|  Host preset … is not resolving / is hidden | Its nameservers stopped resolving in public DNS (FR-D2); after a day it is hidden from customers | Settings → Presets → **Save a change** (a draft), **Check now**, **Publish** (owner). Registrar-default rows: **SQL editor only** | Read the provider's own documentation. Changed: update the preset's nameservers and `verified_at` in the table editor — it is checked again within 6 hours and shown once it passes. Gone: leave it hidden. A *Registrar default* row has no documentation page: read a domain freshly registered on the defaults from its registry's RDAP (live), or ask the supplier's support (sandbox).  |
|  Host preset … was last verified … | 90 days since it was checked against the provider's documentation | Settings → Presets → the preset; a change goes through a draft as above | Check it again; update `verified_at`, and the nameservers if they changed.  |
|  A compliance / security email … has no delivery report (`email_unconfirmed`) | Sent over a day ago, and neither delivered nor bounced has come back — from Brevo's read-back or SES's events (migration 34). It is not counted as delivered | Emails → Outbox (read only) | Brevo: look the message up under Transactional → Logs. SES keeps no per-message log of its own: check the SNS subscription is still *Confirmed* and Vercel's log shows `SES events` lines arriving. For an ERRP notice you cannot confirm, reach the registrant another way.  |
|  A … email … was reported as spam (`email_complaint`) | The recipient marked it as spam; SES has put the address on the account's suppression list | Emails → Outbox; **Send again** is not offered for it | Nothing to send. If it was a mistake the customer can ask; remove the address from the suppression list in SES only then. Several in a week: look at what we send.  |
|  The supplier catalogue sync failed / was refused / hasn't run for 8 days | The weekly sync in the gateway stopped updating costs; prices can drift from the supplier's | Supplier → Price list → **Preview**, then **Apply price list** (owner, code) | `fly logs -a mydomainshub-gateway` for `catalogue`. To run it now, set `CATALOGUE_SYNC_EVERY_HOURS=1` on Fly, wait for it, then unset it.  |

**SQL editor only**, whatever the dashboard shows: recording a landed transfer
(`complete_transfer`), recording an unrecorded payment (`record_order_payment`),
closing a `PAYMENT_NOT_VERIFIED` job, changing `vat_pct`, registrar-default
presets, adding or removing a preset's source domains
(`nameserver_preset_sources`), and admins (§6b).

`cancel_refund` means "no money went back and none will"; use
`record_manual_refund` whenever money did go back, so the customer's order
page tells the truth. Retrying a failed registration (`select retry_job('<job
id>');`) takes back its pending refund first, and is refused once that refund
has reached Flutterwave.

Limits and timings live in the `ops_settings` table (change them in the
dashboard under Settings, as the owner, or in the SQL editor). Refunds are
refused anything that would take more than their charge — that rule is in the
database, so no setting changes it.

## 6b. Admin access (ADR-006)

The dashboard at `/admin` is open only to rows in `public.admins`, checked in
SQL on every request: a password or Google sign-in, then the code from an
authenticator **pinned** to your admin row, and for any money button a code
typed into its dialog. Anyone else gets a plain 404. Admins are added and
changed only here, in the Supabase **SQL editor** — never in a migration, in
git, or from the dashboard.

1. **You:** turn on two-factor in Settings on every device you will use for the
   dashboard (a backup phone included), from `/app/settings`.
2. **You:** after migration 40, in the SQL editor — type your email here only:
   ```sql
   -- List your verified authenticators: one row per device.
   select f.id as factor_id, f.friendly_name, f.created_at
     from auth.users u join auth.mfa_factors f on f.user_id = u.id
    where u.email = 'OWNER_EMAIL' and f.factor_type = 'totp' and f.status = 'verified';

   -- Enrol, pinning every verified authenticator.
   insert into public.admins (user_id, label, role, mfa_factor_ids, added_by)
   select u.id, 'owner', 'owner',
          (select array_agg(f.id order by f.created_at) from auth.mfa_factors f
            where f.user_id = u.id and f.factor_type = 'totp' and f.status = 'verified'),
          'sql-editor'
     from auth.users u where u.email = 'OWNER_EMAIL';
   ```
3. **After adding, removing or replacing a device**, re-pin every verified
   authenticator — a sign-in with an unpinned one is told "This sign-in used an
   authenticator that isn't linked to your admin access":
   ```sql
   update public.admins a
      set mfa_factor_ids = (select array_agg(f.id order by f.created_at) from auth.mfa_factors f
                             where f.user_id = a.user_id and f.factor_type = 'totp' and f.status = 'verified')
    where a.label = 'owner';
   ```
   An operator is the same insert with role `'operator'` (or `'viewer'`) and
   their own label (lower-case letters, digits, `-` and `_`; never an email).
   Removing anyone: `update public.admins set revoked_at = now() where label = '<label>';`
4. **Every change raises an `admin_changed` Telegram alert.** That alert is how
   you know nobody else made one: an `admin_changed` you did not cause means
   someone with database access is adding admins — rotate the database
   password and `SUPABASE_SECRET_KEY` at once.
5. **You:** the gateway's admin secret, which the web sends on every live read
   (`/v1/admin/*`). Make it in your terminal, not here, and set the same value
   on both sides:
   ```bash
   openssl rand -hex 32                                         # copy the output
   fly secrets set GATEWAY_ADMIN_SECRET=… -a mydomainshub-gateway
   vercel env add GATEWAY_ADMIN_SECRET production                # paste when asked
   ```
   Without it the dashboard works, but live reads answer "Live reads are off".
   Neither secret alone reaches the supplier: the gateway also claims the
   read's audit note in the database first.
6. **`SUPABASE_ACCESS_TOKEN` and the database password are never set in CI or
   on Vercel.** The dashboard needs neither; with either, a leaked build log
   could add an admin.

Deploy order for the dashboard: migrations 40 and 41, then the gateway with
`GATEWAY_ADMIN_SECRET`, then the web, then step 2 above (§5b).
