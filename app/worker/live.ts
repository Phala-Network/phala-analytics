import {formatTotalCirculation} from './circulation/calc'
import type {Config} from './circulation/config'
import {
  field,
  type GraphRequest,
  parseState,
  queryLatest,
  STATE_FIELDS,
} from './circulation/subgraph'
import {finiteNumber} from './data'
import {CLAIM_FIELDS, type ClaimDay, count, wei} from './subgraph'

// The dashboard falls back to daily rows rather than wait for a slow subgraph.
export const LIVE_TIMEOUT_MS = 2000

// Latest and the ChainState claim counters come from the same indexed block.
// The counters hold the current UTC day's claims and reset at each midnight.
const LIVE_QUERY = `{
  _meta { hasIndexingErrors block { number } }
  latest(id: "current") { ${STATE_FIELDS} vaultTotalAssets sharePrice apr stakers }
  chainState(id: "current") { ${[...CLAIM_FIELDS.counts, ...CLAIM_FIELDS.tokens].join(' ')} }
}`

export interface LiveData {
  timestamp: string
  blockNumber: number
  circulation: number
  vaultTotalAssets: number
  sharePrice: number
  apr: number
  stakers: number
  /** Claims so far on `flowDate`, the UTC day of `timestamp`. */
  claims: Omit<ClaimDay, 'date'>
}

/**
 * Current figures with the circulation API's checks: no indexing errors, a
 * reviewed Vault implementation and Latest at most 15 minutes old.
 */
export const readLive = async (
  {ethereumUrl}: Pick<Config, 'ethereumUrl'>,
  request?: GraphRequest,
): Promise<LiveData> => {
  const {data, latest, indexedBlock} = await queryLatest(
    {ethereumUrl, timeoutMs: LIVE_TIMEOUT_MS},
    LIVE_QUERY,
    undefined,
    request,
  )
  const state = parseState(latest, indexedBlock)
  const timestamp = new Date(Number(state.timestamp) * 1000).toISOString()
  const claim = (key: string) => field(data, 'chainState', key)
  return {
    timestamp,
    blockNumber: Number(state.observedBlockNumber),
    // The same value as the plain-number /api/circulation.
    circulation: Number(formatTotalCirculation(state.circulation)),
    vaultTotalAssets: wei(field(latest, 'vaultTotalAssets')),
    sharePrice: finiteNumber(field(latest, 'sharePrice')),
    apr: finiteNumber(field(latest, 'apr')),
    stakers: count(field(latest, 'stakers')),
    claims: {
      flowDate: timestamp.slice(0, 10),
      khalaClaimCount: count(claim('khalaClaimCount')),
      khalaFree: wei(claim('khalaFree')),
      khalaStaked: wei(claim('khalaStaked')),
      phalaClaimCount: count(claim('phalaClaimCount')),
      phalaFree: wei(claim('phalaFree')),
      phalaStaked: wei(claim('phalaStaked')),
    },
  }
}
