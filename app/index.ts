import {type AnalyticsData, DAY_MS, realtimeRow} from './data'
import {ASSETS, UPLOT_SCRIPT, UPLOT_STYLE} from './page'
import {CHAINS, type ChainDay, type VaultDay} from './subgraph'
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
        "SELECT key, value FROM sync_state WHERE key = 'realtime' OR key LIKE 'subgraph:%'",
      ),
      db.prepare(`
      WITH dates AS (SELECT date FROM circulation_day UNION SELECT date FROM legacy_circulation_day),
      chains AS (
        SELECT date, MAX(CASE WHEN chain = 'ethereum' THEN circulation END) AS ethereum,
          MAX(CASE WHEN chain = 'base' THEN circulation END) AS base
        FROM circulation_day GROUP BY date
      )
      SELECT date, ethereum, base, phala, khala,
        COALESCE(ethereum, 0) + COALESCE(base, 0) + COALESCE(phala, 0) + COALESCE(khala, 0) AS total
      FROM dates LEFT JOIN chains USING (date) LEFT JOIN legacy_circulation_day USING (date) ORDER BY date
    `),
      db.prepare('SELECT * FROM circulation_day ORDER BY date, chain'),
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
  const subgraph = (chain: string) => {
    const value = values.get(`subgraph:${chain}`)
    return typeof value === 'string' ? JSON.parse(value) : null
  }
  return {
    generatedAt: now.toISOString(),
    realtime: realtimeRow(JSON.parse(value)),
    subgraphs: {ethereum: subgraph('ethereum'), base: subgraph('base')},
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

const PAGE_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'none'",
    `script-src 'self' ${UPLOT_SCRIPT}`,
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
      (SELECT MAX(date) FROM circulation_day WHERE chain = 'base') AS base,
      (SELECT MAX(date) FROM vault_day) AS vault,
      (SELECT MAX(date) FROM claim_day) AS claims,
      (SELECT MAX(date) FROM cloud_daily) AS cloud`),
    db.prepare("SELECT key, value FROM sync_state WHERE key LIKE 'subgraph:%'"),
  ])
  const latest = dates?.results[0] ?? {}
  const status = new Map(
    states?.results.map((row) => [row.key, JSON.parse(String(row.value))]),
  )
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`)
  const fresh = (date: unknown, days: number) =>
    typeof date === 'string' &&
    Number.isFinite(Date.parse(date)) &&
    today - Date.parse(date.slice(0, 10)) >= 0 &&
    today - Date.parse(date.slice(0, 10)) <= days * DAY_MS
  const reviewed = CHAINS.every(
    (chain) =>
      status.get(`subgraph:${chain}`)?.vaultImplementationReviewed === true,
  )
  const ok =
    CHAINS.every(
      (chain) =>
        fresh(latest[chain], 2) &&
        fresh(status.get(`subgraph:${chain}`)?.timestamp, 2),
    ) &&
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

export const fetchHandler = async (
  request: Request,
  env: Env,
): Promise<Response> => {
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return new Response('Method not allowed', {
      status: 405,
      headers: {Allow: 'GET, HEAD'},
    })
  const path = new URL(request.url).pathname
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
