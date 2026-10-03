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

The rules `boundaries.test.ts` holds: queries and actions are server-only; every `.select(`
takes a string literal (no variable, no `${…}`), so the scan can read it; no `select('*')`;
no select names a column in `PRIVATE_COLUMNS` (personal data, secrets, raw provider answers);
no embed but the table's own side parent, by plain names; `.from()` only names `ADMIN_TABLES`
keys; writes are only `rpc('admin_*')`; the service client is imported only by
`queries/session.ts`; and each sensitive projection (`admin_reveal_*`, `admin_find_customers`,
`admin_float`, the `admin_*_v` views, `order_item_costs`, `supplier_ledger_*`, `float_topups`,
…) appears only in the package ADMIN-SPEC §9 gives it to (`PERMITTED` in the test).

## Rules for B packages

- **`adminDb(...).from(name).select(columns)`** takes plain column names, plus one embed of the
  table's side parent by plain names (`orders(order_number)` on `order_items`). Anything else —
  another embed (the service key would follow `user_id` to `profiles`), an alias, a cast, a JSON
  path, `*`, a name in `PRIVATE_COLUMNS` — throws. Select once: the builder refuses a second
  `select()`. Orders are read through `admin_orders_v`, which has no registrant or contacts.
- **The builder `select()` hands back is read-only.** Filter, order and page it (`eq`, `ilike`,
  `in`, `not`, `or`, `match`, `order`, `range`, `limit`, `single`, …) and await it; every other
  method throws, its `url`, `method` and `headers` read as undefined, and nothing on it can be
  set. A filter or order column — an embedded path, a JSON path, a `match()` key or an `or()`
  condition included — is held to `PRIVATE_COLUMNS` like the select.
- **Test admins** see a domain's contacts, or send an email again, only for a test-mode row that
  belongs to an e2e account (`reserved_target`); live targets refuse them as `TEST_ADMIN`.
- **Wrapper errors.** Call `adminAccessError(error.message)` on an RPC error and throw what it
  returns. A recognised admin code (`admin:role`, `NOT_HELD`, …) becomes an `AdminRefusal`: the
  call was refused, nothing changed, and `ConfirmAction` takes a new request key. Anything else
  (`fetch failed`, a statement timeout) is a plain `Error`: the action answers
  `SERVER_CRASH_WORDS`, `adminOutcome` reads it as `UNKNOWN_OUTCOME`, and the dialog keeps its
  key — the wrapper may have committed, and trying again with the same key replays it.
- **Reveals.** `admin_reveal_customer` / `admin_reveal_registrant` show details only on a fresh
  request key. A replayed key answers `{ ok, auditId, replayed: true }` with no details: take a
  new key and ask again (gated, rate-limited and audited again).

`app/` routes import from here. Nothing here imports from `app/`.
