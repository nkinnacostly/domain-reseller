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
