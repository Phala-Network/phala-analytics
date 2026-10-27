import {VAULT_ADDRESS, VAULT_DEPLOY_BLOCK, VAULT_TOPIC} from './data'

export const dailyCloud = (date: string) => ({
  date,
  total_users: 100,
  total_vms: 20,
  running_vms: 10,
  total_vcpu: 40,
})

export const settlementLog = (
  settledAt: number,
  rewards = 2n * 10n ** 18n,
  totalAssets = 100n * 10n ** 18n,
  block = VAULT_DEPLOY_BLOCK,
  logIndex = 0,
) => ({
  address: VAULT_ADDRESS,
  topics: [VAULT_TOPIC],
  removed: false,
  blockNumber: `0x${block.toString(16)}`,
  logIndex: `0x${logIndex.toString(16)}`,
  data: `0x${[BigInt(settledAt), rewards, totalAssets].map((value) => value.toString(16).padStart(64, '0')).join('')}`,
})
