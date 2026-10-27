import {type AnalyticsData, DAY_MS, realtimeRow, VAULT_DAILY_SQL} from './data'
import {PAGE} from './page'
import {sync} from './sync'

export const analyticsData = async (
  db: D1Database,
  now: Date,
): Promise<AnalyticsData> => {
  const [realtime, circulation, vault, cloud] = await db.batch<
    Record<string, unknown>
  >([
    db.prepare("SELECT value FROM sync_state WHERE key = 'realtime'"),
    db.prepare(`
      SELECT date, ethereum, base, phala, khala,
        ethereum + COALESCE(base, 0) + COALESCE(phala, 0) + COALESCE(khala, 0) AS total
      FROM circulation_daily ORDER BY date
    `),
    db.prepare(VAULT_DAILY_SQL),
    db.prepare(`
      SELECT date, total_users AS totalUsers, total_vms AS totalVms,
        running_vms AS runningVms, total_vcpu AS totalVcpu, captured, source
      FROM cloud_daily ORDER BY date
    `),
  ])
  const value = realtime?.results[0]?.value
  if (typeof value !== 'string' || !circulation || !vault || !cloud)
    throw new Error('Analytics has not been synchronized')
  return {
    generatedAt: now.toISOString(),
    realtime: realtimeRow(JSON.parse(value)),
    circulation: circulation.results as AnalyticsData['circulation'],
    vault: vault.results as AnalyticsData['vault'],
    cloud: cloud.results.map(({source, ...row}) => ({
      ...row,
      backfilled: source === 'api-backfill',
    })) as AnalyticsData['cloud'],
  }
}

const health = async (db: D1Database, now: Date) => {
  const dates = await db
    .prepare(`
    SELECT (SELECT MAX(date) FROM circulation_daily) AS circulation,
      (SELECT MAX(date) FROM cloud_daily) AS cloud,
      (SELECT date(MAX(settled_at), 'unixepoch') FROM vault_settlements) AS vault,
      (SELECT value FROM sync_state WHERE key = 'vault_scan') AS vaultScan
  `)
    .first<{
      circulation: string | null
      cloud: string | null
      vault: string | null
      vaultScan: string | null
    }>()
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`)
  const fresh = (value: string | null | undefined, days: number) =>
    value != null &&
    Number.isFinite(Date.parse(value)) &&
    today - Date.parse(value) <= days * DAY_MS
  const scanTime =
    dates?.vaultScan == null ? Number.NaN : Date.parse(dates.vaultScan)
  const ok =
    fresh(dates?.circulation, 2) &&
    fresh(dates?.cloud, 3) &&
    Number.isFinite(scanTime) &&
    now.getTime() - scanTime <= 3 * DAY_MS
  return Response.json(
    {ok, generatedAt: now.toISOString(), ...dates},
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
    if (path === '/') {
      response = new Response(PAGE, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
          'Content-Security-Policy':
            "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
          'X-Content-Type-Options': 'nosniff',
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
