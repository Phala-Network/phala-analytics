import assert from 'node:assert/strict'
import {finiteNumber, record, utcDate} from '../data'
import {exportRows} from './seed'

const datedRows = (value: unknown, field: string) => {
  if (!Array.isArray(value)) throw new Error('Expected dated rows')
  const result = new Map<string, Record<string, unknown>>()
  for (const valueRow of value) {
    const row = record(valueRow)
    const date = utcDate(row[field])
    if (result.has(date)) throw new Error(`Duplicate date ${date}`)
    result.set(date, row)
  }
  return result
}

export const compare = (
  value: unknown,
  exported: unknown,
  skipVault = false,
): string[] => {
  const data = record(value)
  const circulation = datedRows(data.circulation, 'date')
  const history = exportRows(exported, '3572546')
  assert.equal(history.length, 365, 'Expected all 365 History rows')
  for (const expected of history) {
    assert.equal(typeof expected.updated_time, 'string')
    const date = String(expected.updated_time).slice(0, 10)
    const actual = circulation.get(date)
    assert.ok(actual, `Circulation missing ${date}`)
    const total = finiteNumber(expected.total_circulation)
    assert.ok(
      Math.abs(finiteNumber(actual.total) - total) / Math.max(1, total) <= 1e-9,
      `Circulation differs ${date}`,
    )
  }
  const cloud = datedRows(data.cloud, 'date')
  const expectedCloud = exportRows(exported, '4614059').filter(
    (row) => row.date != null,
  )
  assert.equal(expectedCloud.length, 663, 'Expected all 663 Cloud dates')
  const mappings = [
    ['totalUsers', 'total_users'],
    ['totalVms', 'total_vms'],
    ['runningVms', 'running_vms'],
    ['totalVcpu', 'total_vcpu'],
    ['captured', 'captured'],
  ] as const
  for (const expected of expectedCloud) {
    const date = utcDate(expected.date)
    const actual = cloud.get(date)
    assert.ok(actual, `Cloud missing ${date}`)
    for (const [api, archive] of mappings)
      assert.equal(
        actual[api],
        expected[archive] ?? null,
        `Cloud ${api} differs ${date}`,
      )
  }
  assert.equal(
    [...cloud.keys()].filter((date) => date <= '2026-09-22').length,
    663,
    'Extra Cloud archive dates',
  )
  const messages = [
    'Circulation: all 365 History totals match (relative tolerance 1e-9)',
    'Cloud: all 663 archive rows match exactly, including captured',
  ]
  if (skipVault) {
    messages.push(
      'Vault: SKIPPED (requires independently scanned Ethereum history)',
    )
  } else {
    const vault = datedRows(data.vault, 'date')
    const expectedVault = exportRows(exported, '5154700').filter(
      (row) => row.day != null,
    )
    assert.equal(expectedVault.length, 550, 'Expected all 550 Vault dates')
    for (const expected of expectedVault) {
      const date = utcDate(expected.day)
      const actual = vault.get(date)
      assert.ok(actual, `Vault missing ${date}`)
      assert.equal(
        actual.totalAssets,
        expected.totalAssets,
        `Vault assets differ ${date}`,
      )
    }
    assert.equal(
      [...vault.keys()].filter((date) => date <= '2026-10-10').length,
      550,
      'Extra Vault dates through export cutoff',
    )
    assert.equal(
      vault.get('2026-10-10')?.dailyRewards,
      34930.0634765625,
      'Vault rewards differ 2026-10-10',
    )
    messages.push(
      'Vault: all 550 assets match exactly; no extra days through 2026-10-10; final dailyRewards match',
    )
  }
  return messages
}

const main = async () => {
  const [input, resultsPath, ...flags] = Bun.argv.slice(2)
  if (
    !input ||
    !resultsPath ||
    flags.some((flag) => flag !== '--skip-vault') ||
    flags.length > 1
  )
    throw new Error(
      'Usage: bun scripts/compare.ts <api-data.json|api-data-url> <results.json> [--skip-vault]',
    )
  let data: unknown
  if (/^https?:\/\//.test(input)) {
    const response = await fetch(input, {
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`Analytics data: HTTP ${response.status}`)
    data = await response.json()
  } else data = JSON.parse(await Bun.file(input).text())
  for (const message of compare(
    data,
    JSON.parse(await Bun.file(resultsPath).text()),
    flags.includes('--skip-vault'),
  ))
    console.log(message)
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Comparison failed')
    process.exitCode = 1
  })
}
