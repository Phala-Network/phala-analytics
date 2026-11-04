import {writeFile} from 'node:fs/promises'
import {
  LEGACY_CHAINS,
  LEGACY_FIELDS,
  LEGACY_RANGES,
  type LegacyChain,
  type LegacyCpuTee,
  type LegacyField,
} from '../src/lib/legacy-cpu-tee'
import {finiteNumber, record, shiftDate, utcDate} from '../worker/data'

const LATE_FIELDS: LegacyField[] = ['average_apr', 'budget_per_share']

/**
 * Per-chain daily columns from the archived Dune
 * `dataset_phala_computation_snapshots` export (one JSON row per line). Fails
 * unless each chain has every field on every day of its range, none outside
 * it, and the export continues past the range. Only APR and budget per share
 * may be missing, at the start of a chain's range (Phala's first 13 days).
 */
export const legacyCpuTee = (ndjson: string): LegacyCpuTee => {
  const days = new Map<string, Record<string, unknown>>()
  for (const line of ndjson.split('\n')) {
    if (!line.trim()) continue
    const row = record(JSON.parse(line))
    if (typeof row.updated_time !== 'string')
      throw new Error('Missing snapshot timestamp')
    const date = utcDate(row.updated_time.slice(0, 10))
    if (days.has(date)) throw new Error(`Duplicate snapshot date: ${date}`)
    days.set(date, row)
  }
  for (const chain of LEGACY_CHAINS) {
    const [start, end] = LEGACY_RANGES[chain]
    if (!days.has(shiftDate(start, -1)) || !days.has(shiftDate(end)))
      throw new Error(`Export does not cover the ${chain} range`)
    for (const [date, row] of days) {
      if (date >= start && date <= end) continue
      for (const field of LEGACY_FIELDS) {
        if (row[`${chain}_${field}`] != null)
          throw new Error(`${chain} ${field} outside its range: ${date}`)
      }
    }
  }
  const columns = (chain: LegacyChain) => {
    const [start, end] = LEGACY_RANGES[chain]
    const column = (field: LegacyField) => {
      const values: (number | null)[] = []
      for (let date: string = start; date <= end; date = shiftDate(date)) {
        const value = days.get(date)?.[`${chain}_${field}`]
        if (value != null) values.push(finiteNumber(value))
        else if (LATE_FIELDS.includes(field) && !values.some((v) => v != null))
          values.push(null)
        else throw new Error(`Missing ${chain} ${field}: ${date}`)
      }
      return values
    }
    return {
      start,
      idle_worker_count: column('idle_worker_count'),
      total_value: column('total_value'),
      delegator_count: column('delegator_count'),
      average_apr: column('average_apr'),
      budget_per_share: column('budget_per_share'),
      cumulative_rewards: column('cumulative_rewards'),
    }
  }
  return {khala: columns('khala'), phala: columns('phala')}
}

const main = async () => {
  const [ndjsonPath, outputPath, ...rest] = Bun.argv.slice(2)
  if (!ndjsonPath || !outputPath || rest.length)
    throw new Error(
      'Usage: bun scripts/legacy-cpu-tee.ts <snapshots.ndjson> <output.json>',
    )
  const data = legacyCpuTee(await Bun.file(ndjsonPath).text())
  await writeFile(outputPath, `${JSON.stringify(data)}\n`)
  console.log(
    LEGACY_CHAINS.map(
      (chain) =>
        `${chain}: ${data[chain].total_value.length} days from ${data[chain].start}`,
    ).join(', '),
  )
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : 'Legacy CPU (TEE) export failed',
    )
    process.exitCode = 1
  })
}
