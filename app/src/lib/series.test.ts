import {expect, test} from 'bun:test'
import type {AnalyticsData} from '../../worker/data'
import {vaultDay} from '../../worker/fixtures'
import {parseDay, VAULT_FIELDS} from '../../worker/subgraph'
import {DAY_MS} from './format'
import {backfillRanges, dailyRewards} from './series'

const vault = (flowDates: string[], rewards: number[]) =>
  flowDates.map((flowDate, index) => ({
    ...parseDay(vaultDay(flowDate), VAULT_FIELDS),
    flowDate,
    dailyRewards: rewards[index] ?? 0,
  })) as AnalyticsData['vault']
const days = (first: string, count: number) =>
  Array.from({length: count}, (_, index) =>
    new Date(Date.parse(first) + index * DAY_MS).toISOString().slice(0, 10),
  )

test('daily rewards plot on their flow day with a trailing 7-day mean', () => {
  const rows = dailyRewards(
    vault(days('2026-01-01', 9), [7, 14, 21, 28, 35, 42, 49, 56, 0]),
  )
  expect(rows.map((row) => row.date)).toEqual(days('2026-01-01', 9))
  expect(rows.map((row) => row.dailyRewards)).toEqual([
    7, 14, 21, 28, 35, 42, 49, 56, 0,
  ])
  // Null until a full week is available, then the mean of the last seven days.
  expect(rows.map((row) => row.average)).toEqual([
    null,
    null,
    null,
    null,
    null,
    null,
    28,
    35,
    33,
  ])
})

test('the 7-day mean skips days without a row', () => {
  const dates = days('2026-01-01', 9).filter((date) => date !== '2026-01-04')
  const rows = dailyRewards(
    vault([...dates].reverse(), [80, 70, 60, 50, 40, 30, 20, 10]),
  )
  expect(rows.map((row) => row.date)).toEqual(dates)
  // Jan 4 has no row, so each window from Jan 7 to Jan 9 holds six rows.
  expect(rows.map((row) => row.average)).toEqual([
    null,
    null,
    null,
    null,
    null,
    (10 + 20 + 30 + 40 + 50 + 60) / 6,
    (20 + 30 + 40 + 50 + 60 + 70) / 6,
    (30 + 40 + 50 + 60 + 70 + 80) / 6,
  ])
})

test('the 7-day mean varies far less from day to day than daily rewards', () => {
  // Settlement-driven rewards: about 40k a day, uneven, with quiet days.
  let seed = 7
  const random = () => {
    seed = (seed * 48271) % 2147483647
    return seed / 2147483647
  }
  const rewards = Array.from({length: 365}, () =>
    random() < 0.15 ? 0 : 40_000 * (0.2 + 1.6 * random()),
  )
  const rows = dailyRewards(vault(days('2025-01-01', 365), rewards))
  const variation = (key: string) => {
    const values = rows
      .map((row) => row[key])
      .filter((value): value is number => typeof value === 'number')
    return (
      values
        .slice(1)
        .reduce(
          (sum, value, index) =>
            sum + Math.abs(value - (values[index] ?? value)),
          0,
        ) /
      (values.length - 1)
    )
  }
  expect(variation('average')).toBeLessThan(variation('dailyRewards') / 4)
})

test('backfilled Cloud days group into consecutive ranges', () => {
  const cloud = [
    ['2026-09-22', false],
    ['2026-09-23', true],
    ['2026-09-24', true],
    ['2026-09-25', false],
    ['2026-09-26', true],
    ['2026-09-28', true],
  ].map(([date, backfilled]) => ({date, backfilled})) as AnalyticsData['cloud']
  expect(backfillRanges(cloud)).toEqual([
    ['2026-09-23', '2026-09-24'],
    ['2026-09-26', '2026-09-26'],
    ['2026-09-28', '2026-09-28'],
  ])
})
