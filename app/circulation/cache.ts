// Store computed JSON, separately from public responses: the historical data
// TTL is 30 days while its public max-age is one hour. Cache API entries are
// local to each Cloudflare location and are discarded across Worker versions.
export const createCached = (
  cache: Pick<Cache, 'match' | 'put'>,
  namespace: string,
) => {
  const inflight = new Map<string, Promise<unknown>>()
  return <T>(
    key: string,
    ttlSeconds: number,
    compute: () => Promise<T>,
  ): Promise<T> => {
    // A cancelled originating request can give concurrent waiters an uncached 503.
    const pending = inflight.get(key)
    if (pending) return pending as Promise<T>
    const request = new Request(
      `https://analytics.phala.network/__circulation-cache/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`,
    )
    const promise = (async () => {
      try {
        const hit = await cache.match(request)
        if (hit) return (await hit.json()) as T
      } catch {
        // A cache outage or malformed entry must not make the API unavailable.
      }
      const value = await compute()
      try {
        await cache.put(
          request,
          Response.json(value, {
            headers: {'Cache-Control': `public, max-age=${ttlSeconds}`},
          }),
        )
      } catch {
        // Cache errors can contain provider details; never log their contents.
        console.error('Circulation cache write failed')
      }
      return value
    })().finally(() => inflight.delete(key))
    inflight.set(key, promise)
    return promise
  }
}
