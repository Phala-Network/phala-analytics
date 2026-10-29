import {expect, test} from 'bun:test'
import type {AnalyticsData} from '../../worker/data'
import {claimDay, vaultDay} from '../../worker/fixtures'
import {CLAIM_FIELDS, parseDay, VAULT_FIELDS} from '../../worker/subgraph'
import {DAY_MS} from './format'
import {claimTotals, toRows, weeklyRewards, withProjection} from './series'

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

test('live claims are added only when the daily rows run through the previous day', () => {
  // claimDay(date) holds the flows of the day before: Khala 2 claims, 4 PHA; Phala 1.
  const claims = [claimDay('2026-10-28'), claimDay('2026-10-29')].map((row) =>
    parseDay(row, CLAIM_FIELDS),
  )
  const live = (flowDate: string) =>
    ({
      claims: {
        flowDate,
        khalaClaimCount: 1,
        khalaFree: 10,
        khalaStaked: 0,
        phalaClaimCount: 0,
        phalaFree: 0,
        phalaStaked: 0,
      },
    }) as AnalyticsData['live']
  expect(claimTotals(claims, live('2026-10-29'))).toEqual({
    live: true,
    through: '2026-10-28',
    count: [5, 2],
    amount: [18, 0],
  })
  // Just after midnight, before the hourly sync stores 2026-10-30 (flows of
  // 2026-10-29), the live day 2026-10-30 is not adjacent: show daily totals.
  for (const value of [live('2026-10-30'), live('2026-10-28'), null])
    expect(claimTotals(claims, value)).toEqual({
      live: false,
      through: '2026-10-28',
      count: [4, 2],
      amount: [8, 0],
    })
  expect(claimTotals([], live('2026-10-29'))).toBeUndefined()
})

test('projected rows continue from the last actual row without touching it otherwise', () => {
  const rows = toRows(
    [
      {date: '2026-10-28', total: 1},
      {date: '2026-10-29', total: 2},
    ],
    ({total}) => ({total}),
  )
  const merged = withProjection(rows, [
    {date: '2026-10-29', total: 2},
    {date: '2026-10-30', total: 3},
  ])
  expect(
    merged.map(({date, total, projected}) => [date, total, projected]),
  ).toEqual([
    ['2026-10-28', 1, undefined],
    ['2026-10-29', 2, 2],
    ['2026-10-30', undefined, 3],
  ])
})
