# Product Requirements Document
## Domain Reseller Platform — Next.js + Supabase + DomainNameAPI

| Field | Value |
|---|---|
| Version | 1.0 (Draft for review) |
| Date | 20 September 2026 |
| Status | Awaiting sign-off |
| Supplier | DomainNameAPI (Atak Domain / Atakonline Ltd, Türkiye) |
| Stack | Next.js 16.x (App Router), Supabase (Postgres/Auth/Storage), TypeScript |
| Primary market | Nigeria, expanding to West/Sub-Saharan Africa |
| v1 scope | Search → Register → Manage (DNS + nameservers) → Renew → Transfer |

> **How to read this document.** Every factual claim about ICANN policy, registry pricing, supplier capability or payment fees was verified against primary sources during research on 20 Sept 2026; sources are in [§21](#21-sources). Claims I could **not** verify without a live reseller account are marked **[VERIFY]** and collected into a Day-0 checklist in [§19](#19-day-0-verification-checklist). Do not begin implementation of any **[VERIFY]** item until it is confirmed.

---

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [The single most important finding](#2-the-single-most-important-finding)
3. [Market, users and jobs to be done](#3-market-users-and-jobs-to-be-done)
4. [Competitive research: how the leaders actually work](#4-competitive-research-how-the-leaders-actually-work)
5. [Supplier reality: DomainNameAPI capability matrix](#5-supplier-reality-domainnameapi-capability-matrix)
6. [Architecture decisions forced by supplier gaps](#6-architecture-decisions-forced-by-supplier-gaps)
7. [Regulatory and compliance requirements](#7-regulatory-and-compliance-requirements)
8. [Commercial model: pricing, FX, margin](#8-commercial-model-pricing-fx-margin)
9. [Scope: in and out for v1](#9-scope-in-and-out-for-v1)
10. [Domain lifecycle state machine](#10-domain-lifecycle-state-machine)
11. [Functional requirements](#11-functional-requirements)
12. [Data model](#12-data-model)
13. [Technical architecture](#13-technical-architecture)
14. [Security requirements](#14-security-requirements)
15. [Design system and UX](#15-design-system-and-ux)
16. [Transactional messaging](#16-transactional-messaging)
17. [Admin back-office](#17-admin-back-office)
18. [Analytics, KPIs and instrumentation](#18-analytics-kpis-and-instrumentation)
19. [Day-0 verification checklist](#19-day-0-verification-checklist)
20. [Risks and mitigations](#20-risks-and-mitigations)
21. [Sources](#21-sources)
22. [Appendices](#22-appendices)

---

## 1. Executive summary

### 1.1 What we are building

A consumer and SMB-facing domain registration storefront and control panel for the Nigerian market, reselling DomainNameAPI's 800+ TLD wholesale catalogue under our own brand. Users search for a domain, pay in Naira, and get a self-serve control panel to manage DNS, nameservers, contacts, privacy, renewals and transfers.

### 1.2 Why this can win

The Nigerian market is served today by a mix of (a) international registrars that price in USD and settle poorly on Nigerian cards, and (b) local hosts whose domain products are bolted onto WHMCS with dated UX and manual support loops. A product that combines *international-registrar-grade UX* with *local payment rails and Naira pricing* has a clear opening.

### 1.3 The three things that will make or break it

1. **We do not run DNS — a deliberate decision, not a gap.** DomainNameAPI exposes nameserver delegation and glue records but **no DNS zone/record CRUD**. Rather than build authoritative DNS, v1 ships a *delegation* product: customers point the domain at their web host's nameservers, and our job is to make that take fifteen seconds and verify it worked. The trade-offs are real and are set out in [§6.1](#61-dns-decision-adr-001).
2. **Money moves in two currencies and one direction.** We collect NGN from customers; we pay the supplier in USD from a prepaid balance. Every registration is a foreign-currency purchase funded from a float we have to keep topped up, in a country with FX friction. The pricing engine, the float monitor and the FX buffer are core product, not finance admin. See [§8](#8-commercial-model-pricing-fx-margin).
3. **Domain registration is irreversible and non-refundable.** A payment that succeeds while a registration fails is a support incident and a chargeback. The order saga, idempotency and reconciliation design in [§13.4](#134-the-order-saga) is the highest-risk engineering surface in the product.

### 1.4 Success criteria for v1

| Metric | Target at 90 days post-launch |
|---|---|
| Search → checkout conversion | ≥ 6% |
| Checkout → successful registration | ≥ 98.5% |
| Registrations stuck in manual reconciliation | < 0.5% of orders |
| p75 availability-search response | < 800 ms |
| Auto-renew opt-in rate at checkout | ≥ 70% |
| Nameservers supplied at checkout | ≥ 35% |
| Nameservers delegated and verified within 7 days of registration | ≥ 60% |
| Failed renewals due to float exhaustion | 0 |
| Chargeback rate | < 0.4% of transaction value |

---

## 2. The single most important finding

I pulled DomainNameAPI's live WSDL (`https://api.domainnameapi.com/DomainApi.svc?wsdl`) and their official Node.js SDK source, and enumerated every operation the API exposes. The complete list is in [Appendix A](#appendix-a-complete-domainnameapi-operation-map).

**There is no DNS record management in the API.** The two DNS-adjacent endpoints are:

- `PUT domains/dns/name-server` — replaces the *delegation* (which nameservers the registry points at)
- `POST|PUT|DELETE domains/dns/host` — child nameservers / glue records

There is no create/read/update/delete for A, AAAA, CNAME, MX, TXT, SRV, CAA or NS records inside a zone.

DomainNameAPI *does* operate free DNS hosting — their default nameservers are `tr.apiname.com` and `eu.apiname.com` (verified: they resolve to 185.46.43.65 and 188.245.192.34). But zone records on that service are editable **only in their reseller panel**, which our customers will never see and which we cannot drive programmatically.

**Consequence:** we cannot sell a DNS record editor on top of this supplier. Pointing customer domains at `*.apiname.com` would mean every MX change arrives as a support email and gets typed by hand into a Turkish supplier panel. That is not a product.

There are two ways out: **(a)** run our own authoritative DNS behind branded nameservers, or **(b)** don't sell DNS at all — delegate to whatever the customer already uses and make that handoff excellent. **v1 takes option (b).** [ADR-001](#61-dns-decision-adr-001) sets out why, and what we give up for it.

A second finding of the same class: **there is no availability-suggestion engine, no WHOIS/RDAP lookup, and no bulk-domain-search beyond a cartesian product of names × TLDs.** Those are also ours to build. See [§6.2](#62-name-suggestion-engine-adr-002) and [§6.3](#63-rdap-lookup-adr-003).

---

## 3. Market, users and jobs to be done

### 3.1 Target segments

| Segment | Share of v1 focus | Characteristics |
|---|---|---|
| **Founders and solo builders** | 40% | Registering their first 1–3 domains. Price-sensitive on the headline, not on renewal. Need hand-holding on DNS. Pay by card or transfer. |
| **Agencies and web developers** | 35% | Register on behalf of clients. 10–200 domains. Care about bulk operations, fast DNS, API access (v2), and not being embarrassed in front of a client. High LTV. |
| **SMBs and churches/schools/NGOs** | 25% | One domain, often `.com.ng` or `.org.ng`. Renewal is the whole relationship. Need reminders that actually arrive. Often pay by bank transfer. |

### 3.2 Personas

**Tobi — founder, 27, Lagos.**
Building a fintech. Wants `getpaid.ng` or something close. Has tried three international registrars; two declined his card, one charged him $14.99 for a `.com` he thought was $9.99. Jobs: *"Find a name that isn't taken and doesn't look cheap"*, *"Pay with the card I actually have"*, *"Point it at Vercel without reading a tutorial"*.

**Ada — agency technical lead, 34, Abuja.**
Manages 60+ client domains across four registrars. Jobs: *"See everything expiring in the next 60 days on one screen"*, *"Change nameservers for 12 domains without 12 page loads"*, *"Never be the reason a client's site goes dark"*.

**Pastor Emeka — administrator, 52, Enugu.**
Renews `church.org.ng` once a year, usually late, usually after the site has already gone down. Jobs: *"Tell me before it breaks, in a way I'll see"*, *"Let me pay by transfer"*, *"Don't make me remember a password"*.

### 3.3 Jobs to be done (ranked)

1. Find an available name I actually like, fast, with honest pricing.
2. Pay in my currency with my instrument, and know it worked.
3. Make the domain point somewhere — the first DNS change is the moment of truth.
4. Not lose the domain. Ever. Renewal reminders and auto-renew that work.
5. Move a domain in or out without a support ticket.
6. Prove I own it (contacts, privacy, transfer lock, auth code).

### 3.4 Anti-goals

- We are not a hosting company in v1. No cPanel, no site builder.
- We are not an aftermarket/brokerage in v1.
- We are not chasing the domain-investor segment (bulk 500+ registrations, drop-catching, backorders). Their unit economics need registrar accreditation, not reselling.

---

## 4. Competitive research: how the leaders actually work

I studied the current behaviour of Namecheap, Porkbun, Spaceship, Cloudflare Registrar, Dynadot and GoDaddy. Patterns worth copying, and patterns worth deliberately rejecting.

### 4.1 Search and discovery

| Pattern | Who does it | Our position |
|---|---|---|
| Availability *as you type*, debounced, exact match first | Instant Domain Search, Spaceship, Namecheap | **Adopt.** Exact-match card renders first with a skeleton; TLD grid streams in behind it. |
| A grid of alternate TLDs with prices inline | All | **Adopt.** But show *renewal* price on the card, not only first-year. |
| AI/semantic name suggestions | GoDaddy, Namecheap, Spaceship | **Adopt a lightweight version.** See [§6.2](#62-name-suggestion-engine-adr-002). Not an LLM in the hot path in v1. |
| Bulk search (paste a list / upload CSV) | Dynadot, NameSilo, Instant Domain Search | **Adopt for v1** — it is Ada's headline feature and cheap to build on `CheckAvailability`. |
| Front-running protection (searches never leak to third parties) | Instant Domain Search markets this explicitly | **Adopt and say so publicly.** Our searches hit our supplier, which is unavoidable, but we never sell, log-share or syndicate search data. Put it in the privacy policy and on the search page. |
| Premium/aftermarket names mixed into results | GoDaddy (aggressively), Namecheap | **Adopt with restraint.** Registry premiums are flagged by the supplier (`IsFee`, `ClassKey`). Show them, label them clearly, never let a premium price surprise someone at checkout. |

### 4.2 Pricing presentation — where most registrars lose trust

The single most-cited complaint across reviews of every major registrar is renewal-price shock: a `.com` advertised at a low first-year price that renews at 2–3×.

- **Namecheap** discloses the ICANN fee as a separate line at checkout rather than burying it. Reviewers consistently call this out as a genuine trust signal.
- **Porkbun** and **Cloudflare** compete explicitly on *renewal* price rather than first-year, and say so.
- **Cloudflare Registrar** sells at cost with no markup, which reframes the whole category — we cannot match it and should not pretend to.

**Our position — non-negotiable product rules:**

1. Every price display shows **first year and renewal** together, always, everywhere. Search cards, cart, checkout, receipts.
2. The ICANN fee ($0.20/yr on gTLDs) is a **separate, labelled line item**, not baked into the headline.
3. No pre-ticked add-ons in the cart. Ever.
4. If a domain is a registry premium, the card says "Premium" before the user clicks, and the renewal price (which for premiums is usually also premium) is shown at the same size as the first-year price.

### 4.3 Checkout

- **Add-on panel with nothing pre-selected** (Namecheap's approach) is the standard to beat. GoDaddy's pre-ticked upsells are the anti-pattern.
- **Auto-renew defaults on** at every major registrar, with a clear, one-click off. Adopt — it is genuinely in the user's interest — but disclose it in plain language on the same screen, not in terms.
- **Registration period selector** (1–10 years) with the multi-year saving shown. Adopt; note supplier enforces `MinRegistrationPeriod`/`MaxRegistrationPeriod` per TLD.

### 4.4 The control panel

- **Spaceship** currently sets the UX bar: fast search, clean results, a dashboard that does not require a tutorial.
- **Porkbun** lands users directly on domain management with search, portfolio, labels and bulk tools visible immediately — not on a marketing dashboard.
- **Namecheap** leads on account security, supporting hardware security keys (U2F/FIDO2) for 2FA.
- **Cloudflare** leads on DNS API quality.

**Our position:** land on the portfolio, not a dashboard. Labels and bulk actions from day one (Ada's job #2). Security keys in v1.1, TOTP in v1.0.

### 4.5 What nobody does well, that we can

1. **Naira-native pricing with a stable, published FX policy.** Every international registrar either prices in USD or applies an opaque conversion.
2. **Renewal reminders that reach Nigerian users.** Email-only reminders fail here. WhatsApp and SMS as first-class reminder channels is a genuine differentiator for the Pastor Emeka segment.
3. **Bank transfer as a real checkout path**, not a "contact us" fallback — with automatic reconciliation via Flutterwave virtual accounts rather than a human matching receipts.
4. **Pointing the domain, done properly.** Every registrar gives you two text fields and a shrug. We ship a searchable list of hosts that fills the nameservers for you, validation that catches typos before they cost a day, and verification that actually confirms the delegation took and is answering. It is the first-timer's hardest moment and currently nobody's product.

---

## 5. Supplier reality: DomainNameAPI capability matrix

Everything in this section was verified directly against the live WSDL and the official SDK source on 20 Sept 2026.

### 5.1 Identity and endpoints

| Item | Value | Verified |
|---|---|---|
| Legal operator | Atakonline Domain Hosting Internet and Information Technologies Ltd | ✅ (payment-options page) |
| REST production | `https://api.domainresellerapi.com/api/v1` | ✅ (responds 401 unauthenticated) |
| REST sandbox (OTE) | `https://ote.domainresellerapi.com/api/v1` | ✅ (responds 401 unauthenticated) |
| SOAP legacy | `https://whmcs.domainnameapi.com/DomainApi.svc` and `https://api.domainnameapi.com/DomainApi.svc` | ✅ (WSDL retrieved) |
| Official Node SDK | `npm i nodejs-dna` — v3.0.0, Apache-2.0 | ✅ |
| Default DNS nameservers | `tr.apiname.com`, `eu.apiname.com` | ✅ (resolve) |
| Abuse contact | `domain@apiname.com` | ✅ |
| Catalogue size | "800+ TLDs" (marketing claim) | ⚠️ marketing |

### 5.2 Authentication

Two credential schemes, auto-detected by the SDK from the username format:

| Credentials | Transport | Notes |
|---|---|---|
| Reseller ID (UUID) + API Key | **REST** | Current scheme. Obtained in panel → API Settings. **Use this.** |
| API username + password | SOAP | Legacy. SOAP has **no sandbox** — it always hits production. Avoid. |

Credentials are passed in the request body on SOAP (`BaseMethodRequest.UserName` / `.Password`). **[VERIFY]** the exact REST auth header shape against the live account.

### 5.3 What the API can do

| Capability | Operations | v1 use |
|---|---|---|
| Availability | `CheckAvailability` (`POST domains/bulk-search`) — names × TLDs cartesian, returns `Price`, `Currency`, `Period`, `IsFee`, `ClassKey`, `Reason` | Core search |
| Catalogue | `GetTldList` — returns `TldInfo` incl. min/max period, min/max chars, `EppAllowed`, `IsTransferable`, `IsDocumentRequired`, `RequiredDocumentInfo`, `RedemptionPeriod`, `Country`, full price matrix by `TradeType` | Nightly catalogue sync |
| Register | `RegisterWithContactInfo` (`POST domains/register-with-contacts`) — 4 contacts, NS list, period, EPP lock, privacy, `AdditionalAttributes` | Core |
| Renew | `Renew` (`POST domains/renew`) | Core |
| Transfer in | `CheckTransfer` → `Transfer` → `QueryTransfer` / `CancelTransfer` | Core |
| Transfer out | `ApproveTransfer`, `RejectTransfer`, `ModifyAuthCode` | Core |
| Nameservers | `ModifyNameServer` | Core |
| Glue records | `Add/Modify/Delete/GetChildNameServer(s)` | Core |
| Contacts | `GetContacts`, `SaveContacts`, `ModifyContacts` | Core |
| Privacy | `ModifyPrivacyProtectionStatus` | Core |
| Transfer lock | `EnableTheftProtectionLock` / `DisableTheftProtectionLock` | Core |
| Auth code | `ModifyAuthCode` | Core |
| Auto-renew mode | `ModifyRenewalMode` | Core |
| Status | `ModifyStatus` (add/remove EPP status strings) | Admin only |
| Portfolio | `GetList` (paged, filter by status/dates), `GetDetails`, `GetDetailsFromRegistry` | Reconciliation |
| Sync | `Sync`, `SyncFromRegistry` | Reconciliation |
| Restore | `Restore` (RGP redemption) | Core |
| Delete | `Delete` | Admin only |
| URL forwarding | `CreateForward`, `ModifyForward`, `DeleteForward`, `GetForward` (`STANDART` / `FRAME`) | v1.1 |
| Account | `GetResellerDetails`, `GetCurrentBalance` (`GET deposit/accounts/me`) | Float monitor |

### 5.4 What the API cannot do — gaps we must fill

| Gap | Impact | Fill |
|---|---|---|
| **No DNS zone/record CRUD** | We cannot sell managed DNS on this supplier | Don't. Delegation-only product — [ADR-001](#61-dns-decision-adr-001) |
| **No name suggestions** | Search is functional but not delightful | Build suggestion engine — [ADR-002](#62-name-suggestion-engine-adr-002) |
| **No WHOIS/RDAP lookup** | Cannot show ownership data, cannot pre-validate transfers | Query registrar RDAP directly — [ADR-003](#63-rdap-lookup-adr-003) |
| **No DNSSEC operations** | Cannot offer DNSSEC | Out of scope v1; document as known limitation. **[VERIFY]** whether DS records can be set via panel/support |
| **No webhooks or event stream** | We cannot be *told* about transfer completions, expiries, registry status changes | Poll. Scheduled reconciliation — [§13.5](#135-reconciliation-and-drift) |
| **No idempotency keys** | Retrying a failed `Register` risks a double registration | Client-side idempotency + pre-flight `GetDetails` — [§13.4](#134-the-order-saga) |
| **No documented rate limits** | Unknown blast radius under load | **[VERIFY]**. Assume conservative limits; token-bucket all outbound calls |
| **No test-mode for SOAP** | Legacy transport is production-only | Use REST + OTE exclusively |

### 5.5 Two supplier behaviours that will bite us

**1. Egress IP allowlisting.** The SDK documents error code `API_301 — IP address not authorized`. This implies DomainNameAPI allowlists reseller egress IPs. **Next.js on Vercel and Supabase Edge Functions both have dynamic egress IPs.** If allowlisting is enforced, neither can call the supplier directly.

**Mitigation (design for it either way):** all supplier calls go through a single **registrar gateway service** on infrastructure with a static egress IP (a small Fly.io machine with a dedicated IPv4, a Railway/Render service with static egress, or a VPS). Nothing else in the system talks to DomainNameAPI. This is good architecture regardless — it gives us one place for rate limiting, retries, idempotency, audit logging and credential custody. **[VERIFY]** whether allowlisting is mandatory or optional.

**2. Default-on telemetry in the SDK.** `nodejs-dna` reports errors to the vendor's Sentry instance by default. The README states credentials are scrubbed and domain names are tagged but not used as grouping keys. Under NDPA this is a third-country transfer of processing metadata we did not authorise.

**Requirement:** construct the client with `{ telemetry: false }`, and assert it in a unit test so nobody removes it.

```ts
const api = new DomainNameApi(RESELLER_ID, API_KEY, {
  testMode: process.env.DNA_ENV !== 'production',
  telemetry: false, // REQUIRED — NDPA. Covered by test: gateway/dna-client.test.ts
});
```

### 5.6 Supplier funding and float

Registration is settled against a **prepaid balance**, not invoiced. Running out means `API_350 — Insufficient reseller balance` and a hard registration failure after we have already taken the customer's money.

Verified top-up methods and fees:

| Method | Fee | Settlement time |
|---|---|---|
| Bank transfer (TRY or USD, Garanti/TRNC, SWIFT `TGBATRISXXX`) | 0% | Up to 10 days |
| Credit card (Visa/Mastercard, TRY or USD) | 2% | Immediate |
| Stripe | 3.5% | Immediate |
| AliPay | 3.5% | Immediate |
| PayPal | 6.3% + $0.30 + cross-border variable | Manual (support ticket required) |

Tiering: reseller pricing improves by tier (Reseller → Premium → Platinum → VIP), driven by portfolio size and/or deposit volume. **[VERIFY]** our current tier and the tier thresholds.

**Product requirements arising:**
- **FR-FLOAT-1**: Poll `GetCurrentBalance` every 15 minutes; store a time series.
- **FR-FLOAT-2**: Alert at **10 days of projected cover** (based on trailing 7-day burn), page at **3 days**.
- **FR-FLOAT-3**: Pre-flight balance check before accepting payment for any order whose supplier cost exceeds remaining balance; if insufficient, do not take the money — show a graceful "try again shortly" and alert ops.
- **FR-FLOAT-4**: Because bank transfer (the 0%-fee route) takes up to 10 days, maintain minimum float of **21 days of trailing burn**, topped up weekly.

---

## 6. Architecture decisions forced by supplier gaps

### 6.1 DNS decision (ADR-001)

**Context.** The supplier gives us delegation control but no record control. Customers still need DNS. Two routes: operate authoritative DNS ourselves, or delegate to whatever provider the customer already uses.

**Decision: v1 does not sell or operate DNS.** Customers point the domain at nameservers they already have — in almost every case their web host's, supplied in the host's welcome email or control panel. Our job is to make applying them trivial and to verify they took. `ModifyNameServer` is the entire integration.

**Why this is right for v1**

| Factor | Effect |
|---|---|
| Ops risk | Authoritative DNS is the least forgiving service in this stack. One outage takes every customer's site *and* email down at once. We do not own that on day one |
| Cost | No DNS provider, no anycast, no white-label nameserver fees, no Cloudflare Business plan |
| Build time | Removes the record editor, validation engine, templates, zone import, propagation tooling and provider abstraction — comfortably 4–6 weeks |
| Quality | A customer's host already runs DNS for their site, and platform DNS (Cloudflare, Vercel, Netlify) outperforms anything we would stand up at launch volume |
| Reversibility | Adding managed DNS later is purely additive. Nothing built in v1 has to be unwound |

**What we give up — accept these consciously**

| Cost | Detail | Mitigation |
|---|---|---|
| **A step between buying and working** | The customer must fetch two nameservers from their host and apply them. Much smaller than it sounds — they already have hosting and already have the values — but it is still a step where someone can stall | The preset picker in [FR-D1](#e6--nameserver-setup) makes it a fifteen-second task; the T+3 nudge catches stragglers. Customers with **no** hosting yet are the real drop-off risk, not customers with hosting |
| **Support burden shifts, it does not vanish** | "My email stopped working" is still our ticket, but we no longer hold the zone and cannot fix it | Read-only DNS inspection ([FR-N4](#e7--advanced-delegation)) so support sees exactly what the customer sees |
| **Stale presets break customer sites silently** | If a host changes its nameservers and our preset still carries the old pair, we will confidently point customers somewhere dead | Presets are data with a `verified_at` stamp, re-verified quarterly and auto-hidden when they stop resolving ([FR-D2](#e6--nameserver-setup)) |
| **Lower switching cost** | DNS is the stickiest part of a registrar relationship. Without it, retention rests entirely on price, reminders and support | Makes renewal-price honesty ([FR-RN7](#e8--renewals)) and the reminder stack strategically load-bearing rather than nice-to-have |
| **No parking, no email forwarding, no URL forwarding** | All three need zone control. The supplier's URL forwarding requires *their* nameservers, which we are not using | Deferred until managed DNS exists |
| **Newly registered domains resolve nowhere** | Until the customer delegates, the domain is dark | Honest empty state ([FR-D7](#e6--nameserver-setup)) plus a single nudge at T+3 days ([FR-D8](#e6--nameserver-setup)) |

**Consequences for the build**

- Keep an unimplemented `DnsProvider` interface in the codebase so managed DNS in v1.x is an implementation, not a refactor.
- Build and maintain the nameserver preset catalogue as an ops asset. It is small, it is high-leverage, and it is the difference between "paste two strings" and "pick your host".
- Register with the supplier's default nameservers unless the customer supplied their own at checkout. **[VERIFY]** whether those defaults serve a parking page or simply fail to resolve — it changes the empty-state copy.
- Glue records (`AddChildNameServer`) stay in scope: agencies running their own nameservers need them.
- Track the delegation funnel as a headline metric from week one. If it sags, that is the signal to reconsider.

**Revisit when:** DNS misconfiguration exceeds ~5% of support tickets, or transfers-out to Cloudflare Registrar become measurable — whichever comes first.

### 6.2 Name suggestion engine (ADR-002)

**Decision.** A deterministic, cheap suggestion engine in v1. No LLM in the hot request path.

**Layers, in order, all feeding one `CheckAvailability` batch:**

1. **Exact match** across a curated "hero" TLD set (`.com`, `.ng`, `.com.ng`, `.io`, `.co`, `.app`, `.africa` if available).
2. **TLD spray** — the full catalogue filtered to TLDs we merchandise, ranked by a popularity score we maintain.
3. **Affix rules** — prefix/suffix from a curated wordlist (`get`, `try`, `use`, `hq`, `app`, `hub`, `ly`, `now`) applied to the stem.
4. **Hack/split** — where the stem ends with a TLD string (`bank.ly`, `tri.be`).
5. **Synonym expansion** — a static thesaurus keyed on the stem's head noun.

Rank by: availability → TLD popularity score → price band → string length → brandability heuristic (no digits, no hyphens, ≤ 12 chars).

**v1.1:** an *offline* LLM job that pre-computes suggestion clusters for the top 50k searched stems into a Postgres table, served as a cache hit. Keeps latency and cost out of the request path.

### 6.3 RDAP lookup (ADR-003)

**Context.** ICANN removed the contractual obligation for gTLD registries and registrars to run WHOIS on port 43 on **28 January 2025**. RDAP is now the authoritative source for gTLD registration data. ccTLDs (`.ng` included) are outside ICANN's remit and follow their own registry's rules.

**Decision.** Build a small RDAP client:
1. Resolve the authoritative RDAP base URL from the **IANA RDAP bootstrap registry** (`https://data.iana.org/rdap/dns.json`), cached daily.
2. Query, parse, cache results for 15 minutes.
3. For ccTLDs with no RDAP endpoint (**[VERIFY]** `.ng` specifically), degrade gracefully: show registry status and expiry from our own records, and a "lookup unavailable for this TLD" note rather than a broken page.

**Uses:** the public WHOIS/RDAP lookup page (an SEO asset), pre-transfer validation (is it locked? when does it expire? is it within the 60-day window?), and support tooling.

### 6.4 Registrar gateway (ADR-004)

**Decision.** A dedicated, single-purpose Node service — the only thing in the system holding DomainNameAPI credentials and the only thing making outbound calls to them.

**Responsibilities:**
- Static egress IP (satisfies `API_301` allowlisting)
- Credential custody (supplier keys never reach Vercel or the browser)
- Token-bucket rate limiting per operation class
- Retry with exponential backoff and jitter, **only for idempotent reads**
- Idempotency ledger for writes ([§13.4](#134-the-order-saga))
- Structured audit log of every supplier request/response (redacted) to Supabase
- Circuit breaker — if the supplier is down, orders queue rather than fail
- Normalised error taxonomy — supplier codes mapped to our own

**Interface to the app:** authenticated internal HTTP + a shared secret, called only from Supabase Edge Functions / Next.js server actions. Never from the client.

---

## 7. Regulatory and compliance requirements

### 7.1 Our status: reseller, not registrar

We are a **reseller** of an ICANN-accredited registrar's services (via DomainNameAPI's upstream accreditations). Under the **2013 RAA**, the accredited registrar remains responsible for compliance, but specific obligations flow down to us contractually. If ICANN observes reseller non-compliance, it opens the inquiry with the sponsoring registrar — who will then come to us.

**Hard requirements (all v1 blockers):**

| # | Requirement | Where it lives |
|---|---|---|
| **CMP-1** | Our registration agreement must include all provisions and notices required by the RAA and ICANN Consensus Policies, and must **identify the sponsoring registrar** by name | Terms page + checkout |
| **CMP-2** | Publish, or link to, the **Registrants' Benefits and Responsibilities Specification** | Footer + checkout + post-purchase email |
| **CMP-3** | **Never** display the ICANN logo or describe ourselves as "ICANN-accredited" without written ICANN permission. We are an authorised reseller | Brand guidelines, marketing copy review |
| **CMP-4** | Publish an abuse contact and respond to abuse reports; route to supplier abuse (`domain@apiname.com`) where appropriate | `/abuse` page + inbox + SLA |
| **CMP-5** | Link the UDRP and registrar's transfer dispute policy | Legal pages |

**[VERIFY]** the exact sponsoring registrar name(s) per TLD from DomainNameAPI — this differs by TLD and must be displayed correctly.

### 7.2 Registration Data Policy (in effect 21 August 2025)

ICANN's Registration Data Policy is now fully in force, governing collection, transfer, publication and retention of registration data.

- **CMP-6**: Collect the minimum required registrant data set; do not collect fields the policy does not require.
- **CMP-7**: Registrant contact verification — if the sponsoring registrar sends a verification request, failure to respond **within 15 days** can result in suspension or cancellation. Our product must surface this state prominently (banner, email, SMS) and never let it fail silently. A domain in `pending_verification` gets a persistent red banner in the panel.
- **CMP-8**: Retention and deletion policy documented and implemented for contact records.

### 7.3 Transfer Policy

Current policy (updated 21 February 2024, mandatory compliance from 21 August 2025):

| Rule | Product implication |
|---|---|
| Registrars must provide a unique AuthInfo code per domain and remove transfer locks **within 5 calendar days** of request | Our "get auth code" flow must set expectations; show a timer |
| **60-day lock after registration** — transfers within 60 days of creation may be denied | Disable "transfer out" UI with an explanatory tooltip and the exact unlock date |
| **60-day inter-registrar transfer lock after a change of registrant**, with pre-change opt-out | When editing registrant contact, show an explicit "this will lock transfers for 60 days unless you opt out" dialog — an opt-out checkbox, not buried |
| AuthInfo release cannot be refused solely over a payment dispute | Encode in support policy; no "pay your bill to get your code" |
| Denial reasons are enumerated (fraud, identity dispute, unpaid fees, express objection, recency, UDRP/URS/court order) | Map each to a specific, human-readable failure message |
| Registrars respond to transfer coordination emails within 7 calendar days; TEAC emergency response within 4 hours | Our support SLA must be tighter than the supplier's |

### 7.4 Expired Registration Recovery Policy (ERRP)

Mandatory notification schedule. **These are not marketing emails — they are compliance artefacts and must be independently logged and auditable.**

| Notice | Window | Requirement |
|---|---|---|
| Pre-expiry #1 | **26–35 days** before expiry | Mandatory |
| Pre-expiry #2 | **4–10 days** before expiry | Mandatory |
| Post-expiry | **within 5 days** after expiry, if deleted by registrar | Must include restoration instructions |

**FR-ERRP-1**: A dedicated `compliance_notices` table records every notice with template version, channel, recipient, timestamp and delivery status. Never merged with marketing email logs. Retained 3 years.

### 7.5 Domain lifecycle (registry-enforced)

| Phase | Duration | Our behaviour |
|---|---|---|
| Add Grace Period (AGP) | ~5 days post-registration | Deletion within AGP may be creditable; admin-only, never customer-facing |
| Active | Registration term | Normal |
| **Auto-Renew Grace Period** | ~30–45 days post-expiry (registry/TLD dependent) | Domain may stop resolving. Renew at normal price. Aggressive recovery messaging |
| **Redemption Grace Period (RGP)** | ~30 days | `Restore` operation. Registry restore fees are high (commonly $150–200+). Price transparently, never absorb silently |
| **Pending Delete** | ~5 days | Nothing can be done. Say so plainly |
| Released | — | Available again |

`TldInfo.RedemptionPeriod` is returned per-TLD by `GetTldList` — use it rather than hardcoding 30 days.

### 7.6 Fees we must pass through

| Fee | Amount | Applies to |
|---|---|---|
| ICANN transaction fee | **$0.20 per transaction year** (raised from $0.18 effective 1 July 2025) | gTLD add, renew, transfer that survives the grace period. **Not** ccTLDs (`.ng`, `.co`, `.ai`) |
| Registry fee | Per-TLD, in supplier price matrix | All |
| RGP restore fee | Per-TLD, high | Restores |

**Known upcoming change:** Verisign raises the `.com` wholesale registry fee from **$10.26 to $10.97 (+6.9%), effective 1 November 2026 at 04:00 UTC** — six weeks after this document's date. `.net` is contractually allowed up to 10% annual increases through mid-2029.

**FR-PRICE-1**: The pricing engine must support **scheduled future price changes** with an effective timestamp, so the 1 Nov 2026 `.com` change is loaded in advance and applies automatically. Do not build a system that needs a manual price edit at 04:00 UTC.

### 7.7 Nigeria Data Protection Act 2023 (NDPA)

We process personal data of Nigerian data subjects — registrant names, addresses, phones, emails — and transfer it out of Nigeria (to a Turkish supplier, and onward to registries worldwide). This is squarely in scope.

| # | Requirement | Detail |
|---|---|---|
| **CMP-9** | **Registration with the NDPC** as a Data Controller of Major Importance | Triggered at >200 data subjects in 6 months — we will cross this quickly. Register within 6 months of attaining the status |
| **CMP-10** | **Appoint a Data Protection Officer** with demonstrable data protection expertise | Named person, contactable, published |
| **CMP-11** | **Cross-border transfer basis** | Transfers to DomainNameAPI (Türkiye) and onward to registries need a lawful basis — contractual clauses in the supplier agreement providing adequate protection. Review the DomainNameAPI reseller agreement for data protection terms; if absent, request an addendum |
| **CMP-12** | Technical and organisational safeguards | Encryption at rest and in transit, pseudonymisation where possible, access control, audit logging, backup/recovery, periodic assessment |
| **CMP-13** | Periodic compliance audits and **Compliance Audit Returns (CAR)** filed with NDPC | Annual process, owner assigned |
| **CMP-14** | Privacy notice, lawful basis per processing purpose, DSAR handling (access, rectification, erasure where lawful) | `/privacy` + a working DSAR workflow |

Penalties for a Data Controller of Major Importance reach **₦10,000,000 or 2% of annual gross revenue, whichever is higher**.

**Note the tension:** domain registration *requires* publishing/transferring registrant data to registries. Our privacy notice must be explicit that this is a legal necessity of the service, and WHOIS privacy is the mitigation we offer.

### 7.8 Tax

| # | Requirement |
|---|---|
| **CMP-15** | VAT registration threshold is **₦25m annual taxable supplies**. Register when approached |
| **CMP-16** | **7.5% VAT** charged on taxable supplies; shown as a separate line on every invoice |
| **CMP-17** | Under the **Nigeria Tax Act 2025**, obligations for digital-service supply take effect **1 January 2026**. E-invoicing obligations extend to medium and small VAT-registered businesses from **1 January 2026** — invoices must be structured, validated and transmitted through the national system, carrying supplier TIN, description and VAT liability |
| **CMP-18** | Our supplier is non-resident (Türkiye). Nigerian customers may be obliged to withhold VAT on payments to foreign suppliers in some structures — confirm treatment of our supplier invoices with a Nigerian tax adviser |

**FR-TAX-1**: The invoicing system must be built to emit structured e-invoices from day one, not retrofitted. Invoice numbering sequential and immutable; invoices stored as generated artefacts, never re-rendered from live data.

### 7.9 FX and cross-border payment

| Fact | Implication |
|---|---|
| CBN Foreign Exchange Manual, 4th edition, in effect **1 June 2026** — first major overhaul since 2018 | Review the current manual before designing the settlement process |
| Domiciliary account holders may initiate direct telegraphic transfers up to **USD 10,000/day** without exhaustive trade documentation | Our weekly supplier top-up should be structured to fit this envelope |
| From **1 May 2026**, IMTOs must route through Naira settlement accounts — recipients receive Naira | Affects inbound, not our outbound supplier payments, but relevant to any future payout features |

**Operational requirement:** open a corporate **domiciliary (USD) account**; fund the DomainNameAPI balance by SWIFT bank transfer (0% supplier fee) rather than card (2%) or PayPal (6.3%+). Budget 10 days settlement; hold 21 days of float.

---

## 8. Commercial model: pricing, FX, margin

### 8.1 Cost stack for one `.com`, one year

| Component | USD | Notes |
|---|---|---|
| Supplier wholesale (`GetTldList`, tier-dependent) | ~$8.00–10.50 | **[VERIFY]** actual tier price. DNA advertises a `.COM $7.99` headline |
| ICANN fee | $0.20 | gTLD only |
| Effective supplier cost | ~$8.20–10.70 | |
| Float funding cost (bank transfer) | 0% | If card: +2% |
| **Landed USD cost** | **~$8.20–10.70** | |

Converted at an internal rate of `CBN/market mid-rate × (1 + FX buffer)`.

| Component | NGN | Notes |
|---|---|---|
| Landed cost @ ₦1,550/$ + 4% buffer | ~₦13,200–17,250 | Illustrative rate only |
| Flutterwave local payment fee (card, transfer, USSD) | 2% (1.4% transaction + 0.6% platform), no cap published | Plus 7.5% VAT on Flutterwave's fee. Customer bears it by default — configurable in the dashboard |
| Flutterwave international card | 4.8% | Price separately or discourage |
| VAT on our supply | 7.5% | Collected and remitted, not margin |

**Margin target: 18–30% gross on registration, 25–40% on renewal.** Renewal is where registrars actually earn; the first-year discount is customer acquisition cost.

### 8.2 FX policy (published, not hidden)

**FR-FX-1**: A single `fx_rates` table holds one active rate per currency pair with an effective timestamp and a source reference.

**FR-FX-2**: The rate updates **once daily at a fixed time**, not continuously. Prices are stable for 24 hours. A user who sees ₦18,500 at 09:00 sees ₦18,500 at 17:00.

**FR-FX-3**: An **FX buffer** (default 4%, configurable) is applied on top of the mid-rate to absorb intraday movement and settlement lag. Published on a `/pricing` page in plain language: *"We convert at the market rate plus a 4% buffer, updated daily at 08:00 WAT."* Do not hide it inside the domain price — honesty here is a moat against incumbents who obscure it.

**FR-FX-4**: **Cart price lock** — once a cart is created, prices freeze for 30 minutes. If the lock expires, re-price and show a clear, non-hostile diff before payment.

**FR-FX-5**: If the daily rate moves more than a configurable threshold (default 5%) in one update, **hold the change and alert ops** rather than auto-applying. Protects against bad rate-feed data.

### 8.3 Pricing engine requirements

**FR-PRICE-2**: Prices are computed, never hand-entered, from:

```
retail_ngn = ceil_to_psychological(
    (supplier_cost_usd + icann_fee_usd)
    × fx_rate × (1 + fx_buffer)
    × (1 + margin_pct_for_tld_and_trade_type)
    + fixed_markup_ngn
)
```

with an optional **manual override** per (TLD, trade_type, period) for merchandised loss-leaders, and a promotional price with a start/end window.

**FR-PRICE-3**: Margin is configurable per TLD **and per trade type** — registration, renewal, transfer and restore need different margins. Transfers are typically loss-leaders; restores carry real risk and should carry margin.

**FR-PRICE-4**: `ceil_to_psychological` rounds NGN prices to the nearest ₦500 below a "…,900" or "…,500" ending. ₦17,214 → ₦17,500. Never display unrounded converted prices; they look like an error.

**FR-PRICE-5**: Premium domains (`IsFee = true`, or a non-standard `ClassKey`) **bypass the margin table** and use a flat percentage markup with a floor and ceiling, because registry premium prices range from $50 to $50,000.

**FR-PRICE-6**: Scheduled price changes, per [FR-PRICE-1](#76-fees-we-must-pass-through).

**FR-PRICE-7**: Every displayed price carries its `price_version_id`. A cart line stores the version it was quoted at. Receipts reference it. This makes every historical price reproducible for disputes and accounting.

### 8.4 Payment methods (v1)

**Provider: Flutterwave** — the owner's decision on 22 Sept 2026, replacing Paystack. Fees verified from flutterwave.com/ng/pricing the same day.

| Method | Provider | Priority | Notes |
|---|---|---|---|
| Local card | Flutterwave | P0 | 2% + VAT on the fee |
| Bank transfer (virtual account) | Flutterwave | P0 | Auto-reconciled — the differentiator for the SMB segment. A dynamic account per payment expires after one hour; a permanent per-customer account needs the customer's BVN or NIN (see FR-W2) |
| USSD | Flutterwave | P1 | 2% + VAT on the fee |
| Apple Pay / Google Pay | Flutterwave | P2 | **[VERIFY]** availability for our merchant account |
| International card | Flutterwave | P2 | 4.8%. Separate price or surcharge |
| **Account wallet / credit balance** | Internal | **P0** | See below |

**FR-PAY-1 — the wallet is load-bearing.** A prepaid NGN wallet per user solves: agency bulk purchasing, auto-renew without card-on-file, failed-card recovery, refunds (credit rather than reverse), and the bank-transfer path. Auto-renew charges the wallet first, card second.

**FR-PAY-2 — card tokenisation for auto-renew.** A successful Flutterwave card charge returns a card token; store it (never the PAN) with the user's explicit consent, and charge it for renewals through the tokenized-charges endpoint (`POST /v3/tokenized-charges`). Flutterwave has no dunning tooling to lean on, so the schedule below is ours to run. Dunning schedule: T-30, T-21, T-14, T-7, T-3, T-1, T+1, T+7, T+14, T+25 relative to expiry.

**FR-PAY-3 — idempotency.** Every charge carries a client-generated idempotency key derived from the order ID. Webhook handlers are idempotent and signature-verified.

### 8.5 Refund policy

Domain registration is **non-refundable once the registry has accepted it** — we have already spent the money and cannot get it back. This must be stated at checkout, above the pay button, not only in terms.

| Scenario | Policy |
|---|---|
| Payment succeeded, registration failed | **Full refund to wallet within minutes, automatically**, or to source on request. Non-negotiable, automated, no ticket |
| Registration succeeded, user changed mind | No refund. Offer to transfer away after the 60-day lock |
| Typo in the domain name | No refund. This is why the checkout confirmation step spells the domain out in large type with an explicit "this cannot be undone" |
| Chargeback received | Suspend the domain's outbound transfer, freeze the account, open a case. Document the process — payment-processor termination over chargebacks is an existential risk for registrars |

---

## 9. Scope: in and out for v1

### 9.1 In scope

| Epic | Summary |
|---|---|
| **E1 Search** | Instant availability, TLD grid, suggestions, bulk search, premium flagging |
| **E2 Accounts** | Email + password, magic link, Google OAuth, TOTP 2FA, profile, contact profiles |
| **E3 Cart & checkout** | Cart, period selection, privacy toggle, auto-renew toggle, price lock, Flutterwave + wallet |
| **E4 Registration** | The order saga, contact handling, failure recovery, receipts |
| **E5 Portfolio** | Domain list, labels, filters, search, bulk actions, expiry view |
| **E6 Nameserver setup** | Host preset picker, paste/manual entry, typo validation, delegation verification, propagation check, undelegated states |
| **E7 Advanced delegation** | Manual NS editing, glue records, bulk NS change, read-only DNS inspection, history |
| **E8 Renewals** | Manual renew, auto-renew, dunning, expiry recovery, restore |
| **E9 Transfers** | Transfer in (auth code, status tracking), transfer out (unlock, auth code) |
| **E10 Domain settings** | Contacts, privacy, transfer lock, auth code |
| **E11 Wallet & billing** | Top-up, balance, transactions, invoices, receipts |
| **E12 Notifications** | Email + SMS + WhatsApp, preferences, compliance notices |
| **E13 Admin** | Order queue, reconciliation, float monitor, pricing, catalogue, support impersonation, abuse |
| **E14 Public pages** | Home, TLD pages, pricing, RDAP lookup, legal, help |

### 9.2 Explicitly out of scope for v1

- **Managed DNS / DNS record editing** — customers bring their own nameservers ([ADR-001](#61-dns-decision-adr-001))
- Hosting, email hosting, site builder
- SSL certificate sales (supplier supports it; deferred)
- Sub-reseller / white-label tiers
- Aftermarket, marketplace, backorders, brokerage
- Public API for customers (v2 — design the internal service boundaries so this is additive)
- DNSSEC (supplier gap)
- Multi-currency storefront beyond NGN with USD reference display
- Mobile apps (responsive web only)

### 9.3 Deliberately deferred with a reason

| Item | Why deferred | Revisit when |
|---|---|---|
| Managed DNS (record editor, templates, zone import) | [ADR-001](#61-dns-decision-adr-001) — delegation-only in v1 | DNS misconfiguration >5% of tickets, or measurable transfers-out to Cloudflare Registrar |
| LLM suggestions in-path | Latency and cost | v1.1 as precomputed cache |
| URL forwarding | Requires the supplier's nameservers, which we no longer use | Only alongside managed DNS |
| Security keys (WebAuthn) | TOTP covers v1 | v1.1 |

---

## 10. Domain lifecycle state machine

Every domain in our system carries **two** status fields: `registry_status` (what the registry says, synced) and `local_status` (what we believe, driven by our own workflow). They are reconciled continuously; divergence is an alert.

```
                        ┌──────────────┐
      checkout  ───────▶│   PENDING    │  order created, payment authorised
                        └──────┬───────┘
                               │ register succeeded
                        ┌──────▼───────┐
              ┌─────────│    ACTIVE    │◀────────┐
              │         └──────┬───────┘         │ renew / restore succeeded
              │                │                 │
              │                │ T-35 → T-1: ERRP notices (compliance)
              │                │
              │                │ expiry reached, not renewed
              │         ┌──────▼───────────────┐
              │         │  EXPIRED_GRACE       │ 30–45d, TLD-dependent
              │         │  (may stop resolving)│ renew at normal price
              │         └──────┬───────────────┘
              │                │ grace ended
              │         ┌──────▼───────────────┐
              │         │  REDEMPTION (RGP)    │ ~30d, TldInfo.RedemptionPeriod
              │         │  Restore + fee       │──────────┘
              │         └──────┬───────────────┘
              │                │ redemption ended
              │         ┌──────▼───────────────┐
              │         │  PENDING_DELETE      │ ~5d, nothing can be done
              │         └──────┬───────────────┘
              │                │
              │         ┌──────▼───────────────┐
              │         │      RELEASED        │ terminal
              │         └──────────────────────┘
              │
              │ transfer out approved        ┌──────────────────────┐
              ├─────────────────────────────▶│  TRANSFERRED_AWAY    │ terminal
              │                              └──────────────────────┘
              │
              │ registrar verification request
              │         ┌──────────────────────┐
              └────────▶│ PENDING_VERIFICATION │ 15 days to respond, else suspension
                        └──────────────────────┘

  Transfer-in track:
  TRANSFER_REQUESTED ──▶ TRANSFER_PENDING ──▶ ACTIVE
                              │
                              ├──▶ TRANSFER_REJECTED
                              └──▶ TRANSFER_CANCELLED

  Failure track:
  PENDING ──▶ REGISTRATION_FAILED ──▶ (auto-refund to wallet) ──▶ CLOSED
```

**FR-STATE-1**: Every transition is written to `domain_events` with actor, reason, supplier response ID and timestamp. This table is append-only and is the source of truth for support.

**FR-STATE-2**: `EXPIRED_GRACE`, `REDEMPTION` and `PENDING_VERIFICATION` each render a persistent, unmissable banner in the panel with the exact deadline date and the exact cost to resolve.

---

## 11. Functional requirements

Format: **ID — Title.** Requirement. *Acceptance criteria as Given/When/Then.*

### E1 — Search

**FR-S1 — Instant availability.**
The search input queries availability with a 300 ms debounce, minimum 2 characters. The exact match renders first, as a skeleton immediately, filled when the result lands. The TLD grid streams in behind it.
*Given a user types `tobi` and stops; When 300 ms elapse; Then a request is issued for `tobi` across the hero TLD set and the exact-match card shows a loading state within 100 ms of the keystroke settling.*

**FR-S2 — Honest price display.**
Every result card shows: first-year price, renewal price, and — for gTLDs — an ICANN-fee indicator. Renewal price is never smaller than 80% of the first-year price's type size.
*Given a `.com` result; Then the card displays "₦X first year · ₦Y/yr after" with both prices legible at a glance.*

**FR-S3 — Premium flagging.**
When `IsFee = true` or `ClassKey` indicates a premium tier, the card carries a "Premium" badge and shows the premium renewal price. Premium domains cannot be added to the cart without an explicit confirmation modal restating both prices.
*Given a premium result priced at ₦3,400,000; When the user clicks add; Then a modal restates the first-year and renewal price and requires an explicit confirm.*

**FR-S4 — Suggestions.** Per [ADR-002](#62-name-suggestion-engine-adr-002). At least 12 available alternatives for any query returning an unavailable exact match.

**FR-S5 — Bulk search.**
Paste up to 500 names or upload a CSV; check against a selected TLD set; results filterable by available/taken/premium; select-all-available → cart; export CSV.
*Given 500 names × 3 TLDs; Then results are batched into supplier-compliant chunks, progress is shown, and partial results render as they arrive.*

**FR-S6 — Search result caching.** Availability results are cached for 60 seconds per (name, tld) to protect the supplier quota. Cached results carry no visible staleness to the user but are re-validated at cart-add time.

**FR-S7 — Front-running protection.** Search queries are never sold, syndicated or shared with third parties beyond the supplier call required to answer them. Stated on the search page and in the privacy policy.

**FR-S8 — IDN support.** Accept Unicode input, convert to Punycode for the supplier call, display Unicode in the UI with the Punycode form available. Reject mixed-script names that trigger homograph heuristics with a clear explanation.

**FR-S9 — Validation before supplier call.** Enforce `MinCharacterCount`, `MaxCharacterCount` and syntax rules from the cached `TldInfo` locally before calling the supplier. Never spend a supplier call on a name the TLD cannot accept.

### E2 — Accounts

**FR-A1 — Sign-up.** Email + password, magic link, and Google OAuth via Supabase Auth. Email verification required before the first registration completes.

**FR-A2 — TOTP 2FA.** Supabase Auth TOTP enrolment, with recovery codes. **Mandatory** for accounts holding more than 10 domains or with a wallet balance above a configurable threshold; optional but strongly prompted otherwise.
*Given an account with 11 domains and no 2FA; When the user next signs in; Then an interstitial requires 2FA enrolment before reaching the panel.*

**FR-A3 — AAL enforcement.** Sensitive operations — changing registrant contact, disabling transfer lock, revealing an auth code, changing nameservers, withdrawing wallet balance — require a session at **AAL2** (2FA verified in this session), re-challenging if the last verification is older than 15 minutes.

**FR-A4 — Contact profiles.** Users maintain reusable contact profiles (Registrant / Admin / Tech / Billing) with full validation per the supplier's `ContactInfo` shape: `FirstName`, `LastName`, `Company`, `EMail`, `AddressLine1-3`, `City`, `State`, `ZipCode`, `Country` (ISO-3166-1 alpha-2), `Phone` + `PhoneCountryCode`, `Fax` + `FaxCountryCode`, `Type`.
*Given a Nigerian address; Then `Country = NG`, `PhoneCountryCode = 234`, and the phone is normalised to E.164 before submission.*

**FR-A5 — Session management.** List active sessions with device, IP, last-seen; revoke individually or all. Email alert on new-device sign-in.

**FR-A6 — Account recovery hardening.** Password reset does not, by itself, grant access to sensitive operations for 24 hours — domain theft via email compromise is the dominant attack. Show a clear notice explaining the hold.

### E3 — Cart and checkout

**FR-C1 — Cart.** Persisted server-side per user (and per anonymous session, merged on sign-in). Holds domain lines with TLD, period, privacy flag, auto-renew flag, and the quoted `price_version_id`.

**FR-C2 — Period selection.** 1 to `TldInfo.MaxRegistrationPeriod` years, floored at `MinRegistrationPeriod`. A multi-year registration is priced as the first year at the registration price plus each later year at the renewal price — the way the supplier builds its own per-period matrix (checked 23 Sept 2026 against all 5,613 multi-year prices; the few exceptions differ by cents). There is no multi-year discount, so none is claimed.

**FR-C3 — No pre-ticked add-ons.** Privacy protection and auto-renew are the only toggles. Auto-renew defaults **on** with plain-language disclosure adjacent to the toggle. Privacy defaults **on** where the TLD supports it at no cost, **off** where it costs extra.

**FR-C4 — Price lock.** 30 minutes from cart creation. On expiry, re-price and present a clear diff requiring acknowledgement.

**FR-C5 — Fee transparency at checkout.** The order summary itemises: domain price, ICANN fee (gTLDs, labelled), privacy (if charged), VAT (7.5%), total. No line is hidden behind a tooltip.

**FR-C6 — Irreversibility confirmation.** The final step renders each domain in large type with its period, and requires an explicit checkbox: *"I've checked the spelling. Domain registrations cannot be cancelled or refunded."*

**FR-C7 — Availability re-check.** Immediately before charging, re-run `CheckAvailability` for every line. If any line became unavailable, stop, remove it, and re-present the order. Never charge for a name we cannot register.

**FR-C8 — Float pre-flight.** Before charging, verify the supplier balance covers the order's wholesale cost. If not, do not charge — queue and alert ops. Per [FR-FLOAT-3](#56-supplier-funding-and-float).

**FR-C9 — Payment.** Flutterwave checkout for card/transfer/USSD; wallet debit where balance covers. Mixed payment (wallet + card for the remainder) supported.

**FR-C10 — Nameservers at checkout (optional).**
An optional, collapsed-by-default "Already know where this domain is going?" section offers the same three inputs as [FR-D1](#e6--nameserver-setup) — host preset, paste, or manual. Values supplied here are applied immediately after registration, so the domain is live without a second visit.
- Collapsed by default. It must never make checkout look longer for someone who does not have the values.
- Applies to the whole order by default, with a per-domain override for mixed carts.
- Validation is identical to [FR-D4](#e6--nameserver-setup), and runs **before** payment, so a typo is caught while it is still free to fix.
- If delegation later fails, the registration still stands — the domain simply lands in the undelegated state ([FR-D7](#e6--nameserver-setup)) and the customer is told.
- Target: **≥ 35%** of orders supply nameservers at checkout, which removes the post-purchase step entirely for that cohort.

### E4 — Registration

**FR-R1 — The order saga.** Per [§13.4](#134-the-order-saga). Payment capture and registration are separate steps linked by a durable, resumable job with an idempotency key.

**FR-R2 — Per-domain independence.** In a multi-domain order, each registration succeeds or fails independently. A partial success is a normal outcome, not an error state, and the receipt reflects exactly what was registered.

**FR-R3 — Automatic refund on failure.** A line that fails after successful payment is refunded to the wallet within 5 minutes, automatically, with an email explaining what happened. No ticket required.

**FR-R4 — Additional attributes.** TLDs requiring extra data collect it at checkout with TLD-specific field definitions. Only attributes marked `isRequired` block a registration — optional acknowledgements must not be presented as eligibility requirements, or we deter people from TLDs that need nothing. The `.tr` family, for instance, requires `TRABISDOMAINCATEGORY`, `TRABISCITIZENID`, `TRABISNAMESURNAME`, `TRABISCOUNTRYID`, `TRABISCITYID`.
*Given a TLD with `IsDocumentRequired = true`; Then checkout renders the required fields and blocks submission until they validate.*

**FR-R5 — Delegation at registration.** If the customer supplied nameservers at checkout ([FR-C10](#e3--cart-and-checkout)), apply them via `ModifyNameServer` immediately after a successful register and begin verification. A delegation failure never fails the registration — the domain falls back to `undelegated` and the customer is told why.

Ordering within the provision job: `RegisterWithContactInfo` → `ModifyNameServer` (if supplied) → `ModifyRenewalMode` → persist → verify delegation asynchronously.

**FR-R6 — Post-registration state.** Transfer lock **on** by default. Privacy per the cart. Auto-renew per the cart, applied via `ModifyRenewalMode`.

### E5 — Portfolio

**FR-P1 — Landing.** Authenticated users land on the domain portfolio, not a marketing dashboard.

**FR-P2 — Table.** Columns: domain, status (with lifecycle colour), expiry with days remaining, auto-renew state, delegation status, privacy, labels. Sortable, filterable, searchable, paginated at 50.

**FR-P3 — Labels.** User-defined, colour-coded, multi-assign, filterable. Agency requirement.

**FR-P4 — Bulk actions.** Multi-select → renew, toggle auto-renew, change nameservers, toggle privacy, toggle transfer lock, apply label, export CSV. Each bulk action is a queued job with per-domain result reporting, not a synchronous loop.

**FR-P5 — Expiry view.** A dedicated view of everything expiring in 7 / 30 / 60 / 90 days with one-click bulk renew. Ada's headline feature.

**FR-P6 — Domain detail.** Tabs: Overview, Nameservers (setup, delegation, glue, DNS inspection), Contacts, Security (lock, auth code, privacy), Activity (from `domain_events`).

### E6 — Nameserver setup

**FR-D1 — One panel, three ways in.**
Pointing a domain happens on one screen, not in a multi-step wizard: (a) **pick your host** from a searchable preset list, which fills the nameservers automatically; (b) **paste** the nameservers your host emailed you; (c) **manual entry** for anything else. Most customers already have hosting and already have the values — the job is to make using them take fifteen seconds.
*Given a user selects their host from the preset list; Then the nameserver fields populate, and a single Save applies and begins verification.*

**FR-D2 — Presets are data, not code.**
An admin-managed `nameserver_presets` table holds `{provider, nameservers[], assigns_per_zone, notes, verified_at}`. Ops populates it from each provider's own documentation and re-verifies quarterly — hosts do change nameservers, and a stale preset silently breaks a customer's site.
- **Never hardcode a provider's nameservers in application code.**
- A preset whose nameservers stop resolving is flagged in admin and hidden from customers automatically.
- Coverage at launch: the major Nigerian hosts, common international hosts, and platforms with stable nameservers (Vercel, Netlify).

**FR-D3 — Providers that assign per-account nameservers.**
Some providers — Cloudflare most notably — assign a unique nameserver pair per zone and reveal it only after the domain is added to an account. These are marked `assigns_per_zone` and their entry explains where to find the values rather than pre-filling anything. They are listed alongside everything else, with no special prominence.

**FR-D4 — Validation before submission.**
Before calling `ModifyNameServer`: syntax check, confirm each nameserver resolves to at least one A or AAAA record, and warn (not block) if one does not currently answer. Between 2 and 13 nameservers.
*Given a typo'd `ns1.whogohst.com`; Then submission is blocked with "This nameserver doesn't exist — check the spelling", not a generic failure.*

**FR-D5 — Delegation verification.**
After the change, poll the TLD's authoritative servers until the new delegation appears, then confirm the new nameservers answer authoritatively for the domain. Show progress honestly: *"Registry updated ✓ · Waiting for your host's nameservers to respond…"*. Email on success.
*Given delegation has not verified after 24 hours; Then surface a diagnostic with likely causes and a support route.*

**FR-D6 — Propagation check.** Query several public resolvers and report what each currently sees, with a plain-language TTL explanation. Available any time, not only after a change.

**FR-D7 — Undelegated empty state.**
A domain still on the supplier's default nameservers shows *"Not pointed anywhere yet — where is your site hosted?"* with the preset picker inline. Never an empty table, never a blank page.

**FR-D8 — Undelegated nudge.** If a domain is still undelegated 3 days after registration, send one helpful email with the preset picker linked. Once only — this is help, not dunning.

### E7 — Advanced delegation

**FR-N1 — Manual nameserver editor.** Direct entry for anything not in the preset list, with the same validation as [FR-D4](#e6--nameserver-setup).

**FR-N2 — Bulk nameserver change.** Multi-select in the portfolio → apply one nameserver set across many domains as a queued job with per-domain results. Ada's job #2.

**FR-N3 — Child nameservers / glue.** Create, edit and delete glue records via `Add/Modify/DeleteChildNameServer`, IPv4 and IPv6, behind an "Advanced" disclosure. Agencies running their own nameservers need this.

**FR-N4 — Read-only DNS inspection.**
For any domain, query its current authoritative nameservers and display what we can see — A, AAAA, CNAME, MX, TXT, NS, CAA. Read-only; we do not hold the zone. This exists so support can answer *"why isn't my email working?"* without asking for screenshots.
*Given a domain pointed at a host with no MX records configured; When support opens DNS inspection; Then the missing MX records are visible immediately.*

**FR-N5 — Change history.** Every delegation change recorded with before/after, actor and timestamp, with one-click revert to the previous set.

**FR-N6 — Destructive-change warning.** Changing nameservers warns that records served by the current provider will stop being authoritative, and shows the currently visible records from [FR-N4](#e7--advanced-delegation) so the customer sees exactly what they are about to orphan.

### E8 — Renewals

**FR-RN1 — Manual renew.** From portfolio or detail. Period selection. Price shown before confirmation.

**FR-RN2 — Auto-renew.** Per-domain toggle synced to the supplier via `ModifyRenewalMode`. Renewal attempt at **T-30 days** so failures have runway.

**FR-RN3 — Dunning ladder.** Wallet first, then stored card authorisation. Retry schedule T-30, T-21, T-14, T-7, T-3, T-1, T+1, T+7, T+14, T+25, with escalating messaging across email → SMS → WhatsApp.

**FR-RN4 — ERRP compliance notices.** Independent of dunning, per [§7.4](#74-expired-registration-recovery-policy-errp). Logged to `compliance_notices`.

**FR-RN5 — Expiry recovery.** A dedicated recovery page reachable from any reminder, with no sign-in friction beyond authentication — one screen, one price, one button.

**FR-RN6 — Restore (RGP).** Surfaces the actual restore cost, which is high, before the user commits. Requires explicit confirmation of the amount. Calls `Restore`.

**FR-RN7 — Renewal price change notice.** If a domain's renewal price has increased since the last renewal, say so in the reminder. This is the single biggest trust issue in the category — getting it right is a competitive weapon.

### E9 — Transfers

**FR-T1 — Transfer-in eligibility check.** Before taking money: run `CheckTransfer` (returns `AuthCodeIsRequired`, `AuthCodeIsValid`, `TransferAvailabilityStatus`, `TransferLock`, `UserTransferRequired`) and an RDAP lookup. Present a checklist of what must be true: unlocked, >60 days since registration or last transfer, valid auth code, privacy disabled if the losing registrar requires it.
*Given a domain registered 20 days ago; Then the checker states the domain is inside the 60-day lock and gives the exact date it becomes eligible.*

**FR-T2 — Transfer-in flow.** Auth code entry → eligibility → price (transfer typically includes +1 year) → payment → `Transfer` → status tracking.

**FR-T3 — Transfer status tracking.** Poll `QueryTransfer` on a schedule; surface `TransferStatus` and `TransferLog` in plain language. Transfers can take up to 5 days (auto-approval on losing-registrar non-response); the UI shows the expected completion window rather than leaving the user guessing.

**FR-T4 — Transfer-in cancel.** `CancelTransfer` while pending, with refund to wallet.

**FR-T5 — Transfer-out.** Unlock (`DisableTheftProtectionLock`) and reveal the auth code (`ModifyAuthCode` to regenerate, or fetch existing). Gated on AAL2. Must complete within **5 calendar days** of request per Transfer Policy — automate it, do not queue it for a human.

**FR-T6 — Transfer-out never held hostage.** Auth code release is not conditioned on billing state. Encoded in policy and in code.

**FR-T7 — 60-day lock surfacing.** Wherever a transfer is impossible due to a 60-day lock (post-registration or post-registrant-change), state the reason and the exact unlock date.

### E10 — Domain settings

**FR-DS1 — Contact management.** View and edit all four contacts via `GetContacts` / `SaveContacts`.

**FR-DS2 — Registrant change warning.** Changing the registrant triggers a modal explaining the **60-day inter-registrar transfer lock**, offering the documented opt-out, and requiring an explicit choice. Never apply the lock silently.

**FR-DS3 — Privacy toggle.** `ModifyPrivacyProtectionStatus`, with per-TLD availability from the catalogue. Where a TLD does not support privacy, explain why rather than hiding the control.

**FR-DS4 — Transfer lock.** On by default. Toggling off requires AAL2 and shows a security warning.

**FR-DS5 — Auth code.** Reveal requires AAL2 and is logged to `domain_events` and emailed to the account owner as a security notification.

**FR-DS6 — Verification banner.** A domain in `PENDING_VERIFICATION` renders a persistent, dismissable-only-after-action banner with the deadline and a resend-verification action.

### E11 — Wallet and billing

**FR-W1 — Wallet.** NGN balance per user. Top up via Flutterwave. Ledger with running balance. Every movement is a double-entry row referencing its cause.

**FR-W2 — Dedicated virtual account.** Each user who opts in gets a permanent Flutterwave virtual account, so bank transfers auto-credit the wallet without human reconciliation. Flutterwave requires the customer's **BVN or NIN** to create one — collect it only with explicit consent, store no more than the provider needs (NDPA), and explain why. Without it, a one-off virtual account per top-up (expires after one hour) is the fallback. Payments arrive as `charge.completed` webhooks with `payment_type: bank_transfer`.

**FR-W3 — Invoices.** Structured, sequentially numbered, immutable, VAT-itemised, built for the Nigerian e-invoicing regime from day one per [FR-TAX-1](#78-tax). Downloadable as PDF.

**FR-W4 — Receipts.** Every transaction produces a receipt referencing the `price_version_id` used.

**FR-W5 — Payment methods.** Manage stored card authorisations; delete with clear warning about auto-renew impact.

### E12 — Notifications

**FR-NT1 — Channels.** Email (transactional, via a reputable provider with a dedicated sending domain, SPF/DKIM/DMARC aligned), SMS, and WhatsApp. WhatsApp and SMS are **not optional extras** in this market — they are how reminders actually land.

**FR-NT2 — Preferences.** Per-category opt-in/out for marketing. **Compliance and security notices are not opt-out-able** and this is stated plainly.

**FR-NT3 — Deliverability instrumentation.** Track sent/delivered/bounced/opened per notice. A bounced ERRP notice triggers an alternate channel and an ops alert — a failed compliance notice is a compliance failure, not a marketing metric.

**FR-NT4 — Templates.** Every template versioned; the version recorded on each sent notice.

### E13 — Admin

See [§17](#17-admin-back-office).

### E14 — Public pages

**FR-PUB1 — Per-TLD landing pages.** Generated from the catalogue: price, restrictions, min/max period, registration requirements, transferability, redemption period. Significant organic search surface.

**FR-PUB2 — RDAP lookup page.** Public, rate-limited, per [ADR-003](#63-rdap-lookup-adr-003).

**FR-PUB3 — Pricing page.** Full catalogue with register/renew/transfer prices, searchable and filterable. Includes the plain-language FX policy statement.

**FR-PUB4 — Legal pages.** Registration agreement (identifying the sponsoring registrar), Registrants' Benefits and Responsibilities, privacy notice, refund policy, abuse policy, UDRP link, transfer dispute policy.

---

## 12. Data model

Postgres on Supabase. RLS on **every** table. `service_role` used only inside Edge Functions and the registrar gateway.

### 12.1 Core tables

```sql
-- ─── Identity ──────────────────────────────────────────────────────────────
profiles(
  id uuid pk references auth.users,
  email citext not null,
  full_name text, phone text,
  account_type text check (in ('individual','business')),
  business_name text, tax_id text,
  kyc_status text default 'none',
  risk_score int default 0,
  created_at timestamptz, updated_at timestamptz
)

contact_profiles(
  id uuid pk, user_id uuid fk profiles,
  label text,                          -- "Personal", "Acme Ltd"
  first_name, last_name, company,
  email citext, phone text, phone_country_code text,
  fax text, fax_country_code text,
  address_line1, address_line2, address_line3,
  city, state, zip_code, country char(2),  -- ISO-3166-1 alpha-2
  is_default boolean,
  created_at, updated_at
)

-- ─── Catalogue and pricing ─────────────────────────────────────────────────
tlds(
  id uuid pk, name text unique,        -- 'com', 'com.ng'
  type text,                           -- 'gtld' | 'cctld' | 'sld'
  country char(2),
  min_period int, max_period int,
  min_chars int, max_chars int,
  epp_allowed boolean, is_transferable boolean,
  is_document_required boolean, required_document_info text,
  redemption_period_days int,
  supports_privacy boolean,
  is_icann_fee_applicable boolean,     -- gTLD → true
  is_merchandised boolean default false,
  popularity_score int default 0,
  additional_attribute_schema jsonb,   -- e.g. TRABIS fields
  raw_supplier_payload jsonb,
  synced_at timestamptz
)

supplier_prices(               -- raw wholesale, synced nightly, append-only
  id uuid pk, tld_id uuid fk,
  trade_type text,             -- Registration|Renew|Transfer|Restore|...
  period int, price_usd numeric(12,4),
  currency text, or_more boolean,
  effective_from timestamptz, synced_at timestamptz
)

fx_rates(
  id uuid pk, base char(3), quote char(3),
  mid_rate numeric(16,6), buffer_pct numeric(6,4),
  effective_rate numeric(16,6) generated,
  source text, effective_from timestamptz, created_at timestamptz
)

pricing_rules(
  id uuid pk, tld_id uuid fk null,     -- null = global default
  trade_type text, period int null,
  margin_pct numeric(6,4), fixed_markup_ngn numeric(12,2),
  manual_override_ngn numeric(12,2) null,
  promo_price_ngn numeric(12,2) null,
  promo_starts_at timestamptz, promo_ends_at timestamptz,
  effective_from timestamptz not null,  -- scheduled changes (FR-PRICE-1/6)
  created_by uuid, created_at timestamptz
)

price_versions(                -- immutable computed retail prices
  id uuid pk, tld_id uuid fk, trade_type text, period int,
  supplier_cost_usd numeric(12,4), icann_fee_usd numeric(12,4),
  fx_rate_id uuid fk, pricing_rule_id uuid fk,
  retail_ngn numeric(12,2), vat_ngn numeric(12,2),
  computed_at timestamptz, valid_until timestamptz
)

-- ─── Domains ───────────────────────────────────────────────────────────────
domains(
  id uuid pk, user_id uuid fk profiles,
  domain_name citext unique, tld_id uuid fk,
  supplier_domain_id text,              -- DNA's internal Id
  roid text,
  local_status text,                    -- see §10
  registry_status text[],               -- EPP statuses
  rgp_statuses jsonb,                   -- RGPStatus[] from supplier
  registered_at, expires_at, transferred_at, updated_at timestamptz,
  auto_renew boolean default true,
  renewal_mode text,
  transfer_lock boolean default true,
  privacy_enabled boolean default false,
  is_premium boolean default false,
  nameservers text[],
  delegation_status text,               -- undelegated|pending|verified|failed
  delegation_verified_at timestamptz,
  nameserver_preset_id uuid fk null,    -- which preset was applied, if any
  registrant_contact_id uuid fk contact_profiles,
  admin_contact_id, tech_contact_id, billing_contact_id uuid fk,
  registrant_change_locked_until timestamptz,   -- 60-day rule
  transfer_eligible_at timestamptz,              -- 60-day rule
  verification_status text, verification_deadline timestamptz,
  labels uuid[],
  last_synced_at timestamptz,
  created_at timestamptz
)

domain_events(                 -- append-only audit log
  id bigserial pk, domain_id uuid fk,
  event_type text, actor_type text, actor_id uuid,
  from_state text, to_state text,
  payload jsonb, supplier_request_id text,
  created_at timestamptz
)

domain_labels(id uuid pk, user_id uuid fk, name text, color text)

-- ─── Orders and money ──────────────────────────────────────────────────────
orders(
  id uuid pk, user_id uuid fk,
  order_number text unique,
  status text,                 -- draft|awaiting_payment|paid|provisioning|
                               -- completed|partially_failed|failed|refunded
  subtotal_ngn, icann_fees_ngn, vat_ngn, total_ngn numeric(12,2),
  fx_rate_id uuid fk,
  idempotency_key text unique,
  price_locked_until timestamptz,
  created_at, updated_at timestamptz
)

order_items(
  id uuid pk, order_id uuid fk,
  item_type text,              -- register|renew|transfer|restore|privacy
  domain_name citext, tld_id uuid fk, period int,
  price_version_id uuid fk,
  unit_price_ngn, icann_fee_ngn, vat_ngn, total_ngn numeric(12,2),
  privacy_requested boolean, auto_renew_requested boolean,
  additional_attributes jsonb,
  contact_profile_id uuid fk,
  status text,                 -- pending|provisioning|completed|failed|refunded
  supplier_reference text, failure_code text, failure_message text,
  domain_id uuid fk null,
  created_at, updated_at timestamptz
)

payments(
  id uuid pk, order_id uuid fk null, user_id uuid fk,
  provider text,               -- 'flutterwave' | 'wallet'
  provider_reference text unique,
  authorization_code text,     -- tokenised, for recurring
  amount_ngn numeric(12,2), fee_ngn numeric(12,2),
  status text, method text,
  idempotency_key text unique,
  raw_webhook jsonb,
  created_at, updated_at timestamptz
)

wallet_ledger(                 -- double-entry, append-only
  id bigserial pk, user_id uuid fk,
  direction text check (in ('credit','debit')),
  amount_ngn numeric(12,2) check (amount_ngn > 0),
  balance_after_ngn numeric(12,2),
  reason text,                 -- topup|order|refund|adjustment|renewal
  reference_type text, reference_id uuid,
  created_by uuid, created_at timestamptz
)

invoices(
  id uuid pk, user_id uuid fk, order_id uuid fk null,
  invoice_number text unique,          -- sequential, immutable
  issued_at timestamptz,
  subtotal_ngn, vat_ngn, total_ngn numeric(12,2),
  tax_id text, einvoice_payload jsonb, einvoice_status text,
  pdf_storage_path text
)

-- ─── Operations ────────────────────────────────────────────────────────────
jobs(                          -- durable work queue
  id uuid pk, job_type text, payload jsonb,
  status text,                 -- queued|running|succeeded|failed|dead
  idempotency_key text unique,
  attempts int default 0, max_attempts int default 5,
  run_after timestamptz, locked_by text, locked_at timestamptz,
  last_error text, created_at, updated_at timestamptz
)

supplier_calls(                -- every DNA request/response, redacted
  id bigserial pk, operation text, request_id text,
  request_payload jsonb, response_payload jsonb,
  http_status int, supplier_error_code text,
  duration_ms int, order_item_id uuid null, domain_id uuid null,
  created_at timestamptz
)

supplier_balance_snapshots(
  id bigserial pk, currency char(3),
  balance numeric(14,4), captured_at timestamptz
)

compliance_notices(            -- ERRP and Registration Data Policy notices
  id uuid pk, domain_id uuid fk, user_id uuid fk,
  notice_type text,            -- errp_pre_35|errp_pre_7|errp_post|rdp_verification
  channel text, recipient text,
  template_version text, sent_at timestamptz,
  delivery_status text, provider_message_id text
)

nameserver_presets(            -- admin-managed, FR-D2. NEVER hardcoded in app code
  id uuid pk,
  provider_name text unique,           -- 'Whogohost', 'Vercel', 'Cloudflare', …
  provider_type text,                  -- 'host' | 'platform' | 'dns'
  nameservers text[],
  assigns_per_zone boolean default false,   -- true → cannot pre-fill (FR-D3)
  instructions text,                   -- where the customer finds their values
  country char(2) null,                -- for surfacing local hosts first
  is_active boolean default true,
  last_verified_at timestamptz, verification_status text,
  sort_weight int default 0,
  created_by uuid, created_at, updated_at timestamptz
)

nameserver_history(
  id bigserial pk, domain_id uuid fk,
  before text[], after text[],
  actor_type text, actor_id uuid,
  verification_status text,            -- pending|verified|failed
  verified_at timestamptz, created_at timestamptz
)

dns_observations(              -- read-only snapshots from public resolvers (FR-N5)
  id bigserial pk, domain_id uuid fk,
  observed_nameservers text[],
  records jsonb,               -- A/AAAA/CNAME/MX/TXT/NS/CAA as seen
  resolver text, observed_at timestamptz
)

abuse_reports(
  id uuid pk, domain_name citext, reporter_email citext,
  category text, description text, evidence_urls text[],
  status text, assigned_to uuid,
  forwarded_to_supplier_at timestamptz,
  resolution text, created_at, resolved_at timestamptz
)
```

### 12.2 RLS posture

| Table | Policy |
|---|---|
| `profiles`, `contact_profiles`, `domains`, `orders`, `order_items`, `payments`, `wallet_ledger`, `invoices`, `domain_labels` | `user_id = auth.uid()`; admin role bypass via a checked claim |
| `domain_events`, `nameserver_history`, `dns_observations` | Read own via domain ownership join; **no client insert/update/delete** |
| `tlds`, `price_versions` | Public read of merchandised rows only |
| `nameserver_presets` | Public read of `is_active = true` rows; write admin only |
| `supplier_prices`, `pricing_rules`, `fx_rates`, `jobs`, `supplier_calls`, `supplier_balance_snapshots`, `compliance_notices` | **No client access at all** — service role only |
| `abuse_reports` | Insert allowed unauthenticated (rate-limited); read admin only |

**Hard rules:**
- `service_role` key never reaches Vercel's client bundle, never reaches the browser, and is scoped to Edge Functions and the registrar gateway.
- Admin authorisation is a **JWT custom claim in `app_metadata`**, checked in policy, not a client-settable field.
- Every money table is **append-only**; balances are derived, never mutated in place.

---

## 13. Technical architecture

### 13.1 Topology

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser — Next.js 16 App Router (RSC + Server Actions)          │
└───────────────┬──────────────────────────────────────────────────┘
                │
┌───────────────▼──────────────────────────────────────────────────┐
│  Vercel — Next.js                                                │
│  • Public storefront (cached, ISR)  • Authed panel (dynamic)     │
│  • Server Actions for all mutations • No supplier credentials    │
└───────┬──────────────────────────────────┬───────────────────────┘
        │                                  │
┌───────▼──────────────────┐   ┌───────────▼──────────────────────┐
│ Supabase                 │   │  Registrar Gateway (ADR-004)     │
│ • Postgres + RLS         │◀─▶│  Fly.io / Railway — STATIC IP    │
│ • Auth (TOTP, OAuth)     │   │  • Sole holder of DNA creds      │
│ • Storage (invoices)     │   │  • Rate limit, retry, breaker    │
│ • Edge Functions         │   │  • Idempotency ledger            │
│ • pg_cron + pg_net       │   │  • nodejs-dna { telemetry:false }│
│ • Realtime (job status)  │   └───────────┬──────────────────────┘
└───────┬──────────────────┘               │
        │                        ┌─────────▼──────────┐
        │                        │  DomainNameAPI     │
        │                        │  REST / OTE        │
        │                        └────────────────────┘
        │
        ├──────────▶ Flutterwave (payments, webhooks, virtual accounts)
        ├──────────▶ Public DNS resolvers (delegation verification, inspection)
        ├──────────▶ Email (Resend/Postmark) + SMS + WhatsApp
        └──────────▶ RDAP (IANA bootstrap → registry/registrar endpoints)
```

### 13.2 Why the gateway is separate

1. **Static egress IP** for supplier allowlisting (`API_301`) — Vercel and Supabase Edge Functions cannot guarantee this.
2. **Credential isolation** — supplier keys live in exactly one place.
3. **One choke point** for rate limiting, retries, circuit breaking and audit.
4. **Transport independence** — if we ever need SOAP for an operation REST lacks, it changes here and nowhere else.
5. **It is the natural seam for a future public API.**

### 13.3 Next.js conventions

- **App Router**, React Server Components by default. Client components only where interaction demands.
- **Server Actions** for every mutation. No `/api` routes for app mutations; `/api` reserved for webhooks.
- **Cache Components / `use cache`** — Next 16 caches nothing by default. Cache deliberately: TLD pages, pricing tables and catalogue reads are cached with explicit tags; portfolio, cart, DNS and anything authed is dynamic.
- **Streaming and Suspense** for search results — the exact-match card must not wait on the TLD grid.
- **`proxy.ts`** (Next 16 replaced middleware) for auth gating and locale.
- **Route groups**: `(marketing)` static/ISR, `(app)` authed dynamic, `(auth)` auth flows.
- **`next/after`** for fire-and-forget post-response work (analytics, non-critical logging).

### 13.4 The order saga

This is the highest-risk flow in the product. The failure mode we must never hit: **customer charged, domain not registered, nobody notices.**

```
1. CREATE ORDER            status=draft, idempotency_key generated
2. RE-CHECK AVAILABILITY   CheckAvailability for every line       [FR-C7]
3. FLOAT PRE-FLIGHT        GetCurrentBalance ≥ wholesale cost     [FR-C8]
4. PRICE RE-VALIDATION     price lock still valid, else re-quote  [FR-C4]
5. CHARGE                  Flutterwave / wallet, idempotency key  [FR-PAY-3]
   └─ fail → order=failed, nothing provisioned, user informed
6. MARK PAID               status=paid, payment row written
7. ENQUEUE PROVISION JOB   one durable job PER order_item
        ▼
   ┌────────────────────────────────────────────────────────┐
   │ PROVISION JOB (per item) — at-most-once effective       │
   │                                                         │
   │ a. PRE-FLIGHT: GetDetails(domain)                       │
   │    └─ already registered to us? → treat as SUCCESS      │
   │       (recovers from a timeout on a call that landed)   │
   │ b. RegisterWithContactInfo(...)                         │
   │ c. on NETWORK TIMEOUT / 5xx:                            │
   │       DO NOT blind-retry.                               │
   │       Re-run GetDetails. Registered? → success.         │
   │       Not registered? → retry with backoff (max 3).     │
   │ d. on BUSINESS ERROR (API_310 unsupported TLD,          │
   │       API_350 insufficient balance, taken, etc.):       │
   │       → item=failed, classify, no retry                 │
   │ e. on SUCCESS:                                          │
   │       ModifyNameServer (only if NS given at checkout) → │
   │       ModifyRenewalMode → write domains row →           │
   │       domain_events → item=completed                    │
   └────────────────────────────────────────────────────────┘
        ▼
8. SETTLE ORDER    all completed → completed
                   some failed   → partially_failed
                   all failed    → failed
9. AUTO-REFUND     failed items refunded to wallet ≤ 5 min  [FR-R3]
10. RECEIPT + INVOICE + confirmation notifications
```

**Non-negotiable invariants:**

| # | Invariant |
|---|---|
| I1 | A registration is never attempted without a *pre-flight* `GetDetails`. The supplier has no idempotency keys; this is our substitute. |
| I2 | A network timeout is **never** treated as a failure. It is treated as *unknown*, and resolved by reading state, never by retrying blind. |
| I3 | Money is never captured before availability and float are re-verified. |
| I4 | Every job is idempotent by `idempotency_key`; a duplicate delivery is a no-op. |
| I5 | An order in `provisioning` for more than 15 minutes raises an ops alert. |
| I6 | Refunds for failed lines are automatic and require no human. |
| I7 | Every supplier call is logged to `supplier_calls` **before** the response is acted on. |

### 13.5 Reconciliation and drift

The supplier offers no webhooks, so we poll. Three scheduled jobs via `pg_cron` → `pg_net` → Edge Function → gateway:

| Job | Cadence | Purpose |
|---|---|---|
| **Portfolio reconcile** | Hourly, paged | `GetList` over the whole reseller portfolio; diff against `domains`. Any divergence in status, expiry or nameservers is corrected and logged. Detects transfers-away, registry suspensions, expiries we missed |
| **Domain deep sync** | Daily per domain, batched | `GetDetails` for domains changed in the last 24h or flagged stale; `SyncFromRegistry` for those with registry-status drift |
| **Transfer poll** | Every 15 min while any transfer is pending | `QueryTransfer` for pending transfers; advance state |
| **Float monitor** | Every 15 min | `GetCurrentBalance` → `supplier_balance_snapshots` → alerting |
| **Catalogue sync** | Nightly | `GetTldList(IncludePriceDefinitions=true)` → `tlds` + `supplier_prices`; recompute `price_versions` |
| **FX update** | Daily 08:00 WAT | New `fx_rates` row; recompute `price_versions`; threshold guard [FR-FX-5] |
| **Orphan sweep** | Every 15 min | Orders in `provisioning` > 15 min; items with no supplier confirmation → alert |

**Drift alerting:** any domain where `registry_status` and `local_status` disagree for more than one reconcile cycle raises an ops ticket automatically.

### 13.6 Job execution

Supabase Edge Functions have cold starts around 200–400 ms and are not suited to long-running, durable, retryable work. Two viable shapes:

| Option | Fit |
|---|---|
| Postgres-backed queue (`jobs` table) + `pg_cron` worker ticks + Edge Function or gateway consumers | **Recommended.** Simple, transactional with the rest of our data, no new vendor, easy to inspect and replay |
| A dedicated durable-execution service (Inngest, Trigger.dev) | Better ergonomics for complex retries; adds a vendor and moves state outside Postgres |

**Decision:** start with the Postgres queue consumed by the **registrar gateway** (which is already a long-lived process with the right egress IP). Revisit if orchestration complexity grows. `FOR UPDATE SKIP LOCKED` for claim semantics.

### 13.7 Caching and performance

| Surface | Strategy | Target |
|---|---|---|
| Availability (name, tld) | Redis/Postgres cache, 60 s TTL | p75 < 800 ms |
| TLD catalogue | `use cache`, tag-invalidated on nightly sync | < 50 ms |
| Price tables | `use cache`, invalidated on price recompute | < 50 ms |
| TLD landing pages | ISR, revalidate hourly | LCP < 1.5 s |
| Portfolio | Dynamic, RSC, paginated 50 | p75 < 1.2 s |
| DNS inspection | Live resolver query, cached 60 s per domain | < 600 ms |

**Search-specific:** issue the exact-match check and the TLD-grid check as **two separate supplier calls** so the exact match can render without waiting on the grid. Stream with Suspense boundaries.

### 13.8 Error taxonomy

The gateway maps every supplier error to our own taxonomy, so the UI never shows a raw supplier string.

| Our code | Supplier | User-facing message | Retryable |
|---|---|---|---|
| `SUPPLIER_AUTH` | `CREDENTIALS` | *(never shown — pages ops)* | No |
| `SUPPLIER_IP_BLOCKED` | `API_301` | *(never shown — pages ops)* | No |
| `SUPPLIER_INSUFFICIENT_FUNDS` | `API_350` | "We're unable to complete this right now. We haven't charged you — please try again in a few minutes." | Yes, after top-up |
| `TLD_UNSUPPORTED` | `API_310` | "We don't currently support .xyz. Tell us if you'd like us to add it." | No |
| `DOMAIN_TAKEN` | registration failure | "That domain was registered by someone else moments ago. Your payment has been refunded to your wallet." | No |
| `CONTACT_INVALID` | `CONTACT_INFO` / `CONTACT_SAVE` | Field-level validation with the specific problem | No |
| `TRANSFER_INELIGIBLE` | `CheckTransfer` flags | Specific reason + date when eligible | No |
| `SUPPLIER_UNAVAILABLE` | timeout / 5xx | "Taking longer than usual — we'll email you the moment it's done." | Yes |

---

## 14. Security requirements

Domain registrar accounts are high-value targets. A compromised account means a stolen domain, which can mean stolen email, stolen identity and stolen money downstream.

| # | Requirement |
|---|---|
| **SEC-1** | TOTP 2FA available to all; mandatory above the portfolio/balance thresholds in [FR-A2](#e2--accounts) |
| **SEC-2** | AAL2 step-up for: registrant change, transfer-lock disable, auth-code reveal, nameserver change, wallet withdrawal, stored-card deletion. Re-challenge if AAL2 is older than 15 minutes |
| **SEC-3** | 24-hour cool-down on sensitive operations after a password reset [FR-A6](#e2--accounts) |
| **SEC-4** | Email notification — not opt-out-able — on: sign-in from a new device, password change, 2FA change, contact change, nameserver change, transfer lock change, auth code reveal, transfer initiated |
| **SEC-5** | All supplier credentials in the gateway's secret store only. Never in Vercel env vars, never in the Next.js bundle, never in Supabase table data |
| **SEC-6** | `service_role` key restricted to Edge Functions and the gateway. Audited in CI — a test fails the build if it appears in any client-reachable bundle |
| **SEC-7** | Every Flutterwave webhook: compare the `verif-hash` header with our secret hash in constant time, then re-query the transaction (`GET /v3/transactions/{id}/verify`) and confirm `status`, `amount`, `currency` and `tx_ref` before giving value. Replay protection via `provider_reference` uniqueness. Respond `200` within 60 s — Flutterwave retries three times, 30 minutes apart |
| **SEC-8** | Rate limiting: search (per IP and per session), auth endpoints, RDAP lookup, abuse form |
| **SEC-9** | Bot protection on search and sign-up — Turnstile or equivalent — to protect the supplier quota and prevent scraping |
| **SEC-10** | Fraud scoring at checkout: new account + high value + international card + mismatched geo → manual review queue. Registrars are targeted for carding because stolen-card domain registration is the dominant funding method for phishing infrastructure; chargeback volume is an existential risk to our payment processing |
| **SEC-11** | Velocity limits: max domains per new account per 24h, configurable, raised automatically with account age and successful payment history |
| **SEC-12** | Encryption at rest (Supabase default) and in transit everywhere. Auth codes never stored in plaintext at rest; fetched on demand and never logged |
| **SEC-13** | `supplier_calls` logging redacts credentials, auth codes and full contact PII (store a hash and a reference, not the payload) |
| **SEC-14** | SDK telemetry disabled and asserted by test [§5.5](#55-two-supplier-behaviours-that-will-bite-us) |
| **SEC-15** | Content Security Policy, HSTS, secure cookie flags, SameSite. No third-party scripts on checkout |
| **SEC-16** | Annual penetration test; dependency scanning in CI |

---

## 15. Design system and UX

> You said you'll supply the UI direction. This section defines the **structure and behaviour** the UI must express — the information architecture, the states every screen needs, and the non-negotiable interaction rules. When your designs land, we map them onto this skeleton rather than renegotiating it.

### 15.1 Information architecture

```
Public
 ├── /                       Home — search is the hero, nothing above it
 ├── /search?q=              Results (shareable URL)
 ├── /domains/{tld}          Per-TLD landing (SEO)
 ├── /pricing                Full catalogue + FX policy
 ├── /whois                  RDAP lookup
 ├── /transfer               Transfer-in landing + eligibility checker
 ├── /help, /abuse, /legal/*
 └── /auth/*

App (authenticated)
 ├── /app                    → redirects to /app/domains
 ├── /app/domains            Portfolio (landing)
 │    └── /{domain}
 │         ├── /             Overview
 │         ├── /nameservers  Host picker, delegation, glue, DNS inspection
 │         ├── /contacts     Four contacts
 │         ├── /security     Lock, auth code, privacy
 │         └── /activity     Event log
 ├── /app/domains/expiring   Expiry view
 ├── /app/transfers          Transfer status
 ├── /app/checkout           (/cart is public — anonymous carts, FR-C1)
 ├── /app/orders             Orders, invoices, receipts
 ├── /app/wallet             Balance, top-up, ledger
 └── /app/settings           Profile, contacts, security, notifications, payment methods
```

### 15.2 Interaction rules — binding regardless of visual direction

| # | Rule |
|---|---|
| **UX-1** | Search is never more than one interaction away, from any screen. Global command palette (`⌘K`) with search, domain jump and action shortcuts. |
| **UX-2** | Every price is shown with its renewal price. No exceptions, anywhere. |
| **UX-3** | No pre-ticked upsells. No dark patterns. No countdown timers manufacturing urgency. |
| **UX-4** | Destructive and irreversible actions require typed confirmation of the domain name, not just a click. |
| **UX-5** | Every async operation has four designed states: loading (skeleton, not spinner), empty, error (with a next action), success. No screen ships without all four. |
| **UX-6** | Delegation changes show real verification progress, never a fake success. A nameserver change is not "done" until the registry and the nameservers both confirm it. |
| **UX-7** | Every error message says what happened, why, and what to do next. "Something went wrong" is a bug. |
| **UX-8** | Lifecycle urgency is a first-class visual: an expiring domain looks different at 30 days, 7 days, expired and redemption. |
| **UX-9** | Mobile-first for the storefront and reminders; the panel is responsive but desktop-optimised for bulk work. |
| **UX-10** | Accessibility: WCAG 2.2 AA. Keyboard-navigable throughout, focus visible, 4.5:1 contrast, `prefers-reduced-motion` honoured, screen-reader labels on every icon-only control. |
| **UX-11** | Performance is design: LCP < 1.5 s on the storefront on a mid-range Android on 4G. That is the actual device our market uses. |

### 15.3 Screens requiring special care

| Screen | Why it's hard |
|---|---|
| **Search results** | Must feel instant while waiting on a network call to Türkiye. Exact-match card streams independently; skeletons sized to final content so nothing jumps. |
| **Checkout confirmation** | The last chance to catch a typo in an irreversible, non-refundable purchase. Domain in large type, spelled out, with the irreversibility checkbox. |
| **Nameserver panel** | The moment of truth. One screen: pick your host, or paste what they gave you. Typo-catching validation, honest verification progress, and a clear "your domain is live" moment when it resolves. |
| **Expiry recovery** | Reached by a panicking user from an email, often on a phone. One screen, one price, one button, zero navigation. |
| **Transfer eligibility** | A checklist, not a form. Each item green/red with the specific reason and, where blocked, the exact date it unblocks. |
| **Partial order failure** | Must be calm and clear: what succeeded, what failed, why, and that the money is already back. |

### 15.4 Motion

Purposeful only: state transitions, list reordering, skeleton→content. Spring physics over linear easing. Nothing over 300 ms in the panel. Everything respects `prefers-reduced-motion`. Motion must never delay interactivity.

---

## 16. Transactional messaging

### 16.1 Message inventory

| Trigger | Channels | Category |
|---|---|---|
| Welcome / verify email | Email | Account |
| Order receipt | Email | Transactional |
| Registration success (per domain) | Email | Transactional |
| Registration failure + refund | Email + SMS | Transactional |
| Nameservers updated | Email | Transactional |
| Delegation verified — your domain is live | Email | Transactional |
| Still not pointed anywhere (T+3 days) | Email | Transactional |
| **ERRP pre-expiry #1 (26–35 days)** | Email + SMS | **Compliance** |
| **ERRP pre-expiry #2 (4–10 days)** | Email + SMS + WhatsApp | **Compliance** |
| **ERRP post-expiry (≤5 days after)** | Email + SMS + WhatsApp | **Compliance** |
| Dunning T-30 → T+25 | Email, escalating to SMS/WhatsApp | Transactional |
| Auto-renew succeeded / failed | Email | Transactional |
| Entering redemption | Email + SMS + WhatsApp | Transactional |
| **Registrant verification required (15-day clock)** | Email + SMS, daily from T-5 | **Compliance** |
| Transfer-in initiated / progressed / completed / failed | Email | Transactional |
| Transfer-out requested / auth code revealed | Email + SMS | **Security** |
| New device sign-in, password/2FA change | Email | **Security** |
| Nameserver / contact / lock change | Email | **Security** |
| Wallet credited / low balance | Email | Transactional |
| Invoice issued | Email | Transactional |

### 16.2 Rules

- **Compliance and security categories are never opt-out-able** and are sent from a separate stream with its own reputation.
- Dedicated sending domain with aligned SPF, DKIM and DMARC (`p=reject` once warm).
- WhatsApp templates pre-approved; SMS via a provider with reliable Nigerian delivery — test all four major MNOs before launch.
- Every send is logged with template version and delivery status; compliance notices additionally land in `compliance_notices`.
- A bounced compliance notice triggers channel fallback **and** an ops alert.

---

## 17. Admin back-office

A real internal tool, not a Supabase Studio session. Separate route group, separate auth claim, full audit logging.

| Module | Capability |
|---|---|
| **Order queue** | Live view of orders in `provisioning`, failures, orphans. Manual retry of a provision job. Force-refund. Per-item supplier call trace |
| **Reconciliation** | Domains where `registry_status ≠ local_status`. One-click resync. Diff view |
| **Float monitor** | Supplier balance time series, burn rate, projected days of cover, top-up log, alert thresholds |
| **Pricing** | Catalogue with wholesale/retail/margin per TLD and trade type. Edit rules. Schedule future changes. Preview the effect of an FX move before applying |
| **Catalogue** | Sync status, TLD merchandising toggles, popularity scores, per-TLD required attributes |
| **Nameserver presets** | Add, edit and order presets. Quarterly re-verification queue. Automatic health check — a preset whose nameservers stop resolving is flagged and hidden from customers. Shows how many domains currently use each preset, so a breakage has a known blast radius |
| **Customers** | Search, view portfolio, wallet ledger, order history. **Impersonation** (read-only by default, write requires a second admin's approval, always logged and always disclosed to the user afterwards) |
| **Domains** | Global search, force sync, status override, manual supplier operation with a mandatory reason field |
| **Abuse** | Inbound reports, triage, forward to supplier abuse, resolution tracking, SLA timers |
| **Fraud** | Manual-review queue, risk scores, velocity overrides, blocklists |
| **Compliance** | ERRP notice log with delivery proof, verification-status dashboard, DSAR queue, retention jobs |
| **Supplier calls** | Searchable log of every DNA request/response for debugging |

---

## 18. Analytics, KPIs and instrumentation

### 18.1 North-star and guardrails

**North star:** *net domains under management (DUM)* — registrations plus transfers-in, minus expiries and transfers-out.

**Guardrails:** provisioning success rate, chargeback rate, support tickets per 100 orders, float days-of-cover.

### 18.2 Funnel

```
search → result viewed → added to cart → checkout started
      → payment completed → registration succeeded → nameservers delegated
      → auto-renew on → renewed at year 1
```

| Metric | Target |
|---|---|
| Search → cart | ≥ 12% |
| Cart → checkout start | ≥ 55% |
| Checkout → payment success | ≥ 85% |
| Payment → registration success | ≥ 98.5% |
| Nameservers supplied at checkout | ≥ 35% |
| Registration → delegation verified within 7 days | ≥ 60% |
| Auto-renew on at checkout | ≥ 70% |
| **Year-1 renewal rate** | ≥ 72% |

Renewal rate is the business. Everything else is a leading indicator of it.

### 18.3 Operational metrics

Supplier call latency (p50/p95/p99) by operation; supplier error rate by code; job queue depth and age; orders stuck in provisioning; float days of cover; delegation verification success rate and median time-to-verify; notification delivery rate by channel; RDAP lookup success by TLD.

### 18.4 Instrumentation requirements

- Server-side event tracking — ad-blockers are common and client-side analytics will undercount.
- Every event carries `user_id` (where authenticated), `session_id`, `order_id` where relevant.
- No PII in analytics payloads. Domain names are hashed in analytics, stored in full only in our own database.
- Error tracking (Sentry, **our own instance**) across Next.js, Edge Functions and the gateway — distinct from and independent of the supplier SDK's telemetry, which is disabled.

---

## 19. Day-0 verification checklist

Everything marked **[VERIFY]**. Do these before writing feature code — several could change the architecture.

| # | Item | How | Blocks |
|---|---|---|---|
| **V1** | ✅ **RESOLVED 20 Sept 2026.** Four `.ng` SLDs available: `.ng`, `.com.ng`, `.net.ng`, `.org.ng` — all **USD 11.99 flat** for both register and renew, 30-day redemption, **no extra checkout attributes required**. `.ng` and `.com.ng` cap at 5 years; `.net.ng` and `.org.ng` at 10. `.i.ng` and `.sch.ng` are **not** in the catalogue. `.ng` transfer prices at **0.00**, which needs confirming — free, or not supported | `apps/gateway/scripts/verify-supplier.ts` | — |
| **V2** | ✅ **RESOLVED.** No `API_301` from an unregistered IP — allowlisting is **not enforced** on this account. The gateway remains correct for credential custody, rate limiting and idempotency, but it is no longer a hard deployment constraint | `verify-supplier.ts` | — |
| **V3** | ✅ **RESOLVED.** Two headers: `X-API-KEY: <api key>` and `__reseller: <reseller uuid>`. No bearer token, no signing | SDK source + live call | — |
| **V4** | ✅ **RESOLVED 22 Sept 2026 — and it is a capacity ceiling.** The supplier allows **two concurrent requests**: a third is refused with `API_429` within ~0.5 s; sequential calls are never refused. A call costs ~0.75 s per extension (1–3 s observed) and little per extra name. The gateway enforces a process-wide limit of 2 in-flight calls, splits each request into ≤2 batches of extensions, retries `API_429` with backoff, and lets the exact match jump the queue. A search costs ~4 calls, so **throughput is roughly one uncached search every 2 s across all users** — the 60 s cache (FR-S6) absorbs repeats. **Support answered 25 Sept 2026: the account-wide hard limit is 2 requests per second (a third simultaneous one gets `API_429`), it cannot be raised, and past softer thresholds they add latency rather than refuse.** The gateway now also caps starts at 2 per second (`supplierSlots`); capacity grows only through caching, never through the supplier | live probe, gateway logs | Search capacity |
| **V5** | ⚠️ **RESOLVED, AND IT IS A PROBLEM.** Account `CLOOP UNIVERSE TECH`, price group **`Reseller`** — the base tier. Balance **USD 0.00 / TRY 0.00**, so nothing can be registered until the float is funded. See R17 | `GetResellerDetails` | Pricing model, launch |
| **V6** | ✅ **RESOLVED.** 723 TLDs, 701 with a 1-year register price. Base-tier USD: `.com` 11.31 reg / 11.51 renew · `.org` 8.49 / 13.99 · `.net` 13.99 / 14.01 · `.io` 44.99 / 64.90 · `.co` 19.49 / 38.99 · `.app` 23.99 flat · `.xyz` 1.99 / 14.99 · `.africa` 25.90 flat. **91 TLDs declare extra attributes, but only 6 actually require one** (`.tr`, `.com.tr`, `.hk`, `.kz`, `.pt`, `.us`) — the rest, `.app` and `.uk` among them, are optional acknowledgements. The `.ng` family declares none | `verify-supplier.ts` | Pricing model |
| **V7** | ✅ **RESOLVED 22 Sept 2026.** Registry premiums return `Status: notavailable`, `IsFee: true`, Reason "Premium domain name. Please cont[act]" (e.g. `google.africa`, `hotel.africa` at USD 3,898.70). They **cannot be registered through the API**, so search flags them as Premium and does not price them; FR-S3's add-to-cart confirmation applies only if the supplier ever sells them. `ClassKey` never populated. `Price` arrives as a decimal string | live `CheckAvailability` | Premium display |
| **V8** | Sponsoring registrar name(s) per TLD | Ask DNA support — required for CMP-1 | Legal pages |
| **V9** | Data protection terms in the DNA reseller agreement | Read the agreement; request an addendum if absent | CMP-11, NDPA |
| **V10** | ⚠️ **BLOCKED.** Current credentials are **production only** — OTE returns `401 Unauthorized! Invalid API Key.` Separate sandbox credentials must be requested from DomainNameAPI support before any write path can be tested | Support request | **Test strategy, all write paths** |
| **V11** | ⏳ Blocked behind V10 — ask in the same support request | Support request | Test strategy |
| **V12** | Can DS records (DNSSEC) be set at all, by any route? | Ask support | Scope confirmation |
| **V13** | `.ng` RDAP endpoint existence | Check IANA bootstrap; query NiRA | RDAP page |
| **V14** | Do the supplier's default nameservers (`tr.apiname.com`, `eu.apiname.com`) serve a parking page, or does an undelegated domain simply not resolve? Can a domain be registered with *no* nameservers? | Register a test domain in OTE and query it | Undelegated empty-state copy |
| **V15** | Flutterwave virtual accounts for our business type, and whether collecting customer BVN/NIN for permanent accounts needs extra KYC on our side | Flutterwave account manager | Bank transfer path |
| **V16** | Nigerian tax treatment of non-resident supplier invoices; e-invoicing onboarding | Nigerian tax adviser | CMP-17, CMP-18 |
| **V17** | NDPC registration status and DPO appointment | Legal | CMP-9, CMP-10 |
| **V18** | Current CBN FX Manual (4th ed., June 2026) requirements for our supplier payment pattern | Bank + adviser | Float funding |
| **V19** | Transfer-in pricing: does a transfer include +1 year for each launch TLD? | `GetTldList` price matrix, `TradeType = Transfer` | Transfer pricing |
| **V20** | Whether privacy protection is free or charged per TLD on our tier | `GetTldList` / panel | Cart defaults |

---

## 20. Risks and mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | ~~`.ng` not available from the supplier~~ **RETIRED** — confirmed available 20 Sept 2026 | — | — | The `RegistrarProvider` interface stays regardless, so a second supplier remains an implementation rather than a rewrite (see R16) |
| R2 | **Supplier float exhausted mid-order** | Medium | High | Pre-flight balance check, 21-day float, 15-min monitoring, alert at 10 days / page at 3 |
| R3 | **Payment succeeded, registration failed, undetected** | Medium | **Critical** | The order saga's invariants, orphan sweep, auto-refund, 15-min alerting |
| R4 | **Double registration from a blind retry** | Low | High | Invariant I1/I2 — pre-flight `GetDetails`, never retry a write on timeout |
| R5 | **Egress IP blocking breaks production** | Medium | High | Gateway with static IP from day one |
| R6 | **FX moves faster than the daily rate** | High | Medium | 4% buffer, 30-min cart lock, 5% threshold guard, daily update |
| R7 | **Chargebacks threaten payment processing** | Medium | **Critical** | Fraud scoring, velocity limits, 2FA prompts, manual review queue, documented dispute process |
| R8 | **Customer buys a domain with no hosting yet, so there are no nameservers to point at** | Medium | Medium | Honest empty state, T+3 nudge, and an "I don't have hosting yet" path that explains the next step rather than dead-ending. Track undelegated domains as a cohort |
| R8b | **A stale nameserver preset points customers at dead nameservers** | Medium | High | `verified_at` on every preset, quarterly re-verification, automatic health check that hides failing presets, and blast-radius visibility in admin ([FR-D2](#e6--nameserver-setup)) |
| R9 | **Supplier API outage during a launch push** | Medium | High | Circuit breaker, order queueing, honest status page, cached catalogue so browsing survives |
| R10 | **NDPA non-compliance penalty** | Medium | High | CMP-9 → CMP-14 before scale; DPO appointed; cross-border basis documented |
| R11 | **Missed ERRP notice → complaint to the sponsoring registrar** | Low | High | Independent compliance notice log, delivery verification, bounce fallback, ops alert |
| R12 | **Supplier changes API or pricing without notice** | Medium | Medium | Contract terms on notice periods; nightly catalogue sync with change alerts; `RegistrarProvider` interface keeps a second supplier viable |
| R13 | **Verisign 1 Nov 2026 `.com` increase mishandled** | Medium | Medium | FR-PRICE-1 scheduled price changes; load the change in October |
| R14 | **Supplier SDK telemetry leaks metadata** | Low | Medium | `telemetry: false`, asserted by test |
| R15 | **Search abuse burns the supplier quota** | Medium | Medium | Caching, rate limiting, bot protection |
| R16 | **Single-supplier concentration** | — | High | Build to `RegistrarProvider` from day one so a second supplier is an implementation, not a rewrite |
| **R17** | **Our supplier prices the whole `.ng` family flat, but the market does not** — verified 20 Sept 2026 | **Confirmed** | **Critical** | DomainNameAPI charges USD 11.99 for `.ng`, `.com.ng`, `.net.ng` and `.org.ng` alike, confirmed from both the catalogue and a live availability check. NiRA does not price them that way: `.ng` is a second-level premium and the third-levels are far cheaper. Nigerian registrars retail `.ng` at ₦13,500–16,000 and `.com.ng` at ₦3,000–7,650. At our cost we must charge ₦19,000 for all four — **27% above market on `.ng` and 171% above on `.com.ng`**, which is unsellable. `.com.ng` is roughly 70% of all `.ng` registrations, so this is the bulk of the Nigerian market. **The constraint is wholesale cost, not our margin: dropping the ₦3,000 profit to zero still leaves `.com.ng` above the going rate.** Action: source the `.ng` family from a NiRA-accredited registrar rather than DomainNameAPI, or obtain NiRA accreditation. `check:competitiveness` monitors this continuously |

---

## 21. Sources

**Supplier (primary — retrieved directly, 20 Sept 2026)**
- DomainNameAPI WSDL: `https://api.domainnameapi.com/DomainApi.svc?wsdl` and schemas `?xsd=0..9`
- Official Node SDK: [github.com/domainreseller/nodejs-dna](https://github.com/domainreseller/nodejs-dna) (v3.0.0, Apache-2.0)
- PHP SDK: [github.com/domainreseller/php-dna](https://github.com/domainreseller/php-dna)
- [Payment options and fees](https://www.domainnameapi.com/payment-options)
- [Reseller program](https://www.domainnameapi.com/domain-reseller) · [API integration](https://www.domainnameapi.com/api-integration) · [TLD list](https://www.domainnameapi.com/tld)

**ICANN policy**
- [Transfer Policy](https://www.icann.org/en/contracted-parties/accredited-registrars/resources/domain-name-transfers/policy)
- [About Resellers](https://www.icann.org/resources/pages/reseller-2013-05-03-en) · [2013 RAA](https://www.icann.org/en/contracted-parties/accredited-registrars/registrar-accreditation-agreement/2013-registrar-accreditation-agreement-17-09-2013-en)
- [Registration Data Policy](https://www.icann.org/en/contracted-parties/consensus-policies/registration-data-policy) · [now in effect, 21 Aug 2025](https://www.icann.org/en/announcements/details/icann-registration-data-policy-now-in-effect-for-contracted-parties-21-08-2025-en)
- [Expired Registration Recovery Policy](https://www.icann.org/resources/pages/errp-2013-02-28-en)
- [RDAP launch / WHOIS sunset, 28 Jan 2025](https://www.icann.org/en/announcements/details/icann-update-launching-rdap-sunsetting-whois-27-01-2025-en)
- [FY2026 registrar fees — $0.20 per transaction year](https://www.icann.org/en/announcements/details/icann-accredited-registrars-approve-registrar-level-fees-for-fiscal-year-2026-21-07-2025-en)

**Registry pricing**
- [Verisign .com $10.26 → $10.97, effective 1 Nov 2026](https://osir.com/en/blog/verisign-com-price-update-2026/) · [Domain Name Wire](https://domainnamewire.com/2026/04/23/breaking-verisign-raising-wholesale-com-prices/)

**Nigeria**
- [NiRA accredited registrars](https://nira.org.ng/accredited-registrars/) · [NiRA accreditation policy](https://nira.org.ng/pdf/NiRA-Registrars-Accreditation-Policy-1.pdf)
- [Flutterwave Nigeria pricing](https://flutterwave.com/ng/pricing) · [Webhooks](https://developer.flutterwave.com/v3.0/docs/webhooks) · [NGN virtual accounts](https://developer.flutterwave.com/v3.0/docs/ngn-virtual-accounts) · [Transaction verification](https://developer.flutterwave.com/v3.0/docs/transaction-verification) · [Tokenized charges](https://developer.flutterwave.com/v3.0/reference/charge-with-token-1)
- [NDPA 2023 overview](https://securiti.ai/overview-of-nigeria-data-protection-act/) · [Controller/processor registration](https://www.michalsons.com/blog/nigeria-data-protection-act-ndpa-controller-and-processor-registration/77465)
- [Nigeria VAT on non-resident digital services from 2026](https://www.vatupdate.com/2025/09/11/nigeria-to-enforce-vat-on-non-resident-digital-services-from-2026/) · [E-invoicing 2026](https://www.globalvatcompliance.com/globalvatnews/nigeria-e-invoicing-rollout-key-updates-2026/)
- [CBN FX Manual 4th edition, June 2026](https://www.mondaq.com/nigeria/financial-services/1806166/key-regulatory-update-in-nigeria-the-cbn-foreign-exchange-manual-2026)

**Competitive and technical**
- [Namecheap ICANN fee disclosure](https://www.namecheap.com/support/knowledgebase/article.aspx/1256/2201/what-is-the-icann-fee/)
- [Registrar comparison 2026](https://domaindetails.com/kb/getting-started/best-domain-registrars-compared)
- [Domain lifecycle and grace periods](https://www.icann.org/resources/pages/domain-name-renewal-expiration-faqs-2018-12-07-en)
- [Anti-fraud practice for registrars — NetBeacon](https://netbeacon.org/best-practice-anti-fraud-tools-and-registration-flows-for-registrars/)
- [Cloudflare custom nameservers](https://developers.cloudflare.com/dns/nameservers/custom-nameservers/)
- [Next.js 16](https://nextjs.org/blog/next-16)
- [Supabase MFA](https://supabase.com/docs/guides/auth/auth-mfa/totp) · [Edge Functions, cron and queues](https://supabase.com/blog/processing-large-jobs-with-edge-functions)

---

## 22. Appendices

### Appendix A — Complete DomainNameAPI operation map

Verified from the live WSDL and SDK source. REST paths from `nodejs-dna/src/DNARest.js`.

| # | Operation | REST path | Purpose |
|---|---|---|---|
| 1 | `CheckAvailability` | `POST domains/bulk-search` | Availability + price, names × TLDs |
| 2 | `GetTldList` | — | Catalogue + price matrix |
| 3 | `GetList` | `GET domains` | Paged portfolio |
| 4 | `GetDetails` | `GET domains/info` | Single domain |
| 5 | `GetDetailsFromRegistry` | — | Registry-authoritative details |
| 6 | `Register` | — | Register with existing contact IDs |
| 7 | `RegisterWithContactInfo` | `POST domains/register-with-contacts` | Register with inline contacts |
| 8 | `Renew` | `POST domains/renew` | Renew |
| 9 | `Restore` | — | RGP restore |
| 10 | `Delete` | — | Delete |
| 11 | `Transfer` | `POST domains/transfer` | Initiate transfer-in |
| 12 | `CheckTransfer` | `POST domains/transfers/check` | Transferability |
| 13 | `QueryTransfer` | — | Transfer status + log |
| 14 | `ApproveTransfer` | `POST domains/transfers/approve` | Approve outbound |
| 15 | `RejectTransfer` | `POST domains/transfers/reject` | Reject outbound |
| 16 | `CancelTransfer` | `POST domains/transfers/cancel` | Cancel inbound |
| 17 | `ModifyNameServer` | `PUT domains/dns/name-server` | Delegation |
| 18 | `AddChildNameServer` | `POST domains/dns/host` | Glue |
| 19 | `ModifyChildNameServer` | `PUT domains/dns/host` | Glue |
| 20 | `DeleteChildNameServer` | `DELETE domains/dns/host` | Glue |
| 21 | `GetChildNameServer` | — | Glue |
| 22 | `GetChildNameServers` | — | Glue |
| 23 | `GetContacts` | — | Four contacts |
| 24 | `SaveContacts` | `PUT domains/contacts/update` | Update contacts |
| 25 | `ModifyContacts` | — | Reassign by contact ID |
| 26 | `ModifyPrivacyProtectionStatus` | `POST domains/privacy` | WHOIS privacy |
| 27 | `EnableTheftProtectionLock` | `POST domains/lock` (`true`) | Transfer lock on |
| 28 | `DisableTheftProtectionLock` | `POST domains/lock` (`false`) | Transfer lock off |
| 29 | `ModifyAuthCode` | — | Set/regenerate auth code |
| 30 | `ModifyStatus` | — | Add/remove EPP statuses |
| 31 | `ModifyRenewalMode` | — | Auto-renew mode |
| 32 | `Sync` | — | Sync expiry day/month |
| 33 | `SyncFromRegistry` | — | Pull registry state |
| 34 | `CreateForward` | — | URL forwarding |
| 35 | `ModifyForward` | — | URL forwarding |
| 36 | `DeleteForward` | — | URL forwarding |
| 37 | `GetForward` | — | URL forwarding |
| 38 | `GetResellerDetails` | — | Account + balances |
| 39 | `GetCurrentBalance` | `GET deposit/accounts/me` | Balance by currency |

**Not present at any path: DNS zone record CRUD.**

### Appendix B — Key supplier data shapes

```
DomainInfo
  DomainName, Roid, StatusCode, ResellerId
  StartDate, ExpirationDate, UpdatedDate, TransferDate, RemainingDay
  LockStatus, PrivacyProtectionStatus, IsPremiumName, IsChildNameServer
  RenewalMode, Auth
  NameServerList[], ChildNameServerInfo[], RGPStatues[]
  RegistrantContactId, AdministrativeContactId, TechnicalContactId, BillingContactId
  AdditionalAttributes{}

ContactInfo
  FirstName, LastName, Company, EMail
  AddressLine1..3, City, State, ZipCode, Country
  Phone, PhoneCountryCode, Fax, FaxCountryCode
  Type (ContactType enum), Auth, AdditionalAttributes{}

TldInfo
  Name, Country
  MinRegistrationPeriod, MaxRegistrationPeriod
  MinCharacterCount, MaxCharacterCount
  EppAllowed, IsTransferable, IsDocumentRequired, RequiredDocumentInfo
  RedemptionPeriod
  PriceInfoList[] → { TradeType, Period, Price, CurrencyId, CurrencyName, OrMore }

DomainAvailabilityInfo
  DomainName, Tld, Command, Period
  Price, Currency, IsFee, ClassKey, Reason

TradeType enum
  Registration, Renew, Transfer, Restore, Setup, Trade,
  AdditionalLicence, PayRenewal, BackOrder, Refund, PreRegistration

ContactType enum
  Contact, CoopContact, UkContact, EuContact, CnContact, CoContact,
  CaContact, DeContact, EsContact, CoopSponsor, Sponsor,
  Trabis2DefaultContact, Trabis2OwnerContact

BaseMethodResponse
  OperationResult (SUCCESS|ERROR), ErrorCode (int), OperationMessage
```

### Appendix C — Supplier error codes (documented subset)

| Code | Meaning | Our handling |
|---|---|---|
| `CREDENTIALS` | Invalid username/password | Page ops. Never shown to users |
| `API_301` | IP address not authorized | Page ops. Deployment problem |
| `API_310` | TLD not supported | `TLD_UNSUPPORTED`, remove from catalogue, alert |
| `API_350` | Insufficient reseller balance | `SUPPLIER_INSUFFICIENT_FUNDS`, page ops, queue order |
| `DOMAIN_REGISTER` | Registration failed | Classify from message; refund |
| `DOMAIN_RENEW` | Renewal failed | Retry ladder, then ops |
| `DOMAIN_DETAILS` | Not found / bad format | Reconciliation flag |
| `DOMAIN_LIST` | Unexpected list response | Reconciliation retry |
| `CONTACT_INFO` / `CONTACT_SAVE` | Contact problem | Field-level validation |

The full numeric table (100+ codes, ranges 101–211 system, 400–451 contact, 500–599 domain, 2003–2304 operational) is in the php-dna repository. Map it exhaustively in the gateway before launch.

### Appendix D — Glossary

| Term | Meaning |
|---|---|
| **AGP** | Add Grace Period — ~5 days after registration |
| **AuthInfo / EPP code / auth code** | Per-domain secret authorising a transfer |
| **DUM** | Domains under management |
| **ERRP** | Expired Registration Recovery Policy |
| **FOA** | Form of Authorization — transfer authorisation artefact |
| **gTLD / ccTLD** | Generic / country-code top-level domain |
| **Glue / child nameserver** | A nameserver inside the domain it serves, needing an IP at the registry |
| **OTE** | Operational Test and Evaluation — supplier sandbox |
| **RAA** | Registrar Accreditation Agreement |
| **RDAP** | Registration Data Access Protocol — the WHOIS replacement |
| **RGP** | Redemption Grace Period |
| **TEAC** | Transfer Emergency Action Contact — 4-hour response obligation |
| **UDRP** | Uniform Domain-Name Dispute-Resolution Policy |
| **WDRP / RDRP** | Registration Data Reminder Policy |

---

*End of document.*
