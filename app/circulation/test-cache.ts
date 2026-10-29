// Minimal Cache API store with expiry for unit tests; workerd covers the real API.
export const memoryCache = () => {
  const entries = new Map<string, {response: Response; expires: number}>()
  return {
    clear: () => entries.clear(),
    match: async (request: RequestInfo | URL) => {
      const key = request instanceof Request ? request.url : String(request)
      const entry = entries.get(key)
      if (!entry || entry.expires <= Date.now()) return undefined
      return entry.response.clone()
    },
    put: async (request: RequestInfo | URL, response: Response) => {
      const key = request instanceof Request ? request.url : String(request)
      const seconds = Number(
        response.headers.get('cache-control')?.match(/max-age=(\d+)/)?.[1],
      )
      entries.set(key, {
        response: response.clone(),
        expires: Date.now() + seconds * 1000,
      })
    },
  }
}
