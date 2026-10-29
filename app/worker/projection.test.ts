import {expect, test} from 'bun:test'
import type {AnalyticsData} from './data'
import {chainDay, claimDay, vaultDay} from './fixtures'
import {projectCirculation} from './projection'
import {
  CHAIN_FIELDS,
  CLAIM_FIELDS,
  type ClaimDay,
  parseDay,
  VAULT_FIELDS,
} from './subgraph'

const now = new Date('2026-10-29T12:00:00Z')
const claims = (flowDates: string[], amount: number): ClaimDay[] =>
  flowDates.map((flowDate) => ({
    ...parseDay(claimDay('2026-01-01'), CLAIM_FIELDS),
    flowDate,
    khalaFree: amount / 2,
    khalaStaked: 0,
    phalaFree: 0,
    phalaStaked: amount / 2,
  }))
const input = ({
  sunsetReward = 1_000_000,
  vaultReward = 1_000,
  rewardRate = 1 / 864,
  claimRows = claims(['2026-10-28'], 10),
  reviewed = true,
}: {
  sunsetReward?: number
  vaultReward?: number
  rewardRate?: number
  claimRows?: ClaimDay[]
  reviewed?: boolean
}) =>
  ({
    circulation: [
      {date: '2026-10-28', ethereum: 1, phala: null, khala: null, total: 1},
      {date: '2026-10-29', ethereum: 500, phala: null, khala: null, total: 500},
    ],
    chainCirculation: [
      {
        ...parseDay(chainDay('2026-10-29'), CHAIN_FIELDS),
        chain: 'ethereum',
        sunsetReward,
        vaultReward,
      },
    ],
    vault: [
      {
        ...parseDay(vaultDay('2026-10-29'), VAULT_FIELDS),
        rewardRate,
        vaultImplementationReviewed: reviewed,
      },
    ],
    claims: claimRows,
  }) as Pick<
    AnalyticsData,
    'circulation' | 'chainCirculation' | 'vault' | 'claims'
  >

test('projects 12 months of daily totals from the latest actual total', () => {
  const {method, generatedAt, points} = projectCirculation(input({}), now)
  expect(method).toBe('trend')
  expect(generatedAt).toBe(now.toISOString())
  expect(points[0]).toEqual({date: '2026-10-29', total: 500})
  // 10 PHA of claims and 100 PHA of Vault rewards per day.
  expect(points[1]).toEqual({date: '2026-10-30', total: 610})
  expect(points.at(-1)?.date).toBe('2027-10-29')
  expect(points).toHaveLength(366)
})

test('caps claims at the unclaimed sunset pool and stops when the Vault reserve is exhausted', () => {
  const {points} = projectCirculation(
    input({sunsetReward: 25, vaultReward: 250}),
    now,
  )
  expect(points.slice(1, 5).map(({total}) => total)).toEqual([
    610, 720, 775, 775,
  ])
  expect(points.at(-1)?.total).toBe(775)
  // A negative reserve adds nothing; no claims or rate leaves the total flat.
  const flat = projectCirculation(
    input({vaultReward: -5, claimRows: [], rewardRate: 0}),
    now,
  )
  expect(new Set(flat.points.map(({total}) => total))).toEqual(new Set([500]))
})

test('averages claims over the trailing 90 flow days only', () => {
  const window = Array.from({length: 90}, (_, index) =>
    new Date(Date.parse('2026-07-31T00:00:00Z') + index * 86_400_000)
      .toISOString()
      .slice(0, 10),
  )
  expect(window.at(-1)).toBe('2026-10-28')
  const rows = [...claims(['2026-07-30'], 1_000_000), ...claims(window, 9)]
  const {points} = projectCirculation(
    input({claimRows: rows, rewardRate: 0}),
    now,
  )
  expect(points[1]?.total).toBe(509)
  // Shorter histories average over the days available.
  const short = projectCirculation(
    input({
      claimRows: claims(['2026-10-27', '2026-10-28'], 4),
      rewardRate: 0,
    }),
    now,
  )
  expect(short.points[1]?.total).toBe(504)
})

test('an unreviewed Vault implementation projects claims only', () => {
  const {method, points} = projectCirculation(input({reviewed: false}), now)
  expect(method).toBe('trend-claims-only')
  expect(points[1]).toEqual({date: '2026-10-30', total: 510})
})
