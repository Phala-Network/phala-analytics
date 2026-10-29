import type {AnalyticsData} from './data'
import {shiftDate} from './data'

const CLAIM_WINDOW_DAYS = 90

export interface Projection {
  method: 'trend'
  generatedAt: string
  /** Daily totals in PHA from the latest actual day through 12 months later. */
  points: {date: string; total: number}[]
}

/**
 * Circulating supply extended from its latest actual total: sunset claims at
 * the trailing 90-day average daily amount, capped at the unclaimed sunset
 * pool, plus the Vault reward reserve paid out at the current reward rate
 * until exhausted. No top-ups are assumed.
 */
export const projectCirculation = (
  {
    circulation,
    chainCirculation,
    vault,
    claims,
  }: Pick<
    AnalyticsData,
    'circulation' | 'chainCirculation' | 'vault' | 'claims'
  >,
  now: Date,
): Projection => {
  const start = circulation.at(-1)
  if (!start) throw new Error('No circulation to project')
  const chain = chainCirculation.at(-1)
  const lastClaim = claims.at(-1)
  const window = lastClaim
    ? claims.filter(
        (row) =>
          row.flowDate > shiftDate(lastClaim.flowDate, -CLAIM_WINDOW_DAYS),
      )
    : []
  const claimsPerDay =
    window.reduce(
      (sum, row) =>
        sum + row.khalaFree + row.khalaStaked + row.phalaFree + row.phalaStaked,
      0,
    ) / Math.max(1, window.length)
  const sunsetPool = chain?.sunsetReward ?? 0
  const rewardsPerDay = (vault.at(-1)?.rewardRate ?? 0) * 86_400
  const reserve = Math.max(0, chain?.vaultReward ?? 0)
  const end = new Date(`${start.date}T00:00:00Z`)
  end.setUTCFullYear(end.getUTCFullYear() + 1)
  const last = end.toISOString().slice(0, 10)
  const points: Projection['points'] = []
  for (let day = 0, date = start.date; date <= last; day++) {
    points.push({
      date,
      total:
        start.total +
        Math.min(claimsPerDay * day, sunsetPool) +
        Math.min(rewardsPerDay * day, reserve),
    })
    date = shiftDate(date)
  }
  return {method: 'trend', generatedAt: now.toISOString(), points}
}
