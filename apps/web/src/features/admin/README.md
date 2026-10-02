# feature: admin

The back office at `/admin` (ADR-006, [`docs/ADMIN-SPEC.md`](../../../../../docs/ADMIN-SPEC.md)).
Admins are the `admins` table, checked in SQL on every request; there is no admin claim and
no RLS bypass. Everything for this feature lives here — `app/(admin)/admin/**` is routing only.

| Folder | Holds |
|---|---|
| `queries/session.ts` | `requireAdmin()`, `adminSessionStatus()`, `getAdminSide()` and **`adminDb(admin, side)`** — select-only service reads over `ADMIN_TABLES`, with the Live/Test side applied for you. The only file here that may import the service client. |
| `queries/gateway.ts` | `callAdminGateway()` — the gateway's `/v1/admin/*` routes, logged by route template. |
| `queries/attention.ts` | What needs a person, per side (`admin_attention_counts`). |
| `queries/<area>.ts` | A B package's reads: `adminDb` row lists, or `admin_*` SQL functions for aggregates and anything personal. |
| `actions/` | Server Actions built with `adminAction` / `adminMoneyAction` from `@/lib/safe-action`. Writes are `rpc('admin_*')` wrappers called with `ctx.db` (the session client) — never a table. Live reads write an `admin_note` first, then call the gateway with its id (`actions/supplier-live.ts`). |
| `components/` | Shared: `table/*`, `confirm-action`, `admin-status-pill`, `stat-tile`, `charts/*`, `dl-grid`, `timeline`, `copy-value`, `empty-state`, `error-state`, `route-tabs`, `diff-table`, `shell/*`. A B package's own go in `components/<area>/`. |
| `lib/` | Pure functions: the tier mirror (`actions.ts`), list params, WAT/USD/mask formatting, labels, tones, the DEPLOY §6 playbook, error words, the side, links by id. |
| `schemas/` | Zod inputs. `common.ts` has the reason, request key, code and id schemas. |
| `__tests__/` | `foundation/` is Package A's, including `boundaries.test.ts`, which every B package must pass. |

The rules `boundaries.test.ts` holds: queries and actions are server-only; no `select('*')`;
no select names a column of personal data, secrets or raw provider answers; `.from()` only
names `ADMIN_TABLES` keys; writes are only `rpc('admin_*')`; the service client is imported
only by `queries/session.ts`.

`app/` routes import from here. Nothing here imports from `app/`.
