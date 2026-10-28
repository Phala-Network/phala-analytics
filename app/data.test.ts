import {expect, test} from 'bun:test'
import {
  captured,
  cloudSource,
  cloudWindow,
  dailyPrices,
  priceUrls,
  realtimeRow,
  selectCloudRows,
  shiftDate,
  utcDate,
} from './data'
import {chainDay, claimDay, dailyCloud, vaultDay} from './fixtures'
import {seedQueries} from './scripts/seed'
import {
  CHAIN_FIELDS,
  CLAIM_FIELDS,
  parseDay,
  parsePage,
  VAULT_FIELDS,
  wei,
} from './subgraph'

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

const pricePage = (prices: unknown) => ({
  coins: {'coingecko:pha': {prices}},
})

test('DefiLlama hourly prices use Unix seconds and UTC daily means', () => {
  const prices = dailyPrices([
    pricePage([
      {timestamp: Date.parse('2026-10-25T00:00:00Z') / 1000, price: 1},
      {timestamp: Date.parse('2026-10-25T23:59:59Z') / 1000, price: 3},
      {timestamp: Date.parse('2026-10-26T00:00:00Z') / 1000, price: 4},
    ]),
  ])
  expect([...prices]).toEqual([
    ['2026-10-25', 2],
    ['2026-10-26', 4],
  ])
})

test('DefiLlama rejects malformed responses, timestamps and nonpositive prices', () => {
  for (const page of [
    null,
    {},
    {coins: {}},
    {coins: {'coingecko:pha': null}},
    pricePage(null),
    pricePage({}),
  ])
    expect(() => dailyPrices([page])).toThrow()
  for (const point of [
    null,
    [0, 1],
    {},
    ...[-1, 1.5, '1792886400', Number.NaN, Number.MAX_SAFE_INTEGER].map(
      (timestamp) => ({timestamp, price: 1}),
    ),
    ...[0, -1, '1', Number.NaN, Number.POSITIVE_INFINITY].map((price) => ({
      timestamp: 1792886400,
      price,
    })),
  ])
    expect(() => dailyPrices([pricePage([point])])).toThrow()
  expect([...dailyPrices([pricePage([])])]).toEqual([])
})

test('DefiLlama requests consecutive pages of at most 500 hours through the last UTC day', () => {
  const start = Date.parse('2026-10-01T00:00:00Z') / 1000
  const urls = priceUrls('2026-10-01', '2026-10-21')
  expect(
    urls.map((url) => ({
      origin: url.origin,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
    })),
  ).toEqual([
    {
      origin: 'https://coins.llama.fi',
      path: '/chart/coingecko:pha',
      query: {start: String(start), span: '500', period: '1h'},
    },
    {
      origin: 'https://coins.llama.fi',
      path: '/chart/coingecko:pha',
      query: {start: String(start + 500 * 3600), span: '4', period: '1h'},
    },
  ])
  expect(
    priceUrls('2026-10-01', '2026-10-01')[0]?.searchParams.get('span'),
  ).toBe('24')
  const exactPages = priceUrls('2026-01-01', shiftDate('2026-01-01', 124))
  expect(exactPages).toHaveLength(6)
  expect(
    exactPages.every((url) => url.searchParams.get('span') === '500'),
  ).toBe(true)
})

test('UTC means combine hourly samples across a page boundary before averaging', () => {
  const start = Date.parse('2026-10-01T00:00:00Z') / 1000
  const prices = dailyPrices([
    pricePage(
      Array.from({length: 500}, (_, hour) => ({
        timestamp: start + hour * 3600,
        price: 1,
      })),
    ),
    pricePage(
      Array.from({length: 4}, (_, hour) => ({
        timestamp: start + (500 + hour) * 3600,
        price: 7,
      })),
    ),
  ])
  expect(prices.size).toBe(21)
  expect(prices.get('2026-10-20')).toBe(1)
  expect(prices.get('2026-10-21')).toBe(2)
})

test('subgraph days convert wei, retain false implementation flags and separate flow dates', () => {
  const chain = parseDay(
    {...chainDay('2026-10-27'), vaultImplementationReviewed: false},
    CHAIN_FIELDS,
  )
  expect(chain.circulation).toBe(100)
  expect(chain.vaultReward).toBe(-1)
  expect(chain.vaultImplementationReviewed).toBe(false)
  const vault = parseDay(
    {...vaultDay('2026-10-27'), settlementTotalAssets: null},
    VAULT_FIELDS,
  )
  expect(vault.flowDate).toBe('2026-10-26')
  expect(vault.totalAssets).toBe(100)
  expect(vault.settlementTotalAssets).toBeNull()
  expect(vault.apr).toBe(0.05)
  expect(vault.sharePrice).toBe(1.25)
  expect(parseDay(claimDay('2026-10-27'), CLAIM_FIELDS).khalaFree).toBe(4)
  for (const value of ['1.1', 1, 'Infinity']) expect(() => wei(value)).toThrow()
  expect(() =>
    parseDay({...vaultDay('2026-10-27'), stakers: '0.1'}, VAULT_FIELDS),
  ).toThrow()
  expect(() =>
    parseDay({...vaultDay('2026-10-27'), flowDate: '2026-10-27'}, VAULT_FIELDS),
  ).toThrow()
  expect(() => utcDate('2026-02-30')).toThrow()
  expect(
    realtimeRow({
      totalCirculation: '102',
      ethereum: {timestamp: '2026-10-27T00:00:00Z'},
    }).totalCirculation,
  ).toBe(102)
})

test('subgraph BigDecimal values accept exponents and reject non-finite or malformed strings', () => {
  const row = parseDay(
    {...vaultDay('2026-10-27'), apr: '1.2E-7', sharePrice: '2e+3'},
    VAULT_FIELDS,
  )
  expect(row.apr).toBe(1.2e-7)
  expect(row.sharePrice).toBe(2000)
  for (const apr of [
    'Infinity',
    'NaN',
    '1e9999',
    '1.2E-7garbage',
    '1e',
    '',
    '0x10',
  ])
    expect(() =>
      parseDay({...vaultDay('2026-10-27'), apr}, VAULT_FIELDS),
    ).toThrow()
})

test('subgraph pages require strict deterministic date ordering after the checkpoint', () => {
  const rows = [chainDay('2026-10-26'), chainDay('2026-10-27')]
  expect(parsePage(rows, CHAIN_FIELDS, '2026-10-25')).toHaveLength(2)
  for (const invalid of [
    [rows[1], rows[0]],
    [rows[0], rows[0]],
    Array(1001).fill(rows[0]),
  ])
    expect(() => parsePage(invalid, CHAIN_FIELDS, '')).toThrow()
  expect(() => parsePage(rows, CHAIN_FIELDS, '2026-10-26')).toThrow()
})

test('seed includes only frozen legacy circulation and original Cloud rows', () => {
  const row = {
    updated_time: '2025-10-01T00:00:00Z',
    ethereum_circulation: 100,
    phala_circulation: 3,
    khala_circulation: null,
  }
  const archive = {
    results: {
      '4614059': {
        rows: [
          {...dailyCloud('2026-09-22'), captured: 123},
          {total_users: 100},
        ],
      },
    },
  }
  const seed = seedQueries(`${JSON.stringify(row)}\n`, archive)
  expect(seed.circulationCount).toBe(1)
  expect(seed.cloudCount).toBe(1)
  expect(seed.circulation[0]?.params).toEqual(['2025-10-01', 3, null])
  expect(seed.circulation[0]?.sql).toContain('legacy_circulation_day')
  expect(seed.cloud[0]?.params).toEqual([
    '2026-09-22',
    100,
    20,
    10,
    40,
    null,
    null,
    null,
    123,
    'archive',
  ])
  for (const query of [...seed.cloud, ...seed.circulation])
    expect(query.params.length).toBeLessThanOrEqual(100)
  expect(() =>
    seedQueries(
      `${JSON.stringify(row)}\n${JSON.stringify({...row, phala_circulation: 4})}`,
      archive,
    ),
  ).toThrow('disagree')
  expect(() =>
    seedQueries('', {results: {'4614059': {rows: [dailyCloud('2026-09-23')]}}}),
  ).toThrow('cutoff')
})
