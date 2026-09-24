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

`cancel_refund` means "no money went back and none will"; use
`record_manual_refund` whenever money did go back, so the customer's order
page tells the truth. Retrying a failed registration (`select retry_job('<job
id>');`) takes back its pending refund first, and is refused once that refund
has reached Flutterwave.

Limits and timings live in the `ops_settings` table (edit it in the Supabase
table editor). Refunds are refused anything that would take more than their
charge — that rule is in the database, so no setting changes it.
