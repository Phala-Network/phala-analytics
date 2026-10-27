import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {URL as NodeURL} from 'node:url'
import {convertV4MiniflareOptions, Miniflare} from 'miniflare'
import {
  FIRST_CIRCULATION_DATE,
  record,
  shiftDate,
  VAULT_DEPLOY_BLOCK,
} from './data'
import {dailyCloud, settlementLog} from './fixtures'

// Miniflare's undici dispatcher needs Node rather than Bun's fetch implementation.
const script = readFileSync(0, 'utf8')
const schema = readFileSync(
  new NodeURL('../migrations/0001_init.sql', import.meta.url),
  'utf8',
)
const today = new Date().toISOString().slice(0, 10)
const yesterday = shiftDate(today, -1)
const scheduledTime = new Date(`${today}T08:00:00Z`)
const settledAt = Date.parse(`${yesterday}T12:00:00Z`) / 1000
const lastBlock = VAULT_DEPLOY_BLOCK + 100

for (const mode of [
  'ok',
  'redirect',
  'server',
  'log-redirect',
  'log-server',
  'write-fail',
  'snapshot-404',
  'old-snapshot-404',
]) {
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
          bindings: {
            PHALA_CLOUD_API_KEY: 'test-cloud-key',
            ETHEREUM_RPC_URL: 'https://rpc.test',
            CIRCULATION_API_URL: 'https://circulation.test',
          },
          outboundService: 'upstream-stubs',
        },
        {
          name: 'upstream-stubs',
          modules: true,
          compatibilityDate: '2026-10-23',
          bindings: {
            MODE: mode,
            CLOUD: dailyCloud(yesterday),
            PREVIOUS_CLOUD: dailyCloud(shiftDate(yesterday, -1)),
            DATE: yesterday,
            NOW: `${today}T07:00:00Z`,
            HEAD: lastBlock + 12,
            LOG: settlementLog(settledAt),
          },
          script: `
          const calls = []
          export default {
            async fetch(request, env) {
              const url = new URL(request.url)
              if (url.hostname === 'control.test') return Response.json(calls)
              const body = await request.text()
              calls.push({url: request.url, body})
              const failure = (status) => new Response('Upstream failed', {
                status, headers: {Location: 'https://not-followed.test/'},
              })
              if (env.MODE === 'redirect') return failure(302)
              if (env.MODE === 'server') return failure(503)
              if (url.pathname === '/api/all') return Response.json({
                totalCirculation: '102', ethereum: {timestamp: env.NOW},
              })
              if (url.pathname === '/api/snapshot') {
                if (env.MODE === 'snapshot-404' || env.MODE === 'old-snapshot-404') return failure(404)
                return Response.json({date: env.DATE + 'T00:00:00Z', ethereum: {circulation: '100'}, base: {circulation: '2'}})
              }
              if (url.pathname === '/api/v1/stats/daily') {
                if (request.headers.get('Authorization') !== 'Bearer test-cloud-key') return failure(401)
                return Response.json({data: [env.CLOUD, env.PREVIOUS_CLOUD]})
              }
              if (url.pathname.endsWith('/market_chart/range')) return Response.json({prices: [
                [Date.parse(env.PREVIOUS_CLOUD.date + 'T00:00:00Z'), 2],
                [Date.parse(env.DATE + 'T00:00:00Z'), 1],
                [Date.parse(env.DATE + 'T23:00:00Z'), 3],
              ]})
              if (url.hostname === 'rpc.test') {
                const rpc = JSON.parse(body)
                const reply = (result) => Response.json({jsonrpc: '2.0', id: rpc.id, result})
                if (rpc.method === 'eth_blockNumber') return reply('0x' + env.HEAD.toString(16))
                if (rpc.method === 'eth_getLogs') {
                  if (env.MODE === 'log-redirect') return failure(302)
                  if (env.MODE === 'log-server') return failure(503)
                  const {fromBlock, toBlock} = rpc.params[0]
                  if (Number(toBlock) - Number(fromBlock) + 1 > 16) return Response.json({
                    jsonrpc: '2.0', id: rpc.id, error: {code: -32005, message: 'block range too large'},
                  })
                  const block = Number(env.LOG.blockNumber)
                  return reply(block >= Number(fromBlock) && block <= Number(toBlock) ? [env.LOG] : [])
                }
              }
              return failure(500)
            },
          }
        `,
        },
      ],
    }),
  )
  try {
    const db = await runtime.getD1Database('DB', 'analytics')
    // D1 exec accepts single-line statements for migration/bootstrap maintenance.
    await db.exec(schema.replaceAll('\n', ' '))
    await db
      .prepare(`
      WITH RECURSIVE dates(date) AS (
        SELECT ?1 UNION ALL SELECT date(date, '+1 day') FROM dates WHERE date < ?2
      ) INSERT INTO circulation_daily
      SELECT date, 1, NULL, NULL, NULL, 'archive' FROM dates
    `)
      .bind(FIRST_CIRCULATION_DATE, shiftDate(yesterday, -1))
      .run()
    if (mode === 'old-snapshot-404') {
      await db
        .prepare(
          "INSERT INTO circulation_daily VALUES (?, 100, 2, NULL, NULL, 'api')",
        )
        .bind(yesterday)
        .run()
      await db
        .prepare('DELETE FROM circulation_daily WHERE date = ?')
        .bind(shiftDate(yesterday, -1))
        .run()
    }
    await db
      .prepare(
        "INSERT INTO cloud_daily VALUES (?, 90, 10, 5, 20, 1, 12000, 'archive')",
      )
      .bind(shiftDate(yesterday, -2))
      .run()
    if (mode === 'write-fail')
      await db.exec(
        "CREATE TRIGGER reject_settlement BEFORE INSERT ON vault_settlements BEGIN SELECT RAISE(ABORT, 'test write failure'); END;",
      )
    const worker = await runtime.getWorker('analytics')
    const initialHealth = await worker.fetch(
      'https://analytics.test/api/health',
    )
    assert.equal(initialHealth.status, 503)
    const result = await worker.scheduled({cron: '17 * * * *', scheduledTime})
    const stubs = await runtime.getWorker('upstream-stubs')
    const callsResponse = await stubs.fetch('https://control.test/')
    const calls: unknown = await callsResponse.json()
    assert.ok(Array.isArray(calls))
    const checkpoint = await db
      .prepare("SELECT value FROM sync_state WHERE key = 'vault_block'")
      .first<string>('value')
    if (mode === 'old-snapshot-404') {
      assert.equal(
        result.outcome,
        'exception',
        'An older snapshot 404 fails the scheduled run',
      )
      assert.equal(
        checkpoint,
        String(lastBlock),
        'Other streams still complete',
      )
      assert.equal(
        await db
          .prepare('SELECT date FROM circulation_daily WHERE date = ?')
          .bind(shiftDate(yesterday, -1))
          .first(),
        null,
      )
      const snapshotCalls = calls
        .map((value) => new URL(String(record(value).url)))
        .filter((url) => url.pathname === '/api/snapshot')
      assert.equal(snapshotCalls.length, 1)
      assert.equal(
        snapshotCalls[0]?.searchParams.get('date'),
        shiftDate(yesterday, -1),
      )
      continue
    }
    const failed = !['ok', 'snapshot-404'].includes(mode)
    assert.equal(
      result.outcome,
      failed ? 'exception' : 'ok',
      `Scheduled outcome: ${mode}`,
    )
    assert.equal(
      checkpoint,
      failed ? null : String(lastBlock),
      `Checkpoint: ${mode}`,
    )
    if (failed) {
      assert.equal(
        await db
          .prepare('SELECT COUNT(*) AS count FROM vault_settlements')
          .first<number>('count'),
        0,
      )
      assert.ok(
        calls.every(
          (value) => !String(record(value).url).includes('not-followed.test'),
        ),
      )
      if (mode === 'redirect' || mode === 'server') {
        assert.equal(
          calls.length,
          4,
          'All independent streams attempted without following redirects',
        )
        assert.equal(
          await db
            .prepare("SELECT value FROM sync_state WHERE key = 'realtime'")
            .first(),
          null,
        )
      }
      continue
    }
    const response = await worker.fetch('https://analytics.test/api/data')
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Cache-Control'), 'public, max-age=300')
    const data = record(await response.json())
    assert.deepEqual(data.realtime, {
      totalCirculation: 102,
      timestamp: `${today}T07:00:00.000Z`,
    })
    assert.ok(Array.isArray(data.circulation))
    if (mode === 'ok')
      assert.deepEqual(data.circulation.at(-1), {
        date: yesterday,
        ethereum: 100,
        base: 2,
        phala: null,
        khala: null,
        total: 102,
      })
    else
      assert.equal(
        record(data.circulation.at(-1)).date,
        shiftDate(yesterday, -1),
      )
    assert.deepEqual(data.vault, [
      {date: yesterday, totalAssets: 100, dailyRewards: 2},
    ])
    assert.ok(Array.isArray(data.cloud))
    assert.deepEqual(data.cloud.at(-1), {
      date: yesterday,
      totalUsers: 100,
      totalVms: 20,
      runningVms: 10,
      totalVcpu: 40,
      captured: 12000,
      backfilled: false,
    })
    assert.equal(record(data.cloud.at(-2)).backfilled, true)
    assert.equal(record(data.cloud.at(0)).backfilled, false)
    assert.equal(
      await db
        .prepare('SELECT source FROM cloud_daily WHERE date = ?')
        .bind(shiftDate(yesterday, -1))
        .first<string>('source'),
      'api-backfill',
    )
    const page = await worker.fetch('https://analytics.test/')
    assert.equal(page.status, 200)
    assert.ok(page.headers.has('Content-Security-Policy'))
    assert.ok((await page.text()).includes('Phala Analytics'))
    assert.match(
      page.headers.get('Content-Security-Policy') ?? '',
      /script-src 'self' https:\/\/cdn\.jsdelivr\.net\/npm\/uplot@1\.6\.32\//,
    )
    for (const [path, type] of [
      ['/app.js', 'text/javascript; charset=utf-8'],
      ['/app.css', 'text/css; charset=utf-8'],
      ['/favicon.svg', 'image/svg+xml'],
    ]) {
      const asset = await worker.fetch(`https://analytics.test${path}`)
      assert.equal(asset.status, 200)
      assert.equal(asset.headers.get('Content-Type'), type)
      assert.ok((await asset.text()).length > 0)
    }
    for (const path of ['/', '/api/data', '/api/health']) {
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
    const before = await db
      .prepare('SELECT key, value, updated_at FROM sync_state ORDER BY key')
      .all()
    const counts = await db
      .prepare(`SELECT
      (SELECT COUNT(*) FROM circulation_daily) AS circulation,
      (SELECT COUNT(*) FROM cloud_daily) AS cloud,
      (SELECT COUNT(*) FROM vault_settlements) AS vault
    `)
      .first()
    if (mode === 'ok') {
      assert.equal(
        (await worker.scheduled({cron: '17 * * * *', scheduledTime})).outcome,
        'ok',
      )
      assert.deepEqual(
        (
          await db
            .prepare(
              'SELECT key, value, updated_at FROM sync_state ORDER BY key',
            )
            .all()
        ).results,
        before.results,
      )
      assert.deepEqual(
        await db
          .prepare(`SELECT
        (SELECT COUNT(*) FROM circulation_daily) AS circulation,
        (SELECT COUNT(*) FROM cloud_daily) AS cloud,
        (SELECT COUNT(*) FROM vault_settlements) AS vault
      `)
          .first(),
        counts,
      )
      const again: unknown = await (
        await stubs.fetch('https://control.test/')
      ).json()
      assert.ok(Array.isArray(again))
      assert.equal(
        again.length - calls.length,
        2,
        'Caught-up run only fetches realtime and chain head',
      )
    }
    await db
      .prepare(
        "UPDATE sync_state SET value = '2000-01-01T00:00:00Z' WHERE key = 'vault_scan'",
      )
      .run()
    assert.equal(
      (await worker.fetch('https://analytics.test/api/health')).status,
      503,
    )
  } finally {
    await runtime.dispose()
  }
}
console.log(
  'workerd: all streams, idempotency, range halving, rollback, HTTP failures and endpoints verified',
)
