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
 * Daily Vault rewards on their flow day with a trailing 7-day mean. The mean is
 * null until seven consecutive UTC days are available.
 */
export const dailyRewards = (vault: AnalyticsData['vault']): Row[] => {
  const rows = [...vault]
    .map(({flowDate, dailyRewards}) => ({date: flowDate, dailyRewards}))
    .sort((a, b) => a.date.localeCompare(b.date))
  return rows.map((row, index) => {
    const window = rows.slice(Math.max(0, index - 6), index + 1)
    const complete =
      window.length === 7 &&
      dayTime(row.date) - dayTime(window[0]?.date ?? row.date) === 6 * DAY_MS
    return {
      date: row.date,
      time: dayTime(row.date),
      dailyRewards: row.dailyRewards,
      average: complete
        ? window.reduce((sum, item) => sum + item.dailyRewards, 0) / 7
        : null,
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
