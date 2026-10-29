import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "khala-circulation-api",
    entrypoint: "./worker/index.ts",
    compatibilityDate: "2026-10-23",
    workersDev: true,
    env: {
      ANALYTICS: bindings.worker({ worker: "phala-analytics" }),
    },
  },
});
