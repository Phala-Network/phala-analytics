import {expect, test} from 'bun:test'
import committed from '../src/generated/legacy-cpu-tee.json'
import {LEGACY_FIELDS, legacyRows} from '../src/lib/legacy-cpu-tee'
import {shiftDate} from '../worker/data'
import {legacyCpuTee} from './legacy-cpu-tee'

const snapshot = (date: string) => {
  const row: Record<string, string | number | null> = {
    updated_time: `${date}T00:00:00Z`,
  }
  const chain = (name: string, start: string, end: string, value: number) => {
    const day = (Date.parse(date) - Date.parse(start)) / 86_400_000
    const active = date >= start && date <= end
    Object.assign(row, {
      [`${name}_idle_worker_count`]: active ? 10 : null,
      [`${name}_total_value`]: active ? value : null,
      [`${name}_delegator_count`]: active ? 2 : null,
      // Phala's APR and budget per share start two days late.
      [`${name}_average_apr`]:
        active && (name === 'khala' || day >= 2) ? value / 1000 : null,
      [`${name}_budget_per_share`]:
        active && (name === 'khala' || day >= 2) ? value / 100 : null,
      // Cumulative rewards start above zero, so a first-day diff would spike.
      [`${name}_cumulative_rewards`]: active ? 5000 + 100 * day : null,
    })
  }
  chain('khala', '2022-12-28', '2025-01-10', 100)
  chain('phala', '2023-04-29', '2025-11-19', 300)
  return row
}

const ndjson = (edit?: (rows: Record<string, unknown>[]) => void) => {
  const rows = []
  for (let date = '2022-12-27'; date <= '2025-11-20'; date = shiftDate(date))
    rows.push(snapshot(date))
  edit?.(rows)
  return rows.map((row) => JSON.stringify(row)).join('\n')
}

const at = (rows: ReturnType<typeof legacyRows>, date: string) => {
  const row = rows.find((item) => item.date === date)
  if (!row) throw new Error(`Missing row ${date}`)
  return row
}

test('legacy CPU (TEE) export enforces ranges and derives Dune metrics', () => {
  const data = legacyCpuTee(ndjson())
  expect(data.khala.start).toBe('2022-12-28')
  expect(data.khala.total_value).toHaveLength(745)
  expect(data.phala.start).toBe('2023-04-29')
  expect(data.phala.total_value).toHaveLength(936)
  expect(data.phala.average_apr.slice(0, 3)).toEqual([null, null, 0.3])

  const rows = legacyRows(data)
  expect(rows).toHaveLength(1058)
  expect(rows[0]?.date).toBe('2022-12-28')
  expect(rows.at(-1)?.date).toBe('2025-11-19')
  // Daily rewards: none on a chain's first day, then day-over-day changes.
  expect(at(rows, '2022-12-28')).toMatchObject({
    rewards_khala: null,
    rewards: null,
    workers: 10,
  })
  expect(at(rows, '2022-12-29').rewards).toBe(100)
  expect(at(rows, '2023-04-29')).toMatchObject({
    rewards_phala: null,
    rewards: 100,
    workers: 20,
    value: 400,
    // Phala has no APR yet, so Khala's is the average.
    apr: 10,
    budget: 1,
  })
  // Weighted by delegation value: (300 × 30% + 100 × 10%) / 400.
  expect(at(rows, '2023-05-01')).toMatchObject({apr: 25, budget: 2.5})
  expect(at(rows, '2025-01-10')).toMatchObject({rewards: 200, value: 400})
  expect(at(rows, '2025-01-11')).toMatchObject({
    rewards_khala: null,
    rewards: 100,
    value: 300,
    apr: 30,
  })

  expect(() =>
    legacyCpuTee(
      ndjson((rows) => {
        const row = rows.find(
          ({updated_time}) => updated_time === '2024-06-01T00:00:00Z',
        )
        if (row) row.khala_total_value = null
      }),
    ),
  ).toThrow('Missing khala total_value: 2024-06-01')
  expect(() =>
    legacyCpuTee(
      ndjson((rows) => {
        const last = rows.at(-1)
        if (last) last.phala_idle_worker_count = 0
      }),
    ),
  ).toThrow('phala idle_worker_count outside its range: 2025-11-20')
  expect(() => legacyCpuTee(ndjson((rows) => rows.pop()))).toThrow(
    'does not cover the phala range',
  )

  // The committed export ends with Phala's final snapshot.
  for (const field of LEGACY_FIELDS) {
    expect(committed.khala[field]).toHaveLength(745)
    expect(committed.phala[field]).toHaveLength(936)
  }
  const final = legacyRows(committed).at(-1)
  expect(final).toMatchObject({
    date: '2025-11-19',
    workers: 19428,
    value: 42219237.585031256,
    delegators: 688,
  })
  expect(final?.rewards).toBeCloseTo(56919.196377, 6)
  expect(final?.apr).toBeCloseTo(5.6622, 10)
  expect(final?.budget).toBeCloseTo(3.30048, 10)
})
