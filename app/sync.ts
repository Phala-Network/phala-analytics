import {
  captured,
  cloudSource,
  cloudWindow,
  dailyPrices,
  decodeSettlement,
  FIRST_CIRCULATION_DATE,
  FIRST_CLOUD_DATE,
  halveChunk,
  hexNumber,
  MISSING_CIRCULATION_SQL,
  realtimeRow,
  record,
  selectCloudRows,
  shiftDate,
  snapshotRow,
  VAULT_ADDRESS,
  VAULT_DEPLOY_BLOCK,
  VAULT_TOPIC,
} from './data'

type Request = (url: string, init?: RequestInit) => Promise<Response>

export const stateStatement = (
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

class RpcError extends Error {
  constructor(
    readonly range: boolean,
    code: unknown,
  ) {
    super(`Ethereum RPC error (${typeof code === 'number' ? code : 'unknown'})`)
  }
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
    let response: Response
    try {
      response = await request(url, {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeout),
      })
    } catch {
      // RPC URLs may contain credentials. Never include them in logs or errors.
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
      console.error(`Analytics sync failed: ${stream}`, error)
      failures.push(error)
    }
  }

  await attempt('realtime', async () => {
    const response = await checkedFetch(
      new URL('/api/all', env.CIRCULATION_API_URL).toString(),
      'Circulation realtime',
    )
    const row = realtimeRow(await json(response))
    await stateStatement(db, 'realtime', JSON.stringify(row), now).run()
  })

  await attempt('circulation', async () => {
    const {results} = await db
      .prepare(MISSING_CIRCULATION_SQL)
      .bind(FIRST_CIRCULATION_DATE, yesterday)
      .all<{date: string}>()
    for (const [index, {date}] of results.entries()) {
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, 3_000))
      const url = new URL('/api/snapshot', env.CIRCULATION_API_URL)
      url.searchParams.set('date', date)
      let response: Response
      try {
        response = await request(url.toString(), {
          redirect: 'manual',
          signal: AbortSignal.timeout(30_000),
        })
      } catch {
        throw new Error(`Snapshot request failed: ${date}`)
      }
      if (response.status === 404) {
        await response.body?.cancel()
        console.log(`Circulation snapshot not finalized: ${date}`)
        break
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`Snapshot ${date}: HTTP ${response.status}`)
      }
      const row = snapshotRow(await json(response), date)
      await db
        .prepare(`
        INSERT INTO circulation_daily (date, ethereum, base, phala, khala, source)
        VALUES (?, ?, ?, ?, ?, 'api') ON CONFLICT DO NOTHING
      `)
        .bind(row.date, row.ethereum, row.base, row.phala, row.khala)
        .run()
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
      rows.map((row) =>
        db
          .prepare(`
      INSERT INTO cloud_daily (date, total_users, total_vms, running_vms, total_vcpu, source)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
    `)
          .bind(
            row.date,
            row.total_users,
            row.total_vms,
            row.running_vms,
            row.total_vcpu,
            cloudSource(row.date, yesterday),
          ),
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
    const url = new URL(
      'https://api.coingecko.com/api/v3/coins/pha/market_chart/range',
    )
    url.searchParams.set('vs_currency', 'usd')
    url.searchParams.set(
      'from',
      String(Date.parse(`${first.date}T00:00:00Z`) / 1000),
    )
    url.searchParams.set(
      'to',
      String(Date.parse(`${shiftDate(last.date)}T00:00:00Z`) / 1000),
    )
    const prices = dailyPrices(
      await json(await checkedFetch(url.toString(), 'PHA price')),
    )
    const statements = rows.map((row) => {
      const price = prices.get(row.date)
      if (price == null) throw new Error(`PHA price missing ${row.date}`)
      return db
        .prepare(`
        UPDATE cloud_daily SET pha_usd = ?, captured = ? WHERE date = ? AND captured IS NULL
      `)
        .bind(price, captured(row.total_vcpu, price), row.date)
    })
    await db.batch(statements)
  })

  await attempt('vault', async () => {
    let calls = 0
    const rpc = async (method: string, params: unknown[]) => {
      calls++
      const response = await checkedFetch(
        env.ETHEREUM_RPC_URL,
        'Ethereum RPC',
        {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({jsonrpc: '2.0', id: calls, method, params}),
        },
      )
      const body = record(await json(response))
      if (body.jsonrpc !== '2.0' || body.id !== calls)
        throw new Error('Invalid Ethereum RPC response')
      if (body.error != null) {
        const error = record(body.error)
        const message = typeof error.message === 'string' ? error.message : ''
        throw new RpcError(
          error.code === -32005 ||
            /block range|too many (?:results|logs)|range.*(?:large|limit)|response size|query returned more|limited to|limit.*blocks/i.test(
              message,
            ),
          error.code,
        )
      }
      return body.result
    }
    const head = hexNumber(await rpc('eth_blockNumber', [])) - 12
    const saved = await db
      .prepare("SELECT value FROM sync_state WHERE key = 'vault_block'")
      .first<string>('value')
    let checkpoint = saved == null ? VAULT_DEPLOY_BLOCK - 1 : Number(saved)
    if (
      !Number.isSafeInteger(checkpoint) ||
      checkpoint < VAULT_DEPLOY_BLOCK - 1
    )
      throw new Error('Invalid vault checkpoint')
    if (checkpoint >= head) return
    let size = 10_000
    while (checkpoint < head && calls < 100) {
      const from = checkpoint + 1
      const through = Math.min(head, from + size - 1)
      let logs: unknown
      try {
        logs = await rpc('eth_getLogs', [
          {
            address: VAULT_ADDRESS,
            topics: [VAULT_TOPIC],
            fromBlock: `0x${from.toString(16)}`,
            toBlock: `0x${through.toString(16)}`,
          },
        ])
      } catch (error) {
        if (!(error instanceof RpcError) || !error.range) throw error
        size = halveChunk(through - from + 1)
        if (calls >= 100)
          throw new Error('Vault RPC budget exhausted while reducing range')
        continue
      }
      if (!Array.isArray(logs)) throw new Error('Expected Ethereum logs')
      const rows = logs.map(decodeSettlement)
      if (
        rows.some(
          (row) => row.block_number < from || row.block_number > through,
        )
      )
        throw new Error('Vault RPC returned logs outside requested range')
      const statements: D1PreparedStatement[] = []
      // Keep every statement within D1's 100-parameter limit.
      for (let index = 0; index < rows.length; index += 20) {
        const chunk = rows.slice(index, index + 20)
        statements.push(
          db
            .prepare(`
          INSERT INTO vault_settlements (block_number, log_index, settled_at, rewards, total_assets)
          VALUES ${chunk.map(() => '(?, ?, ?, ?, ?)').join(', ')} ON CONFLICT DO NOTHING
        `)
            .bind(
              ...chunk.flatMap((row) => [
                row.block_number,
                row.log_index,
                row.settled_at,
                row.rewards,
                row.total_assets,
              ]),
            ),
        )
      }
      statements.push(stateStatement(db, 'vault_block', String(through), now))
      // Mark freshness only once the backfill has reached the finalized head.
      if (through === head)
        statements.push(
          stateStatement(db, 'vault_scan', now.toISOString(), now),
        )
      await db.batch(statements)
      checkpoint = through
    }
    console.log('Vault scan checkpoint', {block: checkpoint, head, calls})
  })

  if (failures.length)
    throw new AggregateError(failures, 'Analytics sync incomplete')
  console.log('Analytics sync complete')
}
