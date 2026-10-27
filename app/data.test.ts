import {Database} from 'bun:sqlite'
import {expect, test} from 'bun:test'
import {
  captured,
  cloudSource,
  cloudWindow,
  dailyPrices,
  decodeSettlement,
  FIRST_CIRCULATION_DATE,
  halveChunk,
  MISSING_CIRCULATION_SQL,
  realtimeRow,
  selectCloudRows,
  shiftDate,
  snapshotRow,
  utcDate,
  VAULT_DAILY_SQL,
} from './data'
import {dailyCloud, settlementLog} from './fixtures'
import {seedQueries} from './scripts/seed'

const schema = await Bun.file(
  `${import.meta.dir}/migrations/0001_init.sql`,
).text()

test('cloud window catches up through yesterday and is capped at 90 days', () => {
  expect(cloudWindow('2026-10-25', '2026-10-26')).toBe(2)
  expect(cloudWindow('2026-01-01', '2026-10-26')).toBe(90)
  const rows = [
    dailyCloud('2026-10-26'),
    dailyCloud('2026-10-25'),
    dailyCloud('2026-10-27'),
  ]
  expect(
    selectCloudRows({data: rows}, '2026-10-24', '2026-10-26').map(
      (row) => row.date,
    ),
  ).toEqual(['2026-10-25', '2026-10-26'])
})

test('cloud rejects a missing first/interior day, duplicates, zero users and invalid counts', () => {
  for (const rows of [
    [dailyCloud('2026-10-26')],
    [dailyCloud('2026-10-24'), dailyCloud('2026-10-26')],
    [dailyCloud('2026-10-24'), dailyCloud('2026-10-24')],
    [{...dailyCloud('2026-10-24'), total_users: 0}],
    [{...dailyCloud('2026-10-24'), total_vms: 0.5}],
  ])
    expect(() =>
      selectCloudRows({data: rows}, '2026-10-23', '2026-10-26'),
    ).toThrow()
})

test('cloud marks recomputed gap days as backfill and the just-closed day as normal API', () => {
  expect(cloudSource('2026-09-23', '2026-10-26')).toBe('api-backfill')
  expect(cloudSource('2026-10-25', '2026-10-26')).toBe('api-backfill')
  expect(cloudSource('2026-10-26', '2026-10-26')).toBe('api')
})

test('captured uses annual vCPU revenue divided by positive PHA price', () => {
  expect(captured(8846, 0.04763761805555556)).toBe(111416150.02266094)
  expect(captured(0, 0.05)).toBe(0)
  for (const price of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
    expect(() => captured(10, price)).toThrow()
})

test('price averages use UTC boundaries, with invalid points rejected', () => {
  const prices = dailyPrices({
    prices: [
      [Date.parse('2026-10-25T00:00:00Z'), 1],
      [Date.parse('2026-10-25T23:59:59Z'), 3],
      [Date.parse('2026-10-26T00:00:00Z'), 4],
    ],
  })
  expect([...prices]).toEqual([
    ['2026-10-25', 2],
    ['2026-10-26', 4],
  ])
  expect(() => dailyPrices({prices: [[0, 0]]})).toThrow()
})

test('circulation parsing retains nullable chains and uses the upstream realtime total', () => {
  expect(
    snapshotRow({ethereum: {circulation: '100.1'}, base: null}, '2026-10-26'),
  ).toEqual({
    date: '2026-10-26',
    ethereum: 100.1,
    base: null,
    phala: null,
    khala: null,
  })
  expect(
    realtimeRow({
      totalCirculation: '102.1',
      ethereum: {timestamp: '2026-10-27T00:01:00Z'},
    }),
  ).toEqual({totalCirculation: 102.1, timestamp: '2026-10-27T00:01:00.000Z'})
  expect(() =>
    snapshotRow(
      {date: '2026-10-25T00:00:00Z', ethereum: {circulation: '1'}},
      '2026-10-26',
    ),
  ).toThrow()
  expect(() => utcDate('2026-02-30')).toThrow()
})

test('missing-date SQL scans holes before an imported tail and limits each run to 20', () => {
  const db = new Database(':memory:')
  try {
    db.exec(schema)
    db.run(
      "INSERT INTO circulation_daily VALUES (?, 1, NULL, NULL, NULL, 'archive')",
      [FIRST_CIRCULATION_DATE],
    )
    db.run(
      "INSERT INTO circulation_daily VALUES ('2026-10-26', 1, NULL, NULL, NULL, 'archive')",
    )
    const rows = db
      .query<{date: string}, [string, string]>(MISSING_CIRCULATION_SQL)
      .all(FIRST_CIRCULATION_DATE, '2026-10-26')
    expect(rows).toHaveLength(20)
    expect(rows[0]?.date).toBe(shiftDate(FIRST_CIRCULATION_DATE))
    expect(rows.at(-1)?.date).toBe(shiftDate(FIRST_CIRCULATION_DATE, 20))
    expect(
      db.query(MISSING_CIRCULATION_SQL).all('2026-10-27', '2026-10-26'),
    ).toEqual([])
  } finally {
    db.close()
  }
})

test('vault decodes ABI words and SQL sums rewards and selects last assets across UTC days', () => {
  const db = new Database(':memory:')
  try {
    db.exec(schema)
    const time = Date.parse('2026-10-25T23:59:59Z') / 1000
    const logs = [
      settlementLog(time, 2n * 10n ** 18n, 100n * 10n ** 18n, 21_596_326),
      settlementLog(time, 3n * 10n ** 18n, 101n * 10n ** 18n, 21_596_326, 1),
      settlementLog(time + 1, 4n * 10n ** 18n, 102n * 10n ** 18n, 21_596_327),
    ]
    for (const log of logs.reverse()) {
      const row = decodeSettlement(log)
      db.run('INSERT INTO vault_settlements VALUES (?, ?, ?, ?, ?)', [
        row.block_number,
        row.log_index,
        row.settled_at,
        row.rewards,
        row.total_assets,
      ])
    }
    expect(db.query(VAULT_DAILY_SQL).all()).toEqual([
      {date: '2026-10-25', dailyRewards: 5, totalAssets: 101},
      {date: '2026-10-26', dailyRewards: 4, totalAssets: 102},
    ])
    expect(() =>
      decodeSettlement({...settlementLog(time), removed: true}),
    ).toThrow()
    expect(() =>
      decodeSettlement({...settlementLog(time), data: '0x00'}),
    ).toThrow()
    expect(() =>
      decodeSettlement({...settlementLog(time), address: '0x00'}),
    ).toThrow()
  } finally {
    db.close()
  }
})

test('chunk halving reaches one block and never retries a rejected single block', () => {
  expect(halveChunk(10_000)).toBe(5000)
  expect(halveChunk(3)).toBe(1)
  expect(() => halveChunk(1)).toThrow('single block')
})

test('seed validates archive overlap and uses parameterized inserts below the D1 limit', () => {
  const row = {
    updated_time: '2025-10-01T00:00:00Z',
    ethereum_circulation: 100,
    base_circulation: 2,
    phala_circulation: null,
    khala_circulation: null,
  }
  const archive = {
    results: {
      '3572546': {rows: [row]},
      '4614059': {
        rows: [
          {...dailyCloud('2026-09-22'), captured: 123},
          {total_users: 100},
        ],
      },
    },
  }
  const seed = seedQueries(`${JSON.stringify(row)}\n`, archive)
  expect(seed.overlaps).toBe(1)
  expect(seed.circulationCount).toBe(1)
  expect(seed.cloudCount).toBe(1)
  expect(seed.cloud[0]?.params).toEqual([
    '2026-09-22',
    100,
    20,
    10,
    40,
    null,
    123,
    'archive',
  ])
  for (const query of [...seed.cloud, ...seed.circulation])
    expect(query.params.length).toBeLessThanOrEqual(100)
  expect(() =>
    seedQueries(JSON.stringify({...row, ethereum_circulation: 101}), archive),
  ).toThrow('disagree')
})
