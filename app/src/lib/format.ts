// Numbers use the reader's locale; dates are UTC days, as stored by the API.
// Exact timestamps follow the reader's time zone setting.

/** Time zone for exact timestamps; daily dates are always UTC days. */
export type TimeZone = 'local' | 'utc'
export const isTimeZone = (value: string | null): value is TimeZone =>
  value === 'local' || value === 'utc'

const integer = new Intl.NumberFormat(undefined, {maximumFractionDigits: 0})
const compact = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
})
const percent = new Intl.NumberFormat(undefined, {
  style: 'percent',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})
const day = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeZone: 'UTC',
})
const dateTime = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC',
})
// Created per call so it follows changes to the reader's time zone.
const localDateTime = () =>
  new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  })
const month = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
})

export const DAY_MS = 86_400_000

/** Whole numbers, or up to `fractionDigits` decimals. */
export const formatNumber = (
  value: number | null | undefined,
  fractionDigits = 0,
) =>
  value == null
    ? '–'
    : fractionDigits
      ? value.toLocaleString(undefined, {maximumFractionDigits: fractionDigits})
      : integer.format(value)
export const formatCompact = (value: number) => compact.format(value)
export const formatPercent = (value: number) => percent.format(value)

/** Milliseconds at 00:00 UTC on a YYYY-MM-DD date. */
export const dayTime = (date: string) => Date.parse(`${date}T00:00:00Z`)
export const formatDay = (date: string) => day.format(dayTime(date))
/**
 * A recent ISO timestamp as a date and time in the reader's time zone, e.g.
 * "Oct 28, 7:27 AM PDT", or in UTC, e.g. "Oct 28, 2:27 PM UTC".
 */
export const formatTimestamp = (iso: string, timeZone: TimeZone) =>
  timeZone === 'utc'
    ? `${dateTime.format(Date.parse(iso))} UTC`
    : localDateTime().format(Date.parse(iso))
/** Axis label for a YYYY-MM-DD date, e.g. "Jan 2025". */
export const formatMonth = (date: string) => month.format(dayTime(date))
