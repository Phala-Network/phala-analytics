import {DAY_MS, dayTime} from './format'
import type {Row} from './series'

/**
 * Days each chain's CPU (TEE) computation was indexed, inclusive. Khala ended
 * on 2025-01-10 and Phala on 2025-11-19; there are no later snapshots.
 */
export const LEGACY_RANGES = {
  khala: ['2022-12-28', '2025-01-10'],
  phala: ['2023-04-29', '2025-11-19'],
} as const

export type LegacyChain = keyof typeof LEGACY_RANGES

export const LEGACY_FIELDS = [
  'idle_worker_count',
  'total_value',
  'delegator_count',
  'average_apr',
  'budget_per_share',
  'cumulative_rewards',
] as const

export type LegacyField = (typeof LEGACY_FIELDS)[number]

/**
 * Daily snapshot columns per chain, one value per day from `start`. Phala's
 * APR and budget per share are null until 2023-05-12.
 */
export type LegacyCpuTee = Record<
  LegacyChain,
  {start: string} & Record<LegacyField, (number | null)[]>
>

export const LEGACY_CHAINS = Object.keys(LEGACY_RANGES) as LegacyChain[]

/**
 * Daily chart rows from the first to the last snapshot, derived as Dune's
 * "History" query 3572546. Each metric has a value per chain under
 * `<metric>_<chain>` (null outside the chain's range) and across chains under
 * `<metric>`: daily rewards (`rewards`, the change in cumulative rewards since
 * the previous day, so a chain's first day has none), online workers
 * (`workers`, idle workers), delegation value (`value`), delegators, average
 * APR (`apr`, in percent) and budget per share (`budget`). Totals sum the
 * chains; APR and budget per share are averages weighted by the delegation
 * value of the chains that report them.
 */
export const legacyRows = (data: LegacyCpuTee): Row[] => {
  const first = Math.min(
    ...LEGACY_CHAINS.map((chain) => dayTime(data[chain].start)),
  )
  const last = Math.max(
    ...LEGACY_CHAINS.map(
      (chain) =>
        dayTime(data[chain].start) +
        (data[chain].total_value.length - 1) * DAY_MS,
    ),
  )
  return Array.from({length: (last - first) / DAY_MS + 1}, (_, day) => {
    const time = first + day * DAY_MS
    const row: Row = {date: new Date(time).toISOString().slice(0, 10), time}
    const total: Record<string, number | null> = {
      workers: null,
      rewards: null,
      value: null,
      delegators: null,
    }
    const weighted = {apr: 0, budget: 0, aprValue: 0, budgetValue: 0}
    for (const chain of LEGACY_CHAINS) {
      const columns = data[chain]
      const index = (time - dayTime(columns.start)) / DAY_MS
      const at = (field: LegacyField, offset = 0) =>
        columns[field][index - offset] ?? null
      const cumulative = at('cumulative_rewards')
      const previous = at('cumulative_rewards', 1)
      const value = at('total_value')
      const metrics = {
        workers: at('idle_worker_count'),
        rewards:
          cumulative == null || previous == null ? null : cumulative - previous,
        value,
        delegators: at('delegator_count'),
      }
      for (const [key, metric] of Object.entries(metrics)) {
        row[`${key}_${chain}`] = metric
        if (metric != null) total[key] = (total[key] ?? 0) + metric
      }
      const averageApr = at('average_apr')
      const budgetPerShare = at('budget_per_share')
      row[`apr_${chain}`] = averageApr == null ? null : averageApr * 100
      row[`budget_${chain}`] = budgetPerShare
      if (value != null && averageApr != null) {
        weighted.apr += value * averageApr
        weighted.aprValue += value
      }
      if (value != null && budgetPerShare != null) {
        weighted.budget += value * budgetPerShare
        weighted.budgetValue += value
      }
    }
    return Object.assign(row, total, {
      apr: weighted.aprValue ? (weighted.apr / weighted.aprValue) * 100 : null,
      budget: weighted.budgetValue
        ? weighted.budget / weighted.budgetValue
        : null,
    })
  })
}
