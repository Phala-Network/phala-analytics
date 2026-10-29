import {createCirculationApi} from './circulation'
import {
  type AnalyticsData,
  CIRCULATION_SERIES_START,
  DAY_MS,
  realtimeRow,
} from './data'
import {ASSETS, UPLOT_SCRIPT, UPLOT_STYLE} from './page'
import type {ChainDay, VaultDay} from './subgraph'
import {sync} from './sync'

type StoredStatus<T> = Omit<T, 'vaultImplementationReviewed'> & {
  vaultImplementationReviewed: number
}
const statusRow = <T extends {vaultImplementationReviewed: boolean}>(
  row: StoredStatus<T>,
) => ({
  ...row,
  vaultImplementationReviewed: row.vaultImplementationReviewed === 1,
})

export const analyticsData = async (
  db: D1Database,
  now: Date,
): Promise<AnalyticsData> => {
  const [state, circulation, chainCirculation, vault, claims, cloud] =
    await db.batch<Record<string, unknown>>([
      db.prepare(
        "SELECT key, value FROM sync_state WHERE key IN ('realtime', 'subgraph:ethereum')",
      ),
      db
        .prepare(`
      WITH dates AS (
        SELECT date FROM circulation_day WHERE chain = 'ethereum'
        UNION SELECT date FROM legacy_circulation_day
      ), ethereum AS (
        SELECT date, circulation AS ethereum FROM circulation_day WHERE chain = 'ethereum'
      )
      SELECT date, ethereum, phala, khala,
        COALESCE(ethereum, 0) + COALESCE(phala, 0) + COALESCE(khala, 0) AS total
      FROM dates LEFT JOIN ethereum USING (date) LEFT JOIN legacy_circulation_day USING (date)
      WHERE date >= ?1 ORDER BY date
    `)
        .bind(CIRCULATION_SERIES_START),
      db
        .prepare(
          "SELECT * FROM circulation_day WHERE chain = 'ethereum' AND date >= ? ORDER BY date",
        )
        .bind(CIRCULATION_SERIES_START),
      db.prepare('SELECT * FROM vault_day ORDER BY date'),
      db.prepare('SELECT * FROM claim_day ORDER BY date'),
      db.prepare(`
      SELECT date, total_users AS totalUsers, total_vms AS totalVms,
        running_vms AS runningVms, total_vcpu AS totalVcpu, running_vcpu AS runningVcpu,
        active_users AS activeUsers, captured, source FROM cloud_daily ORDER BY date
    `),
    ])
  const values = new Map(state?.results.map((row) => [row.key, row.value]))
  const value = values.get('realtime')
  if (
    typeof value !== 'string' ||
    !circulation ||
    !chainCirculation ||
    !vault ||
    !claims ||
    !cloud
  )
    throw new Error('Analytics has not been synchronized')
  const subgraph = values.get('subgraph:ethereum')
  return {
    generatedAt: now.toISOString(),
    realtime: realtimeRow(JSON.parse(value)),
    subgraphs: {
      ethereum: typeof subgraph === 'string' ? JSON.parse(subgraph) : null,
    },
    circulation: circulation.results as AnalyticsData['circulation'],
    chainCirculation: (
      chainCirculation.results as StoredStatus<ChainDay>[]
    ).map(statusRow<ChainDay>),
    vault: (
      vault.results as (Omit<StoredStatus<VaultDay>, 'paused'> & {
        paused: number
      })[]
    ).map((row) => ({
      ...row,
      paused: row.paused === 1,
      vaultImplementationReviewed: row.vaultImplementationReviewed === 1,
    })),
    claims: claims.results as AnalyticsData['claims'],
    cloud: cloud.results.map(({source, ...row}) => ({
      ...row,
      backfilled: source === 'api-backfill',
    })) as AnalyticsData['cloud'],
  }
}

// Cloudflare Web Analytics (automatic setup) injects a versioned beacon at
// beacon.min.js/<version>; the trailing slash matches that path prefix. Beacons
// post to this origin's /cdn-cgi/rum, which connect-src 'self' covers.
const WEB_ANALYTICS_SCRIPT =
  'https://static.cloudflareinsights.com/beacon.min.js/'

const PAGE_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'none'",
    `script-src 'self' ${UPLOT_SCRIPT} ${WEB_ANALYTICS_SCRIPT}`,
    `style-src 'self' ${UPLOT_STYLE}`,
    "connect-src 'self'",
    "img-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
}

const health = async (db: D1Database, now: Date) => {
  const [dates, states] = await db.batch<Record<string, unknown>>([
    db.prepare(`SELECT
      (SELECT MAX(date) FROM circulation_day WHERE chain = 'ethereum') AS ethereum,
      (SELECT MAX(date) FROM vault_day) AS vault,
      (SELECT MAX(date) FROM claim_day) AS claims,
      (SELECT MAX(date) FROM cloud_daily) AS cloud`),
    db.prepare("SELECT value FROM sync_state WHERE key = 'subgraph:ethereum'"),
  ])
  const latest = dates?.results[0] ?? {}
  const state = states?.results[0]?.value
  const status = typeof state === 'string' ? JSON.parse(state) : null
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`)
  const fresh = (date: unknown, days: number) =>
    typeof date === 'string' &&
    Number.isFinite(Date.parse(date)) &&
    today - Date.parse(date.slice(0, 10)) >= 0 &&
    today - Date.parse(date.slice(0, 10)) <= days * DAY_MS
  const reviewed = status?.vaultImplementationReviewed === true
  const ok =
    fresh(latest.ethereum, 2) &&
    fresh(status?.timestamp, 2) &&
    fresh(latest.vault, 3) &&
    fresh(latest.cloud, 3) &&
    reviewed
  return Response.json(
    {
      ok,
      generatedAt: now.toISOString(),
      ...latest,
      vaultImplementationReviewed: reviewed,
    },
    {
      status: ok ? 200 : 503,
      headers: {'Cache-Control': 'no-store'},
    },
  )
}

const circulationApis = new WeakMap<
  Env,
  ReturnType<typeof createCirculationApi>
>()

export const fetchHandler = async (
  request: Request,
  env: Env,
): Promise<Response> => {
  const path = new URL(request.url).pathname
  // The dashboard endpoints keep their existing method and error handling.
  if (
    (path === '/api' || path.startsWith('/api/')) &&
    path !== '/api/data' &&
    path !== '/api/health'
  ) {
    let api = circulationApis.get(env)
    if (!api) {
      api = createCirculationApi(caches.default, env.VERSION.id)
      circulationApis.set(env, api)
    }
    return api.fetch(request, env)
  }
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return new Response('Method not allowed', {
      status: 405,
      headers: {Allow: 'GET, HEAD'},
    })
  let response: Response
  try {
    const asset = ASSETS[path]
    if (asset) {
      response = new Response(asset.body, {
        headers: {
          ...PAGE_HEADERS,
          'Content-Type': asset.type,
          'Cache-Control': 'public, max-age=300',
        },
      })
    } else if (path === '/api/data') {
      response = Response.json(await analyticsData(env.DB, new Date()), {
        headers: {'Cache-Control': 'public, max-age=300'},
      })
    } else if (path === '/api/health') {
      response = await health(env.DB, new Date())
    } else {
      response = new Response('Not found', {status: 404})
    }
  } catch (error) {
    console.error('Analytics request failed', error)
    response = Response.json(
      {error: 'Analytics temporarily unavailable'},
      {
        status: 503,
        headers: {'Cache-Control': 'no-store'},
      },
    )
  }
  return request.method === 'HEAD' ? new Response(null, response) : response
}

export default {
  fetch: fetchHandler,
  async scheduled(controller, env) {
    await sync(env, new Date(controller.scheduledTime))
  },
} satisfies ExportedHandler<Env>
