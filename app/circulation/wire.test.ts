import {
  afterEach,
  beforeEach,
  expect,
  setSystemTime,
  spyOn,
  test,
} from 'bun:test'
import {Buffer} from 'node:buffer'
import {readFileSync} from 'node:fs'
import {record} from '../data'
import {createCirculationApi} from './index'
import {memoryCache} from './test-cache'

interface Fixture {
  path: string
  status: number
  contentType: string | null
  cacheControl: string | null
  cors: string | null
  body: string
}
const fixture: {recordedAt: string; responses: Fixture[]} = JSON.parse(
  readFileSync(`${import.meta.dir}/fixtures/worker-production.json`, 'utf8'),
)
const all = fixture.responses.find((row) => row.path === '/api/all')
if (!all) throw new Error('Missing current production /api/all fixture')
const current = record(JSON.parse(all.body))
const toWei = (value: unknown) => {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d{1,18})?$/.test(value))
    throw new Error('Invalid fixture amount')
  const negative = value.startsWith('-')
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.')
  return `${negative ? '-' : ''}${BigInt(`${whole}${fraction.padEnd(18, '0')}`)}`
}
const state = (body: Record<string, unknown>, date?: string) => {
  const amounts = record(body.ethereum)
  return {
    ...Object.fromEntries(
      Object.entries(amounts)
        .filter(([key]) => key !== 'timestamp' && key !== 'blockNumber')
        .map(([key, value]) => [key, toWei(value)]),
    ),
    chain: 'ethereum',
    vaultImplementationReviewed: true,
    timestamp: String(
      Date.parse(date ? `${date}T00:00:00Z` : String(amounts.timestamp)) / 1000,
    ),
    observedBlockNumber: String(
      amounts.blockNumber ?? record(record(body.sources).ethereum).blockNumber,
    ),
    observedBlockTimestamp: String(
      Date.parse(String(amounts.timestamp)) / 1000,
    ),
    khalaLegacyChainBridge: '0',
  }
}
let app = createCirculationApi(memoryCache(), 'fixture')
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>
beforeEach(() => {
  setSystemTime(new Date(fixture.recordedAt))
  app = createCirculationApi(memoryCache(), 'fixture')
  const implementation = async (
    _input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    if (typeof init?.body !== 'string') throw new Error('Missing GraphQL body')
    const payload = record(JSON.parse(init.body))
    const variables = payload.variables == null ? {} : record(payload.variables)
    const date = variables.date
    const reference = fixture.responses.find(
      (row) => row.path === `/api/snapshot?date=${date}` && row.status === 200,
    )
    if (!reference) throw new Error('Unexpected upstream call')
    return Response.json({
      data: {
        latest: state(current),
        chainDay: state(record(JSON.parse(reference.body)), String(date)),
        _meta: {hasIndexingErrors: false, block: {number: 100_000_000}},
      },
    })
  }
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(implementation, {preconnect: fetch.preconnect}),
  )
})
afterEach(() => {
  fetchSpy.mockRestore()
  setSystemTime()
})

test.each(
  fixture.responses.filter(
    (row) => row.path !== '/api/all' && row.path !== '/api/circulation',
  ),
)('current Vercel wire bytes: $path', async (reference) => {
  const response = await app.request(reference.path, undefined, {
    GOLDSKY_ETHEREUM_URL: 'https://ethereum.test',
  })
  expect(response.status).toBe(reference.status)
  expect(response.headers.get('content-type')).toBe(reference.contentType)
  expect(response.headers.get('cache-control')).toBe(reference.cacheControl)
  expect(response.headers.get('access-control-allow-origin')).toBe(
    reference.cors,
  )
  expect(
    Buffer.from(await response.arrayBuffer()).equals(
      Buffer.from(reference.body),
    ),
  ).toBe(true)
  expect(fetchSpy).toHaveBeenCalledTimes(reference.status === 200 ? 1 : 0)
})
