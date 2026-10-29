import {expect, test} from 'bun:test'

// Far from UTC, so local-time formatting would shift these dates.
process.env.TZ = 'Pacific/Kiritimati'
const {formatDay, formatDayRange, formatMonth, formatNumber, formatTimestamp} =
  await import('./format')

test('dates are formatted as UTC days regardless of the reader time zone', () => {
  expect(formatDay('2026-10-28')).toContain('28')
  expect(formatTimestamp('2026-10-28T23:30:00Z')).toMatch(/28.*UTC$/)
  expect(formatTimestamp('2026-10-28T23:30:00Z')).not.toContain('29')
  expect(formatDayRange(['2026-09-23', '2026-09-23'])).toBe(
    formatDay('2026-09-23'),
  )
  expect(formatDayRange(['2026-09-23', '2026-10-26'])).toBe(
    `${formatDay('2026-09-23')} – ${formatDay('2026-10-26')}`,
  )
  // Axis labels for January 1 stay in that month and year.
  expect(formatMonth('2025-01-01')).toContain('2025')
  expect(formatMonth('2025-01-01')).toBe(
    new Intl.DateTimeFormat(undefined, {
      month: 'short',
      year: 'numeric',
    }).format(new Date(2025, 0, 1)),
  )
})

test('missing values render as a dash and figures as whole numbers', () => {
  expect(formatNumber(null)).toBe('–')
  expect(formatNumber(undefined)).toBe('–')
  expect(formatNumber(1234.6)).toBe(new Intl.NumberFormat().format(1235))
})
