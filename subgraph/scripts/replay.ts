// Rebuilds vaultUnstakeLocked directly from Ethereum logs, independent of any
// indexer. Used to verify the subgraph and as the recovery path for backfills.
//
// Usage:
//   RPC_URL=https://... bun scripts/replay.ts [toBlock]
//
// toBlock defaults to the finalized head. CHUNK_SIZE (default 10000) and
// CONCURRENCY (default 4) tune eth_getLogs batching for the RPC plan in use.
// Ranges the provider rejects as too wide are split automatically.

import {
  BaseError,
  createPublicClient,
  formatUnits,
  http,
  isAddressEqual,
  parseAbi,
} from 'viem'
import {mainnet} from 'viem/chains'

const VAULT = '0x21d6eC8fc14CaAcc55aFA23cBa66798DAB3a0ec0'
const START_BLOCK = 21_596_326n

const events = parseAbi([
  'event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)',
  'event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)',
  'event Claimed(address indexed caller, address indexed receiver, address indexed owner, uint256 assets)',
])

const rpcUrl = process.env.RPC_URL
if (!rpcUrl) throw new Error('RPC_URL is required')
const chunkSize = BigInt(process.env.CHUNK_SIZE ?? '10000')
const concurrency = Number(process.env.CONCURRENCY ?? '4')

const client = createPublicClient({
  chain: mainnet,
  transport: http(rpcUrl, {timeout: 30_000, retryCount: 5}),
})

const toBlock = process.argv[2]
  ? BigInt(process.argv[2])
  : (await client.getBlock({blockTag: 'finalized'})).number

const ranges: [bigint, bigint][] = []
for (let from = START_BLOCK; from <= toBlock; from += chunkSize) {
  const to = from + chunkSize - 1n
  ranges.push([from, to < toBlock ? to : toBlock])
}

const getLogs = (fromBlock: bigint, to: bigint) =>
  client.getLogs({address: VAULT, events, fromBlock, toBlock: to, strict: true})

type Log = Awaited<ReturnType<typeof getLogs>>[number]

// Providers cap eth_getLogs ranges differently, and Goldsky Edge's cap varies
// with the upstream serving a request, so a rejected range is halved.
const fetchRange = async ([fromBlock, to]: [bigint, bigint]): Promise<Log[]> => {
  try {
    return await getLogs(fromBlock, to)
  } catch (error) {
    const tooWide =
      error instanceof BaseError &&
      /range|limit|too many|exceed/i.test(error.details)
    if (!tooWide || to === fromBlock) throw error
    const mid = (fromBlock + to) / 2n
    return [
      ...(await fetchRange([fromBlock, mid])),
      ...(await fetchRange([mid + 1n, to])),
    ]
  }
}
const logs: Log[] = []
let done = 0
const queue = [...ranges]
await Promise.all(
  Array.from({length: concurrency}, async () => {
    for (let range = queue.shift(); range; range = queue.shift()) {
      logs.push(...(await fetchRange(range)))
      done++
      if (done % 50 === 0) console.error(`${done}/${ranges.length} ranges`)
    }
  }),
)

logs.sort((a, b) =>
  a.blockNumber === b.blockNumber
    ? a.logIndex - b.logIndex
    : a.blockNumber < b.blockNumber
      ? -1
      : 1,
)

let vaultUnstakeLocked = 0n
let checkpoints = 0
for (const log of logs) {
  if (log.eventName === 'Withdraw') {
    vaultUnstakeLocked += log.args.assets
  } else if (log.eventName === 'Claimed') {
    vaultUnstakeLocked -= log.args.assets
  } else if (isAddressEqual(log.args.sender, VAULT)) {
    vaultUnstakeLocked -= log.args.assets
  } else {
    continue
  }
  checkpoints++
}

console.log(
  JSON.stringify(
    {
      toBlock: toBlock.toString(),
      checkpoints,
      vaultUnstakeLocked: vaultUnstakeLocked.toString(),
      vaultUnstakeLockedPha: formatUnits(vaultUnstakeLocked, 18),
    },
    null,
    2,
  ),
)
