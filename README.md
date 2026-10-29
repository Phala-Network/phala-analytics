# Phala analytics

Ethereum indexing, the circulating-supply API, and the dashboard at [analytics.phala.network](https://analytics.phala.network) share one Bun workspace.

[`subgraph/`](subgraph/README.md) contains the `phala-ethereum` Goldsky subgraph: token circulation, Vault balances and rewards, daily snapshots, and Phala/Khala claim events. Its mappings, manifests, ABI files, Matchstick tests, and parity verifier live together.

[`app/`](app/README.md) contains the Cloudflare Worker serving the dashboard, `/api/data`, `/api/health`, and the [circulation API](docs/CIRCULATION_API.md): `/api/circulation`, `/api/all`, and `/api/snapshot`. Its hourly refresh caches indexed chain data and Phala Cloud observations in D1, with weekly Cloud-history backups in R2. Circulation reads use the Ethereum subgraph directly and preserve the supply trackers' plain-number contract.

`circulation-api/vercel.json` is the compatibility proxy configuration for the old `pha-circulation-server.vercel.app` hostname. It contains only external rewrites to the Worker; the Vercel project builds from `circulation-api/`. See [Operations](docs/OPERATIONS.md#circulation-proxy) for verification and rollback.

Use Bun **1.4.2** and Node.js **24.x**. Install once at the repository root; dependency versions are pinned and `bun.lock` is shared. Matchstick 0.6.0 requires `libpq5` (installed on Ubuntu 22.04 in CI).

```bash
bun install --frozen-lockfile
bun run verify
```

Run `bun run verify:subgraph`, `bun run verify:app` or `bun run verify:khala-circulation-api` for one package. CI runs root Biome checks and the affected packages; changes to shared tooling run all packages. Package-specific development and deployment commands run from that package's directory.

Production app deploys automatically through Cloudflare Workers Builds after CI-passed PRs merge to protected `main`; preview builds are disabled. Subgraph deployments remain manual and require the upgrade gate. See [deployment and rollback](docs/OPERATIONS.md#dashboard-and-api-deployment) for the build settings and emergency fallback.

See [docs/OPERATIONS.md](docs/OPERATIONS.md) for consumers, upstream services, upgrade and recovery runbooks, and archives.

## Legacy Khala supply alias

[`legacy/khala-circulation-api/`](legacy/khala-circulation-api/) keeps `https://khala-circulation-api.phala-dev.workers.dev/` for existing callers. Every path and method reads `/api/circulation` with GET through a service binding to `phala-analytics`, preserving its status, body, Content-Type and Cache-Control. Binding failures return an uncached plain-text 503. Deployment is manual, from its directory with the intended Cloudflare profile:

```bash
cd legacy/khala-circulation-api
bunx cf deploy
```

Strict-mode conflicts between local and remote Worker configuration abort the upload, even if the CLI prints "Deploy complete" afterward. Resolve the conflict in `cloudflare.config.ts` and retry; do not pass `--no-strict`. The config preserves the existing 50 ms CPU limit.

Record the preceding Worker version before deploying. To roll back, promote that version from the same directory, then verify the legacy hostname:

```bash
bunx cf workers deployments create --worker khala-circulation-api \
  --strategy percentage \
  --versions '[{"version_id":"<previous-version-id>","percentage":100}]'
```
