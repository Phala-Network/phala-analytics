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
 * Vault rewards summed per ISO week (UTC, Monday to Sunday) of their flow day,
 * keyed by the Monday. Quiet days add 0. The latest week is left out until its
 * Sunday has a row, so every bar is a complete week.
 */
export const weeklyRewards = (vault: AnalyticsData['vault']): Row[] => {
  const weeks = new Map<number, number>()
  let latest = Number.NEGATIVE_INFINITY
  for (const {flowDate, dailyRewards} of vault) {
    const time = dayTime(flowDate)
    // getUTCDay() is 0 on Sunday; ISO weeks start on Monday.
    const monday = time - ((new Date(time).getUTCDay() + 6) % 7) * DAY_MS
    weeks.set(monday, (weeks.get(monday) ?? 0) + dailyRewards)
    latest = Math.max(latest, time)
  }
  return [...weeks]
    .filter(([monday]) => monday + 6 * DAY_MS <= latest)
    .sort(([a], [b]) => a - b)
    .map(([time, rewards]) => ({
      date: new Date(time).toISOString().slice(0, 10),
      time,
      rewards,
    }))
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
