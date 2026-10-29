import {expect, test} from 'bun:test'
import {mkdtemp, rm} from 'node:fs/promises'
import {join} from 'node:path'

test('analytics runs in real workerd with migrated local D1 and isolated upstreams', async () => {
  const worker = await Bun.build({
    entrypoints: [`${import.meta.dir}/index.ts`],
    target: 'browser',
  })
  const runner = await Bun.build({
    entrypoints: [`${import.meta.dir}/runtime-check.ts`],
    target: 'node',
    plugins: [
      {
        name: 'external-miniflare',
        setup(build) {
          build.onResolve({filter: /^miniflare$/}, () => ({
            path: import.meta.resolve('miniflare'),
            external: true,
          }))
        },
      },
    ],
  })
  if (!worker.success || !runner.success)
    throw new AggregateError(
      [...worker.logs, ...runner.logs],
      'Runtime test build failed',
    )
  const [workerOutput] = worker.outputs
  const [runnerOutput] = runner.outputs
  if (!workerOutput || !runnerOutput)
    throw new Error('Runtime test bundle missing')
  const directory = await mkdtemp(join(import.meta.dir, 'runtime-'))
  try {
    const runnerPath = join(directory, 'runner.mjs')
    await Bun.write(runnerPath, await runnerOutput.text())
    const schemaPath = join(import.meta.dir, '../migrations/0001_init.sql')
    const child = Bun.spawn(['node', runnerPath, schemaPath], {
      cwd: import.meta.dir,
      stdin: new Blob([await workerOutput.text()]),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timeout = setTimeout(() => child.kill(), 50_000)
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (exitCode !== 0)
        throw new Error(`workerd check failed:\n${stdout}\n${stderr}`)
      expect(stdout).toContain(
        'workerd: incremental fills, price paging and missing days, idempotency, deployment reloads, rollback, HTTP failures, review flags, live fallback and cache, R2 export and endpoints verified',
      )
      expect(`${stdout}\n${stderr}`).toContain(
        'Analytics sync failed: price: PHA price: HTTP 429',
      )
    } finally {
      clearTimeout(timeout)
      if (child.exitCode === null) child.kill()
      await child.exited
    }
  } finally {
    await rm(directory, {recursive: true, force: true})
  }
}, 60_000)
