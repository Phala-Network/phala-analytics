import {mkdir, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {cloudRow, nullableNumber, record, utcDate} from '../worker/data'

export interface BatchQuery {
  sql: string
  params: (string | number | null)[]
}

export const exportRows = (
  value: unknown,
  query: string,
): Record<string, unknown>[] => {
  const result = record(record(record(value).results)[query])
  if (!Array.isArray(result.rows))
    throw new Error(`Missing export query ${query}`)
  return result.rows.map(record)
}

const archivedCirculation = (value: unknown) => {
  const row = record(value)
  if (typeof row.updated_time !== 'string')
    throw new Error('Missing archive timestamp')
  return {
    date: utcDate(row.updated_time.slice(0, 10)),
    phala: nullableNumber(row.phala_circulation),
    khala: nullableNumber(row.khala_circulation),
  }
}

const insertQueries = (
  table: string,
  columns: string[],
  rows: (string | number | null)[][],
): BatchQuery[] => {
  const size = Math.floor(100 / columns.length)
  const queries: BatchQuery[] = []
  for (let index = 0; index < rows.length; index += size) {
    const chunk = rows.slice(index, index + size)
    queries.push({
      sql: `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${chunk.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ')} ON CONFLICT DO NOTHING`,
      params: chunk.flat(),
    })
  }
  return queries
}

export const seedQueries = (ndjson: string, exported: unknown) => {
  const circulation = new Map<string, ReturnType<typeof archivedCirculation>>()
  const addCirculation = (value: unknown) => {
    const row = archivedCirculation(value)
    const previous = circulation.get(row.date)
    if (previous != null) {
      if (JSON.stringify(previous) !== JSON.stringify(row))
        throw new Error(`Circulation archives disagree: ${row.date}`)
    } else circulation.set(row.date, row)
  }
  for (const line of ndjson.split('\n')) {
    if (line.trim()) addCirculation(JSON.parse(line))
  }
  const cloud = new Map<string, (string | number | null)[]>()
  for (const archived of exportRows(exported, '4614059')) {
    // Public Dune exports also include a counter-only row, without a date.
    if (archived.date == null) continue
    const row = cloudRow(archived)
    if (row.date > '2026-09-22')
      throw new Error('Cloud archive exceeds the approved cutoff')
    if (cloud.has(row.date))
      throw new Error(`Duplicate cloud archive date: ${row.date}`)
    cloud.set(row.date, [
      row.date,
      row.total_users,
      row.total_vms,
      row.running_vms,
      row.total_vcpu,
      null,
      null,
      nullableNumber(archived.price),
      nullableNumber(archived.captured),
      'archive',
    ])
  }
  const circulationRows = [...circulation.values()].sort((a, b) =>
    a.date.localeCompare(b.date),
  )
  const cloudRows = [...cloud]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, row]) => row)
  return {
    circulationCount: circulation.size,
    cloudCount: cloud.size,
    circulation: insertQueries(
      'legacy_circulation_day',
      ['date', 'phala', 'khala'],
      circulationRows.map((row) => [row.date, row.phala, row.khala]),
    ),
    cloud: insertQueries(
      'cloud_daily',
      [
        'date',
        'total_users',
        'total_vms',
        'running_vms',
        'total_vcpu',
        'running_vcpu',
        'active_users',
        'pha_usd',
        'captured',
        'source',
      ],
      cloudRows,
    ),
  }
}

const main = async () => {
  const [ndjsonPath, resultsPath, outputPath, ...rest] = Bun.argv.slice(2)
  if (!ndjsonPath || !resultsPath || !outputPath || rest.length)
    throw new Error(
      'Usage: bun scripts/seed.ts <snapshots.ndjson> <results.json> <output-directory>',
    )
  const queries = seedQueries(
    await Bun.file(ndjsonPath).text(),
    JSON.parse(await Bun.file(resultsPath).text()),
  )
  await mkdir(outputPath, {recursive: true})
  for (const name of ['circulation', 'cloud'] as const) {
    const statements = queries[name]
    for (let index = 0; index < statements.length; index += 100) {
      const filename = `${name}-${String(index / 100 + 1).padStart(3, '0')}.json`
      await writeFile(
        join(outputPath, filename),
        `${JSON.stringify(statements.slice(index, index + 100))}\n`,
        {flag: 'wx'},
      )
    }
  }
  console.log(
    `Seed: ${queries.circulationCount} legacy circulation days, ${queries.cloudCount} cloud days`,
  )
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Seed failed')
    process.exitCode = 1
  })
}
