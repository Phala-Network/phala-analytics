import {expect, test} from 'bun:test'
import {
  compareResponses,
  comparisonCases,
  snapshotDates,
  type WireResponse,
} from './compare-circulation'

const wire = (
  body: string,
  headers: Record<string, string> = {},
): WireResponse => ({
  status: 200,
  headers: new Headers({
    'content-type': 'application/json; charset=UTF-8',
    ...headers,
  }),
  body: new TextEncoder().encode(body),
})
const latest = (seconds: number) => {
  const timestamp = new Date(
    Date.UTC(2026, 9, 28, 12, 0, seconds),
  ).toISOString()
  return {
    phala: {timestamp},
    khala: {timestamp},
    ethereum: {
      circulation: String(100 + seconds / 2),
      vaultReward: String(50 - seconds / 2),
      timestamp: timestamp.replace('.000Z', '.000000Z'),
      totalSupply: '1000',
    },
    totalCirculation: String(100 + seconds / 2),
    sources: {
      ethereum: {
        blockNumber: String(100 + seconds),
        indexedAt: timestamp.replace('.000Z', '.000000Z'),
        lagSeconds: '5',
        vaultUnstakeLocked: '10',
      },
      base: null,
    },
    base: null,
  }
}

test('covers 30 deterministic dates and method/route boundaries', () => {
  const dates = snapshotDates('2026-10-28')
  expect(dates).toHaveLength(30)
  expect(new Set(dates).size).toBe(30)
  expect(dates).toContain('2020-09-01')
  expect(dates).toContain('2026-10-29')
  expect(
    comparisonCases('2026-10-28').some(
      (row) =>
        row.path === '/api/all' && 'method' in row && row.method === 'OPTIONS',
    ),
  ).toBe(true)
})

test('historical bodies and relevant headers must match exactly', () => {
  expect(
    compareResponses('/api/snapshot?date=2020-04-30', wire('{}'), wire('{}'))
      .mode,
  ).toBe('bytes')
  expect(() =>
    compareResponses('/api/snapshot?date=2020-04-30', wire('{}'), wire('{}\n')),
  ).toThrow()
  expect(() =>
    compareResponses(
      '/api/all',
      wire('{}'),
      wire('{}', {'cache-control': 'no-store'}),
    ),
  ).toThrow('cache-control')
})

test('only bounded live accrual and its metadata can differ', () => {
  const left = wire(JSON.stringify(latest(0)))
  const right = wire(JSON.stringify(latest(12)))
  expect(compareResponses('/api/all', left, right)).toEqual({
    mode: 'live',
    seconds: 12,
  })
  expect(
    compareResponses('/api/circulation', wire('100'), wire('106'), 12).mode,
  ).toBe('live')
  expect(() =>
    compareResponses('/api/circulation', wire('100'), wire('106\n'), 12),
  ).toThrow()
  const changed = latest(12)
  changed.ethereum.totalSupply = '1001'
  expect(() =>
    compareResponses('/api/all', left, wire(JSON.stringify(changed))),
  ).toThrow('Other fields')
  changed.ethereum.totalSupply = '1000'
  changed.ethereum.circulation = '200'
  expect(() =>
    compareResponses('/api/all', left, wire(JSON.stringify(changed))),
  ).toThrow('drift exceeds')
  expect(() =>
    compareResponses('/api/all', left, wire(`${JSON.stringify(latest(12))}\n`)),
  ).toThrow('serialization')
})
