import {shiftDate} from './data'
import {CHAIN_FIELDS, CLAIM_FIELDS, VAULT_FIELDS} from './subgraph'

export const dailyCloud = (date: string) => ({
  date,
  total_users: 100,
  total_vms: 20,
  running_vms: 10,
  total_vcpu: 40,
  running_vcpu: 24,
  active_users: 8,
})
const token = (amount: number) => String(BigInt(amount) * 10n ** 18n)
export const implementation = {
  vaultImplementation: `0x${'1'.repeat(40)}`,
  vaultImplementationReviewed: true,
  accrualMode: 'formula',
}
export const chainDay = (date: string) => ({
  ...Object.fromEntries(CHAIN_FIELDS.tokens.map((field) => [field, '0'])),
  ...implementation,
  date,
  chain: 'ethereum',
  totalSupply: token(1000),
  circulation: token(100),
  vaultReward: token(-1),
})
export const vaultDay = (date: string) => ({
  ...Object.fromEntries(VAULT_FIELDS.tokens.map((field) => [field, '0'])),
  ...Object.fromEntries(VAULT_FIELDS.counts.map((field) => [field, '0'])),
  ...implementation,
  date,
  flowDate: shiftDate(date, -1),
  totalAssets: token(100),
  settlementTotalAssets: token(99),
  dailyRewards: token(2),
  deposits: token(5),
  claims: token(1),
  paused: false,
  sharePrice: '1.25',
  apr: '0.05',
  stakers: '3',
})
export const claimDay = (date: string) => ({
  ...Object.fromEntries(CLAIM_FIELDS.tokens.map((field) => [field, '0'])),
  ...Object.fromEntries(CLAIM_FIELDS.counts.map((field) => [field, '0'])),
  date,
  flowDate: shiftDate(date, -1),
  khalaClaimCount: '2',
  khalaFree: token(4),
  phalaClaimCount: '1',
})
