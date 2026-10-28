import {expect, test} from 'bun:test'
import {shiftDate} from './data'
import {chainDay, claimDay, dailyCloud, vaultDay} from './fixtures'
import {compare} from './scripts/compare'
import {CHAIN_FIELDS, CLAIM_FIELDS, parseDay, VAULT_FIELDS} from './subgraph'

const cloud = Array.from({length: 663}, (_, index) => ({
  ...dailyCloud(shiftDate('2024-11-29', index)),
  captured: 123,
}))
const exported = {results: {'4614059': {rows: cloud}}}
const data = {
  subgraphs: {
    ethereum: {deployment: 'ethereum-v1'},
  },
  chainCirculation: [
    {...parseDay(chainDay('2026-10-27'), CHAIN_FIELDS), chain: 'ethereum'},
  ],
  vault: [parseDay(vaultDay('2026-10-27'), VAULT_FIELDS)],
  claims: [parseDay(claimDay('2026-10-27'), CLAIM_FIELDS)],
  cloud: cloud.map((row) => ({
    date: row.date,
    totalUsers: row.total_users,
    totalVms: row.total_vms,
    runningVms: row.running_vms,
    totalVcpu: row.total_vcpu,
    runningVcpu: null,
    activeUsers: null,
    captured: row.captured,
    backfilled: false,
  })),
}

test('comparison enforces source counts/latest totals and exact archived Cloud values', () => {
  expect(compare(data, data, exported)).toHaveLength(2)
  const wrongRows = structuredClone(data)
  wrongRows.chainCirculation.pop()
  expect(() => compare(wrongRows, data, exported)).toThrow('row count')
  const wrongTotal = structuredClone(data)
  const vault = wrongTotal.vault[0]
  if (!vault) throw new Error('Missing fixture')
  vault.totalAssets += 1
  expect(() => compare(wrongTotal, data, exported)).toThrow('totalAssets')
  const wrongCaptured = structuredClone(data)
  const row = wrongCaptured.cloud[100]
  if (!row) throw new Error('Missing fixture')
  row.captured += 0.0001
  expect(() => compare(wrongCaptured, data, exported)).toThrow('captured')
  const preSeries = structuredClone(data)
  preSeries.chainCirculation.push({
    ...parseDay(chainDay('2021-02-07'), CHAIN_FIELDS),
    chain: 'ethereum',
  })
  expect(() => compare(preSeries, preSeries, exported)).toThrow(
    'precedes the circulation series',
  )
  const wrongDeployment = structuredClone(data)
  wrongDeployment.subgraphs.ethereum.deployment = 'other'
  expect(() => compare(wrongDeployment, data, exported)).toThrow('deployment')
})
