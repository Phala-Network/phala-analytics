import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {convertV4MiniflareOptions, Miniflare} from 'miniflare'
import {record, shiftDate} from './data'
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
          modules: true,
          script,
          compatibilityDate: '2026-10-23',
          d1Databases: {DB: 'analytics-test'},
          r2Buckets: {BACKUP: 'backup-test'},
          bindings: {
            PHALA_CLOUD_API_KEY: 'test-cloud-key',
            CIRCULATION_API_URL: 'https://circulation.test',
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
          if (url.pathname === '/api/all') return Response.json({totalCirculation: '107', ethereum: {timestamp: env.DATE + 'T07:00:00Z'}})
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
          const _meta = {deployment: chain + (changed ? '-v2' : '-v1'), hasIndexingErrors: env.MODE === 'indexing-errors'}
          if (query.includes('latest(')) return Response.json({data: {_meta, latest: {
            chain, timestamp: String(Date.parse(env.DATE + 'T07:00:00Z') / 1000),
            vaultImplementation: '0x' + '1'.repeat(40), vaultImplementationReviewed: env.MODE !== 'unreviewed',
            accrualMode: env.MODE === 'unreviewed' ? 'checkpoint-only' : 'formula',
          }}})
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
    if (mode === 'write-fail') {
      const columns = [...fields(CHAIN_FIELDS), 'chain']
      const old = {
        ...parseDay(chainDay('2000-01-01'), CHAIN_FIELDS),
        chain: 'ethereum',
      }
      await db
        .prepare(
          `INSERT INTO circulation_day (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        )
        .bind(
          ...columns.map((key) => {
            const value = record(old)[key]
            return typeof value === 'boolean' ? Number(value) : value
          }),
        )
        .run()
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
    assert.equal(
      (await worker.fetch('https://analytics.test/api/health')).status,
      503,
    )
    const result = await worker.scheduled({cron: '17 * * * *', scheduledTime})
    const calls: unknown = await (
      await stubs.fetch('https://control.test')
    ).json()
    assert.ok(Array.isArray(calls))
    for (const call of calls) {
      assert.equal(record(call).userAgent, USER_AGENT, 'Outbound User-Agent')
    }
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
    const response = await worker.fetch('https://analytics.test/api/data')
    assert.equal(response.status, 200)
    const data = record(await response.json())
    assert.deepEqual(Object.keys(record(data.subgraphs)), ['ethereum'])
    assert.ok(Array.isArray(data.chainCirculation))
    assert.equal(data.chainCirculation.length, mode === 'pagination' ? 1001 : 2)
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
    assert.equal(
      (await worker.fetch('https://analytics.test/api/health')).status,
      mode === 'unreviewed' ? 503 : 200,
    )
    if (mode === 'unreviewed') continue
    if (mode === 'pagination') {
      assert.equal(
        await db
          .prepare(
            "SELECT COUNT(*) AS count FROM circulation_day WHERE chain = 'ethereum'",
          )
          .first<number>('count'),
        1001,
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
    assert.equal((await worker.fetch('https://analytics.test/')).status, 200)
    for (const path of [
      '/',
      '/api/data',
      '/api/health',
      '/app.js',
      '/app.css',
      '/favicon.svg',
    ]) {
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
      1,
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
    const version = object.version
    await worker.scheduled({cron: '17 * * * *', scheduledTime: sunday})
    assert.equal((await bucket.head(key))?.version, version)
  } finally {
    await runtime.dispose()
  }
}
console.log(
  'workerd: incremental fills, price paging and missing days, idempotency, deployment reloads, rollback, HTTP failures, review flags, R2 export and endpoints verified',
)
