import type {AnalyticsData} from '../../worker/data'
import {DAY_MS, dayTime} from './format'

export type Row = {date: string; time: number} & Record<
  string,
  number | null | string
>

export type Series = {
  key: string
  label: string
  /** Drawn series take a chart color; others appear only in the tooltip and table. */
  color?: string
  stack?: boolean
}

export const cellValue = (row: Row, key: string) => {
  const value = row[key]
  return typeof value === 'number' ? value : null
}

/** Chart rows keyed by UTC day, with the selected numeric fields. */
export const toRows = <T extends {date: string}>(
  rows: readonly T[],
  pick: (row: T) => Record<string, number | null>,
): Row[] =>
  rows.map((row) => ({date: row.date, time: dayTime(row.date), ...pick(row)}))

/**
 * Daily Vault rewards on their flow day with a trailing 7-day mean: the mean
 * of the rows dated within the last seven UTC days (quiet days count as 0; a
 * day without a row is skipped). It is null for the first six days of history.
 */
export const dailyRewards = (vault: AnalyticsData['vault']): Row[] => {
  const rows = vault
    .map(({flowDate, dailyRewards}) => ({
      date: flowDate,
      time: dayTime(flowDate),
      dailyRewards,
    }))
    .sort((a, b) => a.time - b.time)
  const first = rows[0]?.time ?? 0
  let start = 0
  let sum = 0
  return rows.map((row, index) => {
    sum += row.dailyRewards
    while ((rows[start]?.time ?? row.time) <= row.time - 7 * DAY_MS)
      sum -= rows[start++]?.dailyRewards ?? 0
    return {
      ...row,
      average:
        row.time - first >= 6 * DAY_MS ? sum / (index + 1 - start) : null,
    }
  })
}

/** Consecutive backfilled Cloud days as inclusive [first, last] date ranges. */
export const backfillRanges = (
  cloud: AnalyticsData['cloud'],
): [string, string][] => {
  const ranges: [string, string][] = []
  for (const {date, backfilled} of cloud) {
    if (!backfilled) continue
    const last = ranges.at(-1)
    if (last && dayTime(date) - dayTime(last[1]) === DAY_MS) last[1] = date
    else ranges.push([date, date])
  }
  return ranges
}

/** Latest row with a non-null value for `key`. */
export const latest = <T, K extends keyof T>(rows: readonly T[], key: K) =>
  rows.findLast((row) => row[key] != null)
