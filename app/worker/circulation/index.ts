import {Hono} from 'hono'
import {cors} from 'hono/cors'
import {createCached} from './cache.js'
import {getAllData} from './circulation.js'
import {ConfigError, readConfig} from './config.js'
import {getSnapshot, parseSnapshotDate, SnapshotDateError} from './snapshot.js'
import {SubgraphError} from './subgraph.js'

// Worker Cache API entries are scoped by version; concurrent misses share work.
// Client max-age is 60s for latest and 3600s for snapshots; no edge CDN cache is used.
const LATEST_TTL_SECONDS = 60
const LATEST_CACHE_CONTROL = 'public, max-age=60'
// ChainDay snapshots are immutable within a subgraph deployment.
const SNAPSHOT_TTL_SECONDS = 30 * 24 * 60 * 60
const SNAPSHOT_CACHE_CONTROL = 'public, max-age=3600'

// Only controlled application errors have safe messages; provider and
// persistence errors can include credentials, so log their class alone.
export const describeError = (error: unknown) => {
  if (error instanceof SubgraphError || error instanceof ConfigError) {
    return `${error.name}: ${error.message}`
  }
  return error instanceof Error ? error.name : 'Unknown error'
}

export type CirculationEnv = {
  GOLDSKY_ETHEREUM_URL: string
  UPSTREAM_TIMEOUT_MS?: string
}

export const createCirculationApi = (
  cache: Pick<Cache, 'match' | 'put'>,
  namespace: string,
) => {
  const cached = createCached(cache, namespace)
  const loadLatest = async (env: CirculationEnv) => {
    try {
      return await cached('latest', LATEST_TTL_SECONDS, () =>
        getAllData(readConfig(env)),
      )
    } catch (error) {
      console.error(`Circulation unavailable - ${describeError(error)}`)
      return null
    }
  }

  const app = new Hono<{Bindings: CirculationEnv}>()
    .basePath('/api')
    .use('*', async (c, next) => {
      // Vercel supplies this default for preflights and unknown paths.
      await next()
      if (!c.res.headers.has('Cache-Control'))
        c.res.headers.set('Cache-Control', 'public, max-age=0, must-revalidate')
    })
    .use('*', cors())

  app.get('/circulation', async (c) => {
    const data = await loadLatest(c.env)
    if (data == null) {
      c.header('Cache-Control', 'no-store')
      return c.text('Service Unavailable', 503)
    }
    c.header('Cache-Control', LATEST_CACHE_CONTROL)
    return c.text(data.totalCirculation)
  })

  app.get('/all', async (c) => {
    const data = await loadLatest(c.env)
    if (data == null) {
      c.header('Cache-Control', 'no-store')
      return c.json({error: 'circulation_unavailable'}, 503)
    }
    c.header('Cache-Control', LATEST_CACHE_CONTROL)
    return c.json(data)
  })

  // Daily snapshot evaluated at exactly 00:00 UTC by the subgraph.
  app.get('/snapshot', async (c) => {
    try {
      const date = c.req.query('date') ?? ''
      const target = parseSnapshotDate(date)
      const data = await cached(`snapshot:${date}`, SNAPSHOT_TTL_SECONDS, () =>
        getSnapshot(readConfig(c.env), target),
      )
      c.header('Cache-Control', SNAPSHOT_CACHE_CONTROL)
      return c.json(data)
    } catch (error) {
      c.header('Cache-Control', 'no-store')
      if (error instanceof SnapshotDateError) {
        return c.json(
          {
            error: error.status === 400 ? 'invalid_date' : 'not_available',
            message: error.message,
          },
          error.status,
        )
      }
      console.error(`Snapshot unavailable - ${describeError(error)}`)
      return c.json({error: 'snapshot_unavailable'}, 503)
    }
  })

  return app
}
