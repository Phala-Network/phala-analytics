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

test('the 7-day mean is null when the window spans a missing day', () => {
  const dates = days('2026-01-01', 8).filter((date) => date !== '2026-01-04')
  const rows = dailyRewards(vault([...dates].reverse(), [1, 1, 1, 1, 1, 1, 1]))
  expect(rows.map((row) => row.date)).toEqual(dates)
  expect(rows.every((row) => row.average === null)).toBe(true)
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
