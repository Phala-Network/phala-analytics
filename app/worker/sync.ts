import {getAllData} from './circulation/circulation'
import {readConfig} from './circulation/config'
import {
  captured,
  cloudSource,
  cloudWindow,
  dailyPrices,
  FIRST_CLOUD_DATE,
  priceUrls,
  realtimeRow,
  record,
  selectCloudRows,
  shiftDate,
} from './data'
import {USER_AGENT} from './http'
import {
  dayQuery,
  ENTITIES,
  fields,
  graphql,
  latestStatus,
  META_QUERY,
  PAGE_SIZE,
  parsePage,
  subgraphMeta,
} from './subgraph'

type Request = (url: string, init?: RequestInit) => Promise<Response>
type SqlValue = string | number | null

const stateStatement = (
  db: D1Database,
  key: string,
  value: string,
  now: Date,
) =>
  db
    .prepare(`
    INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    WHERE sync_state.value <> excluded.value
  `)
    .bind(key, value, now.toISOString())

// D1 permits at most 100 bound parameters per statement.
const insertStatements = (
  db: D1Database,
  table: string,
  columns: string[],
  rows: SqlValue[][],
) => {
  const size = Math.floor(100 / columns.length)
  const statements: D1PreparedStatement[] = []
  for (let index = 0; index < rows.length; index += size) {
    const chunk = rows.slice(index, index + size)
    statements.push(
      db
        .prepare(`INSERT INTO ${table} (${columns.join(', ')})
      VALUES ${chunk.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ')}
      ON CONFLICT DO NOTHING`)
        .bind(...chunk.flat()),
    )
  }
  return statements
}

export const sync = async (env: Env, now: Date, request: Request = fetch) => {
  const db = env.DB
  const yesterday = shiftDate(now.toISOString().slice(0, 10), -1)
  const checkedFetch = async (
    url: string,
    label: string,
    init?: RequestInit,
    timeout = 30_000,
  ) => {
    const headers = new Headers(init?.headers)
    headers.set('User-Agent', USER_AGENT)
    let response: Response
    try {
      response = await request(url, {
        ...init,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeout),
      })
    } catch {
      throw new Error(`Request failed: ${label}`)
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`${label}: HTTP ${response.status}`)
    }
    return response
  }
  const json = async (response: Response): Promise<unknown> => {
    try {
      return await response.json()
    } catch {
      throw new Error('Upstream returned invalid JSON')
    }
  }
  const failures: unknown[] = []
  const attempt = async (stream: string, run: () => Promise<void>) => {
    try {
      await run()
    } catch (error) {
      console.error(
        `Analytics sync failed: ${stream}: ${error instanceof Error ? error.message : String(error)}`,
      )
      failures.push(error)
    }
  }

  await attempt('realtime', async () => {
    const data = await getAllData(readConfig(env), (url, init) =>
      checkedFetch(url, 'Circulation realtime', init, 8000),
    )
    await stateStatement(
      db,
      'realtime',
      JSON.stringify(realtimeRow(data)),
      now,
    ).run()
  })

  await attempt('ethereum', async () => {
    const chain = 'ethereum'
    const url = env.GOLDSKY_ETHEREUM_URL
    const meta = await graphql(url, META_QUERY, {}, request)
    const deployment = subgraphMeta(meta)
    if (record(meta.latest).chain !== chain)
      throw new Error('Subgraph chain mismatch')
    const status = latestStatus(meta.latest)
    const key = `deployment:${chain}`
    const previous = await db
      .prepare('SELECT value FROM sync_state WHERE key = ?')
      .bind(key)
      .first<string>('value')
    const changed = previous !== deployment
    let reset = changed
    for (const {entity, table, spec} of ENTITIES) {
      let after = changed
        ? ''
        : ((await (table === 'circulation_day'
            ? db
                .prepare(
                  `SELECT MAX(date) AS date FROM ${table} WHERE chain = ?`,
                )
                .bind(chain)
            : db.prepare(`SELECT MAX(date) AS date FROM ${table}`)
          ).first<string>('date')) ?? '')
      while (true) {
        const page = await graphql(
          url,
          dayQuery(entity, spec),
          {after},
          request,
        )
        if (subgraphMeta(page) !== deployment)
          throw new Error('Subgraph deployment changed during sync')
        const rows = parsePage(page.rows, spec, after)
        if (
          table === 'circulation_day' &&
          Array.isArray(page.rows) &&
          page.rows.some((row) => record(row).chain !== chain)
        )
          throw new Error('Subgraph chain mismatch')
        const columns = fields(spec)
        const statements: D1PreparedStatement[] = []
        if (reset) {
          statements.push(
            db
              .prepare('DELETE FROM circulation_day WHERE chain = ?')
              .bind(chain),
          )
          statements.push(
            db.prepare('DELETE FROM vault_day'),
            db.prepare('DELETE FROM claim_day'),
          )
          statements.push(stateStatement(db, key, deployment, now))
        }
        if (table === 'circulation_day')
          statements.push(
            stateStatement(
              db,
              `subgraph:${chain}`,
              JSON.stringify({deployment, ...status}),
              now,
            ),
          )
        statements.push(
          ...insertStatements(
            db,
            table,
            table === 'circulation_day' ? [...columns, 'chain'] : columns,
            rows.map((row) => {
              const values = columns.map((field): SqlValue => {
                const value = record(row)[field]
                if (
                  value === null ||
                  typeof value === 'string' ||
                  typeof value === 'number'
                )
                  return value
                if (typeof value === 'boolean') return Number(value)
                throw new Error('Invalid cache column')
              })
              return table === 'circulation_day' ? [...values, chain] : values
            }),
          ),
        )
        // Rebuild/reset, each immutable page, and its MAX(date) checkpoint are atomic.
        if (statements.length) await db.batch(statements)
        reset = false
        const last = rows.at(-1)
        if (rows.length < PAGE_SIZE || !last) break
        after = last.date
      }
    }
  })

  await attempt('cloud', async () => {
    const lastDate =
      (await db
        .prepare('SELECT MAX(date) AS date FROM cloud_daily')
        .first<string>('date')) ?? shiftDate(FIRST_CLOUD_DATE, -1)
    if (lastDate >= yesterday) return
    const response = await checkedFetch(
      `https://cloud-api.phala.network/api/v1/stats/daily?days=${cloudWindow(lastDate, yesterday)}`,
      'Phala Cloud daily',
      {headers: {Authorization: `Bearer ${env.PHALA_CLOUD_API_KEY}`}},
      90_000,
    )
    // Validate the whole contiguous window before writing. A missing day fails closed.
    const rows = selectCloudRows(await json(response), lastDate, yesterday)
    await db.batch(
      insertStatements(
        db,
        'cloud_daily',
        [
          'date',
          'total_users',
          'total_vms',
          'running_vms',
          'total_vcpu',
          'running_vcpu',
          'active_users',
          'source',
        ],
        rows.map((row) => [
          row.date,
          row.total_users,
          row.total_vms,
          row.running_vms,
          row.total_vcpu,
          row.running_vcpu,
          row.active_users,
          cloudSource(row.date, yesterday),
        ]),
      ),
    )
  })

  await attempt('price', async () => {
    const {results: rows} = await db
      .prepare(`
      SELECT date, total_vcpu FROM cloud_daily WHERE captured IS NULL ORDER BY date
    `)
      .all<{date: string; total_vcpu: number}>()
    const first = rows[0]
    const last = rows.at(-1)
    if (!first || !last) return
    const pages: unknown[] = []
    for (const url of priceUrls(first.date, last.date))
      pages.push(await json(await checkedFetch(url.toString(), 'PHA price')))
    const prices = dailyPrices(pages)
    const priced = rows.map((row) => {
      const price = prices.get(row.date)
      if (price == null) throw new Error(`PHA price missing ${row.date}`)
      return [row.date, price, captured(row.total_vcpu, price)]
    })
    const statements: D1PreparedStatement[] = []
    for (let index = 0; index < priced.length; index += 33) {
      const chunk = priced.slice(index, index + 33)
      statements.push(
        db
          .prepare(`
        WITH prices(date, price, captured) AS (VALUES ${chunk.map(() => '(?, ?, ?)').join(', ')})
        UPDATE cloud_daily SET pha_usd = prices.price, captured = prices.captured
        FROM prices WHERE cloud_daily.date = prices.date AND cloud_daily.captured IS NULL
      `)
          .bind(...chunk.flat()),
      )
    }
    await db.batch(statements)
  })

  await attempt('backup', async () => {
    if (now.getUTCDay() !== 0) return
    const date = now.toISOString().slice(0, 10)
    const previous = await db
      .prepare("SELECT value FROM sync_state WHERE key = 'cloud_backup'")
      .first<string>('value')
    if (previous === date) return
    const {results: rows} = await db
      .prepare('SELECT * FROM cloud_daily ORDER BY date')
      .all()
    await env.BACKUP.put(
      `cloud-daily/${date}.json`,
      JSON.stringify({exportedAt: now.toISOString(), rows}),
      {
        httpMetadata: {contentType: 'application/json'},
      },
    )
    await stateStatement(db, 'cloud_backup', date, now).run()
  })

  if (failures.length)
    throw new AggregateError(failures, 'Analytics sync incomplete')
  console.log('Analytics sync complete')
}
