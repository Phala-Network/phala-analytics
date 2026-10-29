import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {convertV4MiniflareOptions, Miniflare} from 'miniflare'
import {CIRCULATION_SERIES_START, record, shiftDate} from './data'
import {chainDay, claimDay, dailyCloud, vaultDay} from './fixtures'
import {USER_AGENT} from './http'
import {CHAIN_FIELDS, fields, parseDay} from './subgraph'

// Miniflare's undici dispatcher needs Node rather than Bun's fetch implementation.
const script = readFileSync(0, 'utf8')
const schemaPath = process.argv[2]
if (!schemaPath) throw new Error('Missing migration path')
const schema = readFileSync(schemaPath, 'utf8')
const today = new Date().toISOString().slice(0, 10)
const yesterday = shiftDate(today, -1)
const scheduledTime = new Date(`${today}T08:00:00Z`)
const token = (amount: number) => String(BigInt(amount) * 10n ** 18n)

for (const mode of [
  'ok',
  'pagination',
  'price-pagination',
  'price-missing',
  'price-server',
  'redirect',
  'server',
  'page-redirect',
  'page-server',
  'graphql-errors',
  'indexing-errors',
  'changed-mid-page',
  'write-fail',
  'invalid-page',
  'unreviewed',
]) {
  const cloudDays = mode === 'price-pagination' ? 21 : 2
  const firstCloud = shiftDate(yesterday, 1 - cloudDays)
  const ethereum =
    mode === 'pagination'
      ? Array.from({length: 1001}, (_, i) =>
          chainDay(shiftDate(today, i - 1000)),
        )
      : [chainDay(yesterday), chainDay(today)]
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      workers: [
        {
          name: 'analytics',
          modulesRoot: '/',
          modules: [
            {
              type: 'ESModule',
              path: '/entry.js',
              contents: `
                import worker from './worker.js'
                let batches = 0
                let statements = 0
                let fail = false
                let version = 'test-v1'
                let wrapped
                export default {
                  ...worker,
                  async fetch(request, env, ctx) {
                    if (new URL(request.url).pathname === '/__test/cache') {
                      if (request.method === 'POST') {
                        const state = await request.json()
                        fail = state.fail ?? false
                        version = state.version ?? version
                        wrapped = undefined
                      }
                      return Response.json({batches, statements})
                    }
                    if (!wrapped) {
                      const DB = new Proxy(env.DB, {
                        get(db, name) {
                          if (name === 'batch') return (queries) => {
                            batches++
                            statements += queries.length
                            if (fail) throw new Error('test-d1-unavailable')
                            return db.batch(queries)
                          }
                          const value = Reflect.get(db, name)
                          return typeof value === 'function' ? value.bind(db) : value
                        },
                      })
                      wrapped = {...env, DB, VERSION: {id: version}}
                    }
                    return worker.fetch(request, wrapped, ctx)
                  },
                }
              `,
            },
            {type: 'ESModule', path: '/worker.js', contents: script},
          ],
          compatibilityDate: '2026-10-23',
          d1Databases: {DB: 'analytics-test'},
          r2Buckets: {BACKUP: 'backup-test'},
          bindings: {
            PHALA_CLOUD_API_KEY: 'test-cloud-key',
            VERSION: {id: 'test-v1'},
            GOLDSKY_ETHEREUM_URL: 'https://ethereum.test',
          },
          outboundService: 'upstream-stubs',
        },
        {
          name: 'upstream-stubs',
          modules: true,
          compatibilityDate: '2026-10-23',
          bindings: {
            MODE: mode,
            CLOUD: Array.from({length: cloudDays}, (_, i) =>
              dailyCloud(shiftDate(firstCloud, i)),
            ),
            DATE: today,
            NOW: Math.floor(Date.now() / 1000),
            ETHEREUM: ethereum,
            VAULT: [vaultDay(yesterday), vaultDay(today)],
            CLAIM: [claimDay(yesterday), claimDay(today)],
          },
          script: `
        const calls = []
        let generation = 0
        export default {async fetch(request, env) {
          const url = new URL(request.url)
          if (url.hostname === 'control.test') {
            if (request.method === 'POST') generation++
            return Response.json(calls)
          }
          const body = await request.text()
          calls.push({url: request.url, body, userAgent: request.headers.get('User-Agent')})
          const failure = (status) => new Response('Upstream failed', {status, headers: {Location: 'https://not-followed.test/'}})
          if (env.MODE === 'redirect') return failure(302)
          if (env.MODE === 'server') return failure(503)
          if (url.pathname === '/api/v1/stats/daily') {
            if (request.headers.get('Authorization') !== 'Bearer test-cloud-key') return failure(401)
            return Response.json({data: env.CLOUD})
          }
          if (url.hostname === 'coins.llama.fi' && url.pathname === '/chart/coingecko:pha') {
            if (env.MODE === 'price-server') return failure(429)
            const start = Number(url.searchParams.get('start'))
            const span = Number(url.searchParams.get('span'))
            if (url.searchParams.get('period') !== '1h' || !Number.isSafeInteger(start) || !Number.isSafeInteger(span) || span < 1 || span > 500) return failure(400)
            const prices = Array.from({length: span}, (_, hour) => {
              const timestamp = start + hour * 3600
              return {timestamp, price: new Date(timestamp * 1000).getUTCHours() < 20 ? 1 : 7}
            }).filter((point) => env.MODE !== 'price-missing' || new Date(point.timestamp * 1000).toISOString().slice(0, 10) !== env.CLOUD.at(-1).date)
            return Response.json({coins: {'coingecko:pha': {prices}}})
          }
          if (url.hostname !== 'ethereum.test') return failure(500)
          const chain = 'ethereum'
          const {query, variables} = JSON.parse(body)
          if (env.MODE === 'graphql-errors') return Response.json({errors: [{message: 'not leaked'}]})
          const changed = generation > 0
          const _meta = {deployment: chain + (changed ? '-v2' : '-v1'), block: {number: 100}, hasIndexingErrors: env.MODE === 'indexing-errors'}
          if (query.includes('latest(')) return Response.json({data: {_meta, ...(variables?.date ? {chainDay: {
            ...env.ETHEREUM.at(-1), timestamp: String(Date.parse(variables.date + 'T00:00:00Z') / 1000),
            observedBlockNumber: '100', observedBlockTimestamp: String(Date.parse(variables.date + 'T00:00:00Z') / 1000 - 12),
          }} : {}), latest: {
            ...env.ETHEREUM.at(-1), chain, timestamp: String(env.NOW),
            observedBlockNumber: '100', observedBlockTimestamp: String(env.NOW),
            vaultImplementation: '0x' + '1'.repeat(40), vaultImplementationReviewed: env.MODE !== 'unreviewed',
            accrualMode: env.MODE === 'unreviewed' ? 'checkpoint-only' : 'formula',
            sharePrice: '1.25', apr: '0.05', stakers: '3',
          }, ...(query.includes('chainState(') ? {chainState: {
            khalaClaimCount: '1', khalaFree: '${token(2)}', khalaStaked: '0', phalaClaimCount: '0', phalaFree: '0', phalaStaked: '0',
          }} : {})}})
          if (env.MODE === 'page-redirect') return failure(302)
          if (env.MODE === 'page-server') return failure(503)
          if (!query.includes('first: 1000') || !query.includes('orderBy: date') || !query.includes('orderDirection: asc') || !query.includes('date_gt: $after')) return failure(400)
          let rows = query.includes('chainDays(') ? env.ETHEREUM
            : query.includes('vaultDays(') ? env.VAULT : env.CLAIM
          rows = rows.filter((row) => row.date > variables.after && (!changed || row.date === env.DATE)).slice(0, 1000).map((row) => ({...row}))
          if (changed) rows = rows.map((row) => ({...row,
            ...(query.includes('chainDays(') ? {circulation: '${token(200)}'} : {}),
            ...(query.includes('vaultDays(') ? {totalAssets: '${token(200)}'} : {}),
            ...(query.includes('claimDays(') ? {phalaClaimCount: '4'} : {}),
          }))
          if (env.MODE === 'invalid-page') rows = rows.reverse()
          if (env.MODE === 'unreviewed') rows = rows.map((row) => row.vaultImplementationReviewed == null ? row : {
            ...row, vaultImplementationReviewed: false, accrualMode: 'checkpoint-only',
          })
          if (env.MODE === 'changed-mid-page') _meta.deployment += '-changed'
          return Response.json({data: {_meta, rows}})
        }}
      `,
        },
      ],
    }),
  )
  try {
    const db = await runtime.getD1Database('DB', 'analytics')
    await db.exec(schema.replaceAll('\n', ' '))
    await db
      .prepare('INSERT INTO legacy_circulation_day VALUES (?, 3, 4)')
      .bind(today)
      .run()
    await db
      .prepare(
        "INSERT INTO cloud_daily VALUES (?, 90, 10, 5, 20, NULL, NULL, 1, 12000, 'archive')",
      )
      .bind(shiftDate(firstCloud, -1))
      .run()
    const insertChainDay = async (date: string) => {
      const columns = [...fields(CHAIN_FIELDS), 'chain']
      const row = {...parseDay(chainDay(date), CHAIN_FIELDS), chain: 'ethereum'}
      await db
        .prepare(
          `INSERT INTO circulation_day (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        )
        .bind(
          ...columns.map((key) => {
            const value = record(row)[key]
            return typeof value === 'boolean' ? Number(value) : value
          }),
        )
        .run()
    }
    if (mode === 'write-fail') {
      await insertChainDay('2000-01-01')
      await db
        .prepare(
          "INSERT INTO sync_state VALUES ('deployment:ethereum', 'old', '2000-01-01T00:00:00Z')",
        )
        .run()
      await db.exec(
        "CREATE TRIGGER reject_day BEFORE INSERT ON circulation_day BEGIN SELECT RAISE(ABORT, 'test write failure'); END;",
      )
    }
    const worker = await runtime.getWorker('analytics')
    const stubs = await runtime.getWorker('upstream-stubs')
    const cacheStats = async () =>
      record(
        await (
          await worker.fetch('https://analytics.test/__test/cache')
        ).json(),
      )
    const initialStats = await cacheStats()
    for (let index = 0; index < 2; index++) {
      const unhealthy = await worker.fetch('https://analytics.test/api/health')
      assert.equal(unhealthy.status, 503)
      assert.equal(unhealthy.headers.get('cache-control'), 'no-store')
      assert.equal(unhealthy.headers.get('vercel-cdn-cache-control'), null)
    }
    assert.equal(
      Number((await cacheStats()).batches) - Number(initialStats.batches),
      2,
      'Unhealthy monitoring results are never cached',
    )
    const result = await worker.scheduled({cron: '17 * * * *', scheduledTime})
    const calls: unknown = await (
      await stubs.fetch('https://control.test')
    ).json()
    assert.ok(Array.isArray(calls))
    for (const call of calls) {
      assert.equal(record(call).userAgent, USER_AGENT, 'Outbound User-Agent')
    }
    // An unreviewed implementation is cached with its flag; health reports it.
    const failed = ![
      'ok',
      'pagination',
      'price-pagination',
      'unreviewed',
    ].includes(mode)
    assert.equal(
      result.outcome,
      failed ? 'exception' : 'ok',
      `Scheduled outcome ${mode}`,
    )
    const checkpoint = await db
      .prepare("SELECT value FROM sync_state WHERE key = 'deployment:ethereum'")
      .first<string>('value')
    const priceCalls = calls
      .map((call) => new URL(String(record(call).url)))
      .filter((url) => url.hostname === 'coins.llama.fi')
    if (
      ['ok', 'price-pagination', 'price-missing', 'price-server'].includes(mode)
    ) {
      assert.deepEqual(
        priceCalls.map((url) => ({
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
        })),
        Array.from({length: Math.ceil((cloudDays * 24) / 500)}, (_, page) => ({
          path: '/chart/coingecko:pha',
          query: {
            start: String(
              Date.parse(`${firstCloud}T00:00:00Z`) / 1000 + page * 500 * 3600,
            ),
            span: String(Math.min(500, cloudDays * 24 - page * 500)),
            period: '1h',
          },
        })),
      )
      assert.equal(
        await db
          .prepare("SELECT captured FROM cloud_daily WHERE source = 'archive'")
          .first<number>('captured'),
        12000,
      )
      assert.equal(
        await db
          .prepare("SELECT pha_usd FROM cloud_daily WHERE source = 'archive'")
          .first<number>('pha_usd'),
        1,
      )
    }
    if (mode === 'price-missing' || mode === 'price-server') {
      assert.equal(checkpoint, 'ethereum-v1')
      assert.equal(
        await db
          .prepare(
            'SELECT COUNT(*) AS count FROM cloud_daily WHERE captured IS NULL AND pha_usd IS NULL',
          )
          .first<number>('count'),
        cloudDays,
      )
      continue
    }
    if (failed) {
      // Without served daily rows the API is unavailable, even with live data.
      const before = await cacheStats()
      for (let index = 0; index < 2; index++) {
        const empty = await worker.fetch('https://analytics.test/api/data')
        assert.equal(empty.status, 503)
        assert.equal(empty.headers.get('cache-control'), 'no-store')
        assert.equal(empty.headers.get('vercel-cdn-cache-control'), null)
      }
      assert.equal(
        Number((await cacheStats()).batches) - Number(before.batches),
        2,
        'Unavailable analytics results are never cached',
      )
      assert.equal(
        checkpoint,
        mode === 'write-fail' ? 'old' : null,
        `Checkpoint ${mode}`,
      )
      assert.equal(
        await db
          .prepare('SELECT COUNT(*) AS count FROM circulation_day')
          .first<number>('count'),
        mode === 'write-fail' ? 1 : 0,
      )
      assert.equal(
        await db
          .prepare('SELECT COUNT(*) AS count FROM vault_day')
          .first<number>('count'),
        0,
      )
      assert.ok(
        calls.every(
          (call) => !String(record(call).url).includes('not-followed.test'),
        ),
      )
      continue
    }
    assert.equal(checkpoint, 'ethereum-v1')
    // Stored rows before the circulation series start are kept but not served.
    const preSeries = shiftDate(CIRCULATION_SERIES_START, -1)
    await insertChainDay(preSeries)
    await db
      .prepare('INSERT INTO legacy_circulation_day VALUES (?, 5, 6)')
      .bind(preSeries)
      .run()
    const beforeData = await cacheStats()
    const [response, duplicate, dataHead] = await Promise.all([
      worker.fetch('https://analytics.test/api/data'),
      worker.fetch('https://analytics.test/api/data?ignored=true'),
      worker.fetch('https://analytics.test/api/data', {method: 'HEAD'}),
    ])
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'public, max-age=60')
    assert.equal(response.headers.get('vercel-cdn-cache-control'), 'max-age=60')
    assert.equal(await dataHead.text(), '')
    assert.deepEqual(await duplicate.json(), await response.clone().json())
    const afterData = await cacheStats()
    assert.equal(
      Number(afterData.batches) - Number(beforeData.batches),
      1,
      'Concurrent analytics misses coalesce the entire D1 batch',
    )
    assert.equal(
      Number(afterData.statements) - Number(beforeData.statements),
      6,
    )
    const data = record(await response.json())
    const projection = record(data.projection)
    assert.equal(
      projection.method,
      mode === 'unreviewed' ? 'trend-claims-only' : 'trend',
    )
    assert.ok(Array.isArray(projection.points))
    assert.deepEqual(projection.points[0], {date: today, total: 107})
    assert.ok(projection.points.length >= 366)
    if (mode === 'unreviewed') {
      // An unreviewed implementation leaves the daily rows in place.
      assert.equal(data.live, null)
      assert.deepEqual(data.realtime, {
        totalCirculation: 107,
        timestamp: `${today}T00:00:00.000Z`,
      })
    } else {
      const live = record(data.live)
      assert.equal(live.circulation, 100)
      assert.equal(live.stakers, 3)
      assert.deepEqual(data.realtime, {
        totalCirculation: 100,
        timestamp: live.timestamp,
      })
      assert.equal(record(live.claims).khalaFree, 2)
    }
    assert.deepEqual(Object.keys(record(data.subgraphs)), ['ethereum'])
    assert.ok(Array.isArray(data.chainCirculation))
    assert.equal(data.chainCirculation.length, mode === 'pagination' ? 1001 : 2)
    assert.ok(Array.isArray(data.circulation))
    for (const row of [...data.chainCirculation, ...data.circulation])
      assert.ok(String(record(row).date) >= CIRCULATION_SERIES_START)
    assert.ok(Array.isArray(data.vault))
    assert.equal(record(data.vault.at(-1)).totalAssets, 100)
    assert.equal(record(data.vault.at(-1)).settlementTotalAssets, 99)
    assert.equal(record(data.vault.at(-1)).flowDate, yesterday)
    assert.equal(record(data.vault.at(-1)).apr, 0.05)
    assert.equal(record(data.vault.at(-1)).paused, false)
    assert.equal(
      record(data.vault.at(-1)).vaultImplementationReviewed,
      mode !== 'unreviewed',
    )
    assert.ok(Array.isArray(data.claims))
    assert.equal(record(data.claims.at(-1)).khalaFree, 4)
    assert.ok(Array.isArray(data.cloud))
    assert.deepEqual(data.cloud.at(-1), {
      date: yesterday,
      totalUsers: 100,
      totalVms: 20,
      runningVms: 10,
      totalVcpu: 40,
      runningVcpu: 24,
      activeUsers: 8,
      captured: 12000,
      backfilled: false,
    })
    assert.equal(record(data.cloud.at(-2)).backfilled, true)
    assert.equal(record(data.cloud[0]).runningVcpu, null)
    const beforeHealth = await cacheStats()
    const health = await worker.fetch('https://analytics.test/api/health')
    assert.equal(health.status, mode === 'unreviewed' ? 503 : 200)
    assert.equal(health.headers.get('cache-control'), 'no-store')
    assert.equal(
      health.headers.get('vercel-cdn-cache-control'),
      mode === 'unreviewed' ? null : 'max-age=30',
    )
    if (mode !== 'unreviewed') {
      const healthy = await Promise.all([
        worker.fetch('https://analytics.test/api/health?ignored=true'),
        worker.fetch('https://analytics.test/api/health', {method: 'HEAD'}),
      ])
      assert.deepEqual(await healthy[0].json(), await health.clone().json())
      assert.equal(await healthy[1].text(), '')
      const afterHealth = await cacheStats()
      assert.equal(
        Number(afterHealth.batches) - Number(beforeHealth.batches),
        1,
        'Healthy monitoring cache hits avoid D1',
      )
      assert.equal(
        Number(afterHealth.statements) - Number(beforeHealth.statements),
        2,
      )
    }
    if (mode === 'unreviewed') {
      const unavailable = await worker.fetch('https://analytics.test/api/all')
      assert.equal(unavailable.status, 503)
      assert.equal(unavailable.headers.get('cache-control'), 'no-store')
      assert.equal(
        await unavailable.text(),
        '{"error":"circulation_unavailable"}',
      )
      continue
    }
    if (mode === 'pagination') {
      assert.equal(
        await db
          .prepare(
            "SELECT COUNT(*) AS count FROM circulation_day WHERE chain = 'ethereum'",
          )
          .first<number>('count'),
        1002,
      )
    }
    const states = async () =>
      (
        await db
          .prepare('SELECT key, value, updated_at FROM sync_state ORDER BY key')
          .all()
      ).results
    const before = await states()
    assert.equal(
      (await worker.scheduled({cron: '17 * * * *', scheduledTime})).outcome,
      'ok',
    )
    assert.deepEqual(await states(), before)
    const retriedCalls: unknown = await (
      await stubs.fetch('https://control.test')
    ).json()
    assert.ok(Array.isArray(retriedCalls))
    assert.equal(
      retriedCalls.filter(
        (call) =>
          new URL(String(record(call).url)).hostname === 'coins.llama.fi',
      ).length,
      priceCalls.length,
      'Priced rows do not fetch prices again',
    )
    if (mode === 'pagination') {
      const calls: unknown = await (
        await stubs.fetch('https://control.test')
      ).json()
      assert.ok(Array.isArray(calls))
      assert.ok(
        calls.some((call) =>
          String(record(call).body).includes(shiftDate(today, -1)),
        ),
      )
      continue
    }
    assert.ok(Array.isArray(data.circulation))
    assert.deepEqual(data.circulation.at(-1), {
      date: today,
      ethereum: 100,
      phala: 3,
      khala: 4,
      total: 107,
    })
    // Static assets are served before the Worker; see assets.test.ts.
    for (const path of ['/api/data', '/api/health']) {
      const head = await worker.fetch(`https://analytics.test${path}`, {
        method: 'HEAD',
      })
      assert.equal(head.status, 200)
      assert.equal(await head.text(), '')
    }
    assert.equal(
      (await worker.fetch('https://analytics.test/missing')).status,
      404,
    )
    assert.equal(
      (await worker.fetch('https://analytics.test/', {method: 'POST'})).status,
      405,
    )
    await stubs.fetch('https://control.test', {method: 'POST'})
    assert.equal(
      (await worker.scheduled({cron: '17 * * * *', scheduledTime})).outcome,
      'ok',
    )
    assert.equal(
      await db
        .prepare(
          "SELECT value FROM sync_state WHERE key = 'deployment:ethereum'",
        )
        .first<string>('value'),
      'ethereum-v2',
    )
    assert.equal(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM circulation_day WHERE chain = 'ethereum'",
        )
        .first<number>('count'),
      1,
    )
    assert.equal(
      await db
        .prepare('SELECT totalAssets FROM vault_day')
        .first<number>('totalAssets'),
      200,
    )
    assert.equal(
      await db
        .prepare('SELECT phalaClaimCount FROM claim_day')
        .first<number>('phalaClaimCount'),
      4,
    )
    assert.equal(
      await db
        .prepare('SELECT COUNT(*) AS count FROM legacy_circulation_day')
        .first<number>('count'),
      2,
    )
    assert.equal(
      await db
        .prepare('SELECT COUNT(*) AS count FROM cloud_daily')
        .first<number>('count'),
      cloudDays + 1,
    )
    const sunday = new Date(scheduledTime)
    sunday.setUTCDate(sunday.getUTCDate() - sunday.getUTCDay())
    assert.equal(
      (await worker.scheduled({cron: '17 * * * *', scheduledTime: sunday}))
        .outcome,
      'ok',
    )
    const key = `cloud-daily/${sunday.toISOString().slice(0, 10)}.json`
    const bucket = await runtime.getR2Bucket('BACKUP', 'analytics')
    const object = await bucket.get(key)
    assert.ok(object)
    const exported = record(await object.json())
    assert.deepEqual(
      exported.rows,
      (await db.prepare('SELECT * FROM cloud_daily ORDER BY date').all())
        .results,
    )
    assert.equal(object.httpMetadata?.contentType, 'application/json')
    if (mode === 'ok') {
      const requestCount = async () => {
        const rows: unknown = await (
          await stubs.fetch('https://control.test')
        ).json()
        assert.ok(Array.isArray(rows))
        return rows.length
      }
      const beforeData = await requestCount()
      const beforeCacheHit = await cacheStats()
      const again = record(
        await (await worker.fetch('https://analytics.test/api/data')).json(),
      )
      assert.deepEqual(again.live, data.live)
      assert.equal(
        await requestCount(),
        beforeData,
        'Whole analytics responses avoid upstream calls on cache hits',
      )
      assert.deepEqual(
        await cacheStats(),
        beforeCacheHit,
        'Whole analytics responses avoid D1 on cache hits',
      )
      assert.deepEqual(again, data)
      const all = await worker.fetch('https://analytics.test/api/all')
      assert.equal(all.status, 200)
      assert.equal(all.headers.get('access-control-allow-origin'), '*')
      assert.equal(all.headers.get('cache-control'), 'public, max-age=60')
      const body = record(await all.json())
      const afterAll = await requestCount()
      const supply = await worker.fetch(
        'https://analytics.test/api/circulation?ignored=true',
      )
      assert.equal(await supply.text(), body.totalCirculation)
      assert.equal(
        await requestCount(),
        afterAll,
        'Latest requests share the workerd cache',
      )
      const snapshot = await worker.fetch(
        `https://analytics.test/api/snapshot?date=${yesterday}`,
      )
      assert.equal(snapshot.status, 200)
      assert.equal(
        snapshot.headers.get('cache-control'),
        'public, max-age=3600',
      )
      const afterSnapshot = await requestCount()
      const cached = await worker.fetch(
        `https://analytics.test/api/snapshot?date=${yesterday}&ignored=true`,
      )
      assert.equal(await cached.text(), await snapshot.text())
      assert.equal(
        await requestCount(),
        afterSnapshot,
        'Snapshot query strings do not bypass the workerd cache',
      )
      const preflight = await worker.fetch('https://analytics.test/api/all', {
        method: 'OPTIONS',
        headers: {'Access-Control-Request-Headers': 'X-Example'},
      })
      assert.equal(preflight.status, 204)
      assert.equal(
        preflight.headers.get('cache-control'),
        'public, max-age=0, must-revalidate',
      )
      assert.equal(
        preflight.headers.get('access-control-allow-headers'),
        'X-Example',
      )
      assert.equal(
        (
          await worker.fetch('https://analytics.test/api/data', {
            method: 'OPTIONS',
          })
        ).status,
        405,
      )
      const unknown = await worker.fetch('https://analytics.test/api/unknown')
      assert.equal(unknown.status, 404)
      assert.equal(await unknown.text(), '404 Not Found')
      const head = await worker.fetch(
        'https://analytics.test/api/circulation',
        {method: 'HEAD'},
      )
      assert.equal(head.status, 200)
      assert.equal(await head.text(), '')
      const control = (state: {version?: string; fail?: boolean}) =>
        worker.fetch('https://analytics.test/__test/cache', {
          method: 'POST',
          body: JSON.stringify(state),
        })
      await control({version: 'test-v2', fail: true})
      const beforeFailure = await cacheStats()
      for (const path of ['/api/data', '/api/health']) {
        for (let index = 0; index < 2; index++) {
          const failed = await worker.fetch(`https://analytics.test${path}`)
          assert.equal(failed.status, 503)
          assert.equal(failed.headers.get('cache-control'), 'no-store')
          assert.equal(failed.headers.get('vercel-cdn-cache-control'), null)
        }
      }
      assert.equal(
        Number((await cacheStats()).batches) - Number(beforeFailure.batches),
        4,
        'D1 exceptions are not cached, and a new release misses old entries',
      )
      await control({fail: false})
      for (const path of ['/api/data', '/api/health'])
        assert.equal(
          (await worker.fetch(`https://analytics.test${path}`)).status,
          200,
          'Failures recover immediately without a cached 503',
        )
    }
    const version = object.version
    await worker.scheduled({cron: '17 * * * *', scheduledTime: sunday})
    assert.equal((await bucket.head(key))?.version, version)
  } finally {
    await runtime.dispose()
  }
}
console.log(
  'workerd: incremental fills, price paging and missing days, idempotency, deployment reloads, rollback, HTTP failures, review flags, live fallback and cache, R2 export and endpoints verified',
)
