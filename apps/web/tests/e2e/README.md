# End-to-end tests

Playwright. Runs against a production build (`pnpm build && pnpm start`), never the dev server —
dev-only behaviour hides real bugs.

## What belongs here

Journeys that cross boundaries and must not break:

- search → cart → checkout → registration → portfolio
- nameserver setup → delegation verification
- transfer-in eligibility → transfer → status
- renewal and expiry recovery
- auth: sign-up, sign-in, 2FA enrolment, AAL2 step-up

## What does not

Component behaviour and pure logic. Those are Vitest tests, which run in milliseconds.

## Rules

- **Never touch the live supplier.** Point `GATEWAY_URL` at a stub, or run the gateway against
  DomainNameAPI's OTE sandbox. A test that registers a real domain costs real money.
- **Never use live payment credentials.** Flutterwave test keys only — `requirePaymentEnv()` refuses anything else outside production.
- Every suite runs on desktop, tablet and mobile projects — responsiveness is asserted, not assumed.
- Accessibility is asserted with axe on every page-level suite.
