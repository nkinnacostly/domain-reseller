import type { Database } from '@dr/db'
import type { AdminPresetDraftCheck } from '@dr/shared/admin'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createPriceRefresh } from '../catalogue/refresh'
import { CATALOGUE_HEARTBEAT, createCatalogueStore, createRunLog } from '../catalogue/store'
import { createCatalogueSource } from '../catalogue/supplier'
import { summarise, syncCatalogue } from '../catalogue/sync'
import { getDnaWriteClient, type WriteTarget } from '../dna/client'
import { type Env, env as processEnv } from '../env'
import { getJson } from '../lib/http'
import { logger } from '../lib/logger'
import { TokenBucket } from '../lib/rate-limit'
import { supplierSlots } from '../lib/semaphore'
import { createFlutterwave } from '../payments/flutterwave'
import { createPresetChecker } from '../presets/checker'
import { createAddressLookup } from '../presets/resolvers'
import { createPresetStore } from '../presets/store'
import { createDnaRegistrar } from '../provisioning/registrar'
import { createSslClient } from '../ssl/client'
import {
  createSslListingSource,
  createSslProductStore,
  type SslSyncResult,
  summariseSsl,
  syncSslProducts,
} from '../ssl/products'
import { SSL_CATALOGUE_HEARTBEAT } from '../ssl/schedule'
import { type AdminStore, createAdminStore, createNoteStore } from './notes'
import {
  type AdminRouterDeps,
  adminBucket,
  type CatalogueActions,
  type CatalogueRun,
  createAdminRouter,
} from './routes'
import { createAdminSupplier } from './supplier'

/**
 * The admin router wired to this gateway's environment. Everything is built
 * on first use, so a gateway without GATEWAY_ADMIN_SECRET — which answers
 * 503 to every admin route — creates no client at all.
 */

type CatalogueSync = { outcome: CatalogueRun['outcome']; reason: string | null }

function once<T>(make: () => T): () => T {
  let value: { made: T } | null = null
  return () => {
    value ??= { made: make() }
    return value.made
  }
}

export function adminDepsFor(
  env: Env,
  overrides: { client?: SupabaseClient<Database> } = {},
): AdminRouterDeps {
  const target: 'off' | WriteTarget = env.DNA_WRITE_ENV
  const client = once(
    () =>
      overrides.client ??
      createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      }),
  )
  const store = once<AdminStore>(() => createAdminStore(client()))
  const keyFor = (side: WriteTarget) => (side === 'ote' ? env.DNA_API_TEST_KEY : env.DNA_API_KEY)
  const run = <T>(task: () => Promise<T>, lane: { priority: 'normal' | 'low'; waitMs: number }) =>
    supplierSlots.run(task, lane)

  const targetSupplier = once(() => {
    if (target === 'off') return null
    const apiKey = keyFor(target)
    return apiKey
      ? createAdminSupplier({ environment: target, apiKey, resellerId: env.DNA_RESELLER_ID, run })
      : null
  })
  const catalogueSupplier = once(() => {
    const apiKey = keyFor(env.DNA_ENV)
    return apiKey
      ? createAdminSupplier({
          environment: env.DNA_ENV,
          apiKey,
          resellerId: env.DNA_RESELLER_ID,
          run,
        })
      : null
  })
  // Recorded like any supplier call, under its own name (I7, §4.2).
  const audit = (side: WriteTarget) => (call: Parameters<AdminStore['recordCall']>[1]) =>
    store().recordCall(side, { ...call, operation: `Admin${call.operation}` })

  const lookup = once(() =>
    target === 'off'
      ? null
      : createDnaRegistrar({
          client: getDnaWriteClient(target),
          environment: target,
          audit: audit(target),
          slotWait: { waitMs: 12_000, priority: 'normal' },
        }).lookup,
  )
  const ssl = once(() => {
    if (target === 'off') return null
    const apiKey = keyFor(target)
    return apiKey
      ? createSslClient({
          environment: target,
          apiKey,
          resellerId: env.DNA_RESELLER_ID,
          audit: audit(target),
          slotWait: { waitMs: 12_000, priority: 'normal' },
        })
      : null
  })
  const flutterwave = once(() =>
    target !== 'off' && env.FLUTTERWAVE_SECRET_KEY
      ? createFlutterwave({
          secretKey: env.FLUTTERWAVE_SECRET_KEY,
          baseUrl: env.FLUTTERWAVE_API_URL,
        })
      : null,
  )

  // D19: the weekly sync, run early by an owner. Only the production
  // catalogue is ever compared with or written to `tlds`; only a production
  // deployment writes it, as the scheduled job (N5b).
  const readsLiveCatalogue = env.DNA_ENV === 'production'
  const writesCatalogue = readsLiveCatalogue && env.NODE_ENV === 'production'
  const refresh = env.APP_URL ? createPriceRefresh(env.APP_URL) : null
  const lowLane = (task: () => Promise<unknown>) =>
    supplierSlots.run(task, { waitMs: 60_000, priority: 'low' })

  const catalogue = once<CatalogueActions | null>(() => {
    if (!readsLiveCatalogue) return null
    const source = createCatalogueSource({
      resellerId: env.DNA_RESELLER_ID,
      apiKey: env.DNA_API_KEY,
      environment: 'production',
      run: lowLane as <T>(task: () => Promise<T>) => Promise<T>,
      getJson,
    })
    const tlds = createCatalogueStore(client())
    const toRun = (result: Awaited<ReturnType<typeof syncCatalogue>>): CatalogueRun => {
      const counts = summarise(result)
      return {
        outcome: result.outcome,
        reason: result.reason,
        listed: result.listed,
        sellable: result.sellable,
        changes: counts.added + counts.retired + counts.priceChanges + counts.otherChanges,
        report: result.report,
      }
    }
    return {
      preview: async () => toRun(await syncCatalogue({ source, store: tlds, apply: false })),
      apply: async () => {
        if (!writesCatalogue) {
          return {
            outcome: 'refused',
            reason: 'Only the production gateway applies the catalogue',
            listed: 0,
            sellable: 0,
            changes: 0,
            report: [],
          }
        }
        const result = await syncCatalogue({ source, store: tlds, apply: true })
        await afterApply(CATALOGUE_HEARTBEAT, result, summarise(result))
        return toRun(result)
      },
    }
  })

  const sslCatalogue = once<CatalogueActions | null>(() => {
    if (!readsLiveCatalogue) return null
    const source = createSslListingSource({
      resellerId: env.DNA_RESELLER_ID,
      apiKey: env.DNA_API_KEY,
      environment: 'production',
      run: lowLane as <T>(task: () => Promise<T>) => Promise<T>,
      getJson,
    })
    const products = createSslProductStore(client())
    const toRun = (result: SslSyncResult): CatalogueRun => {
      const counts = summariseSsl(result)
      return {
        outcome: result.outcome,
        reason: result.reason,
        listed: result.listed,
        sellable: result.readable,
        changes: counts.added + counts.retired + counts.priceChanges + counts.otherChanges,
        report: result.report,
      }
    }
    return {
      preview: async () => toRun(await syncSslProducts({ source, store: products, apply: false })),
      apply: async () => {
        if (!writesCatalogue) {
          return {
            outcome: 'refused',
            reason: 'Only the production gateway applies the catalogue',
            listed: 0,
            sellable: 0,
            changes: 0,
            report: [],
          }
        }
        // Never is_sellable: that column is the owner's, set in the dashboard.
        const result = await syncSslProducts({ source, store: products, apply: true })
        await afterApply(SSL_CATALOGUE_HEARTBEAT, result, summariseSsl(result))
        return toRun(result)
      },
    }
  })

  /** As the weekly schedule does: refresh the site's prices, then beat its heartbeat. */
  async function afterApply(
    heartbeat: string,
    result: CatalogueSync,
    counts: Record<string, unknown>,
  ) {
    const runs = createRunLog(client(), heartbeat)
    const previous = await runs.last().catch(() => null)
    const pricesRefreshed = result.outcome === 'written' && refresh ? await refresh() : null
    await runs.record({
      outcome: result.outcome,
      ...(result.outcome === 'refused' ? { reason: result.reason } : {}),
      ...counts,
      pricesRefreshed,
      lastSuccessAt:
        result.outcome === 'refused'
          ? ((previous?.detail.lastSuccessAt as string | undefined) ?? null)
          : new Date().toISOString(),
      by: 'admin',
    })
  }

  const presets = once(() =>
    createPresetChecker({
      store: createPresetStore(client()),
      lookup: createAddressLookup(),
      everyMs: env.PRESET_CHECK_HOURS * 3_600_000,
      log: logger,
    }),
  )

  return {
    secret: env.GATEWAY_ADMIN_SECRET,
    target,
    notes: {
      claim: (...args) => createNoteStore(client()).claim(...args),
      result: (...args) => createNoteStore(client()).result(...args),
    },
    store: {
      recordCall: (...args) => store().recordCall(...args),
      recordFlwCheck: (...args) => store().recordFlwCheck(...args),
      tldCost: (...args) => store().tldCost(...args),
      draft: (...args) => store().draft(...args),
    },
    targetSupplier,
    catalogueSupplier,
    lookup,
    ssl,
    flutterwave,
    catalogue,
    sslCatalogue,
    async checkDraft(draft): Promise<AdminPresetDraftCheck> {
      const result = await presets().checkDraft(draft)
      return {
        ok: result.verdict === 'pass',
        hosts: result.hosts.map((host) => ({ host: host.host, ok: host.verdict === 'resolves' })),
        checkedAt: new Date().toISOString(),
      }
    },
    bucket: adminBucket(),
    flwBucket: new TokenBucket(10, 0.2),
    now: () => new Date(),
    log: logger,
  }
}

export function createDefaultAdminRouter() {
  return createAdminRouter(adminDepsFor(processEnv))
}
