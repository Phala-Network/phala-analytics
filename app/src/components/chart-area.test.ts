import {expect, test} from 'bun:test'
import {formatDay, formatNumber} from '@/lib/format'
import {toRows, withProjection} from '@/lib/series'
import {summary} from './chart-area'

test('summary reports the latest actual value and the projection end separately', () => {
  const rows = withProjection(
    toRows(
      [
        {date: '2026-10-28', ethereum: 1000},
        {date: '2026-10-29', ethereum: 2000},
      ],
      ({ethereum}) => ({ethereum}),
    ),
    [
      {date: '2026-10-29', total: 2000},
      {date: '2027-10-29', total: 5000},
    ],
  )
  expect(
    summary('Supply', rows, [
      {key: 'ethereum', label: 'Ethereum', color: 'a', stack: true},
      {key: 'projected', label: 'Projected', color: 'b', dashed: true},
    ]),
  ).toBe(
    `Supply chart from ${formatDay('2026-10-28')} to ${formatDay('2026-10-29')}. Latest: Ethereum ${formatNumber(2000)}. Projected ${formatNumber(5000)} by ${formatDay('2027-10-29')}.`,
  )
})
