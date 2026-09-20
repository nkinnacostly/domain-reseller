# feature: renewals

Everything for this feature lives here — do not scatter it across `app/`.

| Folder | Holds |
|---|---|
| `components/` | React components for this feature only. Shared UI goes in `src/components/`. |
| `actions/` | Server Actions. Every one wrapped in `actionClient` / `authAction` / `elevatedAction`. |
| `queries/` | Data reads. Server-side by default; these keep Server Components thin. |
| `lib/` | Pure functions. No React, no I/O — so they are trivially testable. |
| `schemas/` | Zod schemas for this feature's inputs. Re-export from `@dr/shared/schemas` where shared. |
| `__tests__/` | Unit and integration tests. Colocated, not in a distant mirror tree. |

`app/` routes import from here. Nothing here imports from `app/`.
