import assert from 'node:assert/strict'
import {Buffer} from 'node:buffer'
import {record, shiftDate} from '../worker/data'

const HEADERS = [
  'content-type',
  'cache-control',
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',
  'access-control-max-age',
  'access-control-allow-credentials',
  'vary',
  'allow',
  'location',
] as const
const MAX_LIVE_SECONDS = 180
const WEI = 10n ** 18n

// Fixed boundary cases plus UTC-relative edges. Pass a reference date to replay
// exactly the same 30 dates later. The Base-era dates remain API compatibility cases.
export const snapshotDates = (today: string) => [
  '2020-04-30',
  '2020-05-01',
  '2020-08-30',
  '2020-08-31',
  '2020-09-01',
  '2020-09-02',
  '2020-09-03',
  '2021-02-08',
  '2021-12-31',
  '2022-01-01',
  '2022-12-31',
  '2023-08-09',
  '2023-12-31',
  '2024-04-03',
  '2024-04-04',
  '2024-04-05',
  '2024-12-11',
  '2024-12-12',
  '2025-01-09',
  '2025-01-10',
  '2025-06-01',
  '2025-12-31',
  '2026-01-01',
  '2026-09-22',
  '2026-09-23',
  shiftDate(today, -2),
  shiftDate(today, -1),
  today,
  '2020-04-29',
  shiftDate(today, 1),
]

export const comparisonCases = (today: string) => [
  {path: '/api/all', status: [200]},
  {path: '/api/circulation', status: [200]},
  ...snapshotDates(today).map((date) => ({
    path: `/api/snapshot?date=${date}`,
    status:
      date < '2020-04-30' || date > today
        ? [404]
        : date === today
          ? [200, 404]
          : [200],
  })),
  ...['', 'invalid', '2026-02-30', '2026-1-01'].map((date) => ({
    path: `/api/snapshot?date=${date}`,
    status: [400],
  })),
  {path: '/api/snapshot', status: [400]},
  ...[
    '/api',
    '/api/',
    '/api/unknown',
    '/api/circulation/',
    '/api/all/',
    '/api/snapshot/',
  ].map((path) => ({path, status: [404]})),
  {path: '/api/all', method: 'HEAD', status: [200]},
  {path: '/api/circulation', method: 'HEAD', status: [200]},
  {path: '/api/all', method: 'POST', status: [404]},
  {path: '/api/all', method: 'OPTIONS', status: [204]},
]

export interface WireResponse {
  status: number
  headers: Headers
  body: Uint8Array
}

const decimalWei = (value: unknown) => {
  assert.equal(typeof value, 'string')
  assert.ok(
    typeof value === 'string' &&
      /^-?(?:0|[1-9]\d*)(?:\.\d{0,17}[1-9])?$/.test(value),
    'Invalid decimal serialization',
  )
  const negative = value.startsWith('-')
  const [whole = '', fraction = ''] = value.replace(/^-/, '').split('.')
  const wei = BigInt(whole) * WEI + BigInt(fraction.padEnd(18, '0'))
  return negative ? -wei : wei
}
const difference = (left: bigint, right: bigint) =>
  left > right ? left - right : right - left
const timestamp = (value: unknown, digits = 6) => {
  assert.ok(
    typeof value === 'string' &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.(?:\d{3}|\d{6})Z$/.test(value),
    'Timestamp format',
  )
  assert.equal(value.length, 21 + digits, 'Timestamp fractional precision')
  const parsed = Date.parse(value)
  assert.ok(Number.isFinite(parsed), 'Invalid timestamp')
  return parsed
}
const jsonBody = (response: WireResponse) => {
  const text = Buffer.from(response.body).toString('utf8')
  const value = record(JSON.parse(text))
  assert.equal(
    JSON.stringify(value),
    text,
    'JSON bytes must retain compact serialization and key order',
  )
  return value
}

export const compareResponses = (
  path: string,
  old: WireResponse,
  current: WireResponse,
  liveSeconds = 0,
): {mode: 'bytes' | 'live'; seconds: number} => {
  assert.equal(current.status, old.status, 'HTTP status')
  for (const header of HEADERS)
    assert.equal(current.headers.get(header), old.headers.get(header), header)
  if (Buffer.from(old.body).equals(Buffer.from(current.body)))
    return {mode: 'bytes', seconds: 0}
  const offset = old.body.findIndex(
    (byte, index) => byte !== current.body[index],
  )
  const bodyDiff = `Body differs at byte ${offset < 0 ? old.body.length : offset}; old=${old.body.length} bytes new=${current.body.length} bytes`
  assert.equal(old.status, 200, bodyDiff)
  assert.ok(path === '/api/all' || path === '/api/circulation', bodyDiff)
  if (path === '/api/circulation') {
    const left = Buffer.from(old.body).toString('utf8')
    const right = Buffer.from(current.body).toString('utf8')
    assert.match(left, /^(?:0|[1-9]\d*)(?:\.\d{0,11}[1-9])?$/)
    assert.match(right, /^(?:0|[1-9]\d*)(?:\.\d{0,11}[1-9])?$/)
    assert.ok(
      liveSeconds > 0 && liveSeconds <= MAX_LIVE_SECONDS,
      'Need bounded /api/all timestamps to compare live circulation',
    )
    assert.ok(
      difference(decimalWei(left), decimalWei(right)) <=
        BigInt(Math.ceil(liveSeconds)) * WEI + 1_000_000n,
      'Live circulation drift exceeds 1 PHA/second',
    )
    return {mode: 'live', seconds: liveSeconds}
  }
  const left = jsonBody(old)
  const right = jsonBody(current)
  const leftEthereum = record(left.ethereum)
  const rightEthereum = record(right.ethereum)
  const leftIndexedAt = leftEthereum.timestamp
  const rightIndexedAt = rightEthereum.timestamp
  const seconds =
    Math.abs(timestamp(leftIndexedAt) - timestamp(rightIndexedAt)) / 1000
  assert.ok(
    seconds <= MAX_LIVE_SECONDS,
    `Indexed times differ by ${seconds}s (maximum 180s): ${leftIndexedAt} vs ${rightIndexedAt}`,
  )
  const tolerance = BigInt(Math.ceil(seconds)) * WEI + 1_000_000n
  for (const key of ['circulation', 'vaultReward']) {
    assert.ok(
      difference(
        decimalWei(leftEthereum[key]),
        decimalWei(rightEthereum[key]),
      ) <= tolerance,
      `ethereum.${key} drift exceeds 1 PHA/second`,
    )
    leftEthereum[key] = rightEthereum[key] = '<live amount>'
  }
  for (const total of [left.totalCirculation, right.totalCirculation])
    assert.ok(
      typeof total === 'string' &&
        /^(?:0|[1-9]\d*)(?:\.\d{0,11}[1-9])?$/.test(total),
      'totalCirculation format',
    )
  assert.ok(
    difference(
      decimalWei(left.totalCirculation),
      decimalWei(right.totalCirculation),
    ) <= tolerance,
    'totalCirculation drift',
  )
  left.totalCirculation = right.totalCirculation = '<live amount>'
  leftEthereum.timestamp = rightEthereum.timestamp = '<indexed timestamp>'
  for (const chain of ['phala', 'khala']) {
    const a = record(left[chain])
    const b = record(right[chain])
    assert.ok(
      Math.abs(timestamp(a.timestamp, 3) - timestamp(b.timestamp, 3)) <=
        MAX_LIVE_SECONDS * 1000,
      `${chain} wall clock drift`,
    )
    a.timestamp = b.timestamp = '<computed timestamp>'
  }
  const a = record(record(left.sources).ethereum)
  const b = record(record(right.sources).ethereum)
  for (const source of [a, b]) {
    assert.ok(
      typeof source.lagSeconds === 'string' &&
        /^\d+$/.test(source.lagSeconds) &&
        Number(source.lagSeconds) <= 900,
      'Source lag',
    )
    assert.ok(
      typeof source.blockNumber === 'string' &&
        /^\d+$/.test(source.blockNumber),
      'Source block format',
    )
  }
  assert.ok(
    difference(BigInt(String(a.blockNumber)), BigInt(String(b.blockNumber))) <=
      BigInt(Math.ceil(seconds)),
    'Observed block drift',
  )
  // These fields describe the evaluation time and request time, not historical data.
  for (const key of ['indexedAt', 'lagSeconds', 'blockNumber']) {
    if (key === 'indexedAt') {
      assert.equal(a[key], leftIndexedAt)
      assert.equal(b[key], rightIndexedAt)
    }
    a[key] = b[key] = `<live ${key}>`
  }
  assert.equal(
    JSON.stringify(right),
    JSON.stringify(left),
    'Other fields or serialized key order differ',
  )
  return {mode: 'live', seconds: Math.max(1, seconds)}
}

const baseUrl = (value: string) => {
  const url = new URL(value)
  assert.ok(
    ['https:', 'http:'].includes(url.protocol) &&
      !url.username &&
      !url.password,
    'Expected an HTTP base URL without credentials',
  )
  return url
}

export const compareCirculation = async (
  oldBase: string,
  newBase: string,
  today = new Date().toISOString().slice(0, 10),
) => {
  assert.match(today, /^\d{4}-\d\d-\d\d$/)
  const bases = [baseUrl(oldBase), baseUrl(newBase)]
  const results = []
  let liveSeconds = 0
  for (const entry of comparisonCases(today)) {
    const method = 'method' in entry ? entry.method : 'GET'
    const responses = await Promise.all(
      bases.map(async (base) => {
        const response = await fetch(new URL(entry.path, base), {
          method,
          headers: {
            Origin: 'https://compare.example',
            'Access-Control-Request-Headers': 'X-Compare',
          },
          redirect: 'manual',
          signal: AbortSignal.timeout(30_000),
        })
        return {
          status: response.status,
          headers: response.headers,
          body: new Uint8Array(await response.arrayBuffer()),
        }
      }),
    )
    const [old, current] = responses
    assert.ok(old && current)
    try {
      assert.ok(
        entry.status.includes(old.status),
        `Unexpected reference status ${old.status}`,
      )
      const result = compareResponses(entry.path, old, current, liveSeconds)
      if (entry.path === '/api/all' && method === 'GET')
        liveSeconds = result.mode === 'bytes' ? 1 : result.seconds
      results.push({
        path: entry.path,
        method,
        status: current.status,
        ...result,
      })
    } catch (error) {
      results.push({
        path: entry.path,
        method,
        status: current.status,
        error: error instanceof Error ? error.message : 'Comparison failed',
      })
    }
  }
  return {
    today,
    snapshotDates: snapshotDates(today).length,
    passed: results.filter((result) => !('error' in result)).length,
    failed: results.filter((result) => 'error' in result).length,
    results,
  }
}

if (import.meta.main) {
  try {
    const [, , oldBase, newBase, today] = process.argv
    if (!oldBase || !newBase)
      throw new Error(
        'Usage: bun scripts/compare-circulation.ts <old-base> <new-base> [UTC-date]',
      )
    const result = await compareCirculation(oldBase, newBase, today)
    console.log(JSON.stringify(result, null, 2))
    process.exitCode = result.failed ? 1 : 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Comparison failed')
    process.exitCode = 1
  }
}
