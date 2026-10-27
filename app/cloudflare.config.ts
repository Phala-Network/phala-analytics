import {bindings, defineConfig, triggers} from 'cf/config'

export default defineConfig(({mode}) => ({
  worker: {
    name: 'phala-analytics',
    entrypoint: './index.ts',
    compatibilityDate: '2026-10-23',
    workersDev: false,
    observability: {enabled: true},
    env: {
      DB: bindings.d1({
        id: '78cb6688-bd76-4cee-8226-4c1c64ee91dc',
        dev: mode === 'manual' ? {remote: true} : undefined,
      }),
      PHALA_CLOUD_API_KEY: bindings.secret(),
      ETHEREUM_RPC_URL: bindings.secret(),
      CIRCULATION_API_URL: bindings.text(
        'https://pha-circulation-server.vercel.app',
      ),
    },
    triggers: [triggers.scheduled({schedule: '17 * * * *'})],
  },
}))
