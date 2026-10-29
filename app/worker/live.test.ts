import {expect, test} from 'bun:test'
import type {GraphRequest} from './circulation/subgraph'
import {LIVE_TIMEOUT_MS, readLive} from './live'

const config = {ethereumUrl: 'https://ethereum.test/gn'}
const token = (amount: number) => String(BigInt(amount) * 10n ** 18n)
const now = Math.floor(Date.now() / 1000)
const data = (latest: Record<string, unknown> = {}) => ({
  _meta: {hasIndexingErrors: false, block: {number: 100}},
  latest: {
    chain: 'ethereum',
    timestamp: String(now - 10),
    observedBlockNumber: '100',
    observedBlockTimestamp: String(now - 10),
    vaultImplementationReviewed: true,
    totalSupply: token(1_000_000_000),
    reward: '0',
    sunsetReward: '0',
    phalaChainBridge: '0',
    khalaLegacyChainBridge: '0',
    khalaChainBridge: '0',
    sygmaBridge: '0',
    portalBridge: '0',
    vaultReward: token(-1),
    vaultUnstakeLocked: '0',
    circulation: '858640825508430344761489765',
    vaultTotalAssets: token(120),
    sharePrice: '1.3154',
    apr: '0.1236',
    stakers: '618',
    ...latest,
  },
  chainState: {
    khalaClaimCount: '2',
    phalaClaimCount: '1',
    khalaFree: token(4),
    khalaStaked: token(1),
    phalaFree: '0',
    phalaStaked: token(3),
  },
})
const respond =
  (body: unknown, status = 200): GraphRequest =>
  async () =>
    Response.json(body, {status})

test('reads live Latest figures and the current day claim counters', async () => {
  let query = ''
  const live = await readLive(config, async (_url, init) => {
    query = String(init?.body)
    return Response.json({data: data()})
  })
  expect(query).toContain('chainState(id: \\"current\\")')
  expect(live).toEqual({
    timestamp: new Date((now - 10) * 1000).toISOString(),
    blockNumber: 100,
    circulation: 858640825.5084304,
    vaultTotalAssets: 120,
    sharePrice: 1.3154,
    apr: 0.1236,
    stakers: 618,
    claims: {
      flowDate: new Date((now - 10) * 1000).toISOString().slice(0, 10),
      khalaClaimCount: 2,
      khalaFree: 4,
      khalaStaked: 1,
      phalaClaimCount: 1,
      phalaFree: 0,
      phalaStaked: 3,
    },
  })
})

test('rejects stale, unreviewed, erroring and malformed subgraph reads', async () => {
  const stale = String(now - 15 * 60 - 1)
  const missingClaims = {...data(), chainState: null}
  for (const request of [
    respond({data: data({timestamp: stale, observedBlockTimestamp: stale})}),
    respond({data: data({vaultImplementationReviewed: false})}),
    respond({
      data: {...data(), _meta: {hasIndexingErrors: true, block: {number: 1}}},
    }),
    respond({errors: [{message: 'down'}]}),
    respond({}, 503),
    respond({data: missingClaims}),
    respond({data: data({stakers: '1.5'})}),
    async () => {
      throw new Error('https://secret.test/key')
    },
  ])
    await expect(readLive(config, request)).rejects.toThrow()
})

test('gives up after its own short timeout', async () => {
  expect(LIVE_TIMEOUT_MS).toBe(2000)
  const started = Date.now()
  await expect(
    readLive(
      config,
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason),
          ),
        ),
    ),
  ).rejects.toThrow('Subgraph request failed')
  const elapsed = Date.now() - started
  expect(elapsed).toBeGreaterThanOrEqual(LIVE_TIMEOUT_MS - 50)
  expect(elapsed).toBeLessThan(LIVE_TIMEOUT_MS + 1000)
})
