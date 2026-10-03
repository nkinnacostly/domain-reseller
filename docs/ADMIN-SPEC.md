# MyDomainsHub Admin Dashboard: Build Specification (v2)

> **Owner sign-off, 2 Oct 2026:** ADR-006 approved (admins are a database table checked in SQL, replacing the PRD §12.2 JWT-claim rule); the money safeguards approved as specified (a fresh authenticator code per money action; refunds capped at ₦1,000,000 each and ₦5,000,000 a day; owner-only cancels, prices, limits and presets); scope: Package A, then all B packages.

Date: 2 Oct 2026. Repo: `/Users/nkinnacostly/Documents/domain-reseller`.

**Binding rules.** `CLAUDE.md` (N1–N14, S1–S13 and the §15 gotchas) applies to every line of this work. Where this spec and `CLAUDE.md` disagree, `CLAUDE.md` wins, and the builder stops and asks. Three conditions come before any build work:
- **The owner signs off ADR-006 (D1) before Package A starts.** It contradicts `CLAUDE.md` §5 ("separate auth claim") and the PRD §12.2 hard rule ("JWT custom claim in `app_metadata`").
- `CLAUDE.md` §5 and PRD §12.2 change **in the same commit as migration 40**.
- Until the sign-off is given, the builder stops (`CLAUDE.md` §16).

**Inputs.** Five analyst reports, a review of v1 (32 points), and these live checks on 2 Oct 2026:
- The column lists, enum values and check constraints of the tables and types used below.
- `pg_default_acl`: every function `postgres` creates in `public` gets EXECUTE for PUBLIC, `anon`, `authenticated` and `service_role`. Every new table and view gets `arwdDxtm` for `anon` and `authenticated`.
- Table ACLs. `fx_rates`, `pricing_settings`, `tlds` and `market_references` grant `arwdDxtm` to `anon` and `authenticated`. `order_items` grants `rDxtm` to `anon` and `authenticated`, and its policy "read own" lets a buyer read their own lines.
- `auth.sessions` and `auth.mfa_amr_claims`.
- The function bodies (dump: `scratchpad/fndefs.sql`). This covers `retry_refund`, which accepts `cancelled`; `fail_job`, whose `apply_nameservers` branch keeps `pending_nameservers`; `retry_job`, which raises for a failed transfer; and `sync_alerts`, which returns no `key`.
- `apps/gateway/src/refunds/refunder.ts`, which reads the registry only for registration, renewal and transfer refunds.
- `apps/web/src/lib/gateway.ts`, which logs `path` at lines 51, 70 and 74.
- The authenticator's `rolconfig`, which has no `pgrst.db_aggregates_enabled`.
- The project JWKS, which publishes one ES256 key.
- The supplier OpenAPI spec (`scratchpad/dna-swagger.json`) and read-only calls to production. `deposit/transactions` ignores `StartDate` without `EndDate`, and filters by whole day when both are set. One live traceId has version nibble `b` and variant `7`, and debit traceIds are upper-case.

**Data today (pre-launch, aggregates):**
- 4 orders (2 live, both completed).
- 0 refunds, 0 SSL certificates.
- 12 jobs.
- 68 alerts, 3 open. All 3 are stale test-mode alerts.
- 413 balance snapshots.
- 232 rows in `supplier_calls`.
- 7 profiles.
- 1 verified TOTP factor.
- 5 entries in the supplier ledger.
- 1 stale `pending_review` FX rate: ₦1,700, quoted 20 Sept, about 28% above the active ₦1,328.10.

### v2: review points taken differently from the proposed fix
Each of these was checked against the code. Every other review point is applied as proposed, in place below.
1. **No dashboard close for `PAYMENT_NOT_VERIFIED`.** No existing queue function closes a line without queuing a refund and a customer notice. DEPLOY §6 already sends this case to a person. Fail is refused, Retry re-reads the charge, and a close is done in the SQL editor (D20).
2. **Presets are staged as drafts, not as hidden rows.** `presets_for_check()` skips presets a person hid, so a "hidden, pending" preset would never be checked (§3.1.2, D21).
3. **Hiding a preset stays at operator level.** Fewer choices cannot point a domain anywhere. Save, publish and show are owner-only.
4. **B12 does not seed an FX row.** `fx_rates` has no `test_mode`, so a seeded pending row would show on the live dashboard and in the FX job's review count. The "too old" rule is unit-tested and checked in rolled-back SQL. The e2e test does not depend on the live row.
5. **No helper that ages a test session's code.** Money actions now take a code inside the dialog. The 12-hour path is covered by SQL check 3 and the safe-action unit test. That GoTrue rebuilds `amr` from `mfa_amr_claims` was unverified (D8); a step-up was observed refreshing it on 3 Oct 2026 (`step-up.db.test.ts`).
6. **Sensitive projections are SQL views, not one function per read.** Lists still need PostgREST filtering, sorting and paging. Each view is `security_invoker`, revoked from `anon` and `authenticated`, and covered by the ACL check.
7. **Refund limit ceilings use the strictest proposal.** The ceilings are ₦1,000,000 per refund and ₦5,000,000 a day, with daily ≥ single and a delay of at least 5 minutes.
8. **`domains/renew/check` is used only after an OTE proof.** It takes the same input as Renew. Package A must first show that it changes neither the balance nor the expiry.
9. **`supplier_unexplained_charge` covers only debits shaped like a registration** (the description is a bare domain name). Other unmatched domain debits are `unclassified` (a warning) until a renewal or transfer debit has been seen.
10. **The table clean-up is wider than proposed.** TRUNCATE is revoked from `anon` and `authenticated` on every public table, and writes are revoked on `market_references` too (found in the same check).
11. **Customer search and reveal move from viewer to operator**, with a limit of 30 an hour.

---

## 0. Decisions where the analysts disagreed

| # | Topic | Decision | Why |
|---|---|---|---|
| D1 | Who is an admin | A table, `public.admins`, read on every request. No JWT claim and no custom access-token hook. Recorded as **ADR-006**, which amends PRD §12.2. **Owner sign-off before Package A.** | Removing an admin takes effect at once (a claim lives up to 3600 s). Any service key can write `app_metadata`. A failing hook would block every sign-in. |
| D2 | Where the admin check lives | In SQL. `admin_session()` checks identity. **`admin_tier(action)`, a fixed map inside SQL, gives each action's role, code freshness, hold check and test-admin rule. No caller supplies them.** The proxy, layout, queries, actions, every wrapper and `admin_note` all go through these. | A missed check in web code cannot bypass it. The database checks AAL2 again. |
| D3 | Refund and incident decisions | They stay **revoked from `service_role`**. New `admin_*` SECURITY DEFINER wrappers are granted to **`authenticated` only**. **Every new function is revoked from `public, anon, authenticated, service_role` and then granted to exactly one role (§3.0). CI checks this in SQL.** | Granting the base functions to `service_role` would let a leaked `SUPABASE_SECRET_KEY` approve refunds. By default Supabase grants every new function to `anon`. |
| D4 | How pages read data | (a) These come from `admin_*` read functions called with the session client: aggregates, anything that reads `auth.*`, anything that returns personal data, and any read a test admin must not see in full. (b) Row lists use **`adminDb(principal, side)`**, which exposes **select only** over a fixed map of tables and Package A's masked views, **and applies the side filter itself**. | Aggregates belong in SQL (1,000-row cap; PostgREST aggregates are off). Only definer functions read `auth.*`. Side and test-admin rules cannot depend on each query remembering a filter. |
| D5 | RLS bypass for admins | **None.** | A bypass exposes every column to the browser in an admin's session. |
| D6 | How fresh the second factor must be | **Standard tier** (viewing and ordinary acts): AAL2, a pinned factor, a code within **12 h**. **Money tier** (money, prices, settings, irreversible acts): **a code typed into the confirm dialog and verified in the same action, at most 5 min old**, plus no 24 h password-reset hold. | Injected script cannot spend money with an old code. Ordinary pages do not ask for a code each time. |
| D7 | Factor pinning | `admins.mfa_factor_ids uuid[]` pins **every** verified TOTP factor the admin enrolled. `auth.sessions.factor_id` must be in the set and still verified. The live session row must exist and not be expired. The sign-in must be strong (`password` or `oauth`). | A leaked secret key can enrol a new factor through the Auth admin API; the pin defeats that. A backup device keeps working (recovery codes are off, §15). |
| D8 | Code freshness source | The `totp` timestamp in the JWT's `amr`. | Observed on the hosted project, 3 Oct 2026 (`step-up.db.test.ts`): a second `challengeAndVerify` on an aal2 session moves the totp timestamp to now. Its money half (`admin_whoami(5)` and a wrapper) runs once migrations 40–41 are applied (BACKLOG A8). |
| D9 | Non-admins and signed-out visitors on `/admin` | The proxy **answers a 404**. **A signed-in user at `/sign-in?next=/admin…` is sent to that `/admin` path**, not to `/app/domains`. | A stranger sees the plain not-found page with no admin words, and the owner's bookmark works whether or not they are signed in. *(Package A review, 3 Oct 2026:)* the stranger's 404 carries **exactly the headers any other 404 on the site gets** — the site's CSP, Next's own `Cache-Control`, no `X-Robots-Tag`, no nonce and no `x-middleware-rewrite` — so nothing in it says `/admin` is special (§2.3; `admin.spec.ts` compares it with a random path). *(Second review, 3 Oct 2026:)* the same holds for every way a browser asks — a document, and the client router's `rsc: 1` navigation, prefetch and segment prefetch: names, values and order alike. Every path no page answers takes the same rewrite (`next.config.ts`'s `fallback`), so any 404's RSC answer carries `x-nextjs-rewritten-path: /__not-found`, not only `/admin`'s; the rewrite sources capture nothing, so the payload holds no `?path=` a random path's lacks; and the site CSP's header rule comes after the security headers', where the proxy's CSP lands. |
| D10 | Supplier calls from admin | Never during render. Live reads happen on a click. Each is audited, runs in the `normal` or `low` lane (**never `high`**), uses caches and a shared bucket, and **runs only after the gateway claims a fresh audit note** (D22). | N1. Two requests a second across the whole account. |
| D11 | Supplier writes from admin | **None.** Two POST *reads* are allowlisted: `domains/transfers/query`, and `domains/renew/check` (only after its OTE proof). | N3. Registry state changes only through the queue. |
| D12 | `GET /order/{orderCode}` | **Not built.** | Nothing we hold resolves it. |
| D13 | Margin | Shown only from real cost **in integer cents**: a matched ledger debit first, then the cost recorded at checkout in the **service-only `order_item_costs`**. Uncosted lines are counted and excluded. Labelled "at the rate charged". | N9b. Customers can read `order_items`. |
| D14 | Registry drift | Read-only, plus "Queue a deep sync" on live, syncable domains. | The next reconcile reopens anything resolved by hand. |
| D15 | Test admins (e2e) | `test_only` operators exist for reserved `e2e-*@example.com` users only. **SQL enforces that they act and read on the test side only.** They see e2e users' profiles only (`admin_e2e_email`: `e2e-*@example.com` — not every reserved address, which anyone can sign up with), their own admin row only, and no production supplier read. Their audit rows are purged by **cron only, after 30 days**. | E2E shares the production database, and a test admin is a real row in it. |
| D16 | Managing admins | Read-only in the UI; done in the SQL editor (DEPLOY §6b). **Every insert, update or delete on `admins` is logged by a trigger and raises a critical Telegram alert.** `SUPABASE_ACCESS_TOKEN` and the database password stay out of CI and Vercel. The owner confirms that the legacy JWT secret is revoked (the JWKS shows an ES256 key). | No API role can write `admins`. Anyone with SQL access can, and the alert makes that visible. |
| D17 | Tables | Our own server `DataTable`, **not** `components/kibo-ui/table`. | Kibo shares one sorting atom, sorts only the loaded rows, and has no `aria-sort`. |
| D18 | Drawers | None. Detail pages, with `<details>` for secondary rows. | Linkable from Telegram, and accessible. |
| D19 | Catalogue apply from admin | Yes. Owner, money tier. The `supplier.catalogue_apply` tier lives in SQL, and the gateway route refuses unless it claims a matching note. | The CLI apply stops working once the allowlist is enforced. |
| D20 | Out of v1 | Abuse, risk scores, impersonation, status override, manual supplier operations, force-refund, DSAR queue, SSL revoke, CSV export of personal data. **SQL editor only** (DEPLOY §6): recording a landed transfer (`complete_transfer`), recording an unrecorded payment (`record_order_payment`), closing a `PAYMENT_NOT_VERIFIED` job, changing `vat_pct`, registrar-default presets, and admins. | Each breaks a §15 invariant, is statutory, or needs an owner decision. |
| D21 | Nameserver presets | Changes are **drafts** in `nameserver_preset_drafts`. A draft goes live only after **a passing public-DNS check of the draft plus a separate owner "Publish"**. The source URL's host must be on a per-provider allowlist. Every change sends a Telegram notice. | Presets steer customer domains. A changed preset is a DNS takeover tool (N11). |
| D22 | Gateway-backed actions | The web writes an **`intent`** audit note through `admin_note`, which applies the tier from SQL. The gateway **claims** it with its service key before acting. The note must exist, be an intent, match the route's action, label and target, be under 60 s old, not have been used, and be on the right side. The gateway then appends the real outcome. | Holding the Vercel env (both shared secrets) is not enough to call `/v1/admin/*`. |
| D23 | Recording a Flutterwave refund | Only after the gateway has read that refund from Flutterwave and stored the facts (`flw_refund_checks`). The wrapper requires: this payment's transaction, this refund's amount, a `completed-*` status, and a read under 15 minutes old. | A completed refund is final and emails the customer. A mistyped id must not close it. |
| D24 | Money units | Kobo and **integer cents** everywhere, in tables, gateway contracts and `admin_*` payloads. No `*_usd` numeric is read under `features/admin` or in B15. | N5. supabase-js returns `numeric` as a JS float. |

---

## 1. Scope and principles

**Scope.** An internal back-office at `/admin/*` in `apps/web` for the owner and future operators. It lets them:
- watch the business (sales, float, provisioning, alerts);
- work the exception queues (refunds, jobs, incidents, emails);
- inspect any order, domain, certificate or customer;
- reconcile the supplier's ledger with our records;
- change the database-held settings (pricing inputs, FX, limits, extensions, SSL products, presets).

All of this happens through audited, AAL2-gated functions.

### Security model
1. **Admin authorisation is checked in SQL on every request.** `admin_session` checks identity, and `admin_tier` / `admin_gate` check per-action rules. This happens on every page request (proxy), every render (layout and query entry), every action (middleware), and inside every wrapper and `admin_note`.
2. **All writes go through `admin_*` SECURITY DEFINER wrappers called with the session client.** No admin web code writes a table, and `adminDb` exposes select only. CI enforces this (§8).
3. **Reads follow D4.** Personal data is masked in lists and masked views. It is revealed only through audited, rate-limited SQL functions.
4. **Audit.** Every admin write, reveal, search and live read writes append-only rows to `admin_audit_log`.
   - **Recorded:** business refusals; tier refusals by an enrolled admin (`ROLE`, `NEEDS_CODE`, `HELD`, `TEST_ADMIN`, `RATE_LIMITED`); gateway intents and their results.
   - **Not recorded:** identity failures (`not_admin`, an expired or `aal1` session, `factor_mismatch`, `weak_sign_in`). These raise before the actor is known to be an admin, so strangers cannot fill the log.

### Rules this touches
- **N1.** The web never calls `api.domainresellerapi.com`. CI greps `apps/web/src` for `domainresellerapi.com`, `X-API-KEY` and `__reseller`.
- **N3.** An admin retry is only `retry_job` / `retry_ssl_job`.
- **N5.** Kobo and integer cents everywhere. Format with `formatNaira()` and `formatUsd(cents)`. USD becomes cents at the gateway edge (`usdToCents`) or in SQL.
- **N5b.**
  - Pricing inputs change only through audited wrappers.
  - After any change to FX, pricing, extensions or SSL products, call `revalidateTag('pricing', { expire: 0 })`.
  - **After any preset publish, hide or show, call `revalidateTag('nameserver-presets', { expire: 0 })`.**
- **N7.** RLS on every new table. The audit log, ledger mirror, revisions, top-up log, cost log and admin change log are append-only by trigger.
- **N10.** Supplier codes are mapped through `mapSupplierError()`. No raw contact data.
- **N11.** A preset goes live only from a checked, published draft with an allowlisted primary source (D21).
- **N12.** E2E uses the mock gateway with `/v1/admin/*` handlers.
- **N13.**
  - Audit rows, web logs and gateway logs carry ids, labels, statuses and amounts.
  - **Web and gateway logs carry route templates (`admin/supplier/domains/:name`), never a domain name.**
  - Reasons are typed under the hint "Don't include personal details", and **the owner can redact them** (§2.5).
  - **Session ids are stored as a SHA-256 hash.** IPs are never stored.
  - Customer search is a **POST action, never `?q=`**.
- **N14.** No admin control blocks a transfer-out. Failing a pending **unlock** is refused (`TRANSFER_OUT_PROTECTED`).

### Read vs act
- **Read:** viewing pages, filtering and paging.
- **Act:** a server action through `adminAction` (standard tier) or `adminMoneyAction` (money tier, with a code in the dialog). Each maps to one `admin_*` wrapper, or to one `admin_note` followed by one gateway call.

---

## 2. Auth design

### 2.1 The admins table and its change log (migration 40)
```sql
create table public.admins (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  label          text not null unique check (label ~ '^[a-z][a-z0-9_-]{1,30}$'), -- used as p_by; never an email
  role           text not null check (role in ('owner', 'operator', 'viewer')),
  mfa_factor_ids uuid[] not null check (cardinality(mfa_factor_ids) between 1 and 5), -- every pinned TOTP factor
  test_only      boolean not null default false,
  added_by       text not null check (char_length(trim(added_by)) > 0),
  added_at       timestamptz not null default now(),
  revoked_at     timestamptz,
  constraint admins_test_not_owner check (not (test_only and role = 'owner'))
);
alter table public.admins enable row level security;            -- no policies
revoke all on public.admins from public, anon, authenticated, service_role;

create table public.admin_changes (                              -- written only by the trigger below
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  op text not null check (op in ('INSERT', 'UPDATE', 'DELETE')),
  label text not null, role text, test_only boolean not null,
  was_test_only boolean,                                         -- the row before an update or delete; null on insert
  e2e_user boolean not null,                                     -- the user is an e2e-*@example.com reserved address
  factor_count integer, revoked boolean not null,
  db_user text not null default current_user
);
alter table public.admin_changes enable row level security;
revoke all on public.admin_changes from public, anon, authenticated, service_role;
```
- **`admins_factor_is_theirs`** (BEFORE INSERT OR UPDATE): raises unless each element of `mfa_factor_ids` is a `verified` `totp` factor of `user_id`.
- **`admins_log_change`** (AFTER INSERT OR UPDATE OR DELETE): writes one `admin_changes` row. It holds the label, role, flags and factor count, and **never the factor ids or an email**. A trigger on `admin_changes` refuses update, delete and truncate.
- **Alert.** `admin_alert_conditions` raises `admin_changed:<id>` (critical, 24 h) for every change that touches a non-test row **before or after** (`was_test_only`), and for any insert or update of a test row whose user is not an e2e user. Only removing or revoking an e2e user's test admin is quiet. A standing test admin for anyone else also raises `admin_test_not_e2e:<label>` (critical) for as long as it exists. A mint, re-pin, role change or flip to test-only by anyone with SQL access therefore reaches Telegram — a test admin can read test-side contacts, so minting one must be seen too. *(Package A review, 3 Oct 2026.)*
- **Roles:**
  - `viewer` reads everything except personal data.
  - `operator` also works refunds, jobs, incidents, emails, deep syncs, preset hiding, live lookups, customer search and reveal.
  - `owner` also changes pricing inputs, FX, limits, extensions, SSL products, presets, the catalogue and top-up records; cancels refunds; and redacts reasons.

### 2.2 The gate: `admin_session`, `admin_tier`, `admin_gate` (internal); `admin_status`, `admin_whoami` (granted to `authenticated`)
```sql
create function public.admin_session(p_min_role text default 'viewer',
                                     p_fresh_minutes integer default null,
                                     p_check_hold boolean default false)
returns public.admins language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid     uuid := auth.uid();
  v_claims  jsonb := coalesce(auth.jwt(), '{}'::jsonb);
  v_amr     jsonb := case when jsonb_typeof(coalesce(auth.jwt(), '{}'::jsonb)->'amr') = 'array'
                          then auth.jwt()->'amr' else '[]'::jsonb end;
  v_admin   public.admins;
  v_sid     uuid;
  v_factor  uuid;
  v_totp_at timestamptz;
begin
  if v_uid is null then raise exception using errcode = '42501', message = 'admin:not_admin'; end if;
  select * into v_admin from public.admins where user_id = v_uid and revoked_at is null;
  if not found then raise exception using errcode = '42501', message = 'admin:not_admin'; end if;
  if (case v_admin.role when 'owner' then 3 when 'operator' then 2 else 1 end)
     < (case coalesce(p_min_role, 'owner') when 'viewer' then 1 when 'operator' then 2 when 'owner' then 3 else 99 end) then
    raise exception using errcode = '42501', message = 'admin:role';
  end if;
  if coalesce(v_claims->>'aal', '') <> 'aal2' then
    raise exception using errcode = '42501', message = 'admin:needs_code';
  end if;
  begin v_sid := (v_claims->>'session_id')::uuid; exception when others then v_sid := null; end;
  select s.factor_id into v_factor from auth.sessions s
   where s.id = v_sid and s.user_id = v_uid and s.aal = 'aal2'
     and (s.not_after is null or s.not_after > now());
  if not found then raise exception using errcode = '42501', message = 'admin:needs_code'; end if;
  if v_factor is null or not (v_factor = any (v_admin.mfa_factor_ids))
     or not exists (select 1 from auth.mfa_factors f where f.id = v_factor and f.user_id = v_uid
                      and f.status = 'verified' and f.factor_type = 'totp') then
    raise exception using errcode = '42501', message = 'admin:factor_mismatch';
  end if;
  if not exists (select 1 from jsonb_array_elements(v_amr) e where e->>'method' in ('password', 'oauth')) then
    raise exception using errcode = '42501', message = 'admin:weak_sign_in';
  end if;
  select to_timestamp(max((e->>'timestamp')::double precision)) into v_totp_at
    from jsonb_array_elements(v_amr) e where e->>'method' = 'totp';
  if v_totp_at is null or v_totp_at < now() - make_interval(mins => coalesce(p_fresh_minutes, 720)) then
    raise exception using errcode = '42501', message = 'admin:needs_code';
  end if;
  if coalesce(p_check_hold, false) and exists (select 1 from public.profiles p where p.id = v_uid
       and p.password_reset_at > now() - interval '24 hours') then
    raise exception using errcode = '42501', message = 'admin:held';
  end if;
  return v_admin;
end $$;
```

**`admin_tier(p_action text, out min_role text, out money boolean, out test_rule text)`** is IMMUTABLE and holds the only copy of the action map. `test_rule` takes one of three values:
- `test_target`: a test admin may act only on a `test_mode` target or on the test side.
- `reserved_target`: a test admin may act only on an e2e user's profile (`admin_e2e_email()`: `e2e-*@example.com`, the rule `grant_test_admin` and every test helper use) — and, for a domain or an email, only on a test-mode one whose owner's `profiles.email` is an e2e user's (for an email, its `to_email` too). A real customer's test order carries their real details, and a reserved address (any `example.com`, `.test`) is not enough: anyone can sign up with one and type their real name beside it. *(Package A review, 3 Oct 2026: `email.requeue` and `domain.reveal_contacts` moved here from `test_target`; the e2e rule replaced "reserved email".)*
- `never`: a test admin is always refused.

| Action | Role | Tier | Test admin |
|---|---|---|---|
| `refund.approve`, `refund.retry`, `refund.record_manual` | operator (owner when the refund is `cancelled`) | money | test_target |
| `refund.cancel` | owner | money | never |
| `refund.flw_check` | operator | standard | test_target |
| `incident.resolve` (kinds where nothing is owed) | operator | standard | test_target |
| `incident.resolve_money` (`unrecorded_payment`, `refund_not_created`, `currency_mismatch`, `mode_mismatch`) | operator (owner for `handled_outside`) | money | test_target |
| `job.retry`, `job.fail`, `ssl_job.retry`, `ssl_job.fail` | operator | money | test_target |
| `domain.deep_sync` | operator | standard | test_target |
| `email.requeue`, `domain.reveal_contacts` | operator | standard | reserved_target |
| `customer.search`, `customer.reveal` | operator | standard | reserved_target |
| `fx.activate`, `fx.reject`, `pricing.update`, `settings.update`, `settings.refund_limit_raise`, `extension.flags`, `ssl_product.sellable` | owner | money | never |
| `preset.draft_save`, `preset.publish`, `preset.show` | owner | money | never |
| `preset.draft_check`, `preset.draft_discard` | owner | standard | never |
| `preset.hide` | operator | standard | never |
| `topup.record`, `topup.correct`, `audit.redact` | owner | money | never |
| `supplier.balance`, `supplier.ledger_live` | viewer | standard | test_target |
| `supplier.domain_lookup`, `supplier.domains_page`, `supplier.verification`, `supplier.ssl_lookup`, `supplier.transfer_query`, `supplier.renew_check` | operator | standard | test_target |
| `supplier.price_check`, `supplier.catalogue_preview`, `supplier.ssl_catalogue_preview` | owner (price check: operator) | standard | never |
| `supplier.catalogue_apply`, `supplier.ssl_catalogue_apply` | owner | money | never |

**Tier constants:**
- Standard tier: a code within 720 minutes (`ADMIN_SESSION_MAX_AGE_MINUTES`).
- Money tier: a code within 5 minutes (`MONEY_CODE_MAX_AGE_MINUTES`), plus the 24 h reset-hold check.

**`admin_gate(p_admin admins, p_action text, p_target_ok_for_test boolean) returns text`** returns the first refusal code, or null:
1. `UNKNOWN_ACTION`.
2. `TEST_ADMIN` for an action whose test rule is `never`, whatever the role.
3. `ROLE`.
4. `NEEDS_CODE`: a money action whose `amr` totp is older than 5 min.
5. `HELD`.
6. `TEST_ADMIN` for a target the test rule refuses (`test_target`, `reserved_target`).

*Amended in the Package A review (3 Oct 2026; owner to acknowledge):* the build checks a test admin's `never` actions before the role, so a test operator asking for an owner action (settings, prices) is told `TEST_ADMIN` — the true reason — rather than `ROLE`. §3.3 check 11 relies on this order.

Wrappers call `admin_session('viewer')` for identity, which raises without an audit row. They then call `admin_gate`, whose refusals **are** recorded.

**`admin_status()` returns text.** It is SECURITY DEFINER and STABLE, granted to `authenticated`.
- It returns `'ok'`, `'needs_code'`, `'factor_mismatch'` or `'weak_sign_in'`.
- Anything else returns `'not_admin'`.

**`admin_whoami(p_fresh_minutes integer default null)` returns jsonb**, granted to `authenticated`.
- It contains `{userId, label, role, testOnly, sessionHash, factorId, codeAt}`, or the call raises the `admin:*` code.
- `factorId` is the session's factor; `adminMoneyAction` verifies the dialog code against it.

### 2.3 Server-side checks (web)
**`apps/web/src/proxy.ts`** (Package A):
- Remove `'/admin'` from `PROTECTED`. Add an `ADMIN` branch before the generic branches:
  1. No user, an `rpc('admin_status')` error, or `'not_admin'`: the request goes on marked with `x-mdh-stranger: 1` (`features/admin/lib/door.ts`), and `next.config.ts`'s `beforeFiles` rewrite sends a marked `/admin` or `/admin/(.*)` request to `/__not-found`, a path no page answers, so Next renders its own 404. Its `fallback` rewrite sends every other path no page answers (bar `/_next/`) to the same place, so an RSC request is told `x-nextjs-rewritten-path: /__not-found` by any 404, not only by `/admin`'s. The answer gets the site's CSP — from the proxy, which Next writes after the config's headers, so `next.config.ts` lists its CSP rule last — and none of the headers below. Not `NextResponse.rewrite`: a proxy rewrite answers with `x-middleware-rewrite: <destination>`, which no other 404 carries (D9). The proxy strips a mark the browser sent from every other `/admin` request. The rewrite's `has` names the value `'1'`, and its sources use unnamed groups, so it captures nothing into the page's query (`/admin/:path*` put `?path=refunds` in the payload).
  2. `'needs_code'`: redirect to `/verify?next=<path+search>`.
  3. `'factor_mismatch' | 'weak_sign_in' | 'ok'`: continue.
- **`SIGNED_OUT_ONLY` change:** a signed-in user at `/sign-in` whose `next` passes `safeNext()` and starts with `/admin` is redirected to that `next`. Every other signed-in user still goes to `/app/domains`.
- **Headers on every `/admin` response to someone SQL knows as an admin** (steps 2 and 3; a stranger's 404 gets the site's own, D9):
  - `X-Robots-Tag: noindex, nofollow`
  - `Cache-Control: private, no-store`
  - **A nonce CSP:** `script-src 'self' 'nonce-<n>' 'strict-dynamic'` (no `'unsafe-inline'`), `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`. The nonce is also set on the request header so Next stamps its scripts. `next.config.ts`'s global CSP `source` pattern excludes `/admin`.
- Server-action POSTs to `/admin/*` pass through the same branch. Actions check again.
- **Matchers.** The proxy's general matcher skips paths ending in an image extension (`.png`, `.svg`, …), which would also skip `/admin/orders/x.png`. `config.matcher` therefore lists `'/admin'` and `'/admin/:path*'` on their own (matchers are OR'd), so every `/admin` path gets the gate and the headers. `next.config.ts` writes the site CSP's name lower-case, as the proxy's `Headers` does, so the two 404s match on HTTP/1.1 too.
- **The layout as a second layer.** `app/(admin)/admin/layout.tsx` awaits `assertAdminArea()` (`adminSessionStatus()`, once per request) and calls `notFound()` for `not_admin` before it renders the sidebar or anything with admin words, and its `generateMetadata` gives a stranger no admin title. Should the proxy ever not run for a path, or its mark not reach the rewrite, a stranger still sees the plain not-found page; only the rewrite can make the status 404, because the page's static shell has gone out first (CLAUDE.md §15, "A streamed page cannot change its status code").

**`features/admin/queries/session.ts`** (`import 'server-only'`):
```ts
export type AdminRole = 'owner' | 'operator' | 'viewer'
export type AdminSide = 'live' | 'test'
export type AdminPrincipal = Readonly<{
  userId: string; label: string; role: AdminRole; testOnly: boolean; sessionHash: string; factorId: string; codeAt: string
}> & { readonly [ADMIN_BRAND]: true }
export const requireAdmin: () => Promise<AdminPrincipal>                 // React cache()
export function adminDb(admin: AdminPrincipal, side: AdminSide): AdminDb  // select-only, side-filtered
export async function getAdminSide(admin: AdminPrincipal): Promise<AdminSide>  // test_only → always 'test'
export async function adminSessionStatus(): Promise<'ok' | 'needs_code' | 'factor_mismatch' | 'weak_sign_in' | 'not_admin'>
```

**`adminDb(admin, side)`** throws unless `admin` is in the module WeakSet of issued principals. It returns an `AdminDb` whose only method is `from(name).select(columns, opts)`:
- **Allowed names.** `name` must be a key of `ADMIN_TABLES`, a fixed map in `session.ts`. Insert, update, delete, upsert and rpc do not exist on the type.
- **Named columns only.** `columns` is plain column names, plus at most one embed of the table's own side parent by plain names (`orders(order_number)` on `order_items`). Any other embed — the service key would follow `orders.user_id` or `refunds.user_id` to `profiles`, or `orders.contact_profile_id` to `contact_profiles` — and any alias, cast, spread, JSON path or `*` throws, as does a name in `PRIVATE_COLUMNS` (the §8.1 list plus `email`, `phone`, `full_name`, `business_name`, `tax_id`, `contact_profile_id`; `key` on `ops_alerts` only). The builder refuses a second `select()`, which would replace the checked columns.
- **The builder handed back is read-only** *(Package A review, 3 Oct 2026)*. Its `url`, `method` and `headers` are plain properties on PostgREST's builder, and the service key passes RLS, so code holding it could turn the read into a `DELETE` or drop the side filter. The proxy reads every property but the filter, order and paging methods (and `then`) as undefined, refuses any other method (`setHeader`, `csv`, `explain`, …), and throws on set, define, delete and `setPrototypeOf`. Every filter and order column — including an embedded path (`admin_side.registrant->>email` reads the parent table) and a JSON path, each key of `match()` and each condition of `or()` — is checked against `PRIVATE_COLUMNS` like the select.
- **Side filter.** Each entry names how the side is applied, and `select` applies it before returning the builder:
  - `test_mode` → `.eq('test_mode', side === 'test')`
  - `environment` (`supplier_calls`) → `'ote' | 'production'`
  - `parent` → an `!inner` embed of the parent's `test_mode`:
    - `order_items`, `refund_events` → `orders` / `refunds`
    - `domain_events`, `domain_nameserver_history` → `domains`
    - `order_item_costs` → `order_items` → `orders`
  - `test_actor` (`admin_audit_log`) → `.eq('test_actor', true)` for a test admin; no filter otherwise.
  - `live_only` (`float_topups`, which records live top-ups only) → no filter on the live side; nothing on the test side.
  - `global` → no filter.
- **`global` entries:** `tlds`, `ssl_products`, `nameserver_presets`, `nameserver_preset_drafts`, `fx_rates`, `pricing_settings`, `ops_settings`, `service_heartbeats`, `reconcile_runs`, `registry_drift`, `ops_alerts`. The last three carry `test_mode` and use it.
- **`test_mode` entries:** `admin_orders_v`, `refunds`, `payment_incidents`, `jobs`, `ssl_jobs`, `registry_drift`, `reconcile_runs`, `ops_alerts`, `supplier_ledger_entries`, `supplier_ledger_revisions`, `supplier_balance_snapshots`, `metrics_daily`, `funnel_daily`, and the masked views `admin_payments_v`, `admin_domains_v`, `admin_ssl_certificates_v`, `admin_email_outbox_v`, `admin_compliance_notices_v`.
- *Amended in the Package A review (3 Oct 2026; owner to acknowledge):* the map holds the tables the B packages read beyond the v2 list — `payment_incidents`, `supplier_balance_snapshots`, `metrics_daily`, `funnel_daily`, `supplier_ledger_entries`, `supplier_ledger_revisions`, `float_topups` (with the `live_only` rule) — and reads orders through `admin_orders_v`, never `orders`. `boundaries.test.ts` pins this list.
- **Test admins.** For a `test_only` principal, `side` is forced to `'test'`. Every entry must have a side filter or be marked `publicSafe`; others throw `TEST_ADMIN`. Only `tlds`, `ssl_products`, `nameserver_presets`, `fx_rates` and `pricing_settings` are `publicSafe`, because the storefront already shows them.
- **Never in the map:** `orders`, `profiles`, `contact_profiles`, `payments`, `email_outbox`, `compliance_notices`, `ssl_certificates`, `domains`, `transfer_secrets`, `admins`, `admin_changes`. Rows from these come through the masked views (§3.2i) or `admin_*` functions.

**`requireAdmin()`:**
1. Calls `createClient()` and `getUser()`. Without a user it calls `notFound()`.
2. Calls `rpc('admin_whoami', { p_fresh_minutes: null })`.
3. Maps the outcome: `needs_code` → `redirect('/verify?next=/admin')`; any other error → `notFound()`.
4. Builds and registers the branded principal.

The service client comes **only** from `adminDb()`. CI forbids importing `@/lib/supabase/service|admin` under `features/admin/**` (except `queries/session.ts`) and under `app/(admin)/**`.

**Layout:** `app/(admin)/admin/layout.tsx`.
- Its metadata is `{ robots: PRIVATE, title: { template: '%s · Admin', default: 'Admin' } }`.
- The shell copies `(app)`: the sidebar in Suspense, then `main#main`, then `<Suspense fallback={<AdminPageSkeleton/>}><AdminGate>{children}</AdminGate></Suspense>`.
- `AdminGate` calls `adminSessionStatus()`:
  - `ok`: renders `SideBanner` and `children`.
  - `factor_mismatch`: "This sign-in used an authenticator that isn't linked to your admin access. Use a linked device, or ask the owner to re-link your devices in the database (DEPLOY.md §6b)."
  - `weak_sign_in`: "The admin area needs a sign-in with your password or Google. Sign out, sign in again, then enter your code." It shows a sign-out button.
  - Anything else: `notFound()`.
- Every page also calls `requireAdmin()` inside its own Suspense.
- `app/(admin)/admin/error.tsx` keeps the shell and offers "Try again" and a link to `/admin`.

**Admin entry link.** `components/layout/app-sidebar.tsx` calls `rpc('admin_status')` and adds "Admin" to the AccountMenu when the answer is not `'not_admin'`. No public page links to `/admin`, and `/admin` is not in robots.txt.

### 2.4 Action clients (`apps/web/src/lib/safe-action.ts`, Package A)
```ts
const adminBase = createSafeActionClient({
  defineMetadataSchema: () => z.object({ action: z.enum(ADMIN_ACTION_IDS) }),   // features/admin/lib/actions.ts
  handleServerError: /* identical to actionClient */,
}).use(/* identical requestId middleware; the id is a uuid */)

export const adminAction = adminBase.useValidated(async ({ next, metadata }) => {
  const tier = ADMIN_ACTIONS[metadata.action]            // mirrors admin_tier for early refusal and UI only
  if (tier.money) throw new Error('money action on adminAction')        // programming error
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new AppError('UNAUTHENTICATED', 'Please sign in to continue.')
  const { data, error } = await supabase.rpc('admin_whoami', { p_fresh_minutes: null })
  if (error) throw adminAccessError(error.message)
  const admin = toPrincipal(data)
  if (rank(admin.role) < rank(tier.minRole)) throw adminAccessError('admin:role')
  return next({ ctx: { user, db: supabase, admin, action: metadata.action } })
})

// Input must include { code: /^\d{6}$/ }. After validation: mfa.challengeAndVerify({ factorId: admin.factorId, code })
// on the session client (which sets the new session cookies), then admin_whoami(5), then the body.
export const adminMoneyAction = adminBase.useValidated(/* as above, plus the code step */)
```
- **Validation comes first.** `useValidated` runs after input validation, so no audit note, gateway call or target id comes from unvalidated input.
- **Roles are checked again in the database.** The web role check is for the message only; the wrapper's `admin_gate` and `admin_note` decide.
- **`adminAccessError()`** maps each code (from a raise or from a wrapper's JSON `code`) to an `AppError`:
  - `needs_code` / `NEEDS_CODE`: "Confirm it's you with the code from your authenticator app to continue."
  - `held` / `HELD`: `describeHold()`'s words without a time — "For your security, changes like this are paused for 24 hours after a password reset." *(Amended in the Package A review, 3 Oct 2026; owner to acknowledge:)* the gate knows the hold but not when it ends, and `admin_whoami` does not return `password_reset_at`; adding it later lets the words give the time.
  - `role` / `ROLE`: "Your admin role can't do this. Ask the owner."
  - `weak_sign_in`: "Sign in with your password or Google, then enter your code. A sign-in link can't open the admin area."
  - `factor_mismatch`: "This sign-in used an authenticator that isn't linked to your admin access."
  - `TEST_ADMIN`: "Test administrators can't do this on live records."
  - `RATE_LIMITED`: "You've looked up a lot of customers this hour. Wait, or ask the owner."
  - `not_admin`: "This needs an administrator."
  - A wrong dialog code: "That code didn't work. Check your authenticator app and try again." Only `mfa_verification_failed` and `mfa_challenge_expired` from `challengeAndVerify` are a wrong code. A rate limit (`over_request_rate_limit`, or status 429) is `CODE_RATE_LIMITED`: "Too many codes were tried just now, so nothing changed. Wait a minute, then enter a new code." Anything else there — a failed request, an Auth error it did not explain — is `CODE_NOT_CHECKED`: "We couldn't check your code just now, so nothing changed. Try again in a moment." None reached a wrapper, so each is a refusal with nothing changed, never an unknown outcome. `adminMoneyAction` throws when built for an action whose tier is not money, as `adminAction` does for one that is. *(Package A review, 3 Oct 2026.)*
- **The result contract for every admin action:** `{ ok: true; auditId: number; after?: Record<string, unknown>; replayed?: true } | { ok: false; code: string; message: string; auditId?: number }`. `message` comes from `features/admin/lib/errors.ts`. A raw `sqlerrm` is never shown.
- **Gateway-backed actions** call `rpc('admin_note', …)` in the action body after validation. They refuse when the note is refused, then call the gateway with the note's id.

### 2.5 The audit log (migration 40)
```sql
create table public.admin_audit_log (
  id               bigint generated always as identity primary key,
  created_at       timestamptz not null default now(),
  admin_id         uuid not null,              -- no FK: the record outlives the account
  admin_label      text not null,
  admin_role       text not null,
  test_actor       boolean not null,
  session_hash     text,                       -- sha256 of the JWT session_id, hex; never the id, never an IP
  action           text not null check (action ~ '^[a-z_]+\.[a-z_]+$'),
  side             text check (side in ('live', 'test', 'global')),
  target_type      text check (char_length(target_type) <= 40),
  target_id        text check (char_length(target_id) <= 200),
  target_test_mode boolean,
  reason           text check (char_length(reason) <= 500),
  redacted_at      timestamptz,
  outcome          text not null check (outcome in ('intent', 'ok', 'refused', 'failed')),
  error_code       text check (char_length(error_code) <= 60),
  error            text check (char_length(error) <= 300),
  detail           jsonb not null default '{}' check (pg_column_size(detail) <= 4096),
  parent_id        bigint,                     -- a gateway result points at its intent note (no FK; purged together)
  request_key      uuid,
  request_id       uuid                        -- only a well-formed uuid from x-request-id, else null
);
create unique index admin_audit_log_request_key_ok on public.admin_audit_log (request_key)
  where request_key is not null and outcome = 'ok';            -- a refusal frees its key
create unique index admin_audit_log_one_result on public.admin_audit_log (parent_id) where parent_id is not null;
create index admin_audit_log_created on public.admin_audit_log (created_at desc);
create index admin_audit_log_target  on public.admin_audit_log (target_type, target_id);
create index admin_audit_log_actor   on public.admin_audit_log (admin_id, action, created_at desc);
alter table public.admin_audit_log enable row level security;
revoke all on public.admin_audit_log from public, anon, authenticated, service_role;
grant select on public.admin_audit_log to service_role;          -- read via adminDb only

create table public.admin_note_claims (audit_id bigint primary key, claimed_at timestamptz not null default now());
alter table public.admin_note_claims enable row level security;
revoke all on public.admin_note_claims from public, anon, authenticated, service_role;
```
**Trigger `admin_audit_is_final()`** (BEFORE UPDATE OR DELETE, per row):
- `UPDATE` is allowed only when `current_setting('app.admin_redact', true) = old.id::text`, `new.reason is null`, `new.redacted_at is not null`, and every other column is unchanged.
- `DELETE` is allowed only when `old.test_actor and old.created_at < now() - interval '30 days'`.
- Anything else raises "the admin audit log is never rewritten".
- A BEFORE TRUNCATE statement trigger always raises.
- No API role has update or delete. A leaked key therefore cannot erase anything, and nobody can erase recent test rows either.

**Internal helpers** (revoked from every API role):
- **`admin_replay(p_request_key uuid, p_admin_id uuid, p_action text, p_target_id text) returns jsonb`**:
  - It raises `admin:request_key` when the key is null.
  - It takes `pg_advisory_xact_lock(hashtextextended(p_request_key::text, 7))`.
  - It looks only at the `outcome = 'ok'` row with that key. If that row's `admin_id`, `action` or `target_id` differs, it raises `admin:request_key_mismatch`.
  - If they match, it returns `{ok:true, auditId, after: detail->'after', replayed:true}`; otherwise null.
- **`admin_record(p_admin public.admins, p_action, p_side, p_target_type, p_target_id, p_target_test_mode, p_reason, p_request_key, p_outcome, p_code, p_error, p_detail, p_parent_id default null) returns jsonb`**:
  - It inserts one row. `session_hash` is `encode(sha256(convert_to(auth.jwt()->>'session_id','UTF8')),'hex')`.
  - `request_id` is the `x-request-id` header only when it matches the uuid pattern.
  - It returns `{ok, auditId, code, message: null, after}`.
  - **A test admin's refusal on anything but a test-mode target is stored with `detail = '{}'`** (always for `TEST_ADMIN`). A test admin reads its own rows (`adminDb`'s `test_actor` rule), and wrappers read the target's facts before the gate, so otherwise a refusal on a live id would store that refund's amount and limits, an incident's kind and order, or a job's kind for the test admin to read. *(Package A review, 3 Oct 2026.)*
- **`admin_reason_problem(p_reason text) returns text`**: `'REASON'` unless the trimmed reason is 10–500 characters, else null.
- **`admin_mask_email(text) returns text`**: `left(local, 1) || '•••@' || domain`. This is the format `maskEmail()` in `format.ts` uses. Granted to `service_role`, because the masked views call it as the invoker.

**`admin_note(p_action text, p_side text, p_target_type text, p_target_id text, p_detail jsonb default '{}', p_reason text default null, p_request_key uuid default null) returns jsonb`**, granted to `authenticated`:
1. Asserts identity with `admin_session('viewer')`.
2. Requires `p_action` to be a `supplier.*`, `refund.flw_check` or `preset.draft_check` action in `admin_tier`, and `p_side` to be `live`, `test` or `global`.
3. Runs `admin_gate`:
   - For `test_target`, a test admin may note only `p_side = 'test'`.
   - Actions whose rule is `never` refuse a test admin.
4. Records a refusal as `refused` and returns `{ok:false, code}`.
5. Otherwise writes an **`intent`** row and returns `{ok:true, auditId}`.

There are **no role or freshness parameters**.

**`admin_claim_note(p_audit_id bigint, p_action text, p_label text, p_side text, p_target_id text) returns jsonb`**, `service_role` (the gateway). In one transaction it checks:
- The row exists and `outcome = 'intent'`.
- `action = p_action`, `admin_label = p_label`, `side = p_side`, and `target_id is not distinct from p_target_id`.
- `created_at > now() - interval '60 seconds'`.
- Not `test_actor` when `p_side` is `live` or `global`.

It inserts into `admin_note_claims`; a conflict returns `USED`. It returns `{ok, auditId, testActor, detail}` — the note's own `detail`, so a route acts on what the admin noted, never on its query string — or `{ok:false, code}` with one of: `NOT_FOUND`, `NOT_INTENT`, `ACTION_MISMATCH`, `LABEL_MISMATCH`, `TARGET_MISMATCH`, `SIDE_MISMATCH`, `EXPIRED`, `USED`, `TEST_ADMIN`, `REVOKED` (the admin was revoked after writing the note).

**`admin_note_result(p_audit_id bigint, p_outcome text, p_code text, p_detail jsonb) returns bigint`**, `service_role`:
- It requires a claim for `p_audit_id`.
- It inserts the result row: the parent's admin fields, `outcome in ('ok','refused','failed')`, and `parent_id = p_audit_id`. There is at most one result per note.

**`admin_redact_reason(p_audit_id bigint, p_why text, p_request_key uuid) returns jsonb`** (`audit.redact`, owner, money):
- It sets `app.admin_redact`, nulls `reason`, and stamps `redacted_at`.
- It records its own audit row, whose `p_why` follows the same rules.
- It never touches `detail`.

**`purge_test_admin_audit() returns integer`** has **no grant**. Cron job `admin-audit-purge` (`'47 3 * * *'`) runs it as `postgres`. It deletes `test_actor` rows older than 30 days and their claims.

### 2.6 Enrolling the owner (operator one-off; never in a migration or in git)
This goes in `docs/DEPLOY.md` §6b "Admin access". It runs in the Supabase SQL editor after migration 40, once the owner has turned on two-factor on every device they will use:
```sql
-- 1. List the owner's verified authenticators: one row per device. Type the email here only.
select f.id as factor_id, f.friendly_name, f.created_at
  from auth.users u join auth.mfa_factors f on f.user_id = u.id
 where u.email = 'OWNER_EMAIL' and f.factor_type = 'totp' and f.status = 'verified';

-- 2. Enrol, pinning every verified authenticator (a backup device included).
insert into public.admins (user_id, label, role, mfa_factor_ids, added_by)
select u.id, 'owner', 'owner',
       (select array_agg(f.id order by f.created_at) from auth.mfa_factors f
         where f.user_id = u.id and f.factor_type = 'totp' and f.status = 'verified'),
       'sql-editor'
  from auth.users u where u.email = 'OWNER_EMAIL';

-- After adding, removing or replacing a device: re-pin every verified authenticator.
update public.admins a
   set mfa_factor_ids = (select array_agg(f.id order by f.created_at) from auth.mfa_factors f
                          where f.user_id = a.user_id and f.factor_type = 'totp' and f.status = 'verified')
 where a.label = 'owner';
-- Adding an operator: same insert with role 'operator' and their own label. Removing anyone:
update public.admins set revoked_at = now() where label = '<label>';
```
Each statement raises an `admin_changed` Telegram alert. That alert is how the owner knows that nobody else made a change.

### 2.7 The e2e admin user and test-only helpers
- **`grant_test_admin(p_user_id uuid) returns text`** (SECURITY DEFINER, `service_role`). It refuses unless:
  - `admin_e2e_email(auth.users.email)`: it matches `^e2e-[^@]+@example\.com$` and `is_reserved_email()` is true (the one rule a test admin's customer reads and every test helper share);
  - the user has at least one verified TOTP factor;
  - the user has no `admins` row with `test_only = false`.

  It then inserts `(label 'e2e-'||left(p_user_id::text,8), role 'operator', test_only true, mfa_factor_ids = every verified factor, added_by 'e2e')`. An e2e user's test rows are logged in `admin_changes` but raise no alert; a test row for anyone else does (§2.1).
- `tests/e2e/support/accounts.mjs` gains `createAdminTestUser(label)`: `createTestUser` → `enableTotp` → `rpc('grant_test_admin')`. It returns `{ user, totpSecret, label }`. Deleting the user cascades to the `admins` row. Audit rows age out through the cron purge, and **teardown purges nothing from the audit log**.
- Test-only helpers in migration 41 (§3.2j), each `service_role` and each refusing anything not tied to an `e2e-*@example.com` user or a `test_mode` row:
  - `seed_test_failed_email(p_user_id)`
  - `hold_test_refund(p_refund_id)`
  - `purge_test_ledger_entries()`

---

## 3. Database changes

Two migrations, both owned by Package A. After each one, the builder:
1. applies it to the hosted project;
2. runs `pnpm db:types` (or `supabase gen types typescript --linked`) and commits `packages/db/src/database.types.ts`;
3. runs `notify pgrst, 'reload schema'` if needed.

### 3.0 Grants: one rule, checked
**Rule.** Every function and view in migrations 40 and 41 ends with `revoke all on function <name>(<args>) from public, anon, authenticated, service_role;` (`revoke all on <view> from …` for views). It is then followed by **at most one** grant, as listed. Migration 15 uses this pattern. Supabase's default privileges would otherwise make every one of them callable with the public anon key.

| Grant | Functions and views |
|---|---|
| **none** (definer-internal, triggers, or `pg_cron` as `postgres`) | `admin_session`, `admin_tier`, `admin_gate`, `admin_replay`, `admin_record`, `admin_reason_problem`, `purge_test_admin_audit`, `match_supplier_ledger`, `ledger_alert_conditions`, `admin_alert_conditions`, `cron_alert_conditions`, `record_metrics_daily`, the trigger functions `admins_factor_is_theirs`, `admins_log_change`, `admin_changes_final`, `admin_audit_is_final`, `supplier_ledger_is_final`, `append_only_final`, `order_item_costs_final` |
| **`authenticated`** | `admin_status`, `admin_whoami`, `admin_note`, `admin_redact_reason`, every write wrapper in §3.1.2, `admin_record_float_topup`, `admin_correct_float_topup`, `admin_find_customers`, `admin_reveal_customer`, `admin_reveal_registrant`, every read function in §3.2h |
| **`service_role`** | `admin_claim_note`, `admin_note_result`, `grant_test_admin`, `record_flw_refund_check`, `preset_drafts_for_check`, `record_preset_draft_check`, `record_supplier_ledger`, `bump_funnel`, `admin_mask_email`, `seed_test_failed_email`, `hold_test_refund`, `purge_test_ledger_entries`; **select only** on the views `admin_payments_v`, `admin_email_outbox_v`, `admin_compliance_notices_v`, `admin_ssl_certificates_v`, `admin_domains_v`, `admin_orders_v` |
| unchanged (`postgres`, `service_role`) | `current_alert_conditions`, re-created in 41; `create or replace` keeps its ACL, and the check asserts it |

**Table privileges** (migration 40, item 8). Today RLS is the only thing preventing these writes. The admin wrappers now own these tables, so one permissive policy added later would open live pricing to the anon key.
```sql
revoke insert, update, delete, truncate on public.fx_rates, public.pricing_settings, public.tlds,
  public.ssl_products, public.nameserver_presets, public.market_references from anon, authenticated;
revoke truncate on all tables in schema public from anon, authenticated;  -- PostgREST never truncates
```
**Sequences.** Supabase's default privileges also give `anon` and `authenticated` every new sequence. Each migration revokes all on its identity sequences (`admin_changes_id_seq`, `admin_audit_log_id_seq`, `flw_refund_checks_id_seq`; `supplier_ledger_revisions_id_seq`, `float_topups_id_seq`) from them, and both ACL checks assert it with `has_sequence_privilege`.

`select` stays where a public policy needs it: `tlds`, `nameserver_presets`, `fx_rates`, `pricing_settings` and `market_references` keep their current read grant and policy. Nothing working is affected, because RLS refuses these writes today.

**ACL checks** (in both `admin.sql` and `admin_data.sql`):
```sql
do $$
declare
  v_expected jsonb := '{ "admin_status":"authenticated", "admin_session":"none", "admin_claim_note":"service_role", … }';
  r record; v_want text; n integer := 0;
begin
  for r in select p.oid, p.proname from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and (p.proname like 'admin\_%' or v_expected ? p.proname) loop
    v_want := v_expected->>r.proname;
    if v_want is null then raise exception 'function % has no expected grant', r.proname; end if;
    if has_function_privilege('anon', r.oid, 'execute') then raise exception '% is anon-executable', r.proname; end if;
    if has_function_privilege('authenticated', r.oid, 'execute') <> (v_want = 'authenticated')
       or has_function_privilege('service_role', r.oid, 'execute') <> (v_want = 'service_role') then
      raise exception '% has the wrong grants', r.proname;
    end if;
    n := n + 1;
  end loop;
  if n < (select count(*) from jsonb_object_keys(v_expected)) then raise exception 'an expected function is missing'; end if;
end $$;
```
The same file also asserts the following, each with `has_table_privilege`:
- every `admin_*_v` view refuses `anon` and `authenticated`;
- `order_item_costs` refuses `authenticated` select;
- `anon` and `authenticated` hold no insert, update, delete or truncate on the item-8 tables;
- `activate_fx_rate` is executable by `service_role` only.

### 3.1 `supabase/migrations/00000000000040_admin.sql`
Contents, in order:
1. `admins`, `admin_changes`, and the `admins_factor_is_theirs` / `admins_log_change` / `admin_changes_final` triggers (§2.1).
2. `admin_audit_log`, `admin_note_claims`, and their triggers (§2.5).
3. `admin_tier`, `admin_session`, `admin_gate`, `admin_status`, `admin_whoami` (§2.2).
4. `admin_replay`, `admin_record`, `admin_reason_problem`, `admin_mask_email`, `admin_note`, `admin_claim_note`, `admin_note_result`, `admin_redact_reason`, `purge_test_admin_audit` and its cron job (§2.5).
5. `grant_test_admin` (§2.7).
6. Supporting tables:
   - `flw_refund_checks`: id, created_at, test_mode, target_type (`refund` or `incident`), target_id, flw_refund_id, tx_id, amount_kobo, currency, status, disburse_status, state (`done`, `failed` or `pending`), audit_id. Append-only.
   - `record_flw_refund_check(…)`. It writes a row only for a `refund.flw_check` note claimed under 2 minutes ago on the same side, when `p_flw_refund_id` is the note's `target_id`, the refund or incident is the one the note's `detail` names (`refund_id` or `incident_id`, exactly one), and no check exists for that note yet (also a unique index on `audit_id`). Otherwise it raises `admin:not_claimed`, `admin:target_mismatch` or `admin:check_recorded`.
   - `nameserver_preset_sources(provider, host)`, seeded with `vercel.com`, `www.hostinger.com`, `truehost.com.ng`, `developers.cloudflare.com` and `docs.netlify.com`.
   - `nameserver_preset_drafts`: id, preset_id (null for new), provider, nameservers, source_url, notes, assigns_per_zone, saved_by, saved_at, check_ok, checked_at, check_detail, published_at, discarded_at.
   - `preset_drafts_for_check()` and `record_preset_draft_check(p_draft_id, p_ok, p_detail)`.

   All have RLS on and no policies. `flw_refund_checks` and `nameserver_preset_drafts` grant select to `service_role`.
7. The write wrappers (§3.1.1, §3.1.2). Each is `language plpgsql security definer set search_path = ''`, `returns jsonb`, and follows §3.0.
8. Grants housekeeping: `revoke execute on function public.activate_fx_rate(uuid, uuid) from public, anon, authenticated;` (`service_role` keeps it), plus the table privileges in §3.0.
9. **Changes to existing objects are only those in item 8 and §3.2g** (`current_alert_conditions`, re-created with two more branches). No other existing function's body or grants change.

#### 3.1.1 Wrapper template (written out once; every wrapper follows it)
```sql
create function public.admin_approve_refund(p_refund_id uuid, p_reason text, p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c_action constant text := 'refund.approve';
  v_admin  public.admins := public.admin_session('viewer', null, false);  -- identity: raises, not audited
  v_prior  jsonb;
  v_refund public.refunds;
  v_line   public.order_items;
  v_ops    public.ops_settings;
  v_code   text;
  v_detail jsonb;
begin
  v_prior := public.admin_replay(p_request_key, v_admin.user_id, c_action, p_refund_id::text);
  if v_prior is not null then return v_prior; end if;
  select * into v_refund from public.refunds where id = p_refund_id for update;
  if not found then
    return public.admin_record(v_admin, c_action, null, 'refund', p_refund_id::text, null, p_reason,
                               p_request_key, 'refused', 'NOT_FOUND', null, '{}');
  end if;
  select * into v_ops from public.ops_settings where id;
  v_detail := jsonb_build_object(
    'before', jsonb_build_object('status', v_refund.status, 'amount_kobo', v_refund.amount_kobo,
                                 'last_error_code', v_refund.last_error_code),
    'limits', jsonb_build_object('single_kobo', v_ops.auto_refund_max_kobo, 'daily_kobo', v_ops.auto_refund_daily_max_kobo));
  -- role, code freshness, hold and test-admin rule come from admin_tier(c_action); never from the caller
  v_code := coalesce(public.admin_gate(v_admin, c_action, v_refund.test_mode), public.admin_reason_problem(p_reason));
  if v_code is null and v_refund.status <> 'held' then v_code := 'NOT_HELD'; end if;
  if v_code is null and v_refund.order_item_id is not null then
    select * into v_line from public.order_items where id = v_refund.order_item_id for update;
    if coalesce(v_line.status::text, '') <> 'failed' then v_code := 'LINE_NOT_FAILED'; end if;
  end if;
  if v_code is not null then
    return public.admin_record(v_admin, c_action, case when v_refund.test_mode then 'test' else 'live' end,
                               'refund', p_refund_id::text, v_refund.test_mode, p_reason, p_request_key,
                               'refused', v_code, null, v_detail);
  end if;
  begin
    perform public.approve_refund(p_refund_id, v_admin.label);
  exception when others then
    return public.admin_record(v_admin, c_action, case when v_refund.test_mode then 'test' else 'live' end,
                               'refund', p_refund_id::text, v_refund.test_mode, p_reason, p_request_key,
                               'refused', 'REFUSED_BY_DATABASE', left(sqlerrm, 300), v_detail);
  end;
  return public.admin_record(v_admin, c_action, case when v_refund.test_mode then 'test' else 'live' end,
    'refund', p_refund_id::text, v_refund.test_mode, p_reason, p_request_key, 'ok', null, null,
    v_detail || jsonb_build_object('after', (select jsonb_build_object('status', status, 'approved_by', approved_by)
                                              from public.refunds where id = p_refund_id)));
end $$;
revoke all on function public.admin_approve_refund(uuid, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.admin_approve_refund(uuid, text, uuid) to authenticated;
```
- **Identity failures raise**, so no row is written for non-admins.
- **Gate refusals, business refusals and inner-function failures are recorded** as `refused` and returned as `{ok:false}`.
- **`p_by` is always `v_admin.label`.**
- **Every guard coalesces nullable inputs** (§15, "NULL never passes a money guard").

#### 3.1.2 The wrappers

The tier comes from `admin_tier` (§2.2). A `test_only` admin is refused `TEST_ADMIN` by its rule. Every wrapper takes `p_request_key uuid` last.

| Wrapper | Extra guards before the call (code on refusal) | Calls / does | `detail` |
|---|---|---|---|
| `admin_approve_refund(p_refund_id, p_reason, …)` | Status `held` (`NOT_HELD`). Line `failed` when `order_item_id` is set (`LINE_NOT_FAILED`). | `approve_refund(id, label)` | before/after status, amount, both limits |
| `admin_retry_refund(p_refund_id, p_checked_provider, p_reason, …)` | Status `failed`, `needs_attention` or `cancelled` (`NOT_RETRYABLE`). `cancelled` needs the owner (`OWNER_ONLY`). Line `failed` when set (`LINE_NOT_FAILED`). A `cancelled` refund whose latest `refund_events` row is the retry cancellation (`detail->>'why' in ('registration retried','certificate order retried')`) is refused (`LINE_RETRIED`). If `provider_called_at` or `provider_refund_id` is set, `p_checked_provider` must be true (`CHECK_PROVIDER`). | `retry_refund(id, label)` | + `bypasses_limits: true` |
| `admin_cancel_refund(p_refund_id, p_no_money_moved, p_checked_provider, p_note, …)` | Owner (tier). `p_no_money_moved` true (`CONFIRM_NO_MONEY`). Status `queued`, `held`, `failed` or `needs_attention` (`NOT_CANCELLABLE`). If `provider_called_at` or `provider_refund_id` is set, `p_checked_provider` must be true (`CHECK_PROVIDER`). `HAS_PROVIDER_REFUND` when `provider_refund_id` is set, unless `status = 'failed'` and `coalesce(last_error_code,'') = 'PROVIDER_REFUND_FAILED'`. | `cancel_refund(id, label, p_note)` | status, amount, code |
| `admin_record_manual_refund(p_refund_id, p_check_id, p_provider_refund_id, p_checked_provider, p_reason, …)` | Reference matches `^[A-Za-z0-9_-]{3,64}$` (`BAD_REFERENCE`). `cancelled` needs the owner. Line `failed` when set (`LINE_NOT_FAILED`). `CHECK_PROVIDER` as for cancel. **`FLW_NOT_VERIFIED`** unless `flw_refund_checks` row `p_check_id` has `target_type = 'refund'`, `target_id = p_refund_id`, `flw_refund_id = p_provider_refund_id`, `tx_id` = the refund's `payments.provider_reference`, `amount_kobo` = the refund's `amount_kobo`, `state = 'done'`, `test_mode` = the refund's, and `created_at > now() - 15 min`. | `record_manual_refund(id, ref, label)` | status, amount, ref, the check's facts |
| `admin_resolve_payment_incident(p_incident_id, p_outcome, p_refund_id, p_check_id, p_confirmed, p_reason, …)` | Unresolved (`ALREADY_RESOLVED`). For owed kinds (`unrecorded_payment`, `refund_not_created`, `currency_mismatch`, `mode_mismatch`), the action is `incident.resolve_money` and `p_outcome` is required (`OUTCOME_REQUIRED`):<br>• `payment_recorded` (unrecorded only): a payment on that order with `provider_reference` = the incident's.<br>• `refund_completed`: `p_refund_id` is a `completed` refund on that order.<br>• `flw_refund_verified`: check `p_check_id` for this incident's `provider_reference`, `state = 'done'`, under 15 min.<br>• `handled_outside`: owner and `p_confirmed`.<br>A failed condition gives `OUTCOME_NOT_MET`. Other kinds: `incident.resolve`, outcome `reviewed`. | `resolve_payment_incident(id, label)` | kind, order id, outcome, its evidence |
| `admin_retry_job(p_job_id, p_reason, …)` | Status `needs_attention` or `failed` (`NOT_RETRYABLE`). A failed `transfer_domain` gives `TRANSFER_CODE_GONE`. A failed register or renew whose line refund is `sending`, `submitted` or `completed`, or has `provider_refund_id`, gives `REFUND_AT_PROVIDER`. | `retry_job(id)`, then a re-read: `NOT_RETRIED` unless `queued` | kind, before/after, the line's refund status |
| `admin_retry_ssl_job(p_job_id, p_reason, …)` | Same, with the certificate line. | `retry_ssl_job(id)` | same |
| `admin_fail_job(p_job_id, p_reason, …)` | Status `needs_attention` (`NOT_NEEDS_ATTENTION`). **`last_error_code = 'PAYMENT_NOT_VERIFIED'` gives `PAYMENT_NOT_VERIFIED`.** `renew_domain` and `apply_nameservers` give `USE_RETRY`. `set_transfer_lock` while `domains.pending_transfer_lock = false` (an unlock) gives `TRANSFER_OUT_PROTECTED` (N14). Then by kind:<br>• `register_domain`: needs a `supplier_calls` row with the job's domain, the side's environment, `operation in ('GetDetails','AdminGetDetails')`, `outcome = 'not_found'`, `created_at > now() - 15 min`, **and `created_at` after the latest `RegisterWithContactInfo` call for that job** (`READ_REGISTRY_FIRST`). It also refuses (`LEDGER_SHOWS_CHARGE`) when `supplier_ledger_entries` on that side holds a debit with `product_type = 1` naming the domain (exact or `position()`) after the job's `created_at`.<br>• `transfer_domain`: needs an `AdminTransferQuery` call in the last 15 min, after the job's last `Transfer` call, with `outcome = 'ok'` and `message in ('rejected','cancelled')` (`READ_TRANSFER_FIRST`). | `fail_job(id, code, left(reason,500), false)`, where code is `NOT_AT_REGISTRY` (register), `TRANSFER_REFUSED` (transfer) or `STOPPED_BY_ADMIN` (`set_transfer_lock` lock, `set_privacy`, `update_contacts`) | kind, line, refund queued, the qualifying call id |
| `admin_fail_ssl_job(p_job_id, p_reason, …)` | Status `needs_attention`. `PAYMENT_NOT_VERIFIED` as above. `ssl_initialize` with `sent_at` set gives `ALREADY_SENT`. | `fail_ssl_job(id, code, reason, false)`: `FAILED_BY_ADMIN` (initialize) or `STOPPED_BY_ADMIN` (configure, reissue) | kind, sent_at |
| `admin_activate_fx_rate(p_rate_id, p_reason, …)` | Status `pending_review` (`NOT_PENDING`). `quoted_at > now() - 48 h` (`RATE_TOO_OLD`). **`NEWER_RATE_ACTIVE` when the active rate's `quoted_at >= ` this rate's.** | `activate_fx_rate(id, auth.uid())` | old/new costing rate, both `quoted_at`, move % |
| `admin_reject_fx_rate(p_rate_id, p_reason, …)` | `pending_review`. | `update fx_rates set status='rejected', reviewed_by, reviewed_at` | rate, source |
| `admin_update_pricing_settings(p_changes jsonb, p_reason, …)` | Keys must be a subset of these (`UNKNOWN_KEY`), each in range (`OUT_OF_RANGE`):<br>• `margin_ngn`: integer 1,000–50,000<br>• `fx_buffer_pct`: 0–20, at most 2 decimals<br>• `icann_fee_cents`: integer 0–200, stored as `icann_fee_usd = cents/100`<br>• `fx_move_threshold_pct`: 1–50<br>**`vat_pct` is not a key** (statutory; SQL editor). | `update pricing_settings … where id` | before/after per key |
| `admin_update_ops_settings(p_changes jsonb, p_reason, …)` | Keys must be a subset of the **11** tunable columns (`UNKNOWN_KEY`). The wrapper's own bounds (`OUT_OF_RANGE`):<br>• `auto_refund_max_kobo`: 1–100,000,000 (₦1,000,000)<br>• `auto_refund_daily_max_kobo`: ≥ the single limit and ≤ 500,000,000 (₦5,000,000)<br>• `refund_delay_minutes`: 5–1440<br>• `stuck_order_minutes`: 5–1440<br>• `max_domains_per_account_day`: 1–1000<br>• `float_alert_cents`: 0–1,000,000, stored as `float_alert_usd`<br>• `velocity_new_max`: 1–1000<br>• `velocity_trusted_max`: 1–5000 and ≥ new<br>• `velocity_standard_after_days`: 0–365<br>• `velocity_trusted_after_days`: 0–3650<br>• `velocity_trusted_after_paid_orders`: 0–1000<br>Integers must be integers. **A rise in either refund limit, or a lower refund delay, is recorded as `settings.refund_limit_raise`** (and alerted); everything else is `settings.update`. | `update ops_settings … where id` | before/after per key |
| `admin_set_tld_flags(p_name, p_is_paused, p_paused_reason, p_featured_rank, p_featured_tagline, p_reason, …)` | The extension exists. Pausing needs a reason of 3–120 characters. Rank is null or 1–50. Tagline is at most 60 characters. **Null keeps the stored value, for every flag**: a pause sent alone leaves the extension featured, a feature sent alone leaves it paused with its reason (a stored reason is not judged again). **Clearing is explicit: rank `0` un-features, an empty tagline removes it.** Resuming clears the pause reason. `admin.sql` check 34 pins this. | `update tlds set …` | before/after, held domains on the extension |
| `admin_set_ssl_sellable(p_product_code, p_sellable, p_reason, …)` | The product exists. **`p_sellable` with `create_usd is null` gives `NO_PRICE`.** A `ssl_products_check` violation gives `INCOMPLETE_PRODUCT`. | `update ssl_products set is_sellable` | before/after |
| `admin_save_preset_draft(p_preset_id, p_provider, p_nameservers, p_source_url, p_notes, p_assigns_per_zone, p_reason, …)` | `^https://` and **the URL's host is in `nameserver_preset_sources` for that provider** (`SOURCE_NOT_ALLOWED`). `are_hostnames`. 2–13 entries unless per-zone. Registrar-default rows give `REGISTRAR_DEFAULT`. One open draft per preset or provider (`DRAFT_OPEN`). | inserts a draft; **the live preset is unchanged** | before/after nameservers, source host |
| `admin_publish_preset_draft(p_draft_id, p_reason, …)` | The draft is open. Unless per-zone: `check_ok` and `checked_at > saved_at` (`NOT_CHECKED`). | inserts or updates `nameserver_presets` (`verified_at = now()`, `last_checked_at = checked_at`, new rows visible); marks the draft published | before/after nameservers, check time |
| `admin_discard_preset_draft(p_draft_id, p_reason, …)` | Open. | stamps `discarded_at` | — |
| `admin_set_preset_hidden(p_id, p_hidden, p_reason, …)` | Hide is `preset.hide` (operator). Show is `preset.show` (owner, money), and a preset with `auto_hidden_at` set gives `CHECKER_HID_IT`. Registrar defaults give `REGISTRAR_DEFAULT`. | `update nameserver_presets set is_hidden` | blast radius counts |
| `admin_requeue_email(p_email_id, p_reason, …)` | A test admin: a `test_mode` email to an e2e address, of an e2e account or none (`reserved_target`). Status `failed`. `complained_at` null. `coalesce(delivery_status,'') <> 'bounced'`. | `update email_outbox set status='pending', attempts=0, next_attempt_at=now(), last_error=null, claimed_by=null, claimed_at=null` | kind, category |
| `admin_queue_deep_sync(p_domain_id, p_reason, …)` | The domain exists, `source <> 'demo'`, and `local_status in ('active','expired_grace','redemption')` (`NOT_SYNCABLE`). The side's `gateway:<production\|ote>` heartbeat is under 15 min old (`NO_GATEWAY`). | `update domains set deep_checked_at = null` | domain id |
| `admin_find_customers(p_query text)` | `customer.search`. A test admin sees e2e users' profiles only, and an order number is looked for among e2e users' test orders only, so the recorded `kind` never says a live order has that number *(second review, 3 Oct 2026)*. 30 searches and reveals per admin per hour (`RATE_LIMITED`), counted by `admin_lookup_rate_limited` under `pg_advisory_xact_lock(hashtextextended('admin_lookup:' \|\| admin_id, 0))`, so parallel calls from one session queue instead of all reading the same count. | Exact match on a lower-cased email, order number, or domain. Returns at most 20 masked rows: `{userId, maskedEmail, joinedAt, domainsHeld, ordersPaid}`. | `{kind, matched: [user ids]}`; the query text is never stored |
| `admin_reveal_customer(p_user_id, p_reason, …)` | `customer.reveal`. An e2e user's profile for a test admin. Same rate limit. Reason optional. | Returns `{email, fullName, phone, businessName}`. **A replayed key returns `{ok, auditId, replayed}` with no details**: they are read only after the gate, the limit and a new audit row, so a key kept from before a demotion shows nothing. | target id only |
| `admin_reveal_registrant(p_domain_id, p_reason, …)` | `domain.reveal_contacts`. A test admin: a `test_mode` domain whose owner is an e2e user (`reserved_target`). Same rate limit. | Returns the registrant and `contacts`. A replay carries no details, as above. | target id only |

`admin_record_float_topup` and `admin_correct_float_topup` are in migration 41 (§3.2b).

### 3.2 `supabase/migrations/00000000000041_admin_data.sql`

**(a) Supplier ledger mirror.** The supplier's statement, append-only, in cents.
```sql
create table public.supplier_ledger_entries (
  test_mode         boolean not null,
  trace_id          uuid not null,                  -- stored lower-case; the supplier's GUIDs need not be RFC 9562
  occurred_at       timestamptz not null,           -- supplierDate(creationTime): zoneless = UTC+3
  type              smallint not null,
  status            smallint not null,              -- may change on re-read; every change is a revision row
  charge_type       smallint not null,
  product_type      smallint not null,
  product_id        uuid,
  description       text not null default '' check (char_length(description) <= 300),
  period            smallint,
  old_balance_cents bigint not null,
  balance_cents     bigint not null,
  delta_cents       bigint generated always as (balance_cents - old_balance_cents) stored,
  recorded_at       timestamptz not null default now(),
  match_state       text not null default 'pending'
                    check (match_state in ('pending','matched','topup','unexplained','unclassified')),
  match_call_id     bigint,
  match_operation   text,
  match_order_item_id uuid,
  matched_at        timestamptz,
  primary key (test_mode, trace_id)
);
create table public.supplier_ledger_revisions (
  id bigint generated always as identity primary key,
  test_mode boolean not null, trace_id uuid not null,
  seen_at timestamptz not null default now(),
  changes jsonb not null,                           -- {field: {stored, read}} for each differing fact
  applied boolean not null                          -- true only for a status change
);
```
- Both tables have RLS on, are revoked from the API roles, and grant select to `service_role`.
- **`supplier_ledger_is_final`:**
  - It refuses TRUNCATE.
  - It refuses DELETE unless `old.test_mode and old.description like 'e2e-%'`, which is used only by `purge_test_ledger_entries`.
  - On UPDATE it allows the `match_*` / `matched_at` columns. It allows `status` only while `current_setting('app.ledger_writer', true) = 'on'`.
- Revisions are append-only (`append_only_final`).
- The supplier's `amount` (always 0) and `resellerName` are never stored.

**`record_supplier_ledger(p_test_mode boolean, p_rows jsonb) returns jsonb`** (`service_role`):
1. Validates each element: `trace_id` as an 8-4-4-4-12 hex GUID (case-insensitive, stored lower-case), integer enums, and balances as integer cents.
2. Inserts new rows.
3. For an existing `(test_mode, trace_id)`, compares the facts.
   - **A different `status`:** sets `app.ledger_writer`, updates `status`, resets `match_state = 'pending'`, and writes a revision with `applied = true`.
   - **Any other differing fact:** writes a revision with `applied = false` and leaves the stored facts unchanged. This raises `ledger_changed`.
4. Calls `match_supplier_ledger(p_test_mode)`.
5. Returns `{inserted, statusChanged, revised}`.

**`match_supplier_ledger(p_test_mode boolean) returns integer`** (no grant). It covers entries in `match_state in ('pending','unexplained','unclassified')` with `occurred_at > now() - 30 days`:
- `status <> 1`: `unclassified`. A later status change re-runs the match.
- `delta_cents > 0`: `topup` when `charge_type = 0 and product_type = 3 and type = 5`, else `unclassified`.
- **Name test** for both debit kinds: `c.domain_name = lower(trim(e.description)) or position(lower(c.domain_name) in lower(e.description)) > 0`.
- `delta_cents < 0 and product_type = 1`:
  - Candidate calls: the nearest `supplier_calls c` on the side's environment, with `operation in ('RegisterWithContactInfo','Renew','Transfer')` and `outcome in ('ok','unknown')`, passing the name test, inside `[c.created_at − duration − 120 s, c.created_at + 120 s]`, ordered by the time gap, limit 1.
  - Found: `matched`, with `match_order_item_id = jobs.order_item_id` via `c.job_id`.
  - Not found after 2 h:
    - **`unexplained` only when the description is a bare hostname** (`lower(trim(description)) ~ '^[a-z0-9.-]+\.[a-z0-9-]+$'`, the registration shape seen live);
    - **otherwise `unclassified`**, until a renewal or transfer debit's description shape has been seen and added here.
  - Not found within 2 h: stays `pending`.
- `delta_cents < 0 and product_type = 2`: the same, with `operation in ('SslInitialize','SslReissue')`. The order item comes via `ssl_jobs.certificate_id` → `ssl_certificates.order_item_id`.
- Any other debit: `unclassified`.

**(b) The top-up cost log.**
```sql
create table public.float_topups (
  id             bigint generated always as identity primary key,
  trace_id       uuid not null,             -- the ledger credit (test_mode = false only)
  usd_cents      bigint not null check (usd_cents > 0),
  ngn_paid_kobo  bigint not null check (ngn_paid_kobo > 0),
  reference      text not null check (char_length(reference) between 1 and 80),
  supersedes_id  bigint unique,             -- a correction points at the row it replaces
  recorded_by    text not null,
  recorded_at    timestamptz not null default now()
);
create unique index float_topups_one_original on public.float_topups (trace_id) where supersedes_id is null;
```
- RLS is on; select for `service_role`. A trigger refuses update, delete and truncate.
- The current row for a trace is the one no other row supersedes.
- **`admin_record_float_topup(p_trace_id, p_ngn_paid_kobo, p_reference, p_reason, …)`** (`topup.record`):
  - The ledger entry must exist with `test_mode = false` and `match_state = 'topup'`, and must not already be recorded.
  - `usd_cents` is copied from `delta_cents`.
  - `detail` holds USD cents, NGN kobo, and the effective rate `ngn_paid_kobo::numeric / usd_cents` (kobo per cent, numeric, never integer division).
- **`admin_correct_float_topup(p_topup_id, p_ngn_paid_kobo, p_reference, p_reason, …)`** (`topup.correct`): the target must be current. It inserts a superseding row and records before/after.

**(c) Cost captured at checkout, service-only** (filled by B15). Customers can read `order_items`, so cost never goes there.
```sql
create table public.order_item_costs (
  order_item_id       uuid primary key references public.order_items (id) on delete cascade,  -- purge_test_orders
  supplier_cost_cents bigint not null check (supplier_cost_cents >= 0),   -- supplier price for the line, ICANN excluded
  icann_fee_cents     bigint not null check (icann_fee_cents >= 0),       -- ICANN fee modelled for the line
  recorded_at         timestamptz not null default now()
);
alter table public.order_item_costs enable row level security;            -- no policies
revoke all on public.order_item_costs from public, anon, authenticated, service_role;
grant select, insert on public.order_item_costs to service_role;
```
`order_item_costs_final` refuses UPDATE; cascade delete is allowed. `admin_data.sql` asserts that `authenticated` cannot select it.

**(d) Funnel counter.** It has no search counts (FR-S7).
```sql
create table public.funnel_daily (
  day date not null, test_mode boolean not null,
  event text not null check (event in ('cart_add')),
  count integer not null default 0 check (count >= 0),
  primary key (day, test_mode, event));
-- RLS on; revoke all from API roles; select for service_role.
create function public.bump_funnel(p_event text, p_test_mode boolean) returns void
  language sql security definer set search_path = '' as $$
  insert into public.funnel_daily (day, test_mode, event, count)
  values ((now() at time zone 'Africa/Lagos')::date, p_test_mode, p_event, 1)
  on conflict (day, test_mode, event) do update set count = public.funnel_daily.count + 1 $$;
revoke all on function public.bump_funnel(text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.bump_funnel(text, boolean) to service_role;
```

**(e) Daily rollup**, so trends outlive the 90-day purges.
- `metrics_daily(day date, test_mode boolean, metric text, value bigint not null, primary key (day, test_mode, metric))`. RLS on, select for `service_role`.
- **`record_metrics_daily(p_day date)`** (no grant; cron) upserts, for both sides:
  - `net_sales_kobo`, `vat_kobo`, `cash_in_kobo`, `line_refunded_kobo`, `line_refunded_vat_kobo`, `charge_refunded_kobo`, `orders_paid`, `signups`
  - `emails_sent`, `emails_failed`, `emails_skipped`, `emails_delivered`, `emails_bounced`
  - `alerts_opened`, `alerts_resolved`
  - `balance_open_cents`, `balance_close_cents`, `balance_min_cents`
- **Ledger series are not rolled up.** They are charted straight from `supplier_ledger_entries`, which is never purged (`admin_ledger_daily`). A backfill that runs before the first sync therefore leaves no zeros.
- `select cron.schedule('admin-metrics-daily', '20 23 * * *', $$select public.record_metrics_daily(((now() at time zone 'Africa/Lagos')::date - 1))$$);`
- The migration backfills the last 90 days in a loop.

**(f) Indexes.**
- `orders (test_mode, paid_at) where payment_id is not null`
- `domains (test_mode, expires_at) where source <> 'demo'`
- `refunds (test_mode, status, created_at)`
- `email_outbox (test_mode, created_at)`
- `supplier_calls (environment, domain_name, created_at)` (`if not exists`)
- `supplier_ledger_entries (test_mode, occurred_at)`

**(g) Alert conditions.** Each returns `table(key text, severity text, kind text, summary text)`, is STABLE and SECURITY DEFINER, and has no grant.

- **`ledger_alert_conditions(p_test_mode)`** returns nothing unless a `service_heartbeats` row `supplier_ledger:%` exists for the side. Rows with `description like 'e2e-%'` are ignored **on the test side only** (e2e seeds them there; `float_runway` does the same). Anyone can register an `e2e-*` name, so on the live side such a debit is a real one: it is unexplained, double, refunded-line or price drift like any other, and counted in `ledgerUnexplained`.

| Key | Severity | Kind | Fires when |
|---|---|---|---|
| `ledger_unexplained:<trace>` | critical | `supplier_unexplained_charge` | `match_state = 'unexplained'` and `occurred_at > now() - 90 days`. Summary: "A supplier charge with no matching provisioning call: supplier panel use, a leaked key, or a supplier-side change (automatic renewal is off for our account per BACKLOG L18; verify)." |
| `ledger_double:<trace>` | critical | `supplier_double_charge` | Another debit shares `match_call_id` or `match_order_item_id`. |
| `ledger_refunded_line:<trace>` | critical | `supplier_charge_on_refunded_line` | The matched line's status is `failed` or `refunded`. |
| `ledger_missing:<order_item_id>` | warning | `supplier_missing_charge` | A completed live `register`/`renew`/`transfer` line whose job finished more than 6 h ago, and after the mirror's first entry, has no matched debit. |
| `ledger_price:<trace>` | warning | `supplier_price_drift` | The matched line has `order_item_costs`, and `abs(-delta_cents - supplier_cost_cents) > 1`. |
| `ledger_unclassified:<trace>` | warning | `supplier_ledger_unclassified` | `match_state = 'unclassified'`, last 90 days. |
| `ledger_changed:<trace>` | warning | `supplier_ledger_changed` | A revision with `applied = false` in the last 7 days. |
| `ledger_gap:<side>` | warning | `supplier_ledger_gap` | Either of two cases. **(1)** Any entry's `old_balance_cents` ≠ the previous entry's `balance_cents`, ordered by `occurred_at, trace_id`. **(2)** A snapshot taken **after** the last entry's `occurred_at + 5 min` **and before** the last successful sync's `detail.readAt` differs from that entry's `balance_cents` by more than 1 cent. A debit made after the last sync therefore never fires. |
| `ledger_stale:<side>` | warning | `supplier_ledger_stale` | The heartbeat is older than 3 h, or its `detail.outcome = 'failed'`. |
| `float_cover:<side>` | warning below 10 days, critical below 3 days | `float_low_cover` | `admin_float`'s runway on 7-day burn, only when burn is known (§6). FR-FLOAT-2. |

- **`admin_alert_conditions(p_test_mode)`**, only when `not p_test_mode`:

| Key | Severity | Fires when |
|---|---|---|
| `admin_changed:<change id>` | critical | An `admin_changes` row in the last 24 h whose row was non-test before or after the change, or an insert or update of a test row for a user who is not an e2e user. |
| `admin_test_not_e2e:<label>` | critical | A non-revoked `test_only` admin whose user is not an `e2e-*@example.com` reserved address. |
| `admin_factor_missing:<label>` | critical when no pinned factor is still verified; warning when some are gone | A non-revoked, non-test admin. |
| `admin_burst:<label>` | warning | ≥ 20 `customer.search`, `customer.reveal` or `domain.reveal_contacts` rows in the last hour. |
| `admin_limit_raised:<audit id>` | warning | A `settings.refund_limit_raise` row in the last 24 h. |
| `admin_preset_changed:<audit id>` | warning | A `preset.draft_save`, `preset.publish`, `preset.show` or `preset.hide` `ok` row in the last 24 h, with the provider and before/after nameservers in the summary. |

- **`cron_alert_conditions(p_test_mode)`**, only when `not p_test_mode`. It reads `cron.job` and `cron.job_run_details` (readable by `postgres`, the definer, but not by `service_role`):
  - `cron_stale:email-notices` (critical): no `succeeded` run in 26 h (ERRP compliance).
  - `cron_failed:<jobname>` (warning): the latest run of any job failed.
- **`current_alert_conditions(p_test_mode)`:**
  1. Re-create it with `create or replace`, copying the live definition verbatim (`pg_get_functiondef`).
  2. Append `union all` the three functions above.
  3. Assert that its grants are unchanged.
- One-off at the end of the migration: `select public.sync_alerts(true);`. It clears the 3 stale test-side alerts.

**(h) Admin read functions.** Each is `stable security definer set search_path = ''`, starts with `perform public.admin_session('viewer', null, false)`, and is granted to `authenticated` only.
- All money is bigint kobo or integer cents.
- When `p_test_mode = false` and the caller is `test_only`, they raise `admin:test_admin`, unless the table says otherwise.
- They exclude `domains.source = 'demo'`, filter `test_mode`, and bucket dates with `(ts at time zone 'Africa/Lagos')::date`.
- `payments` has no `test_mode`; it is filtered through `orders.test_mode` (join on `payments.order_id`).

| Function | Returns | Test admin | Used by |
|---|---|---|---|
| `admin_attention_counts(p_test_mode)` | jsonb `{refunds, jobs, incidents, alertsCritical, alertsWarning, drift, stuckOrders, pendingWithoutJob, emailsFailed, ledgerUnexplained, presetDrafts}` | test side | sidebar, overview |
| `admin_overview(p_test_mode)` | jsonb with:<br>• `sales:{d1,d7,d30,d90:{netKobo,vatKobo,cashKobo,ordersPaid,lineRefundedKobo,chargeRefundedKobo}}`<br>• `lines:{d30:{register,renew,transfer,ssl}}`<br>• `float:{…admin_float}`<br>• `health:{heartbeats:[{name,beatAt,outcome}], reconcile:{finishedAt,error}, fx:{activeFrom,costingRate,pendingCount,pendingOldestAt}, snapshotAt, cron:[{job,lastRunAt,lastStatus,lastSuccessAt}]}`<br>• `signups7d`, `expiries30d`<br>• `revenueByDay:[{day,netKobo}]` (30)<br>• `balanceByDay:[{day,closeCents}]` (30)<br>• `renewalsByMonth:[{month,count}]` (6)<br>• `domainsByStatus:[{status,count}]` | test side; `cron` omitted | B1 |
| `admin_revenue(p_test_mode, p_grain, p_from, p_to)` | table `(bucket, orders, net_kobo, vat_kobo, cash_kobo, line_refunded_kobo, line_refunded_vat_kobo, charge_refunded_kobo, fee_kobo, fee_absorbed_kobo)` | test side | B7 |
| `admin_margin(p_test_mode, p_from, p_to)` | table `(month, row_kind 'sold'\|'lost', item_type, lines, costed_lines, revenue_kobo, cost_kobo, margin_kobo, cost_topup_kobo, cost_source)` | test side | B7 |
| `admin_funnel(p_test_mode, p_from, p_to)` | jsonb `{cartAdds, created, paid, completed, partial, failed, cancelled, awaiting, inFlight, medianSecsToPay, medianSecsToSettle}` | test side | B2, B7 |
| `admin_provisioning(p_test_mode, p_from, p_to)` | jsonb `{jobs, lines, ssl, calls}` | test side | B4, B6 |
| `admin_refund_stats(p_test_mode)` | jsonb `{byReasonStatus, openOldestAt, medianHoursToComplete, sent24hKobo, limits:{singleKobo,dailyKobo,delayMinutes}}` | test side | B3 |
| `admin_float(p_test_mode)` | jsonb `{side, balanceCents, takenAt, alertCents, committedCents, uncostedLines, burn7dCents, burn30dCents, burnState:'known'\|'stale'\|'short_history', runwayDays:number\|null, lastKnownRunway:{days,at}\|null, shortByCents\|null, target21dCents, topUpToTargetCents, topups:[{id,traceId,occurredAt,usdCents,ngnPaidKobo,rateKoboPerCent,reference,supersedesId}], ledgerSyncedAt, ledgerReadAt}` | test side | B1, B6 |
| `admin_ledger_daily(p_test_mode, p_from, p_to)` | table `(day, debit_cents, credit_cents, close_cents)` from the mirror | test side | B6 |
| `admin_customer_stats()` | jsonb `{profiles, confirmed, liveBuyers, mfaUsers, holders, active30d, signupsByDay (30), over10NoMfa}` | **raises** | B8 |
| `admin_customers(p_test_mode, p_sort, p_dir, p_offset, p_limit, p_filter jsonb)` | table `(user_id, account_type, masked_email, joined_at, domains_held, orders_paid, total_paid_kobo, has_totp, email_confirmed, last_sign_in_at, is_admin, total_count)`. Sorts are allowlisted: joined, domains, orders, paid, last_sign_in. `p_limit` ≤ 100. | test side, e2e users' profiles only | B8 |
| `admin_customer(p_user_id, p_test_mode)` | jsonb `{maskedEmail, accountType, joinedAt, emailConfirmed, hasTotp, lastSignInAt, isAdmin, counts:{domains,orders,spentKobo,refunds}, allowance}` (allowance via `account_domain_allowance`) | test side, e2e users only | B8 |
| `admin_domain_stats(p_test_mode)` | jsonb `{byTldStatus, expiries:{expired,d30,d60,d90,autoOn90,autoOff90,next}, delegation, registryAutoRenewLabel}` | test side | B9 |
| `admin_tld_held_counts(p_test_mode)` | table `(tld, held)` | test side | B13 |
| `admin_preset_usage(p_test_mode)` | table `(preset_id, domains, orders, lines)` | test side | B13 |
| `admin_email_stats(p_test_mode, p_days)` | jsonb `{byKind, notices}` | test side | B11 |
| `admin_alert_stats(p_test_mode, p_days)` | jsonb `{byKind, reconcile, drift, presets:{hidden,failing,stale,drafts}}` | test side | B5 |
| `admin_pricing_status()` | jsonb `{tlds, ssl, fx:{active:{id,costingRate,source,quotedAt,effectiveFrom}, pending:[{id,costingRate,source,quotedAt,movePct,tooOld,olderThanActive}]}, settings:{marginNgn,fxBufferPct,icannFeeCents,fxMoveThresholdPct,vatPct}}`. This is storefront-public data plus review state. | allowed | B12 |
| `admin_ssl_stats(p_test_mode)` | jsonb `{byStatus, unrecognised, jobs}` | test side | B10 |
| `admin_list_admins()` | table `(label, role, test_only, added_at, revoked_at, pinned_factors, verified_pinned_factors, last_change_at)`. No ids or emails. | own row only | B13 |

**(i) Masked views** (Package A). Each is `with (security_invoker = true)`, revoked from `public, anon, authenticated` (default privileges would otherwise grant `arwdDxtm`), with select granted to `service_role`. Each carries a `test_mode` column, so `adminDb` applies the side filter.

| View | Columns (never the raw sensitive ones) | For |
|---|---|---|
| `admin_payments_v` | `id, order_id, test_mode` (from `orders`), `provider_reference, amount_kobo, status, method, created_at, fee_kobo` (= `round((raw->>'app_fee')::numeric*100)`), `charged_kobo` (from `charged_amount`), `absorbed` (= `charged_kobo = amount_kobo`) | B2 |
| `admin_email_outbox_v` | `id, test_mode, kind, category, status, delivery_status, attempts, template_version, created_at, sent_at, next_attempt_at, complained_at, masked_to` (`admin_mask_email(to_email)`), `last_error_safe` (addresses replaced by `[address]`) | B11 |
| `admin_compliance_notices_v` | `id, test_mode, domain_id, domain_name, notice_type, window, expires_at, channel, masked_recipient, template_version, sent_at, delivery_status, checked_at` | B11 |
| `admin_ssl_certificates_v` | every column except `csr`, `contact`, `approver_email`; plus `approver_masked` | B10 |
| `admin_domains_v` | every column except `registrant`, `contacts`, `pending_registrant`, `pending_contacts`; plus `registrant_country`, `registrant_type` | B9, B2, B4 |
| `admin_orders_v` | every column of `orders` except `registrant`, `contacts`, `contact_profile_id` (added in the Package A review: the map read `orders` whole) | B2 and any page showing an order |

**(j) Test-only helpers** (`service_role`; each refuses a non-`e2e-*@example.com` user or a live row):
- **`seed_test_failed_email(p_user_id) returns uuid`** inserts one `test_mode` `email_outbox` row with status `failed`.
- **`hold_test_refund(p_refund_id)`** moves a `test_mode` refund from `queued` to `held` (an allowed transition) and adds a refund event.
- **`purge_test_ledger_entries() returns integer`** deletes `test_mode` ledger rows with `description like 'e2e-%'`, and their revisions.

### 3.3 SQL check files (Package A writes them; the commands are listed in CLAUDE.md §11)

**`supabase/tests/admin.sql`** (migration 40). It uses the `begin; do $$ … $$; rollback;` pattern. It creates `auth.users`, `auth.mfa_factors` (two factors), `auth.sessions` and `auth.mfa_amr_claims` rows for `e2e-admin-<tag>@example.com`. It sets claims with `set_config('request.jwt.claims', …, true)` and `set local role authenticated`. **Live payment and refund rows are inserted directly inside the rolled-back transaction, never through `record_order_payment`**, because the invoice sequence does not roll back. Each check raises on failure:
1. A non-admin's `admin_status()` is `not_admin`; `admin_whoami()` raises; each wrapper and `admin_note` raises.
2. `aal1` claims give `needs_code`.
3. A totp 13 h old gives `needs_code` for `admin_whoami(null)`; at the view window's edge, 11 h 59 min views and 12 h 1 min gives `needs_code` (`admin_status` and `admin_whoami(null)`). A totp 20 min old passes `admin_whoami(null)` and gives `NEEDS_CODE` from a money wrapper. At the money tier's edge, a totp 4 min and 4 min 59 s old passes `admin_whoami(5)` and a money wrapper's gate; 5 min 1 s and 6 min old give `needs_code` and `NEEDS_CODE`.
4. A session factor equal to the **second** pinned factor passes. An unpinned factor gives `factor_mismatch`. A pinned but unverified factor gives `factor_mismatch`. A deleted session row gives `needs_code`.
5. An `amr` of only `otp` and `totp` gives `weak_sign_in`.
6. `password_reset_at` within 24 h: money wrappers return `HELD` with a `refused` row; `admin_whoami(null)` passes.
7. A revoked admin gives `not_admin`. A viewer on an operator wrapper gets `ROLE` with a `refused` row. A viewer calling `admin_note('supplier.catalogue_apply', 'global', …)` gets `ROLE`.
8. As `service_role`: `admin_approve_refund` raises (no grant); inserts into `admins` and `admin_audit_log` fail; `approve_refund` is still not executable.
9. Replay:
   - A test-mode held refund approves once (`ok` row, status `queued`, `approved_by = label`). The same key gives `replayed: true` and no second row.
   - The same key on another refund raises `admin:request_key_mismatch`.
   - A refused attempt's key runs again once the cause is fixed.
10. Approving a non-held refund gives `{ok:false, code:'NOT_HELD'}` **and** a `refused` row.
11. A `test_only` admin on a live refund gives `TEST_ADMIN`, and on `admin_update_ops_settings` gives `TEST_ADMIN`. With a stale code it gives `NEEDS_CODE`. Every one of its refusals is stored with `detail = '{}'`.
12. `admin_retry_job` on a `queued` job gives `NOT_RETRYABLE`. On a failed transfer it gives `TRANSFER_CODE_GONE`.
13. `admin_fail_job` on `register_domain`:
    - no `not_found` read gives `READ_REGISTRY_FIRST`;
    - a read **older than the job's latest `RegisterWithContactInfo`** gives `READ_REGISTRY_FIRST`;
    - a ledger debit naming the domain after the job's creation gives `LEDGER_SHOWS_CHARGE`;
    - a fresh read after the call gives `ok`, a failed line and a queued refund.
14. `admin_fail_job` and `admin_fail_ssl_job` with `last_error_code = 'PAYMENT_NOT_VERIFIED'` give `PAYMENT_NOT_VERIFIED`, with no refund row created.
15. `set_transfer_lock` with `pending_transfer_lock = false` gives `TRANSFER_OUT_PROTECTED`. `apply_nameservers` gives `USE_RETRY`. `transfer_domain` without a fresh rejected `AdminTransferQuery` gives `READ_TRANSFER_FIRST`.
16. **LINE_NOT_FAILED:**
    - `retry_job` a failed test registration line (its refund is cancelled), then complete it with `complete_registration`;
    - `admin_retry_refund` on the cancelled refund gives `LINE_NOT_FAILED` (owner) and `OWNER_ONLY` (operator);
    - `admin_record_manual_refund` gives `LINE_NOT_FAILED`.
17. Cancel as an operator gives `ROLE`. Cancel with `provider_called_at` set and no check gives `CHECK_PROVIDER`.
18. `admin_record_manual_refund`:
    - no check gives `FLW_NOT_VERIFIED`;
    - a check with the wrong amount, the wrong `tx_id`, a bare `completed` state, or an age over 15 min gives `FLW_NOT_VERIFIED`;
    - a matching check gives `ok`, a completed refund and a `refunded` line.
19. FX:
    - 3 days old gives `RATE_TOO_OLD`;
    - `superseded` gives `NOT_PENDING`;
    - a pending rate quoted before the active one gives `NEWER_RATE_ACTIVE`.
20. Ops settings:
    - `auto_refund_max_kobo = 200000000` gives `OUT_OF_RANGE`;
    - daily below single gives `OUT_OF_RANGE`;
    - `refund_delay_minutes = 0` gives `OUT_OF_RANGE`;
    - a raise is recorded as `settings.refund_limit_raise`.

    Pricing: `vat_pct` gives `UNKNOWN_KEY`, and `margin_ngn = 500` gives `OUT_OF_RANGE`.
21. `admin_set_ssl_sellable(true)` with null `create_usd` gives `NO_PRICE`.
22. Preset drafts:
    - a disallowed source host gives `SOURCE_NOT_ALLOWED`;
    - publishing before a passing check gives `NOT_CHECKED`;
    - after `record_preset_draft_check(ok)`, publishing makes the preset visible;
    - a `preset.publish` row exists, and `admin_alert_conditions(false)` shows `admin_preset_changed`.
23. Incidents: an owed kind without an outcome gives `OUTCOME_REQUIRED`; `handled_outside` as an operator gives `ROLE`.
24. Deep sync on a `pending` domain gives `NOT_SYNCABLE`.
25. The note claim:
    - `admin_claim_note` with the wrong action gives `ACTION_MISMATCH`, and a wrong target gives `TARGET_MISMATCH`;
    - a second claim gives `USED`;
    - a row aged 61 s gives `EXPIRED`;
    - a missing id gives `NOT_FOUND`; a `refused` row and an `ok` row give `NOT_INTENT`;
    - a `test_actor` intent on `live` or on `global`, written directly, gives `TEST_ADMIN` at the claim, and is not claimed;
    - a `test_actor` note on `live` cannot be created (`TEST_ADMIN` at `admin_note`);
    - `admin_note_result` twice for the same note raises.
26. Audit immutability:
    - updating or deleting a non-test row raises;
    - deleting a test row under 30 days old raises;
    - `admin_redact_reason` nulls only `reason` and stamps `redacted_at`, and writes its own row.
27. `grant_test_admin` refuses a non-`e2e-` email, a user without a verified factor, and a user with a non-test `admins` row. `purge_test_admin_audit()` deletes a `test_actor` row over 30 days old and its claim, and keeps a test row 29 days old and a live row 31 days old.
28. An `admins` insert with someone else's factor raises. Any insert or update writes one `admin_changes` row, and `admin_alert_conditions(false)` shows `admin_changed`.
29. The 31st reveal or search within an hour gives `RATE_LIMITED`. A test admin revealing a real profile gives `TEST_ADMIN`; an e2e user's is shown.
30. The ACL loop and table-privilege assertions (§3.0), and every sequence owned by a migration 40–41 table (at least five): no `usage`, `select` or `update` for `public`, `anon` or `authenticated`.
31. A test admin is refused (`TEST_ADMIN`, nothing shown) the registrant of a test-mode domain held by a real account, and a requeue of a test email to a real address or of a real account; and, for an account at a reserved address that is not an e2e user's (`m40-resv-…@example.com`), its profile, its test domain's registrant, its search and its test email. It may reveal and requeue an e2e user's. Its refusals keep `detail = '{}'`.
32. A search takes the per-admin lookup lock (`pg_locks`, advisory, held to the end of the transaction). The owner, not being a test admin, reads the reserved non-e2e account's test registrant (31).
33. A real operator inserted, flipped to `test_only`, then re-pinned gives three `admin_changed` alerts and `admin_test_not_e2e`; `admin_changes` holds `was_test_only`. Revoking an e2e user's test admin raises nothing.
34. `admin_set_tld_flags`: a null pause keeps the pause; a pause sent alone keeps rank and tagline; a tagline sent alone keeps the pause, its reason and the rank; rank `0` and `''` clear them; a resume clears the reason; a new pause without a reason gives `PAUSE_REASON`; rank 51 and −1 give `OUT_OF_RANGE` and change nothing.
35. `admin_mask_email` over one table of inputs (`a@b@c`, `@x.com`, `''`, no `@`, non-ASCII first characters, …) between `-- mask-email table` markers, which the web's `lib.test.ts` reads and runs through `maskEmail()`, so both mask alike; null masks to null (the web shows `—`).

**`supabase/tests/admin_data.sql`** (migration 41):
1. `record_supplier_ledger` is idempotent. A re-read with a new `status` updates it, writes an applied revision and re-classifies. A re-read with a new balance writes an unapplied revision, keeps the facts, and shows `ledger_changed`.
2. Updating a fact column raises. Deleting a non-`e2e-` row raises.
3. A non-RFC GUID (version nibble `b`, variant `7`) and an upper-case trace are accepted and stored lower-case.
4. Matching:
   - a debit 30 s after an `ok` `RegisterWithContactInfo` call becomes `matched`;
   - an unmatched bare-name debit older than 2 h becomes `unexplained` and appears in `current_alert_conditions(false)`;
   - an unmatched debit with another description shape becomes `unclassified`;
   - a top-up becomes `topup`;
   - `status = 2` becomes `unclassified`.
5. Two debits on one call give `ledger_double`.
6. Gaps:
   - a chain break gives `ledger_gap`;
   - **a debit after the last sync, with a lower snapshot taken after `readAt`, gives no gap**;
   - a differing snapshot inside the window gives a gap.
7. Top-ups: `admin_record_float_topup` refuses a debit and a duplicate; a correction supersedes once; a second correction of the same row is refused.
8. `bump_funnel` increments. `record_metrics_daily` is idempotent.
9. Every read function raises for a non-admin. A test admin on the live side gets `admin:test_admin`. `admin_customers` for a test admin returns only e2e users' rows — not a reserved, non-e2e account — and `admin_customer` refuses a real and a reserved, non-e2e account. `admin_list_admins` returns only the caller's own row. A code 13 h old gets `admin:needs_code`, and a revoked admin `admin:not_admin`, from the reads themselves.
10. `admin_margin` gives `ledger` for a matched line, `checkout` for an `order_item_costs` line, and `none` otherwise, and never estimates. A matched debit on a failed line appears as `row_kind = 'lost'`.
11. `admin_float`:
    - zero burn gives `runwayDays` null;
    - a stale heartbeat gives `burnState = 'stale'` with `lastKnownRunway`;
    - a balance below committed gives `shortByCents`;
    - 9 days of cover gives `float_cover` warning, and 2 days gives critical.
12. `current_alert_conditions(true)` still returns every pre-existing key family (a fixture of one row per kind).
13. `cron_alert_conditions`: no `email-notices` success in 26 h gives `cron_stale:email-notices`. This is done by inserting `cron.job_run_details` rows inside the rollback.
14. The ACL loop, the views, `order_item_costs` and the identity sequences (§3.0).
15. The test-only helpers (§2.7, N12): `seed_test_failed_email` refuses a real and a reserved, non-e2e user; `hold_test_refund` refuses a missing refund, a live refund, a non-e2e user's test refund and a refund that is not `queued`, and holds an e2e user's queued test refund; `purge_test_ledger_entries` deletes a test `e2e-` row and keeps a test row with another description and a live `e2e-` row.

---

## 4. Gateway changes (Package A)

### 4.1 Mounting, auth and the note claim
- `apps/gateway/src/app.ts`: `v1.route('/admin', routes.admin ?? createAdminRouter())`, behind `requireGatewaySecret`. **The global error handler logs `c.req.routePath` (the matched template), never `c.req.path`**, so no domain name reaches a log on any route.
- **`apps/gateway/src/admin/auth.ts`, `requireAdminCaller`:**
  - `GATEWAY_ADMIN_SECRET` unset: `503 ADMIN_DISABLED`.
  - `x-admin-secret` checked with `timingSafeEqual`, else `401 ADMIN_AUTH` — its own code, worded as the dashboard's and the gateway's secrets differing, never as `SUPPLIER_AUTH` (DomainNameAPI's credentials). *(Package A review, 3 Oct 2026.)* The web checks its own copy before it writes a note: unset, a live read answers `ADMIN_DISABLED` with no note.
  - `x-admin-audit-id` matching `^\d{1,19}$` and `x-admin-label` matching `^[a-z][a-z0-9_-]{1,30}$`, else `400 VALIDATION_FAILED`.
- **The claim, before any supplier, Flutterwave or DNS call:**
  1. The route calls `admin_claim_note(auditId, <the route's action>, label, side, <normalised target>)` with the gateway's service client (`admin/notes.ts`).
  2. A refusal returns `403 {ok:false, code:'ADMIN_NOTE_REFUSED', reason:<code>}` and calls the supplier for nothing.
  3. After the call, the route calls `admin_note_result(auditId, 'ok'|'refused'|'failed', code, {ids, counts, cents})`.

  The shared secrets alone therefore reach nothing.
- **Logs.** Every request logs `{route: routePath, adminLabel, auditId, ms, outcome}`. Query values are never logged, except tld, op and paging numbers.
- **`apps/gateway/src/env.ts`:**
  - `GATEWAY_ADMIN_SECRET: z.string().min(32).optional()`
  - `LEDGER_SYNC_MINUTES: z.coerce.number().int().min(15).max(24*60).default(60)`
- **Rate:**
  - `adminBucket = new TokenBucket(20, 0.5)`; empty gives `429 RATE_LIMITED`.
  - `QueueTimeout` gives `503 SUPPLIER_BUSY`.
  - Other failures go through `mapSupplierError` as `502`.
- **Admin never uses `priority: 'high'`.**

### 4.2 Supplier access, allowlists and input validation
- **`admin/supplier.ts`, `createAdminSupplier({environment, apiKey, resellerId, run, getJson, postJson})`.** It exposes `get(path, params)` and `postRead(path, body)` only.
  - `ALLOWED_GET = ['/deposit/accounts/me', '/deposit/transactions', '/domains', '/contacts/verification/check', '/products/info', '/products/tlds', '/products/ssls']`.
  - `ALLOWED_POST_READ = ['/domains/transfers/query', '/domains/renew/check']`.
  - Anything else throws `NotAllowed`.
- **Query strings are built only from `PARAMS[path]`**, an allowlist of parameter names per path:
  - `/deposit/transactions`: `StartDate, EndDate, TransactionTypes, ProductTypes, FilterText, TraceId, Sorting, SkipCount, MaxResultCount`.
  - `/domains`: `DomainName, SkipCount, MaxResultCount`.
  - `/contacts/verification/check`: `HandleCode`.
  - `/products/info`: `ProductName, OrderType, Period`.

  POST bodies are built from `{domainName}` and `{domainName, period}` only. `ResellerId` and `ResellerNames` can never be sent.
- **Keys and sides:**
  - **Balance, ledger and the registry listing use the key of `target`**, the side the snapshots and mirror use (the sandbox key `DNA_API_TEST_KEY` for `ote`, otherwise the production key `DNA_API_KEY`). The response is tagged with `side`. With writes off they answer `503 WRITES_OFF`.
  - Catalogue and price reads use `env.DNA_ENV`, as `catalogue/supplier.ts` does, with side `global`.
  - Per-domain and per-certificate reads use `createDnaRegistrar` or `createSslClient` on `target`. They are recorded as `Admin<Operation>`: `AdminGetDetails`, `AdminSslCheckStatus`, `AdminSslGetCertificate`, `AdminTransferQuery`, `AdminRenewCheck`.
  - `?side=` must equal `target`, else `409 OTHER_SIDE`.
- **Input validation** with the shared schemas, before the claim (a bad input is `400` and the note stays an intent):

| Input | Rule |
|---|---|
| `:name` | `toAsciiHost` + `nameserverSchema`. A `*.` prefix is allowed only on `/ssl/:name`. |
| `:tld` | The shared extension regex. |
| `trace` | A case-insensitive 8-4-4-4-12 hex GUID, lower-cased. |
| `q` | An exact hostname. |
| `skip` | An integer 0–10,000. |
| `take` | An integer 1–100. |
| `from`, `to` | `YYYY-MM-DD`, at most 366 days apart. |
| `type`, `productType` | Integers 0–20. |
| `op` | One of `register`, `renew`, `transfer`, `restore`. |
| `years` | An integer 1–10. |
| `:flwRefundId` | `^[A-Za-z0-9_-]{1,64}$`. |
| `refund`, `incident`, draft id | A uuid or bigint. |

- **Projections** (`admin/shapes.ts`) build every output from allowlisted fields before any cache, log or `supplier_calls` message. `contacts`, `authCode`, `ownerName`, `fieldValue`, `csr`, `pin`, approver and `resellerName` never leave the module. USD values become cents through `usdToCents()` (`@dr/shared/admin`).

### 4.3 Routes

All routes return `{ ok: true, data }`. Types live in `packages/shared/src/admin/supplier.ts` (`@dr/shared/admin`). Every amount is integer cents or kobo. Every route first claims the note for the action shown.

| Route (action) | Upstream call | Lane / wait | Cache | `data` |
|---|---|---|---|---|
| `GET /v1/admin/supplier/balance` (`supplier.balance`) | `deposit/accounts/me`, target's key | normal / 10 s | 30 s | `AdminSupplierBalance {side, balanceCents, priceGroup, readAt}` |
| `GET /v1/admin/supplier/transactions?from&to&type&productType&q&trace&skip&take` (`supplier.ledger_live`) | `deposit/transactions`, target's key. **Always both `StartDate` and `EndDate`** (UTC+3 zoneless dates widened by a day), filtered back in UTC. `Sorting=creationTime desc`, `FilterText=q`, `TraceId=trace`. | low / 15 s | 60 s | `AdminLedgerPage {side, total, items: AdminLedgerEntry[], readAt}`, where `AdminLedgerEntry` is `{traceId, occurredAt, type, status, chargeType, productType, description, period, deltaCents, balanceBeforeCents, balanceAfterCents, kind}` |
| `GET /v1/admin/supplier/domains?skip&take&name` (`supplier.domains_page`) | `domains`, target's key | low / 15 s | 5 min | `AdminRegistryPage {side, total, items:[{name, status, expiresAt, rgpExpiresAt, transferLock, privacy, renewalModeLabel, nameservers}], readAt}` |
| `GET /v1/admin/supplier/domains/:name?side=` (`supplier.domain_lookup`) | registrar `lookup`, recorded `AdminGetDetails` | normal / 12 s | none; 30 s per name | `AdminRegistryDomain {name, outcome:'ok'\|'not_found', status, statusCode, expiresAt, rgpExpiresAt, transferLock, privacy, nameservers, readAt}` |
| `GET /v1/admin/supplier/domains/:name/verification?side=` (`supplier.verification`) | `domains?DomainName=&SkipCount=&MaxResultCount=25`, page after page (at most 4) until this name's item is found or the listing ends, then `contacts/verification/check`, with the registrant handle taken only from the item whose `domainName` is this name, compared whole and case-blind — the filter also lists names that contain it, in no promised order; no such item in a listing read to its end (`totalCount`, or a short page) is `null`. A `null` from a listing not read to its end is answered but never cached *(second review, 3 Oct 2026)* | low / 15 s | 1 h | `AdminRegistrantVerification \| null` |
| `GET /v1/admin/supplier/domains/:name/transfer?side=` (`supplier.transfer_query`) | `POST domains/transfers/query {domainName}`, recorded `AdminTransferQuery` with `message` set to the mapped state | normal / 12 s | none; 30 s per name | `AdminTransferState {name, state:'pending'\|'completed'\|'rejected'\|'cancelled'\|'unknown', supplierStatus (≤ 40 chars), requestedAt, finalAt, readAt}`. The status words are mapped from OTE fixtures; an unrecognised word is `unknown`. |
| `GET /v1/admin/supplier/domains/:name/renewable?side=&years=` (`supplier.renew_check`) | `POST domains/renew/check {domainName, period}`, recorded `AdminRenewCheck`. **Enabled only after the OTE proof (§9 A acceptance).** | normal / 12 s | none; 30 s per name | `AdminRenewCheck {name, renewable, renewalLock, reasonKey, readAt}` |
| `GET /v1/admin/supplier/prices/:tld?op&years` (`supplier.price_check`) | `products/info` | normal / 10 s | 10 min | `AdminPriceCheck {tld, op, years, supplierCents, ourCents, matches: supplierCents === ourCents, readAt}` |
| `GET /v1/admin/supplier/catalogue/preview` (`supplier.catalogue_preview`) | `syncCatalogue({apply:false})`, low lane, 60 s per page | low | 10 min; one run in flight | `AdminCataloguePreview {kind:'tlds', outcome, reason, listed, sellable, changes, report (≤200 lines), readAt}` |
| `GET /v1/admin/supplier/ssl-catalogue/preview` (`supplier.ssl_catalogue_preview`) | `syncSslProducts({apply:false})` | low | 10 min | same with `kind:'ssl'` |
| `POST /v1/admin/supplier/catalogue/apply` (`supplier.catalogue_apply`) | `syncCatalogue({apply:true})`, then `catalogue/refresh.ts`, then the `catalogue:production` heartbeat | low | invalidates the preview; 1 per 10 min (`TOO_SOON`) | `AdminCatalogueApply {outcome, reason, changes, readAt}` |
| `POST /v1/admin/supplier/ssl-catalogue/apply` (`supplier.ssl_catalogue_apply`) | `syncSslProducts({apply:true})` (never `is_sellable`) | low | same | same |
| `GET /v1/admin/supplier/ssl/:name?side=` (`supplier.ssl_lookup`) | `SslClient.status` (+ `details` unless `*.`) | normal / 12 s | none; 30 s per name | `AdminSslStatus {…, readAt}` |
| `GET /v1/admin/flutterwave/refunds/:flwRefundId?side=&refund=\|incident=` (`refund.flw_check`) | The refund or incident comes from the claimed note's `detail`; a query string naming another gives `403 TARGET_MISMATCH` before Flutterwave is called. Then Flutterwave `getRefund` with the side's key, and `record_flw_refund_check` with the note's target | own bucket (not the supplier lane) | none | `AdminFlwRefundCheck {checkId, flwRefundId, transactionId, amountKobo, status, state:'done'\|'failed'\|'pending' (refundState), readAt}` |
| `POST /v1/admin/presets/drafts/:id/check` (`preset.draft_check`) | DoH A/AAAA on Cloudflare and Google for each host (the `presets/` module), then `record_preset_draft_check` | not supplier | 1 per 60 s per draft | `AdminPresetDraftCheck {ok, hosts:[{host, ok}], checkedAt}` |

**`LedgerKind`** (`packages/shared/src/admin/ledger.ts`):
- `'topup'`: `(type 5, chargeType 0, productType 3)`.
- `'domain_charge'`: `(chargeType 1, productType 1)`.
- `'ssl_charge'`: `(chargeType 1, productType 2)`.
- Otherwise `'unclassified'`. Unknown integers are shown raw and never counted as settled when `status ≠ 1`.

The periodic preset checker also checks open drafts (`preset_drafts_for_check()`) on each 6-hour pass.

### 4.4 The ledger sync (`apps/gateway/src/ledger/`)
- **`source.ts`, `createLedgerSource`:**
  - It pages `deposit/transactions` with `Sorting=creationTime asc`, **`StartDate=<since − 1 day>` and `EndDate=<tomorrow>`**, as UTC+3 zoneless dates. The supplier ignores `StartDate` without `EndDate`, and filters by whole day when both are set. It filters back to `occurred_at >= since − 1 day` in UTC.
  - `MaxResultCount=200`, `SkipCount`, with a stop at a short page. `MAX_PAGES = 50`.
  - The number read must equal `totalCount`, else it refuses ("read N of M").
  - Every request runs `supplierSlots.run(…, {priority:'low', waitMs: 60_000})`.
- **`normalize.ts`, `toLedgerRow`:**
  - `occurred_at = supplierDate(creationTime)`.
  - `traceId` and `productId` are validated with **`z.guid()`** (any 8-4-4-4-12 hex, either case; `z.uuid()` in Zod 4 rejects live ids) and **lower-cased**.
  - Balances become cents via `usdToCents`.
  - A row without a GUID `traceId` refuses the whole read. `amount` and `exchange*` are ignored.
  - Fixtures include the live non-RFC GUID shape and an upper-case trace.
- **`sync.ts`, `createLedgerSync({source, store, testMode, everyMs, log})`:**
  - `since = store.latestOccurredAt(testMode) ?? 2026-09-01`.
  - A complete read calls `store.record(rows)` and beats `supplier_ledger:<production|ote>` with `{outcome:'ok', read, inserted, statusChanged, revised, lastOccurredAt, readAt}`. `readAt` is the time the read began.
  - A refused or failed read records **no rows**, only the heartbeat `{outcome:'failed', reason}`.
- **`store.ts`:** the RPC wrappers.
- **`server.ts` wiring:**
  - It runs when `target` is set, with the side's key, every `LEDGER_SYNC_MINUTES`.
  - The alert monitor's `balanceEveryMs` changes from 30 to **15 min** (FR-FLOAT-1).

### 4.5 Telegram links
- **`packages/shared/src/admin/alert-href.ts`, `adminHrefForAlertKey(key)`:**

| Alert key prefix | Admin page |
|---|---|
| `job:` | `/admin/queue/jobs/<id>` |
| `ssl_job:` | `/admin/queue/ssl-jobs/<id>` |
| `ssl_status:` | `/admin/ssl/<id>` |
| `order_stuck:` | `/admin/orders/<id>` |
| `refund:`, `refund_overdue:`, `refund_slow:` | `/admin/refunds/<id>` |
| `incident:` | `/admin/refunds/incidents#incident-<id>` |
| `drift:` | `/admin/alerts?tab=drift` |
| `reconcile_stale:`, `cron_stale:`, `cron_failed:` | `/admin/alerts?tab=health` |
| `float_low:`, `float_cover:` | `/admin/supplier` |
| `catalogue_sync:` | `/admin/supplier/catalogue` |
| `preset_*:` | `/admin/settings/presets/<id>` |
| `email_failed:`, `email_unconfirmed:`, `email_complaint:` | `/admin/emails?status=…` |
| `notice_bounced:` | `/admin/emails?tab=compliance` |
| `emails_waiting:` | `/admin/emails?status=pending` |
| `ledger_missing:` | `/admin/orders?line=<id>` |
| `ledger_*:` (others) | `/admin/supplier/ledger?trace=<id>` |
| `admin_changed:`, `admin_factor_missing:`, `admin_test_not_e2e:` | `/admin/settings/admins` |
| `admin_burst:`, `admin_limit_raised:`, `admin_preset_changed:` | `/admin/audit?id=<id>` |
| anything else | `/admin/alerts` |

- **Alert keys.** `sync_alerts()` is unchanged and returns no `key`. **`alerts/store.ts` then selects `id, key` from `ops_alerts` for the returned ids** (`service_role` has SELECT) and adds `key` to `DueAlert`.
- **`alerts/format.ts`:** when `APP_URL` is set, each line gains ` — ${APP_URL}${adminHrefForAlertKey(key)}`. The `TELEGRAM_MAX_CHARS` budget still holds.

### 4.6 Gateway tests (85% coverage holds)
- **`admin/auth.test.ts`:** a missing or wrong secret gives 401; no secret configured gives 503; a bad audit id gives 400; **the secret with a refused claim gives 403 `ADMIN_NOTE_REFUSED` and makes no upstream call**; a claimed note gets exactly one `admin_note_result`.
- **`admin/supplier.test.ts`:**
  - `ALLOWED_GET`, `ALLOWED_POST_READ` and `PARAMS` equal the exact lists;
  - any other path, method or parameter throws;
  - **`ResellerId` and `ResellerNames` are never sent**, even when passed;
  - the static check over the `admin/` source finds no SDK write method.
- **`admin/validate.test.ts`:** each rule in §4.2. `*.` is accepted only on `/ssl/:name`; an upper-case trace is lower-cased; a 101 `take` gives 400.
- **`admin/shapes.test.ts`:** sentinel PII never appears in output, the logger spy, or `supplier_calls` messages.
- **`admin/routes.test.ts`:**
  - the lane is `normal` or `low`; cache hits make no second call; the 30 s throttle; `OTHER_SIDE`; `WRITES_OFF`; `QueueTimeout` gives 503;
  - `deltaCents` comes from the balance difference (11.31 gives −1131);
  - zoneless times are UTC+3; catalogue apply twice gives `TOO_SOON`;
  - balance and ledger use the target's key and return `side`;
  - transfer-state mapping from recorded OTE fixtures; the Flutterwave check records facts and maps `refundState`.
- **`app.test.ts`:** the error log carries `routePath` (`/v1/admin/supplier/domains/:name`) and no domain.
- **`ledger/*.test.ts`:**
  - a short page stops; a count mismatch records nothing and beats `failed`;
  - **every request carries both `StartDate` and `EndDate`** (a contract test with a fixture showing `StartDate` alone ignored);
  - overlap rows are deduplicated; a status change is passed through as a revision; `MAX_PAGES`; the low lane;
  - `readAt` is in the heartbeat.
- **`presets/*.test.ts`:** drafts are checked on the periodic pass and on demand.
- **`alerts/format.test.ts`:** the link line appears, the key comes from the `ops_alerts` select, and the text stays within budget.

---

## 5. Web

### 5.1 Shared foundation (Package A)

**Route conventions.**
- `app/(admin)/admin/**` holds routing only.
- Each `page.tsx` renders `<Suspense fallback={<…Skeleton/>}><XView …/></Suspense>`.
- `XView` awaits `requireAdmin()`, `getAdminSide()`, the params and the queries.
- `searchParams` is read only inside Suspense. There is no `export const dynamic` and no `'use cache'` under admin.

**Side switch.**
- The cookie `dr_admin_side` is `live` or `test` (httpOnly, Lax, path `/admin`, 30 days). It is set by `actions/side.ts` (`adminAction`, action `side.switch`, not audited and not in `admin_tier`; the client skips the tier lookup for it).
- `SideSwitch` is two submit buttons, followed by `router.refresh()`.
- The Test side shows `SideBanner`: "Showing test-mode records — no real money".
- For `test_only` admins the banner reads: "Test administrator: live records and customers' details are hidden, and live actions are refused."
- **The side filter is applied by `adminDb` and by the read functions, not by each query.**

**Sidebar.** Unchanged from v1, with one addition: the Settings badge counts open preset drafts.
- Badges come from `admin_attention_counts`, and counts sit inside the accessible name.
- Footer: AccountMenu and "Back to your account".
- `MobileNav` gains a `description` prop.

**Placeholders.** Package A creates every route's `page.tsx` as `<AdminPlaceholder title="…"/>`.

**Shared components** (`features/admin/components/`, Package A):

| File | Contract |
|---|---|
| `table/data-table.tsx` (server) | As v1: a card list below `xl`, a `<table>` at `xl` in `div.relative.overflow-x-auto`, an sr-only caption, `scope`, sort `Link`s with `aria-sort` on the `th`, tabular-nums. |
| `table/table-toolbar.tsx`, `table/filter-chips.tsx`, `table/pager.tsx`, `table/table-skeleton.tsx` | As v1. The toolbar is never used for PII search. |
| `admin-status-pill.tsx`, `stat-tile.tsx`, `charts/bar-chart.tsx`, `charts/line-chart.tsx` | As v1 (server SVG, sr-only data, `status-*` / brand tokens only). |
| `confirm-action.tsx` (client) | `ConfirmAction({trigger, title, rows, body, confirmLabel, cancelLabel, reason, reasonLabel?, typeToConfirm?, checks?, destructive?, needsCode?, run:(extra:{reason?, requestKey, checks, code?})=>Promise<AdminResult>, returnTo})`.<br>• **`needsCode` (every money action) adds a six-digit field** ("Code from your authenticator app", `inputMode="numeric"`, `autoComplete="one-time-code"`). The action verifies it before anything else.<br>• `requestKey = crypto.randomUUID()` is made per opening and **replaced after every refused answer**. It is kept after a network error or timeout, so a retry replays a committed `ok`.<br>• Destructive dialogs focus Cancel first. Pressed, pending and disabled states (S12). Errors show through `ActionError`. Success gives a toast, `FormMessage role=status` and `router.refresh()`. |
| `dl-grid.tsx`, `timeline.tsx`, `copy-value.tsx`, `empty-state.tsx`, `error-state.tsx`, `route-tabs.tsx`, `diff-table.tsx` | As v1. |
| `shell/*` | As v1. |

**Shared lib** (`features/admin/lib/`, pure and unit-tested):
- `actions.ts`: `ADMIN_ACTIONS`, a mirror of `admin_tier` (`minRole`, `money`, `testRule`). It is used to hide buttons a role cannot use and to refuse early. SQL remains the authority.
- `list-params.ts` (as v1).
- `format.ts`: `formatWat`, `ago`, `formatUsd(cents)`, `maskEmail` (the same `a•••@gmail.com` format as `admin_mask_email`), `maskPhone`, `shortId`.
- `labels.ts`, `tone.ts`.
- `playbook.ts`: DEPLOY §6 as `code → {meaning, next, offers}`.
  - `PAYMENT_NOT_VERIFIED` offers **Retry only**: "Retry re-reads the charge from Flutterwave. If it still can't be confirmed, the owner closes it in the SQL editor (DEPLOY §6)."
  - `TRANSFER_OVERDUE` offers "Read the transfer state". Landed: "Record it in the SQL editor (`complete_transfer`, DEPLOY §6)". Refused: Fail.
  - `NOT_RENEWABLE` offers "Check renewability".
  - `REGISTERED_AT_REGISTRY` offers retrying the registration job.
  - Unknown codes: "No playbook entry — read the job's supplier calls first."
- `errors.ts`: every `admin:*` and wrapper code in §2.4 and §3.1.2, mapped to words.
- `side.ts`, `href.ts`.

**Shared queries and actions** (Package A):
- `queries/session.ts` (§2.3).
- `queries/attention.ts`.
- **`queries/gateway.ts`: `callAdminGateway<T>({admin, auditId, route, params, method?, body?})`.**
  - `route` is a template (`'admin/supplier/domains/:name'`), and `params` fills it.
  - `lib/gateway.ts` (refactored by A) gains `headers`, `method` and **`logPath`**. `callAdminGateway` passes the template as `logPath`, so web logs never carry a domain.
- `actions/supplier-live.ts`: `readLiveBalance`, `searchLiveLedger`, `lookupDomain`, `readRegistryPage`, `readRegistrantVerification`, `readTransferState`, `checkRenewable`, `checkSupplierPrice`, `lookupSsl`, `checkFlutterwaveRefund`.
  - Each is an `adminAction` with `{action}` metadata. The body (after validation) calls `admin_note(action, side, target…)`, refuses when the note is refused, then calls the gateway with the note's id.

**Promotions:**
- `refresh-while.tsx` moves to `components/common/`.
- `ActionError`, `useOutcome` and `QUIET_BUTTON` move to `components/common/action-parts.tsx`.
- Install the shadcn `textarea`.

**Hardening** (Package A, its own commit):
- `cookieOptions: { httpOnly: true }` on the Supabase server clients, plus the `dr_signed_in=1` hint cookie that `use-signed-in.ts` reads. An injected script cannot lift a refresh token.
- The nonce CSP on `/admin` (§2.3).
- Money actions need a code typed into the dialog (D6). Injected script on another page therefore cannot spend money, even inside a 12-hour session.

### 5.2 Pages

Every list is URL-driven (`?status=&from=&to=&sort=&page=&per=`) unless noted. Every page shows all four states: a loading skeleton, an empty state, an error state with "Try again", and success.

#### `/admin`: Overview (B1)
- **Header:** `PanelHeader` "Operations", with `todayLine` and `SideSwitch`.
- **Health strip** (dot plus word; from `admin_overview.health`):

| Tile | OK when |
|---|---|
| Gateway | heartbeat under 15 min |
| Registry reconcile | last finished under 2 h and no error |
| Catalogue sync, SSL catalogue sync | heartbeat under 8 days and outcome not `refused` |
| Supplier ledger | last successful sync under 3 h |
| Balance snapshot | under 30 min (snapshots every 15) |
| FX | the active rate's age; "N held for review" |
| **Scheduled jobs** | every `cron` job's last run succeeded, and `email-notices` succeeded within 26 h; a failing job is named |

- **"Needs a person" tiles:** refunds, jobs, critical alerts, drift, incidents, stuck orders, pending without a job, failed emails, unexplained supplier charges, preset drafts.
- **KPI row** (7 / 30 / 90 days): cash in, net sales, VAT, orders paid, registrations, renewals, transfers in, SSL sold, line refunds, charge refunds.
- **Float tiles:**
  - "$43.38 · about N days at the last 7 days' spend (30-day pace: M days)".
  - Or "Runway unknown — the supplier ledger was last read at 14:15 WAT (then about N days)".
  - Or "No spend in the last 7 days".
  - Or "Short by $X for work already paid for".
  - A **"21-day target"** tile: "Keep $Y (21 days of spend); top up $Z." (FR-FLOAT-4).
- **Charts:** net sales by day; balance close by day with a dashed alert line; renewals due over the next 6 months; domains by status.
- **Lists:** the latest 10 audit entries and the latest 10 orders.
- **Empty state:** "No paid orders on this side yet."
- **Actions:** none.

#### `/admin/orders`, `/admin/orders/[id]` (B2)
**List:** `orders`, with the customer from `admin_customers` masked and linked.

| Columns | Order no. + Test badge · Placed · Customer (masked) · Kind · Items · Total · Status · Paid · Invoice · Float check |
|---|---|
| Filters | status chips; kind; from/to; "Stuck only"; `?line=<order_item_id>` |
| Search | GET `q` for an order number, `MDH-` tx_ref, `INV-` invoice or domain; email search lives on Customers only |
| Default | `created_at.desc` |

- A funnel strip from `admin_funnel`, with cart adds "counted since <date>".

**Detail:**
- A summary `<dl>`.
- **Lines** (`order_items` plus embedded `order_item_costs`): cost shown as "$11.31 + $0.20 ICANN (recorded at checkout)" or "not recorded".
- **Payments from `admin_payments_v`**: fee and absorbed come from the view, so no `raw` is read.
- Refunds, incidents, the `supplier_calls` trace and the `domain_events` timeline.

**Actions:** none.

#### `/admin/refunds`, `/admin/refunds/[id]`, `/admin/refunds/incidents` (B3)
**List and stats:** as v1. Stats come from `admin_refund_stats`, including `limits`.

**Detail:**
- Summary, the **Playbook card**, limits (both from `limits`), payment, provider, and the timeline.
- Buttons are shown by status, playbook and role. **Cancel is shown only to the owner.**

**Incidents:** the list defaults to unresolved. "Mark resolved" opens the structured dialog.

**Actions** (`actions/refunds.ts`, `actions/incidents.ts`). Copy lives in `lib/refunds-copy.ts`, which **builds every limit figure from `limits`** (never a literal amount):

**1. Approve** (money, `refund.approve`)
- **Title:** "Approve this refund?"
- **Rows:** Order · For · Amount · Held because:
  - `OVER_SINGLE_LIMIT`: "Over the ₦{single} automatic limit per refund".
  - `OVER_DAILY_LIMIT`: "Over the ₦{daily} daily automatic limit — ₦{sent24h} already sent in the last 24 hours".
- **Body:** "The worker sends it to the card or account that paid on its next run, after reading the charge back from Flutterwave. It stops if the charge isn't this order's."
- **Reason:** required. **Code:** required.
- **Buttons:** **[Approve ₦X refund]** / **[Keep it held]**

**2. Retry** (money, `refund.retry`; the owner for a cancelled refund)
- **Title:** "Send this refund again?"
- **Body:** "Only after checking Flutterwave shows no refund for this charge. The worker reads the charge's refunds before sending."
- **Warning:** "Retrying approves it: the ₦{single} per-refund and ₦{daily} daily automatic limits won't hold it again."
- **Required check** (when a provider call is recorded): "I checked the Flutterwave dashboard: no refund of this charge went through."
- **Reason and code:** required.
- **Buttons:** **[Retry ₦X refund]** / **[Not now]**

**3. Cancel** (money, owner, `refund.cancel`)
- **Title:** "Cancel this refund?"
- **Body:** "Use this only when we won't send this money back — for example, the customer's bank reversed the charge (a chargeback), so the money returned without us. If we sent it from the Flutterwave dashboard, use Record a Flutterwave refund instead. If the domain turned out to be registered, retry the registration job: that records it and cancels the refund."
- **Note:** required, at most 300 characters, label "What happened".
- **Required checks:** "We haven't returned this money through Flutterwave, and won't." Plus, when a provider call is recorded: "I checked the Flutterwave dashboard: no refund of this charge went through."
- **Type to confirm:** the order number. **Code:** required.
- **Buttons:** **[Cancel refund — nothing sent]** / **[Keep refund]**

**4. Record a Flutterwave refund** (money, `refund.record_manual`). Two steps:
1. "Flutterwave refund id" plus **[Check with Flutterwave]** (`checkFlutterwaveRefund`, standard tier). It shows: "Flutterwave refund 123: ₦19,672.50 on charge 456, completed — matches this refund", or each mismatch in words.
2. The record button is enabled only for a matching `done` check under 15 minutes old.

- **Body:** "Nothing is sent. The customer's order page will show ₦X as refunded."
- **Required check** (when a provider call is recorded): as for cancel.
- **Reason and code:** required.
- **Buttons:** **[Record ₦X as refunded]** / **[Cancel]**

**5. Resolve incident** (`incident.resolve` or `incident.resolve_money`)
- **Title:** "Mark this incident resolved?"
- **For owed kinds,** choose one outcome:
  - "The payment is now recorded" (unrecorded payment only).
  - "A refund for this order completed" (pick it).
  - "A Flutterwave refund I checked just now" (the step-1 check).
  - Owner only: "Handled outside the dashboard", with the required check "I confirmed in Flutterwave that the customer has their money or their order, and recorded what happened in the SQL editor."
  - Code required.
- **Other kinds:** "This records that you've looked at it. Nothing is charged or refunded."
- **Reason:** required.
- **Buttons:** **[Mark resolved]** / **[Not yet]**

After success, re-read the refund and show its new status and timeline event.

#### `/admin/queue`, `/admin/queue/jobs/[id]`, `/admin/queue/ssl-jobs/[id]` (B4)
- **Tabs, columns, filters, stats:** as v1. The pending-without-a-job note is kept.
- **`RefreshWhile`** (10 s) runs while a listed job is `queued` or `running`.

**Job detail:**
- Summary, the playbook card, the line with its refund status, the call trace, and the timeline.
- **"Read the registry now"** (`lookupDomain`): "Read at 14:05 WAT: not in our account" or "in our account, expires …".
- **Transfers:** **"Read the transfer state"** (`readTransferState`): "Read at 14:05 WAT: refused by the registry on 30 Sept" or "landed — record it in the SQL editor (DEPLOY §6)".
- **`NOT_RENEWABLE` renewals:** **"Check renewability"** (`checkRenewable`).

**Actions** (`actions/jobs.ts`; copy in `lib/jobs-copy.ts`):

**Retry** (money, `job.retry`). Offered for `needs_attention` and failed jobs, **except a failed transfer**, which shows: "A failed transfer can't be retried: its transfer code was deleted. The customer starts a new transfer."
- **Title:** "Try the registration of example.com again?" (by kind)
- **Body by kind:**
  - Failed registration: "The worker reads the registry first: if example.com is already in our account it is recorded, not bought again. Its pending refund of ₦X is cancelled first; this is refused if that refund has reached Flutterwave."
  - `needs_attention` registration, including `PAYMENT_NOT_VERIFIED`: "The worker re-reads the charge from Flutterwave and the registry, and registers only if both allow it."
  - Renewal: "The worker compares the registry's expiry with the one stored before renewing, and renews only if it hasn't moved."
  - Waiting transfer: "The worker reads the transfer's state; once submitted it never sends the code again."
  - Settings: "The worker reads the registry, makes the change if it's still needed, and records what the registry shows."
  - SSL: "If the order was already sent, the worker only reads its status — it never buys twice."
- **Reason and code:** required.
- **Buttons:** **[Retry]** / **[Not now]**

**Fail** (money, `job.fail`).
- Offered only for `needs_attention` jobs of kind `register_domain`, `transfer_domain`, `set_transfer_lock` (a lock only), `set_privacy` or `update_contacts`.
- **Not** offered for `last_error_code = PAYMENT_NOT_VERIFIED`, `renew_domain`, `apply_nameservers` or a pending unlock. The page shows: "Only Retry is offered: stopping this could block a transfer-out, or leave a change half-recorded."
- **Precondition panel:** "Read the registry (or the transfer state) in the last 15 minutes, after the last registration attempt", plus the read button and its last result. It also shows the supplier ledger: "Ledger last read 14:15 WAT; no charge for example.com since this job started."
- **Registration:**
  - **Title:** "Fail the registration of example.com and refund ₦X?"
  - **Body:** "The line fails, the customer is told nothing was bought, and a refund of ₦X is queued to the card or account that paid."
  - **Button:** **[Fail and refund ₦X]**
- **Transfer:**
  - **Title:** "Fail the transfer of example.com and refund ₦X?"
  - **Body:** "The registry refused it, so the domain didn't move to us. The customer is told and a refund of ₦X is queued."
- **Settings:**
  - **Title:** "Stop this transfer lock change?" (or the privacy or contacts equivalent)
  - **Body:** "The change is dropped; the domain keeps what the registry shows. The customer can ask again."
  - **Button:** **[Stop the change]**
- **Reason, type-to-confirm (the domain) and code:** required.

**Fail certificate order** (money, `ssl_job.fail`; only when not yet sent, and never for `PAYMENT_NOT_VERIFIED`): as v1.

#### `/admin/alerts` (B5)
Tabs and contents as v1, with one addition. **Health** adds the scheduled jobs: each cron job's schedule, last run, last status and last success, from `admin_overview.health.cron`. A test admin sees no cron panel.

#### `/admin/supplier` + `/ledger`, `/calls`, `/lookup`, `/catalogue` (B6)

**Balance:**
- Tiles from `admin_float`, all in cents:
  - the latest snapshot (with its side);
  - committed (with "N older lines not costed" when relevant);
  - burn over 7 and 30 days;
  - runway on 7-day burn (or unknown, none, or short-by);
  - the 21-day target and the top-up needed;
  - the alert level.
- Charts: daily close over 90 days (`metrics_daily` plus snapshots), and daily debits and credits from `admin_ledger_daily`.
- **Top-ups:** Date · USD · NGN paid · Effective ₦/$ (numeric) · Reference · Recorded by · Corrected.
  - Rows not yet recorded offer **"Record what it cost"**.
  - Recorded rows offer **"Correct"** (owner).
- **"Read live balance":** "$43.38 at 14:05 WAT on live (snapshot 14:00: $43.38)".

**Ledger:**
- The mirror table, with revisions in `<details>`.
- Filters and a chain strip.
- **"Search the live ledger"** (a POST).

**Calls, Lookup:** as v1. Lookup adds "Read the transfer state" and "Check renewability". For a test admin, the price check shows the `TEST_ADMIN` words.

**Catalogue:** preview and apply are owner-only.

**Owner actions** (`actions/supplier.ts`; copy in `lib/supplier-copy.ts`):

**Apply price list** (money, owner, `supplier.catalogue_apply`)
- **Flow:** the dialog code, then `admin_note`, then the gateway POST (which claims the note), then `revalidateTag('pricing',{expire:0})`.
- **Body:** "This is the weekly sync, run early: it writes only changes it trusts, refuses a listing that looks broken, and reports the rest. Site prices update on the next refresh."
- **Buttons:** **[Apply price list]** / **[Not now]**

**Record top-up cost** (money, owner)
- **Rows:** Ledger credit $36.00 on 1 Oct · NGN paid · Reference · Effective rate ₦X/$ against costing ₦Y/$.
- **Buttons:** **[Record top-up]** / **[Cancel]**

**Correct a top-up** (money, owner)
- **Title:** "Correct what this top-up cost?"
- **Body:** "The first record stays in history, marked as corrected."

#### `/admin/money` (B7)
- Grain links and a date range.
- **Table and bars from `admin_revenue`:** Net sales · VAT · Cash in · **Line refunds** (and the VAT returned with them) · **Charge refunds** (duplicates, overpayments, underpayments, empty orders; these reduce cash in only) · Flutterwave fees · Fees we absorbed.
- **Margin table from `admin_margin`:** Lines · Costed · Revenue · Cost · Margin · Source, plus an optional "Cost at the last top-up rate" column.
  - A **"Supplier cost on failed or refunded lines"** row shows `row_kind = 'lost'`.
  - Caption: "Margin is shown at the rate we charged, and only for lines whose cost is known — matched to DomainNameAPI's ledger, or recorded at checkout. N lines sold before costs were recorded are left out."
- An aggregate CSV with the formula guard.

#### `/admin/customers`, `/admin/customers/[id]` (B8)
- **Stats** from `admin_customer_stats`. A test admin sees "Not shown to test administrators."
- **List** from `admin_customers`, paged and sorted in SQL:

| Columns | Customer (`shortId` + type) · Email (masked) · Joined · Domains held · Orders paid · Total paid · 2FA · Last sign-in · Admin badge |
|---|---|
| Sorts | joined, domains, orders, paid, last sign-in |
| Default | joined desc |

- **Search:** the POST action `findCustomers` (operator) → `admin_find_customers`. It returns masked rows and never uses `?q=`.
- **Detail** from `admin_customer`:
  - Route tabs (Overview · Domains · Orders · Certificates · Emails) read through `adminDb` by `user_id`, side-filtered.
  - **"Show contact details"** (operator, `revealCustomer` → `admin_reveal_customer`, optional reason). Title "Show this customer's contact details?"; body "Your view is recorded in the audit log."
  - The details live in client state and are cleared when the page is left.

#### `/admin/domains`, `/admin/domains/[id]` (B9)
- **Stats** from `admin_domain_stats`. The registry renewal mode is labelled "Registry renewal mode 'AutoRenew' (the supplier's label; automatic renewal isn't available to our account, BACKLOG L18)". It is not presented as a risk.
- **List** from `admin_domains_v`: v1's columns and filters.
- **Detail:**
  - The "Ours vs Registry" diff, drift, nameserver history, jobs and the timeline.
  - Registrant verification.
  - **The registrant summary (country, type) comes from the view.** **"Show registrant"** (operator) calls `admin_reveal_registrant`.
  - **"Queue a deep sync"** is offered only on live, syncable domains (`active`, `expired_grace`, `redemption`).
    - **Title:** "Read example.com from the registry on the next sync?"
    - **Body:** "The next deep sync, within an hour, reads it and corrects our record from the registry. Nothing changes at the registry."
  - On test domains, the page shows "No sandbox gateway is reading test domains right now, so nothing would read it" whenever the `gateway:ote` heartbeat is stale.

#### `/admin/ssl`, `/admin/ssl/[id]` (B10)
- As v1, reading `admin_ssl_certificates_v`.
- The approver is `approver_masked`. `csr`, `contact` and `approver_email` are never selected.
- Term wording comes from `SSL_TERM`.

#### `/admin/emails` (B11)
- As v1.
- **Outbox** reads `admin_email_outbox_v` (`masked_to`, `last_error_safe`).
- **Compliance** reads `admin_compliance_notices_v`.
- **"Send again"** (operator, standard): not offered for bounced or complained rows.

#### `/admin/pricing`, `/admin/pricing/fx` (B12)
**Inputs:**
- `pricing_settings` is shown in full. **VAT is read-only:** "VAT is a statutory rate; it's changed in the SQL editor."
- The edit form covers margin (₦1,000–₦50,000), FX buffer, ICANN fee (cents) and move threshold.
- The save dialog is unchanged except for the code field. Then `revalidateTag('pricing')`.

**FX:**
- Pending rows show the stored and recomputed move, plus **both quote times**.
- A row older than 48 h, or older than the active rate, shows "Too old to activate — the daily job will fetch a fresh one" and offers Reject only.

**Activate** (money, owner)
- **Title:** "Charge at ₦1,523.40 to the dollar?"
- **Rows:** Current ₦1,328.10 (quoted …, since …) · New ₦1,523.40 (source, quoted …) · Move +14.7% · Effect ".com: ₦X → ₦Y first year".
- **Body:** "Every price on the site changes on the next refresh, within minutes. Orders already placed keep their rate."
- Code required. Then `revalidateTag('pricing')`.

**Reject:** as v1, with the code.

#### `/admin/settings` + `/extensions`, `/ssl-products`, `/presets`, `/presets/[id]`, `/admins` (B13)

**Limits.** The `ops_settings` form shows the **11** columns, grouped Refunds · Orders · Velocity · Float. Inputs show their bounds ("up to ₦1,000,000"). Save is money tier, owner.
- **Title:** "Change 2 limits?"
- **Rows:** before → after.
- When a refund limit rises or the delay falls: "Refunds already held stay held until someone approves them. Raising a refund limit sends a Telegram notice."
- When a refund limit falls: "Refunds already queued are judged against the new limit when the worker picks them up."
- **Buttons:** **[Save limits]** / **[Cancel]**

**Extensions:**
- As v1. **"Held domains" comes from `admin_tld_held_counts`.**
- Pause, Resume and Feature dialogs as v1, with the code. Each is followed by `revalidateTag('pricing')`.

**SSL products:**
- As v1. Sellable-on is refused for a product with no price: "DomainNameAPI lists no price for this product yet."

**Presets:**
- **List:** Provider · Nameservers · Per-zone · Source · Verified · Health · Hidden (by a person / by the checker) · **blast radius from `admin_preset_usage`** · Open draft.
- **Save a change** (money, owner, `preset.draft_save`):
  - **Title:** "Save a draft of <provider>'s nameservers?"
  - **Body:** "Customers keep seeing the current nameservers. The draft is checked in public DNS (now, or within 6 hours); then you publish it. The source must be <provider>'s own documentation."
  - **Button:** **[Save draft]**
- **Check now** (owner, standard): "Checked at 14:05 WAT: both hosts answer."
- **Publish** (money, owner):
  - **Title:** "Publish <provider>'s new nameservers?"
  - **Rows:** before → after · last check.
  - **Body:** "Every checkout, host pick and bulk change that uses <provider> sends domains to these nameservers from the next refresh. A Telegram notice is sent."
  - **Button:** **[Publish]**
- **Hide** (operator):
  - **Title:** "Hide <provider>?"
  - **Body:** "N domains use it now; they keep their nameservers. Customers stop seeing it as a choice within a minute."
- **Show again** (money, owner): as v1.
- Publish, Hide and Show are each followed by **`revalidateTag('nameserver-presets', { expire: 0 })`**.
- Registrar-default rows are read-only.

**Admins** (from `admin_list_admins`):
- Label · Role · Test only · Added · Revoked · Pinned devices ("2 linked, 2 active" / "1 of 2 removed") · Last change.
- A test admin sees only their own row.
- **Note:** "Admins and their linked devices are changed in the SQL editor (DEPLOY.md §6b). Every change sends a Telegram alert."

#### `/admin/audit` (B14)
- **Columns:** When · Admin (label + Test badge) · Action · Target (linked) · Side · Reason (or "Redacted on …") · Result · Request id.
- **An `intent` row shows its gateway result inline** ("Read: ok", "Refused: TOO_SOON", or "No result recorded").
- **Filters:** action prefix chips, outcome, label, dates, `?id=`.
- `<details>` per row shows `detail`.
- **Owner only:** **"Redact reason"** (money).
  - **Title:** "Remove the reason text from this entry?"
  - **Body:** "Only the typed reason is removed; who did what, when, and the amounts stay. The removal is recorded."
- A test admin sees only test rows.

### 5.3 Mobile, dark mode, accessibility and indexing
As v1:
- Cards below `xl`; every control `h-11`; no overflow from 320 to 1920 px.
- Existing tokens only.
- Words on every pill; charts as `role=img` with data tables; captions, `scope` and `aria-sort`; counts inside accessible names.
- Axe reports no violations.
- `robots: PRIVATE`, `X-Robots-Tag`, and the 404 for non-admins.

Added: the dialog's code field has a visible label and `autoComplete="one-time-code"`.

---

## 6. Metrics

All metrics are filtered by side (live by default), exclude `source = 'demo'`, use WAT buckets, and are in kobo or integer cents.

| Metric | Definition | Source | Page |
|---|---|---|---|
| Net sales | `sum(orders.subtotal_kobo)` where `payment_id is not null`, by `paid_at` | `admin_revenue`, `admin_overview` | Overview, Money |
| VAT collected | `sum(orders.vat_kobo)`, same filter | same | same |
| Cash in | `sum(payments.amount_kobo)` by `payments.created_at`, **side from `orders.test_mode` via `payments.order_id`**; includes duplicates and overpayments | same | same |
| Line refunds | Completed refunds with `order_item_id is not null`, by `completed_at`. They reduce net sales by `order_items.price_kobo`, and VAT by `amount_kobo − price_kobo`. | same | Overview, Money, Refunds |
| Charge refunds | Completed refunds with `order_item_id is null` (`duplicate_charge`, `overpayment`, `underpayment`, `empty_order`). They reduce cash in only, carry no VAT, and never touch net sales. | same | same |
| Flutterwave fees | `admin_payments_v.fee_kobo`; absorbed when `charged_kobo = amount_kobo` | `admin_revenue` | Money |
| Gross margin ("at the rate charged") | Per completed paid line: `price_kobo − cost_kobo`, where `cost_kobo = round(cost_cents × costing_rate)` and `cost_cents` is the matched debit (`−delta_cents`), else `supplier_cost_cents + icann_fee_cents`, else not costed. Optional `cost_topup_kobo` uses the latest top-up's effective rate. `lost` rows show matched debits on failed or refunded lines. | `admin_margin` | Money |
| Funnel | As v1 | `admin_funnel` | Orders, Money |
| Stuck orders, Provisioning, Pending without a job, Refund health | As v1 | as v1 | as v1 |
| Float balance | The latest snapshot of the gateway's side (every 15 min after A), in cents | `admin_float` | Overview, Supplier |
| Committed float | Open `register`/`renew`/`transfer` jobs (transfers only before `submitted_at`) and unsent `ssl_initialize`. Each uses `order_item_costs` (supplier plus ICANN) when recorded; otherwise today's price by the rules of `wholesaleCostUsd` / `renewalCostUsd` / `transferCostUsd` / `sslCostUsd` (first term at the register rate, later years at renew, transfer × 1), plus `icann_fee_usd × years` (× 1 for a transfer) on non-country-code extensions. The count of lines priced at today's prices is shown. | `admin_float` | Overview, Supplier |
| Burn and runway | Burn = settled ledger debits (`status = 1`, `delta_cents < 0`) over 7 and 30 days. **Runway = (balance − committed) ÷ (burn₇ / 7).** It is **null** when burn₇ = 0. It is **unknown** (with the last known value and time) when the ledger heartbeat is over 3 h old or the mirror holds under 7 days. When balance < committed, it shows short-by. There is no fallback to line costs. | `admin_float` | Overview, Supplier |
| 21-day target | `21 × burn₇ / 7 + committed`; top-up needed = target − balance (FR-FLOAT-4) | `admin_float` | Overview, Supplier |
| Float cover alert | Runway below 10 days is a warning; below 3 days is critical (FR-FLOAT-2) | `ledger_alert_conditions` | Telegram |
| Top-ups | Ledger credits joined with current `float_topups`; rate = `ngn_paid_kobo::numeric / usd_cents` | `admin_float` | Supplier |
| Unexplained supplier charges | Count of `ledger_unexplained`, `ledger_double` and `ledger_refunded_line` | `admin_attention_counts` | Overview, Supplier |
| Supplier spend trend | Daily debits and credits from the mirror (never purged) | `admin_ledger_daily` | Supplier |
| Customers | As v1 (live only) | `admin_customer_stats` | Customers |
| Domains and expiries | As v1. The registry renewal mode is a label only (L18). | `admin_domain_stats` | Domains, Overview |
| Email, Alerts, Catalogue and FX, SSL | As v1, plus cron health | as v1 | as v1 |

**New tracking**, all built in this project:
1. **`order_item_costs` at order creation (B15).**
   - `place-order.ts`, `place-renewal.ts`, `place-renewals.ts` and `place-transfer.ts` insert the lines, then one `order_item_costs` row per line through the service client.
   - The costs come from `lineCostUsd()` in `features/checkout/lib/cost.ts`, which returns `{supplierCents, icannCents}`. It uses `wholesaleCostUsd`, `sslCostUsd`, and the refactored `renewalCostUsd` (`features/renewals/lib/renewal.ts`) and `transferCostUsd` (`features/transfers/lib/start.ts`).
   - If that insert fails, the error is logged and the line stays uncosted. The order still stands.
   - No backfill.
2. **`funnel_daily` `cart_add`** via `bump_funnel` (B15). Fire-and-forget. No search counts.
3. **The ledger mirror** (§3.2a, §4.4).
4. **`float_topups`** (owner-entered, correctable).
5. **The `metrics_daily` rollup.**

---

## 7. Ledger reconciliation

1. **Source of truth.**
   - `deposit/transactions`, mirrored hourly on the gateway's side. Every read sends both `StartDate` and `EndDate` and overlaps the last by a day.
   - Spend is `balance − oldBalance` in integer cents, **never `amount`**.
   - Times go through `supplierDate()`. Trace ids are GUIDs, stored lower-case.
2. **Classification.**
   - Top-ups (5/0/3).
   - Domain debits (product type 1).
   - SSL debits (product type 2).
   - **Unclassified:** anything else, `status ≠ 1`, or an unmatched debit whose description is not a bare domain name. Unclassified entries are kept, shown raw and alerted (warning), and never counted.
   - **A re-read that changes `status` updates it and re-classifies. Any other change is kept as a revision and alerted (`supplier_ledger_changed`).** The first sighting is never frozen silently.
3. **Matching.**
   - A debit is tied to the nearest money-spending call (`RegisterWithContactInfo`, `Renew`, `Transfer`, `SslInitialize`, `SslReissue`; `ok` or `unknown`) on the same environment. The description must equal or contain the name, inside the timing window.
   - Then it goes through the job to the line. The match is persisted.
   - Proven live for registrations. **Renewal and transfer description shapes are unverified.** Until one is seen, an unmatched non-registration-shaped debit is `unclassified`, not `unexplained`.
4. **Exceptions:**

| Exception | Severity | Meaning |
|---|---|---|
| `supplier_unexplained_charge` | critical | A registration-shaped debit with no matching call after 2 h: supplier panel use, a leaked key, or a supplier-side change. Automatic renewal is off for our account per BACKLOG L18; verify with the supplier if this fires. |
| `supplier_double_charge` | critical | Two debits on one call or one line. |
| `supplier_charge_on_refunded_line` | critical | The supplier charged for a line we failed or refunded. |
| `supplier_missing_charge` | warning | A completed live line with no debit 6 h after its job finished. |
| `supplier_price_drift` | warning | The debit differs from the recorded supplier cost by more than 1 cent. |
| `supplier_ledger_unclassified` | warning | An entry we can't classify, or one not yet settled. |
| `supplier_ledger_changed` | warning | The supplier changed a past entry's facts. |
| `supplier_ledger_gap` | warning | A broken balance chain, or a snapshot taken between the last entry and the last complete read that disagrees with it. |
| `supplier_ledger_stale` | warning | No successful read in 3 h. |
| `float_low_cover` | warning / critical | Under 10 / 3 days of cover at 7-day burn. |

   All of them reach Telegram with admin links (§4.5).
5. **Balance cross-check.** Snapshots every 15 min must agree with the ledger's running balance inside each read window. The current chain 0 → 15 → 3.69 → 18.69 → 7.38 → 43.38 agrees.
6. **Margin and burn** use matched debits as the actual cost of goods (§6).
7. **Not in v1:** matching on supplier `productId` / `domainId`.

---

## 8. Testing and docs

### 8.1 Tests
- **Unit (Vitest, `apps/web`, 80%):**
  - `list-params`; `format` (WAT, mask, USD cents; `maskEmail` matches the documented SQL mask); `labels`; `tone`; `errors` (every code has words); `playbook` (every DEPLOY §6 code; `PAYMENT_NOT_VERIFIED` offers Retry only).
  - `actions.ts`: every action used by an action file has an entry.
  - Each `*-copy.ts`: exact strings; **limit figures are interpolated from non-default limits, never literal**; N8 renewal shown.
  - `session.ts`:
    - `adminDb` refuses an unbranded object and has no write method;
    - it applies the side filter for every table kind;
    - for a test admin it forces `test` and throws `TEST_ADMIN` on a table without a side filter.
  - `safe-action` admin clients:
    - `needs_code` gives the "Confirm it's you" wording;
    - `useValidated` order (no note before validation);
    - the money client verifies the code with the session's factor before calling the wrapper, and refuses a wrong code with no RPC;
    - role pre-check.
  - `callAdminGateway`: logs `logPath` (the template) and never the filled path.
- **Component tests:**
  - `DataTable` and `FilterChips` as v1.
  - `ConfirmAction`:
    - reason required; type-to-confirm; the code field for money actions;
    - **a new `requestKey` after a refused answer and the same key after a network error**;
    - Cancel focused first; the step-up link.
  - Charts as v1.
- **Static test** (`features/admin/__tests__/foundation/boundaries.test.ts`):
  - every file in `queries/**` and `actions/**` starts with `import 'server-only'` or `'use server'`;
  - no `.select('*')`;
  - **no select string names one of these whole column names** (word-boundary match, so `idempotency_key` passes): `auth_code`, `raw`, `csr`, `contact`, `contacts`, `registrant`, `pending_registrant`, `pending_contacts`, `to_email`, `recipient`, `approver_email`, `delivery_detail`, `data`, `private_key`, `secret`, `key`. `key` is allowed only in `queries/alerts.ts` (`ops_alerts.key`);
  - `.from()` names appear only as keys of `ADMIN_TABLES`, and `ADMIN_TABLES` equals the list in §2.3;
  - writes are only `.rpc('admin_*')`;
  - no service-client import outside `session.ts`;
  - every `.select(` takes a string or template literal with nothing interpolated (`session.ts`'s own `select(list, …)` excepted), names no `PRIVATE_COLUMNS` entry (the list above plus `email`, `phone`, `full_name`, `business_name`, `tax_id`, `contact_profile_id`), and embeds nothing but the table's side parent by plain names;
  - each sensitive projection in the §9 table (and `admin_reveal_*`, `admin_find_customers`) appears only in the area paths of the package it is given to; Package A's shared files may use `admin_attention_counts` and define `checkFlutterwaveRefund`.
- **SQL:** `supabase/tests/admin.sql` and `admin_data.sql` (§3.3).
- **Gateway:** §4.6, plus MSW handlers for every `/v1/admin/*` route in `apps/web/tests/mocks/handlers.ts`.
- **E2E (Playwright):**
  - The mock gateway gains `/v1/admin/*` handlers with PII-free bodies. It does not claim notes, which are covered by gateway tests.
  - `screenshot`, `video` and `trace` are off for every admin spec.
  - Runs on `SIGN_IN_PROJECTS` only, with `createAdminTestUser` and `signInAsAdmin`.
  - Money dialogs type `freshTotpCode(totpSecret)`.
  - The Test side is forced.
  - Seeds: `seedPaidTestOrder`, `settleRegistration` / `settleSslOrder`, and the §3.2j helpers (`hold_test_refund`, `seed_test_failed_email`, `record_supplier_ledger(true, …)` with `e2e-` descriptions).
  - Teardown calls `purge_test_ledger_entries()`.
  - Axe and no overflow at 320 / 375 / 768 / 1024 / 1440 / 1920.
- **`tests/e2e/admin.spec.ts` (A):**
  - signed-out and non-admin users get a 404 at `/admin` and `/admin/refunds`, and no admin text renders;
  - an enrolled admin reaches the dashboard after `/verify`;
  - **a signed-in admin at `/sign-in?next=/admin` lands on `/admin`**;
  - an aal1 session goes to `/verify`;
  - the sidebar shows `aria-current`; the test banner is visible;
  - `X-Robots-Tag` is present, and **the CSP on `/admin` has a nonce and no `'unsafe-inline'` in `script-src`**;
  - `/admin` is not in robots.txt.

### 8.2 Docs (Package A)
**CLAUDE.md** (§5 changes in the same commit as migration 40):
- **§5:** `(admin)/` becomes "Back-office: admins table checked in SQL, two-factor (ADR-006)".
- **§8:**
  - Add `adminAction` / `adminMoneyAction` rows.
  - Add a row under Reading: "Admin reads use `adminDb(principal, side)` from `features/admin/queries/session.ts` — select-only service reads over a fixed table and view map with the side filter applied — or `admin_*` SQL functions. RLS does not apply to them; the map and the SQL functions are the control."
- **§9:** replace the DNS row as in v1, and add: "`domains/transfers/query` and `domains/renew/check` are POST reads, used only by `/v1/admin/*`."
- **§11:** the two SQL check commands.
- **§15 new rows:**
  1. **Admins are a table, checked in SQL; each action's tier lives in `admin_tier`.** *Don't:* add an admin claim, an RLS bypass, a role or freshness parameter, or an admin check only in web code.
  2. **Admin writes are `admin_*` wrappers called with the session client. They record refusals and return JSON. Every new function is revoked from `public, anon, authenticated, service_role` and granted once.** *Don't:* write a table from admin code, rely on default grants, or grant refund functions to `service_role`.
  3. **Admin pages never call the supplier on render; live reads are audited notes the gateway claims.** *Don't:* poll, use `priority: 'high'`, or call `/v1/admin/*` without a note.
  4. **The supplier ledger's `amount` is always 0, and `deposit/transactions` ignores `StartDate` without `EndDate`** (with both, it filters by whole day; seen 2 Oct 2026). Spend is `balance − oldBalance` in cents, and times are UTC+3. *Don't:* sum `amount`, send `StartDate` alone, or parse `creationTime` with `new Date()`.
  5. **Supplier trace ids are GUIDs, not RFC 9562 UUIDs.** One live top-up has version nibble `b`, and debits are upper-case. Validate with `z.guid()` and lower-case before storing. *Don't:* use `z.uuid()` on supplier ids.
  6. **Supplier cost is service-only (`order_item_costs`).** Customers can read `order_items`. *Don't:* add a cost or margin column to a table a customer can read.
  7. **Admin e2e runs without failure artifacts, on the Test side, as `test_only` admins.**
  8. **Customer search and reveal are POSTs to SQL functions, rate-limited and audited.** *Don't:* put an email in an admin URL.
  9. **Admin logs carry route templates.** *Don't:* log a filled admin path.
- **§14:** a pointer to this spec.

**docs/PRD.md** (§12.2 changes in the same commit as migration 40):
- Add ADR-006 to §6.
- Change the §12.2 hard rule to: "Admin authorisation is the `admins` table checked in SQL (`admin_session`), with no claim and no RLS bypass (ADR-006)." Update the policy column of the table.
- Mark the §17 modules shipped or deferred.

**docs/DEPLOY.md:**
- **New §6b "Admin access":**
  - the §2.6 SQL and re-pinning every device;
  - the `admin_changed` alert;
  - `GATEWAY_ADMIN_SECRET` (`openssl rand -hex 32`, on Fly and Vercel, never in chat);
  - deploy order;
  - **`SUPABASE_ACCESS_TOKEN` and the database password are never set in CI or Vercel.**
- **Rewrite the §6 "When an alert arrives" table** with an "In the dashboard" column naming the page and button for each row. Rows marked **SQL editor only**:
  - a landed transfer (`complete_transfer`);
  - an unrecorded payment (`record_order_payment`);
  - closing a `PAYMENT_NOT_VERIFIED` job;
  - `vat_pct`;
  - registrar-default presets;
  - adding or removing preset source domains;
  - admins.

  The SQL editor stays as the fallback when the dashboard is down.
- **§5b:** the deploy order.

**docs/BACKLOG.md:**
- Remove line 83 when B3 lands.
- **Owner tasks:**
  1. Sign off ADR-006. Then enrol yourself (DEPLOY §6b), pinning every device, and set `GATEWAY_ADMIN_SECRET`.
  2. In Supabase → JWT Keys, confirm the legacy JWT secret is revoked (the JWKS shows an ES256 key; check nothing still uses the legacy anon or service keys first). Keep `SUPABASE_ACCESS_TOKEN` out of CI and Vercel. L9 (rotate the database password) still applies.
  3. Ask DomainNameAPI:
     - the meanings of ledger `type`, `status`, `chargeType` and `productType`, and whether entries change after creation;
     - the `creationTime` zone;
     - whether the $0.20 ICANN fee is billed separately;
     - the description format of renewal and transfer debits;
     - the `transfers/query` status values.
  4. Decide whether to count searches, without their terms (FR-S7).
  5. Decide on the deferred §17 modules (D20).

  The AutoRenew question is **not** repeated: L18 answered it.

---

## 9. Work packages

**Merge rules.**
- Package A lands first, in four tracks (A-db, A-gw, A-web, A-docs) that merge together.
- Every B package branches from the merged A and owns **only** its listed files.
- Only A touches shared files.
- A B package that needs SQL or a shared change raises a follow-up for A (migration 42).
- **With the functions and views in §3.2h–j, no B package needs one.**

Each B package's area paths:
- `app/(admin)/admin/<area>/**`
- `features/admin/components/<area>/**`
- `features/admin/queries/<area>.ts`
- `features/admin/actions/<area>.ts`
- `features/admin/lib/<area>-*.ts`
- `features/admin/schemas/<area>.ts`
- `features/admin/__tests__/<area>/**`
- `tests/e2e/admin-<area>.spec.ts`

**Sensitive projections each B package may use** (everything else is banned by the boundaries test):

| Package | Permitted sensitive reads |
|---|---|
| B1 | `admin_overview`, `admin_attention_counts`, `admin_float` |
| B2 | `admin_payments_v` (fee, charged, absorbed), `order_item_costs` (embedded), `admin_customers` (masked email) |
| B3 | `admin_refund_stats.limits`, `checkFlutterwaveRefund` results (ids and amounts) |
| B4 | `admin_domains_v`, `AdminTransferState`, `AdminRenewCheck` |
| B5 | `ops_alerts.key` (in `queries/alerts.ts`), `admin_overview.health.cron` |
| B6 | `admin_float`, `admin_ledger_daily`, `supplier_ledger_entries`, `supplier_ledger_revisions`, `float_topups` |
| B7 | `admin_revenue`, `admin_margin` |
| B8 | `admin_customers`, `admin_customer`, `admin_find_customers`, `admin_reveal_customer` |
| B9 | `admin_domains_v` (`registrant_country`, `registrant_type`), `admin_reveal_registrant` |
| B10 | `admin_ssl_certificates_v` (`approver_masked`, `certificate_pem`, `ca_bundle_pem`) |
| B11 | `admin_email_outbox_v` (`masked_to`, `last_error_safe`), `admin_compliance_notices_v` (`masked_recipient`) |
| B12 | `admin_pricing_status` |
| B13 | `admin_tld_held_counts`, `admin_preset_usage`, `admin_list_admins`, `nameserver_preset_drafts` |
| B14 | `admin_audit_log` (side-filtered by `adminDb`) |

### Package A: Foundation (must land first, after the ADR-006 sign-off)
**Owns:**
- **Database:** both migrations and both SQL check files; `packages/db/src/database.types.ts`.
- **Shared:** `packages/shared/src/admin/{supplier.ts, ledger.ts, alert-href.ts, money.ts (usdToCents), index.ts}` and tests; `packages/shared/package.json` (`./admin`); `packages/shared/src/email/notices.ts`, adding `NOT_AT_REGISTRY` ("The registry did not register it, so nothing was bought."), `TRANSFER_REFUSED` ("The registry refused the transfer, so the domain did not move to us."; added if missing), `STOPPED_BY_ADMIN` ("We stopped this change. Your domain keeps the settings the registry shows.") and `FAILED_BY_ADMIN` ("The certificate was not ordered, so nothing was bought."). No existing wording changes.
- **Gateway:** `apps/gateway/src/admin/**`, `ledger/**`, `presets/**` (drafts), `{app.ts, server.ts, env.ts}`, `alerts/{format.ts, store.ts}`, and tests.
- **Web infrastructure:** `apps/web/src/proxy.ts`, **`apps/web/next.config.ts`** (the CSP source excludes `/admin`), `lib/{safe-action.ts, env.ts, gateway.ts}`, `lib/supabase/{server.ts, cookies.ts}`, `features/auth/lib/{use-signed-in.ts, signed-in-hint.ts}`; the root **`turbo.json`** (`GATEWAY_ADMIN_SECRET` passed through like the shared secret).
- **Components:** `components/layout/{app-sidebar.tsx, app-sidebar-client.tsx}`, `components/common/{refresh-while.tsx, action-parts.tsx}`, import updates, `components/ui/textarea.tsx`.
- **Admin routes:** `app/(admin)/admin/{layout.tsx, error.tsx}` and every placeholder; `features/admin/README.md`.
- **Admin shared code:**
  - `features/admin/lib/{actions,list-params,format,labels,tone,playbook,errors,side,href,gate}.ts`, `schemas/common.ts`;
  - `queries/{session,attention,gateway}.ts`, `actions/{side,supplier-live}.ts`;
  - the shared components; `__tests__/foundation/**`.
- **Tests and CI:** `apps/web/tests/mocks/handlers.ts`, `tests/e2e/support/{accounts.mjs, admin.ts, admin-seed.mjs, mock-gateway.mjs, global-teardown.mjs}`, `tests/e2e/admin.spec.ts`, `playwright.config.ts`, `.github/workflows/ci.yml`.
- **Docs:** `CLAUDE.md`, `docs/PRD.md`, `docs/DEPLOY.md`, `docs/BACKLOG.md`.
- **Clean-up:** deleting the empty `app/(admin)/admin/{float,abuse,catalogue,presets}` folders. Git does not track empty folders, so no commit removes them: `rmdir` them in the main checkout when Package A is merged.

**Acceptance:**
- Both SQL files pass against the hosted project, **including the ACL loops**.
- `pnpm typecheck`, `lint` and `test:coverage` pass. `admin.spec.ts` passes.
- **The gateway:**
  - serves `/v1/admin/supplier/balance` for a claimed note;
  - refuses with the secret alone, and refuses a reused or expired note;
  - logs no filled admin path.
- **The ledger sync records the 5 live entries**, including the non-RFC GUID and the upper-case traces. They are matched or classified as top-ups, and no ledger alert is raised.
- **`domains/renew/check` is proven on OTE** to change neither the balance nor the expiry (read before and after) before its route is enabled. Otherwise the route stays off and `NOT_RENEWABLE` shows only the playbook text.
- The 3 stale test alerts have cleared.
- The owner can sign in through `/sign-in?next=/admin` and see placeholders.
- `sessions.spec.ts`, `accounts.spec.ts` and `two-factor-required.spec.ts` still pass after the httpOnly change.
- **A hard gate before any B package deploys (BACKLOG A8):** once migrations 40–41 are applied, both SQL files run standalone, `admin.spec.ts` passes on `chromium-desktop` and `mobile-ios` with zero skips, and both admin DB tests pass with zero skips — `step-up.db.test.ts` approving a refund held by `hold_test_refund` through `admin_approve_refund` after a step-up (D6, D8).

| Package | Owns (its area paths) | Acceptance tests |
|---|---|---|
| **B1 Overview** | `app/(admin)/admin/page.tsx`, `components/overview/**`, `queries/overview.ts`, `lib/overview-*.ts`, `__tests__/overview/**`, `tests/e2e/admin-overview.spec.ts` | **Unit:** health thresholds, including cron; the runway wording for known, stale, no-spend and short-by; KPI links. **E2E:** tiles on the Test side; every "needs a person" tile links with its filter; charts have sr-only data; axe; overflow. |
| **B2 Orders** | `orders/**`, `queries/orders.ts`, `__tests__/orders/**`, `tests/e2e/admin-orders.spec.ts` | **Unit:** list params. **E2E:** a seeded order appears; sort and paging; the detail shows lines with renewal prices, recorded cost, payments with fees (from the view) and the call trace; `?q=` never takes an email. |
| **B3 Refunds & incidents** | `refunds/**`, `queries/refunds.ts`, `actions/{refunds,incidents}.ts`, `lib/refunds-copy.ts`, `schemas/refunds.ts`, `__tests__/refunds/**`, `tests/e2e/admin-refunds.spec.ts` | **Unit:** the exact copy for all dialogs, with limits interpolated from non-default values; playbook offers; the record step stays disabled without a matching check. **E2E:** seed a paid test order → `settleRegistration(…,'failed')` → `hold_test_refund` → Approve through the dialog (reason + code) → status `queued`, one `ok` audit row. A double submit gives one row. A wrong code is refused and nothing changes. Cancel is not shown to an operator. |
| **B4 Queue** | `queue/**`, `queries/queue.ts`, `actions/jobs.ts`, `lib/jobs-copy.ts`, `__tests__/queue/**`, `tests/e2e/admin-queue.spec.ts` | **Unit:** copy by kind; Fail is hidden for renew, `apply_nameservers`, a pending unlock and `PAYMENT_NOT_VERIFIED`; failed-transfer retry copy. **E2E:** a failed test registration → Retry (code) → `queued` and the refund cancelled; Fail without a fresh read gives the `READ_REGISTRY_FIRST` words; "Read the registry now" shows the mock's line; "Read the transfer state" shows the mock's state; the pending-without-job tab. |
| **B5 Alerts & health** | `alerts/**`, `queries/alerts.ts`, `__tests__/alerts/**`, `tests/e2e/admin-alerts.spec.ts` | **Unit:** tab params. **E2E:** every tab renders; links go through `adminHrefForAlertKey`; the Test-side note; no dismiss control; the cron panel is hidden for a test admin. |
| **B6 Supplier** | `supplier/**`, `queries/supplier.ts`, `actions/supplier.ts`, `lib/supplier-copy.ts`, `__tests__/supplier/**`, `tests/e2e/admin-supplier.spec.ts` | **Unit:** runway formatting; match labels; rate maths in numeric kobo-per-cent; preview report rendering from fixtures. **E2E (mock gateway, side test):** "Read live balance" shows the mock value and writes one `supplier.balance` intent row. The ledger renders `e2e-` mirror rows. The live search is a POST. Catalogue preview, apply and price check show the test-admin or owner-only words. |
| **B7 Money** | `money/**`, `queries/money.ts`, `__tests__/money/**`, `tests/e2e/admin-money.spec.ts` | **Unit:** grain and range params; the margin caption; line vs charge refund columns. **E2E:** grain switching; the source column and the `lost` row; the CSV formula guard. |
| **B8 Customers** | `customers/**`, `queries/customers.ts`, `actions/customers.ts`, `__tests__/customers/**`, `tests/e2e/admin-customers.spec.ts` | **E2E (test admin):** stats show "Not shown to test administrators"; the list holds only `e2e-` profiles, masked; a search by the test user's exact email is a POST (the URL holds no `@`); "Show contact details" reveals and writes a `customer.reveal` row; leaving clears it. |
| **B9 Domains** | `domains/**`, `queries/domains.ts`, `actions/domains.ts`, `lib/domains-copy.ts`, `__tests__/domains/**`, `tests/e2e/admin-domains.spec.ts` | **E2E:** filters; the detail diff. "Queue a deep sync" on a test domain shows the `NO_GATEWAY` wording or succeeds, depending on the `gateway:ote` heartbeat the spec reads first. Verification from the mock. The registrant summary shows; the full registrant is hidden until revealed. |
| **B10 SSL** | `ssl/**`, `queries/ssl.ts`, `__tests__/ssl/**`, `tests/e2e/admin-ssl.spec.ts` | **E2E:** list and detail (skipped when `hasSslSchema()` is false); "Check status now"; the approver masked; no "valid for a year". |
| **B11 Emails** | `emails/**`, `queries/emails.ts`, `actions/emails.ts`, `__tests__/emails/**`, `tests/e2e/admin-emails.spec.ts` | **E2E:** recipients masked; **a failed email seeded with `seed_test_failed_email`** → "Send again" → `pending`; not offered for a bounced row; the compliance tab is read-only. |
| **B12 Pricing & FX** | `pricing/**`, `queries/pricing.ts`, `actions/pricing.ts`, `lib/pricing-copy.ts`, `__tests__/pricing/**`, `tests/e2e/admin-pricing.spec.ts` | **Unit:** the impact line uses the shared pricing functions; a rate older than 48 h, or older than the active one, offers Reject only (fixtures). **E2E (test admin; no FX row is seeded):** the page renders whatever FX state exists; VAT is read-only; Save and Activate are refused with the role words; nothing changes. |
| **B13 Settings** *(decided 3 Oct 2026: `nameserver_preset_drafts` is `publicSafe` — it holds no customer data — so the B13 e2e reads drafts as a test admin; `ops_settings` and `service_heartbeats` stay refused to test admins.)* | `settings/**`, `queries/settings.ts`, `actions/{settings,extensions,ssl-products,presets}.ts`, `lib/settings-copy.ts`, `schemas/settings.ts`, `__tests__/settings/**`, `tests/e2e/admin-settings.spec.ts` | **Unit:** pause copy; the 11-field limits form with bounds; the preset draft form; `revalidateTag('nameserver-presets', { expire: 0 })` after publish, hide and show. **E2E:** extensions filter, with held counts; the pause dialog needs type-to-confirm; a test admin is refused; the preset list shows blast radius and drafts; the admins page shows only the test admin's own row with its pinned-device state. |
| **B14 Audit** | `audit/**`, `queries/audit.ts`, `__tests__/audit/**`, `tests/e2e/admin-audit.spec.ts` | **E2E:** rows from earlier steps appear (a side switch does not audit; a lookup writes an intent row); filters by prefix and outcome; `detail` expands; no edit controls for an operator. |
| **B15 Instrumentation** | `features/checkout/actions/place-order.ts`, `features/renewals/actions/{place-renewal,place-renewals}.ts`, `features/transfers/actions/place-transfer.ts`, `features/cart/actions/{cart,ssl}.ts`, `features/checkout/lib/cost.ts` (`lineCostUsd()` → `{supplierCents, icannCents}`), **`features/renewals/lib/renewal.ts`** (`renewalCostUsd`), **`features/transfers/lib/start.ts`** (`transferCostUsd`), and their existing tests | **Unit:** per-line cents equal the pre-flight total summed, cent-exact, for register (including .ai 2-year), renew, transfer and SSL; the ICANN share is split out; a failed cost insert never fails the order; `bump_funnel` is called once per add and a failure never fails the add. **Integration:** inserted lines get `order_item_costs` rows; `order_items` gains no cost column. The existing checkout, renewals, transfers and cart e2e suites stay green. |

**Deploy order** after all packages merge:
1. Migrations 40 and 41.
2. The gateway with `GATEWAY_ADMIN_SECRET`.
3. The web.
4. The owner enrols (DEPLOY §6b).

---

## Decisions the owner should know
1. **Sign off ADR-006 before building starts.** Admins become a database table checked in SQL. This replaces the PRD's JWT-claim rule.
2. **Every money action asks for a fresh authenticator code** inside its dialog. This covers refunds, job fails and retries, prices, FX, limits, presets, the catalogue and top-ups. Viewing needs a code within the last 12 hours.
3. **Link all your authenticator devices when you enrol.** Each enrol, re-link or removal sends a critical Telegram alert. That alert is how you know nobody else did it.
4. **The SQL editor stays the place for:**
   - recording a landed transfer or an unrecorded payment;
   - closing a `PAYMENT_NOT_VERIFIED` job;
   - VAT;
   - registrar-default presets;
   - preset source domains;
   - admins.
5. **Only you can do these:**
   - cancel a refund;
   - retry or record a refund that was cancelled;
   - change prices, limits or presets;
   - redact an audit reason.

   Operators can approve and retry refunds, fail and retry jobs, and look up customers. Each customer search or reveal is audited and limited to 30 an hour.
6. **Refund limits now have hard ceilings:** ₦1,000,000 per refund and ₦5,000,000 a day, with a delay of at least 5 minutes. Margin cannot go below ₦1,000. Raising a limit sends a Telegram notice.
7. **A Flutterwave refund can be recorded only after the dashboard reads it from Flutterwave** and it matches this payment and this amount.
8. **Preset changes are drafts.** A draft is published only after a public-DNS check and a second confirmation from you. Every change sends a Telegram notice.
9. **Float runway uses the last 7 days of spend** (the PRD rule). It shows "unknown" when the supplier ledger is stale. It alerts at 10 days and pages at 3. A 21-day target tile shows how much to top up.
10. **Please check three things yourself:**
    - The legacy JWT secret is revoked in Supabase (the new ES256 key is live).
    - `SUPABASE_ACCESS_TOKEN` stays out of CI and Vercel.
    - The database password rotation (L9) is still pending.
11. **Questions for DomainNameAPI:**
    - the meanings of the ledger fields;
    - how renewal and transfer debits are described;
    - the transfer-status values;
    - whether the ICANN fee is billed separately.

    Until a renewal debit has been seen, unmatched non-registration charges raise warnings, not critical alerts.