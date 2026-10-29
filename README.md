# Phala analytics

Ethereum indexing, the circulating-supply API, and the dashboard at [analytics.phala.network](https://analytics.phala.network) share one Bun workspace.

[`subgraph/`](subgraph/README.md) contains the `phala-ethereum` Goldsky subgraph: token circulation, Vault balances and rewards, daily snapshots, and Phala/Khala claim events. Its mappings, manifests, ABI files, Matchstick tests, and parity verifier live together.

[`app/`](app/README.md) contains the Cloudflare Worker serving the dashboard, `/api/data`, `/api/health`, and the [circulation API](docs/CIRCULATION_API.md): `/api/circulation`, `/api/all`, and `/api/snapshot`. Its hourly refresh caches indexed chain data and Phala Cloud observations in D1, with weekly Cloud-history backups in R2. Circulation reads use the Ethereum subgraph directly and preserve the supply trackers' plain-number contract.

`circulation-api/vercel.json` is the compatibility proxy configuration for the old `pha-circulation-server.vercel.app` hostname. It contains only external rewrites to the Worker; deployment and rollback are in [Operations](docs/OPERATIONS.md#circulation-api-cutover).

Use Bun **1.4.2** and Node.js **24.x**. Install once at the repository root; dependency versions are pinned and `bun.lock` is shared. Matchstick 0.6.0 requires `libpq5` (installed on Ubuntu 22.04 in CI).

```bash
bun install --frozen-lockfile
bun run verify
```

Run `bun run verify:subgraph` or `bun run verify:app` for one package. CI runs root Biome checks and the affected packages; changes to shared tooling run both packages. Package-specific development and deployment commands run from that package's directory.

See [docs/OPERATIONS.md](docs/OPERATIONS.md) for consumers, upstream services, upgrade and recovery runbooks, and archives.
