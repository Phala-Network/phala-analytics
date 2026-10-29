import {afterEach, expect, setSystemTime, test} from 'bun:test'
import {createCached} from './cache'
import {memoryCache} from './test-cache'

afterEach(() => setSystemTime())

test('shares concurrent and cached results, expires at TTL, and isolates releases', async () => {
  const store = memoryCache()
  const cached = createCached(store, 'v1')
  let calls = 0
  const compute = async () => {
    calls++
    await Bun.sleep(10)
    return {value: calls}
  }
  const now = Date.now()
  setSystemTime(now)
  expect(
    await Promise.all([
      cached('latest', 60, compute),
      cached('latest', 60, compute),
    ]),
  ).toEqual([{value: 1}, {value: 1}])
  expect(await createCached(store, 'v1')('latest', 60, compute)).toEqual({
    value: 1,
  })
  setSystemTime(now + 60_000)
  expect(await cached('latest', 60, compute)).toEqual({value: 2})
  expect(await createCached(store, 'v2')('latest', 60, compute)).toEqual({
    value: 3,
  })
})

test('does not cache failures and recovers from storage failures', async () => {
  const cached = createCached(memoryCache(), 'test')
  let calls = 0
  const compute = async () => {
    if (++calls === 1) throw new Error('upstream down')
    return 'ok'
  }
  await expect(cached('failing', 60, compute)).rejects.toThrow('upstream down')
  expect(await cached('failing', 60, compute)).toBe('ok')
  const unavailable = createCached(
    {
      match: async () => {
        throw new Error('offline')
      },
      put: async () => {
        throw new Error('offline')
      },
    },
    'test',
  )
  expect(await unavailable('latest', 60, compute)).toBe('ok')
})

test('only stores healthy results and expires them after the short monitoring TTL', async () => {
  const cached = createCached(memoryCache(), 'health')
  const now = Date.now()
  setSystemTime(now)
  let calls = 0
  let ok = false
  const load = () =>
    cached(
      'health',
      30,
      async () => ({ok, calls: ++calls}),
      ({ok}) => ok,
    )
  expect(await load()).toEqual({ok: false, calls: 1})
  expect(await load()).toEqual({ok: false, calls: 2})
  ok = true
  expect(await load()).toEqual({ok: true, calls: 3})
  expect(await load()).toEqual({ok: true, calls: 3})
  setSystemTime(now + 30_000)
  ok = false
  expect(await load()).toEqual({ok: false, calls: 4})
  expect(await load()).toEqual({ok: false, calls: 5})
})
