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
  /** Drawn as a dashed line without fill. */
  dashed?: boolean
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
 * Rows followed by projected points under `projected`. The first point is the
 * last row's date, so the projected line starts at the latest actual total.
 */
export const withProjection = (
  rows: Row[],
  [start, ...points]: AnalyticsData['projection']['points'],
): Row[] => [
  ...rows.map((row) =>
    start && row.date === start.date ? {...row, projected: start.total} : row,
  ),
  ...toRows(points, ({total}) => ({projected: total})),
]

/**
 * Sunset claim totals by chain, `[khala, phala]`. The live counts for the
 * current day are added only when the daily rows run through the day before,
 * so around midnight no day is skipped or counted twice.
 */
export const claimTotals = (
  claims: AnalyticsData['claims'],
  live: AnalyticsData['live'],
) => {
  const last = claims.at(-1)
  if (!last) return undefined
  const today = live?.claims.flowDate === last.date ? live.claims : undefined
  const rows = today ? [...claims, today] : claims
  const total = (...keys: Exclude<keyof typeof last, 'date' | 'flowDate'>[]) =>
    rows.reduce(
      (sum, row) => keys.reduce((part, key) => part + row[key], sum),
      0,
    )
  return {
    live: today !== undefined,
    through: last.flowDate,
    count: [total('khalaClaimCount'), total('phalaClaimCount')] as const,
    amount: [
      total('khalaFree', 'khalaStaked'),
      total('phalaFree', 'phalaStaked'),
    ] as const,
  }
}

/**
 * Vault rewards summed per ISO week (UTC, Monday to Sunday) of their flow day,
 * keyed by the Monday. Quiet days add 0. The latest week is left out until its
 * Sunday has a row; the first week may have fewer than seven days.
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

/** Latest row with a non-null value for `key`. */
export const latest = <T, K extends keyof T>(rows: readonly T[], key: K) =>
  rows.findLast((row) => row[key] != null)
