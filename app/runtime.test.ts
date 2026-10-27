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
    external: ['miniflare'],
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
  const directory = await mkdtemp(join(import.meta.dir, '.runtime-test-'))
  try {
    const runnerPath = join(directory, 'runner.mjs')
    await Bun.write(runnerPath, await runnerOutput.text())
    const child = Bun.spawn(['node', runnerPath], {
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
        'workerd: all streams, idempotency, range halving, rollback, HTTP failures and endpoints verified',
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
