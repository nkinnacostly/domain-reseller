# Domain Reseller

Domain registration storefront and control panel for the Nigerian market, reselling
DomainNameAPI's catalogue under our own brand.

**Search → add to cart → buy → manage.** Naira pricing, renewal price always shown,
nameservers pointed at whatever host the customer already uses.

## Start here

| Document | What it covers |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | How to work in this repo — rules, structure, testing, conventions. **Read before writing code.** |
| [`docs/PRD.md`](docs/PRD.md) | What we are building and why. Requirements, compliance, architecture decisions. |

## Getting started

```bash
pnpm install
cp .env.example .env     # fill in the values
pnpm db:start            # local Supabase (Docker required)
pnpm db:types            # generate database types
pnpm dev                 # web on :3000, gateway on :8787
```

## Layout

```
apps/web        Next.js 16 storefront and panel        → Vercel
apps/gateway    Registrar gateway, holds supplier creds → static-egress-IP host
packages/shared Domain logic, pricing, schemas, errors
packages/db     Generated Supabase types
supabase/       config.toml + migrations
```

The gateway is separate because DomainNameAPI allowlists egress IPs and Vercel's are
dynamic. It is also the only place supplier credentials exist.

## Checks

```bash
pnpm lint            # Biome
pnpm typecheck       # tsc across the workspace
pnpm test            # Vitest — unit, component, integration
pnpm test:coverage   # with thresholds enforced
pnpm --filter @dr/web test:e2e   # Playwright, five device profiles
```

## Status

Scaffold complete and verified: typecheck, lint, 86 unit tests, 7 E2E tests and a
production build all pass. Feature implementation has not started — see
[`docs/PRD.md`](docs/PRD.md) §19 for the Day-0 verification items that gate it.
