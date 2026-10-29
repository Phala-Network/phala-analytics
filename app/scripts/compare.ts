import assert from 'node:assert/strict'
import {
  CIRCULATION_SERIES_START,
  finiteNumber,
  record,
  utcDate,
} from '../worker/data'
import {
  dayQuery,
  ENTITIES,
  graphql,
  META_QUERY,
  PAGE_SIZE,
  parsePage,
  subgraphMeta,
} from '../worker/subgraph'
import {exportRows} from './seed'

const datedRows = (value: unknown) => {
  if (!Array.isArray(value)) throw new Error('Expected dated rows')
  const result = new Map<string, Record<string, unknown>>()
  for (const valueRow of value) {
    const row = record(valueRow)
    const date = utcDate(row.date)
    if (result.has(date)) throw new Error(`Duplicate date ${date}`)
    result.set(date, row)
  }
  return result
}
const equalTotal = (actual: unknown, expected: unknown, label: string) => {
  const left = finiteNumber(actual)
  const right = finiteNumber(expected)
  assert.ok(
    Math.abs(left - right) / Math.max(1, Math.abs(right)) <= 1e-9,
    `${label} differs`,
  )
}

export const compare = (
  value: unknown,
  expectedValue: unknown,
  exported: unknown,
): string[] => {
  const data = record(value)
  const expected = record(expectedValue)
  assert.ok(Array.isArray(data.chainCirculation))
  assert.ok(Array.isArray(expected.chainCirculation))
  const actualCirculation = datedRows(data.chainCirculation)
  const expectedCirculation = datedRows(expected.chainCirculation)
  assert.ok(expectedCirculation.size > 0, 'Ethereum subgraph has no daily rows')
  for (const date of actualCirculation.keys())
    assert.ok(
      date >= CIRCULATION_SERIES_START,
      `Ethereum ${date} precedes the circulation series`,
    )
  assert.equal(
    actualCirculation.size,
    expectedCirculation.size,
    'Ethereum row count',
  )
  for (const date of expectedCirculation.keys())
    assert.ok(actualCirculation.has(date), `Ethereum missing ${date}`)
  const latest = [...expectedCirculation.keys()].sort().at(-1)
  assert.ok(latest)
  equalTotal(
    actualCirculation.get(latest)?.circulation,
    expectedCirculation.get(latest)?.circulation,
    'Ethereum latest circulation',
  )
  assert.equal(
    record(record(data.subgraphs).ethereum).deployment,
    record(record(expected.subgraphs).ethereum).deployment,
    'Ethereum deployment',
  )
  for (const [name, totals] of [
    ['vault', ['totalAssets', 'settlementTotalAssets', 'dailyRewards']],
    [
      'claims',
      [
        'khalaClaimCount',
        'phalaClaimCount',
        'khalaFree',
        'khalaStaked',
        'phalaFree',
        'phalaStaked',
      ],
    ],
  ] as const) {
    const actualRows = datedRows(data[name])
    const expectedRows = datedRows(expected[name])
    assert.ok(expectedRows.size > 0, `${name} subgraph has no daily rows`)
    assert.equal(actualRows.size, expectedRows.size, `${name} row count`)
    for (const date of expectedRows.keys())
      assert.ok(actualRows.has(date), `${name} missing ${date}`)
    const date = [...expectedRows.keys()].sort().at(-1)
    assert.ok(date)
    for (const field of totals) {
      const actual: unknown = actualRows.get(date)?.[field]
      const expected: unknown = expectedRows.get(date)?.[field]
      if (expected == null) assert.equal(actual, null, `${name} ${field}`)
      else equalTotal(actual, expected, `${name} ${field}`)
    }
  }
  const cloud = datedRows(data.cloud)
  const expectedCloud = exportRows(exported, '4614059').filter(
    (row) => row.date != null,
  )
  assert.equal(expectedCloud.length, 663, 'Expected all 663 Cloud dates')
  const mappings = [
    ['totalUsers', 'total_users'],
    ['totalVms', 'total_vms'],
    ['runningVms', 'running_vms'],
    ['totalVcpu', 'total_vcpu'],
    ['captured', 'captured'],
  ] as const
  for (const expected of expectedCloud) {
    const date = utcDate(expected.date)
    const actual = cloud.get(date)
    assert.ok(actual, `Cloud missing ${date}`)
    for (const [api, archive] of mappings)
      assert.equal(
        actual[api],
        expected[archive] ?? null,
        `Cloud ${api} differs ${date}`,
      )
    assert.equal(actual.runningVcpu, null, `Archive runningVcpu ${date}`)
    assert.equal(actual.activeUsers, null, `Archive activeUsers ${date}`)
    assert.equal(actual.backfilled, false, `Archive provenance ${date}`)
  }
  assert.equal(
    [...cloud.keys()].filter((date) => date <= '2026-09-22').length,
    663,
    'Extra Cloud archive dates',
  )
  return [
    'Ethereum subgraph: row counts, dates, deployment and latest totals match (relative tolerance 1e-9)',
    'Cloud: all 663 archive rows match exactly, including captured',
  ]
}

export const subgraphSnapshot = async (url: string) => {
  const meta = await graphql(url, META_QUERY, {})
  assert.equal(record(meta.latest).chain, 'ethereum', 'Subgraph chain mismatch')
  const deployment = subgraphMeta(meta)
  const snapshot: {
    chainCirculation: unknown[]
    vault: unknown[]
    claims: unknown[]
    subgraphs: {ethereum: {deployment: string}}
  } = {
    chainCirculation: [],
    vault: [],
    claims: [],
    subgraphs: {ethereum: {deployment}},
  }
  for (const {entity, spec, table} of ENTITIES) {
    let after = ''
    while (true) {
      const data = await graphql(url, dayQuery(entity, spec), {after})
      assert.equal(
        subgraphMeta(data),
        deployment,
        'Subgraph changed during comparison; retry',
      )
      const rows = parsePage(data.rows, spec, after)
      // The API serves circulation from CIRCULATION_SERIES_START only.
      if (table === 'circulation_day')
        snapshot.chainCirculation.push(
          ...rows
            .filter((row) => row.date >= CIRCULATION_SERIES_START)
            .map((row) => ({...row, chain: 'ethereum'})),
        )
      else if (table === 'vault_day') snapshot.vault.push(...rows)
      else snapshot.claims.push(...rows)
      if (rows.length < PAGE_SIZE) break
      const last = rows.at(-1)
      assert.ok(last)
      after = last.date
    }
  }
  return snapshot
}

const main = async () => {
  const [input, resultsPath, ethereum, ...rest] = Bun.argv.slice(2)
  if (!input || !resultsPath || !ethereum || rest.length)
    throw new Error(
      'Usage: bun scripts/compare.ts <api-data.json|api-data-url> <results.json> <ethereum-subgraph-url>',
    )
  let data: unknown
  if (/^https?:\/\//.test(input)) {
    const response = await fetch(input, {
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`Analytics data: HTTP ${response.status}`)
    data = await response.json()
  } else data = JSON.parse(await Bun.file(input).text())
  const expected = await subgraphSnapshot(ethereum)
  for (const message of compare(
    data,
    expected,
    JSON.parse(await Bun.file(resultsPath).text()),
  ))
    console.log(message)
}

if (import.meta.main)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Comparison failed')
    process.exitCode = 1
  })
