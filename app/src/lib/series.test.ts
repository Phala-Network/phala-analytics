import {expect, test} from 'bun:test'
import type {AnalyticsData} from '../../worker/data'
import {vaultDay} from '../../worker/fixtures'
import {parseDay, VAULT_FIELDS} from '../../worker/subgraph'
import {DAY_MS} from './format'
import {weeklyRewards} from './series'

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

test('weekly rewards sum UTC ISO weeks from Monday, keyed by flow day', () => {
  // 2026-10-18 is a Sunday, 2026-10-19 a Monday and 2026-11-01 a Sunday.
  const flowDates = days('2026-10-18', 15)
  const rows = weeklyRewards(
    vault([...flowDates].reverse(), [...flowDates.keys()].reverse()),
  )
  expect(rows.map(({date, rewards}) => [date, rewards])).toEqual([
    ['2026-10-12', 0],
    ['2026-10-19', 1 + 2 + 3 + 4 + 5 + 6 + 7],
    ['2026-10-26', 8 + 9 + 10 + 11 + 12 + 13 + 14],
  ])
  expect(rows[1]?.time).toBe(Date.UTC(2026, 9, 19))
})

test('the latest week is left out until its Sunday has a row', () => {
  const rows = weeklyRewards(vault(days('2026-10-19', 13), Array(13).fill(1)))
  expect(rows.map(({date, rewards}) => [date, rewards])).toEqual([
    ['2026-10-19', 7],
  ])
})

test('quiet days count as 0 and a week of quiet days stays a 0 bar', () => {
  const rows = weeklyRewards(
    vault(days('2026-10-19', 14), [0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  )
  expect(rows.map(({date, rewards}) => [date, rewards])).toEqual([
    ['2026-10-19', 5],
    ['2026-10-26', 0],
  ])
})
