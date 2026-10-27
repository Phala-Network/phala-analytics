import {finiteNumber, record, shiftDate, utcDate} from './data'

export type Chain = 'ethereum' | 'base'
export const CHAINS: Chain[] = ['ethereum', 'base']
export const PAGE_SIZE = 1000

// Names match the immutable subgraph entities and their D1 cache columns.
export const CHAIN_FIELDS = {
  tokens: [
    'totalSupply',
    'reward',
    'sunsetReward',
    'phalaChainBridge',
    'khalaLegacyChainBridge',
    'khalaChainBridge',
    'sygmaBridge',
    'portalBridge',
    'vaultBalance',
    'vaultTotalAssets',
    'vaultTreasuryAssets',
    'vaultUnstakeLocked',
    'vaultReward',
    'circulation',
  ],
  counts: [],
  decimals: [],
  nullableTokens: [],
  dates: [],
  booleans: [],
  status: true,
} as const
export const VAULT_FIELDS = {
  tokens: [
    'totalAssets',
    'treasuryAssets',
    'shareSupply',
    'unstakeLocked',
    'rewardRate',
    'dailyRewards',
    'dailyTreasuryRewards',
    'deposits',
    'withdrawRequests',
    'claims',
    'treasuryClaims',
  ],
  counts: [
    'stakers',
    'treasuryRatio',
    'depositCount',
    'withdrawRequestCount',
    'claimCount',
    'treasurySettlementCount',
  ],
  decimals: ['sharePrice', 'apr'],
  nullableTokens: ['settlementTotalAssets'],
  dates: ['flowDate'],
  booleans: ['paused'],
  status: true,
} as const
export const CLAIM_FIELDS = {
  tokens: ['khalaFree', 'khalaStaked', 'phalaFree', 'phalaStaked'],
  counts: ['khalaClaimCount', 'phalaClaimCount'],
  decimals: [],
  nullableTokens: [],
  dates: ['flowDate'],
  booleans: [],
  status: false,
} as const

type Fields = {
  tokens: readonly string[]
  counts: readonly string[]
  decimals: readonly string[]
  nullableTokens: readonly string[]
  dates: readonly string[]
  booleans: readonly string[]
  status: boolean
}
type Status = {
  vaultImplementation: string
  vaultImplementationReviewed: boolean
  accrualMode: string
}
export type EntityRow<F extends Fields> = {date: string} & {
  [K in
    | F['tokens'][number]
    | F['counts'][number]
    | F['decimals'][number]]: number
} & {[K in F['nullableTokens'][number]]: number | null} & {
  [K in F['dates'][number]]: string
} & {[K in F['booleans'][number]]: boolean} & (F['status'] extends true
    ? Status
    : unknown)
export type ChainDay = EntityRow<typeof CHAIN_FIELDS> & {chain: Chain}
export type VaultDay = EntityRow<typeof VAULT_FIELDS>
export type ClaimDay = EntityRow<typeof CLAIM_FIELDS>

export const fields = (spec: Fields): string[] => [
  'date',
  ...spec.dates,
  ...spec.tokens,
  ...spec.counts,
  ...spec.decimals,
  ...spec.nullableTokens,
  ...spec.booleans,
  ...(spec.status
    ? ['vaultImplementation', 'vaultImplementationReviewed', 'accrualMode']
    : []),
]

export const wei = (value: unknown): number => {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value))
    throw new Error('Expected an integer token quantity')
  const result = Number(BigInt(value)) / 1e18
  if (!Number.isFinite(result)) throw new Error('Token quantity out of range')
  return result
}
const count = (value: unknown): number => {
  const result = finiteNumber(value)
  if (!Number.isSafeInteger(result)) throw new Error('Invalid subgraph count')
  return result
}
const implementationStatus = (row: Record<string, unknown>): Status => {
  if (
    typeof row.vaultImplementation !== 'string' ||
    !/^0x[0-9a-f]{40}$/i.test(row.vaultImplementation) ||
    typeof row.vaultImplementationReviewed !== 'boolean' ||
    !['formula', 'checkpoint-only', 'inactive'].includes(
      String(row.accrualMode),
    )
  )
    throw new Error('Invalid vault implementation status')
  return {
    vaultImplementation: row.vaultImplementation,
    vaultImplementationReviewed: row.vaultImplementationReviewed,
    accrualMode: String(row.accrualMode),
  }
}

export const parseDay = <F extends Fields>(
  value: unknown,
  spec: F,
): EntityRow<F> => {
  const raw = record(value)
  const date = utcDate(raw.date)
  const row: Record<string, string | number | boolean | null> = {date}
  for (const field of spec.dates) {
    row[field] = utcDate(raw[field])
    if (row[field] !== shiftDate(date, -1))
      throw new Error('Subgraph flowDate must precede its snapshot date')
  }
  for (const field of spec.tokens) row[field] = wei(raw[field])
  for (const field of spec.counts) row[field] = count(raw[field])
  for (const field of spec.decimals) row[field] = finiteNumber(raw[field])
  for (const field of spec.nullableTokens)
    row[field] = raw[field] == null ? null : wei(raw[field])
  for (const field of spec.booleans) {
    if (typeof raw[field] !== 'boolean')
      throw new Error('Invalid subgraph boolean')
    row[field] = raw[field]
  }
  if (spec.status) Object.assign(row, implementationStatus(raw))
  return row as EntityRow<F>
}

export const parsePage = <F extends Fields>(
  value: unknown,
  spec: F,
  after: string,
) => {
  if (!Array.isArray(value) || value.length > PAGE_SIZE)
    throw new Error('Invalid subgraph page')
  const rows = value.map((row) => parseDay(row, spec))
  let previous = after
  for (const row of rows) {
    if (row.date <= previous)
      throw new Error('Subgraph dates must increase strictly')
    previous = row.date
  }
  return rows
}

export const subgraphMeta = (value: unknown) => {
  const data = record(value)
  const meta = record(data._meta)
  if (
    typeof meta.deployment !== 'string' ||
    !meta.deployment ||
    meta.hasIndexingErrors !== false
  )
    throw new Error('Subgraph deployment missing or has indexing errors')
  return meta.deployment
}

export const graphql = async (
  url: string,
  query: string,
  variables: Record<string, string>,
  request: (url: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<Record<string, unknown>> => {
  let response: Response
  try {
    response = await request(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({query, variables}),
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    throw new Error('Subgraph request failed')
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Subgraph: HTTP ${response.status}`)
  }
  let body: Record<string, unknown>
  try {
    body = record(await response.json())
  } catch {
    throw new Error('Invalid subgraph JSON')
  }
  if (body.errors != null) throw new Error('Subgraph GraphQL errors')
  return record(body.data)
}

export const META_QUERY = `{
  _meta { deployment hasIndexingErrors }
  latest(id: "current") { chain timestamp vaultImplementation vaultImplementationReviewed accrualMode }
}`
export const latestStatus = (value: unknown) => {
  const row = record(value)
  const seconds = count(row.timestamp)
  const date = new Date(seconds * 1000)
  if (!Number.isFinite(date.getTime()))
    throw new Error('Invalid subgraph timestamp')
  return {timestamp: date.toISOString(), ...implementationStatus(row)}
}
export const dayQuery = (
  entity: string,
  spec: Fields,
) => `query Days($after: String!) {
  _meta { deployment hasIndexingErrors }
  rows: ${entity}(first: ${PAGE_SIZE}, orderBy: date, orderDirection: asc, where: {date_gt: $after}) {
    ${fields(spec).join(' ')} ${entity === 'chainDays' ? 'chain' : ''}
  }
}`
export const ENTITIES = [
  {entity: 'chainDays', table: 'circulation_day', spec: CHAIN_FIELDS},
  {entity: 'vaultDays', table: 'vault_day', spec: VAULT_FIELDS},
  {entity: 'claimDays', table: 'claim_day', spec: CLAIM_FIELDS},
] as const
