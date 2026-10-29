import {expect, test} from 'bun:test'
import {readdir, readFile} from 'node:fs/promises'
import {join} from 'node:path'

const app = join(import.meta.dir, '..')
const output = join(app, '.cloudflare/output/v0/workers/default/assets')

const run = async (args: string[]) => {
  const child = Bun.spawn(['bun', 'x', 'vite', ...args], {
    cwd: app,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0)
    throw new Error(`vite ${args[0]} failed:\n${stdout}\n${stderr}`)
}

test('the build is self-contained and preview routes assets and the API', async () => {
  await run(['build', '--logLevel', 'error'])
  const html = await readFile(join(output, 'index.html'), 'utf8')
  // Every script is an external same-origin module; nothing loads from a CDN.
  expect(html).not.toMatch(/<script(?![^>]*\ssrc="\/)/)
  expect(html).not.toMatch(/(?:src|href)="(?:https?:)?\/\//)
  for (const file of await readdir(join(output, 'assets'))) {
    if (!file.endsWith('.css')) continue
    const css = await readFile(join(output, 'assets', file), 'utf8')
    expect(css).not.toMatch(/url\((?!["']?\/assets\/)/)
  }

  const preview = Bun.spawn(
    ['bun', 'x', 'vite', 'preview', '--port', '0', '--strictPort'],
    {cwd: app, stdout: 'pipe', stderr: 'pipe'},
  )
  try {
    // Vite prints the local URL once workerd serves the build output. Keep
    // draining stdout afterwards: closing the pipe would stop the server.
    let base = ''
    let log = ''
    const reader = preview.stdout.getReader()
    const decoder = new TextDecoder()
    while (!base) {
      const {done, value} = await reader.read()
      if (done) break
      log += decoder.decode(value)
      base = log.match(/http:\/\/localhost:\d+\//)?.[0] ?? ''
    }
    void (async () => {
      while (!(await reader.read()).done);
    })()
    if (!base) throw new Error(`vite preview did not start:\n${log}`)
    const get = (path: string, init?: RequestInit) =>
      fetch(new URL(path, base), {redirect: 'manual', ...init})

    const page = await get('/')
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    const csp = page.headers.get('content-security-policy') ?? ''
    expect(csp).toContain(
      "script-src 'self' https://static.cloudflareinsights.com/beacon.min.js/;",
    )
    expect(csp).toContain("style-src 'self';")
    expect(csp).not.toContain('unsafe-inline')
    expect(await page.text()).toBe(html)
    const head = await get('/', {method: 'HEAD'})
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')

    const script = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1]
    expect(script).toBeDefined()
    const asset = await get(script ?? '')
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toContain('javascript')
    expect((await get('/favicon.svg')).status).toBe(200)

    // API paths always reach the Worker: JSON without the page CSP, whatever
    // the local D1 holds (an empty database answers 503).
    const data = await get('/api/data')
    expect([200, 503]).toContain(data.status)
    expect(data.headers.get('content-type')).toContain('application/json')
    expect(data.headers.get('content-security-policy')).toBeNull()
    expect(await (await get('/api')).text()).toBe('404 Not Found')
    expect((await get('/missing')).status).toBe(404)
    expect((await get('/', {method: 'POST'})).status).toBe(405)
  } finally {
    preview.kill()
    await preview.exited
  }
}, 120_000)
