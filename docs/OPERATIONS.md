# Operations

## Data flow

```text
Ethereum ──> Goldsky phala-ethereum/prod ──> phala-analytics Worker
                                                ├─> /api/circulation (supply trackers)
                                                ├─> /api/all, /api/snapshot
                                                └─> ChainDay / VaultDay / ClaimDay ──┐
Phala Cloud daily stats ───────────────────────────────────────────────────────────┼─> D1 cache ─> dashboard
DefiLlama PHA price ───────────────────────────────────────────────────────────────┘

pha-circulation-server.vercel.app/api/* ──> Vercel external rewrite ──> Worker /api/*
apps claim page ──> phala-ethereum/prod (Khala and Phala claim logs)
```

The Ethereum subgraph owns chain-derived state, midnight snapshots, Vault
accrual and claim events. The circulation API formats its integer wei amounts
as decimal PHA strings; it does not call RPC or reconstruct historical blocks. The
`phala-analytics` Cloudflare Worker refreshes a SQLite cache and serves the
dashboard and JSON APIs. Archived Phala/Khala circulation stays frozen.
Cloud observations include values that cannot be reconstructed later;
weekly `cloud_daily` exports to R2 preserve those observations.

Circulation includes the Portal escrow backing bridged PHA on Base as
circulating on Ethereum. The `portalBridge` component remains available, but
the subgraph no longer subtracts it. `/api/circulation` and `totalCirculation`
use Ethereum `circulation` alone, with the existing 12-decimal plain-number
format. Relative to the former Ethereum-plus-Base total, this adds Portal
escrow minus bridged supply (approximately 50,000 PHA when the definition
changed). Historical snapshots use the same definition. Both JSON endpoints
retain `base: null`; `/api/all` retains `sources.base: null`. There is no
separate bridged-chain indexer or API request. Verify the subgraph uses this
formula before deploying the API.

The circulation API and dashboard run in one Cloudflare Worker. Node.js 24.x
is used only for local tooling and CI, with each package declaring its own
version. The Vercel project `pha-circulation-server` builds from this repository's
`circulation-api/` directory and serves only compatibility rewrites.

Code and component-specific commands:

- [Subgraphs](../subgraph/README.md):
  manifests, mappings, ABI review, builds, deploy commands and parity verifier.
- [Analytics Worker](../app/README.md):
  refresh, cache schema, archive seeding, exports, deployment and secrets.
- [Circulation API contract](CIRCULATION_API.md): endpoint shapes, date convention,
  cache headers and environment variables.

## Consumers

| Consumer                           | Contract                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| External supply trackers           | `https://pha-circulation-server.vercel.app/api/circulation`, a plain decimal with no newline or JSON wrapper. Individual tracker identities are not recorded. |
| Analytics current circulation      | `/api/all`; the Phala/Khala objects are zero.                                                                                                                 |
| Daily API consumers                | `/api/snapshot?date=YYYY-MM-DD`; values at exactly 00:00 UTC, last-observed block metadata.                                                                   |
| `phala-analytics` Worker           | Direct `ChainDay`, `VaultDay`, `ClaimDay` reads; Phala Cloud daily stats and DefiLlama price (CoinGecko-sourced).                                             |
| `analytics.phala.network`          | Dashboard and JSON APIs served by the analytics Worker.                                                                                                       |
| apps claim page                    | `Claimed` (Khala) and `ClaimedAndBridged` (Phala) from `phala-ethereum/prod/gn`; eligibility and transactions use contracts directly.                         |
| Snapshot space `phala-network.eth` | Separate Phala L2 voting-power API described below.                                                                                                           |

## Goldsky deployments and limits

The only deployed subgraph is `phala-ethereum/1.1.0`, with `prod` pointing to
that version. `phala-vault-state`, `khala-claimer` and `phala-claimer` have been
deleted; the Ethereum subgraph now supplies their data.

The project is on Starter; check remaining credits in the dashboard. Starter's
one-time credit is not an ongoing free allowance. Scale's free allowance is
**2,250 worker-hours/month** and about **100,000 stored entities**, team-wide.
Goldsky enforces a hard cap of **three deployed subgraphs, including paused
versions**. Leave room for a temporary upgrade version. Pausing frees worker
time, not a deployment slot or storage.

The Edge RPC endpoint `pha-circulation-api` is unused (0 requests since the API
cutover), but Starter does not allow its deletion. No current consumer uses it.

Count every deployed name/version before a deploy and check stored entities
after sync. Deploy one replacement at a time and delete the superseded
version after verification. Paused subgraphs still serve stale data and can eventually be deleted by Goldsky;
they are not durable archives. Export any irreplaceable comparison data before
deleting a version. These limits also apply during rollback.

## Runbooks

### Subgraph upgrade and tag

1. Review changes to contract ABIs, excluded balances, or accrual formulas.
   For a Vault implementation upgrade, verify the implementation and its
   getters, update the allowlist/formula dispatch, and rebuild. Do not simply
   override `vaultImplementationReviewed`.
2. Check deployment slots, worker-hours and entity budget. Build and deploy
   one replacement version using the subgraph package's commands. Full
   historical mappings need a full sync; a short-range feature test cannot
   validate historical balances.
3. Wait for sync. Query `Latest(id: "current")` and `_meta`: no indexing
   errors, `Latest.timestamp` within 15 minutes, reviewed Vault implementation.
   From `subgraph/`, run the default upgrade verifier while `prod` still points
   to the old version:

   ```bash
   bun run verify --candidate "$CANDIDATE_URL" --output upgrade-results.json
   ```

   It compares all immutable entities and current state at one common block
   (`min(candidate head, prod head) - 64`), with exact ID/field/count equality
   and reviewed Vault implementations. Preserve the report. For intentional
   formula changes, add a narrow `--expect-diff Entity.field,...` list and
   review the printed per-date differences before promotion. Other fields,
   IDs, counts and safety flags must still match. `--production` can select an
   explicit current version URL; changing either deployment during the run
   invalidates verification. No deleted service or circulation API is a
   reference. Historical archive gates are optional.

   `prune: auto` limits old mutable versions and time travel; Goldsky's exact
   retention window is operator-controlled. Run promptly after both versions
   catch up. The verifier probes the common block and fails if it has been
   pruned; wait for sync and restart near both heads. Reduce `--safety-margin`
   only after assessing reorg risk. It never substitutes separate-head reads.
   See the subgraph README for pruning semantics and archive inputs.
4. Move `phala-ethereum/prod` to the verified version. Both the API and apps
   use tag URLs; the Worker tracks `_meta.deployment` and reloads chain-derived
   cache rows after it changes.
5. Run a fresh Workers Build to change the circulation Cache API namespace.
   Existing client responses can persist for 60 seconds (latest) or 3600 seconds
   (snapshots); there is no edge CDN cache.
   Verify plain-number output, `/api/all` totals and sampled daily values
   against `ChainDay`, confirm both JSON endpoints have `base: null`, and
   check the apps claim logs.
6. Delete the superseded version after consumer verification. Keep total
   deployed versions at or below three.

Before deleting the old version, rollback can move `prod` back and run a
fresh Workers Build. After deletion, recovery requires redeploying and
resyncing that version; deleting an indexer is not an instant rollback.

### Dashboard and API deployment

Production deploys automatically through [Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
when a matching change reaches `main` in `Phala-Network/phala-analytics`.
The `main` ruleset requires a PR and the `check`, `app` and `subgraph` checks;
force-pushes and branch deletion are blocked. CI runs the affected package
checks, so only CI-passed merges reach the production build.

Worker **phala-analytics** has these Builds settings:

| Setting           | Value                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| Production branch | `main`                                                                                                     |
| Root directory    | `/app`                                                                                                     |
| Build command     | `bun install --frozen-lockfile`                                                                            |
| Deploy command    | `bunx cf deploy --provision=false`                                                                         |
| Watch paths       | `app/*`, `package.json`, `bun.lock`, `biome.json`                                                          |
| Build environment | `SKIP_DEPENDENCY_INSTALL=1`, `CLOUDFLARE_ACCOUNT_ID` for the production account, `CF_SEND_TELEMETRY=false` |
| Preview builds    | Disabled                                                                                                   |

`cf deploy` builds the Vite dashboard and Worker together. D1, R2, cron and
`analytics.phala.network` remain declared in `app/cloudflare.config.ts`;
existing resources must be present because provisioning is disabled. Build
variables are separate from runtime bindings and the `PHALA_CLOUD_API_KEY`
secret. Subgraph deploys and tag changes remain manual and must pass the
[subgraph upgrade gate](#subgraph-upgrade-and-tag).

After a merge, confirm the Workers Build succeeded, then check `/`,
`/api/health`, `/api/data`, circulation output and browser rendering.
Changes outside the watch paths do not normally deploy the Worker; run a new
build when a subgraph tag change needs a fresh circulation cache namespace.

For recovery, disable automatic builds while investigating if later merges
could overwrite the rollback. From `app/`, promote a known previous Worker
version with the intended Cloudflare profile:

```bash
bunx cf workers deployments create --worker phala-analytics \
  --strategy percentage \
  --versions '[{"version_id":"<previous-version-id>","percentage":100}]'
```

Check that the previous version's bindings and upstream services still exist,
then verify the same endpoints. Disabling builds alone leaves the current
version serving traffic. Fix or revert the source through a PR before
resuming automatic builds. Manual `bunx cf deploy --provision=false` from
`app/` is an emergency fallback only.

### Circulation proxy

The Vercel project `pha-circulation-server` is connected to this repository
with Root Directory `circulation-api`, Framework Preset **Other**, and empty
build/install/output overrides. The directory contains only `vercel.json`;
no function, package manifest, runtime secret or Node runtime is needed.

The sole rewrite is `/api/:path*` →
`https://analytics.phala.network/api/:path*`. Vercel's wildcard also matches
`/api`, and it forwards query strings without changing the browser URL.
Vercel adds platform headers and can consume CDN-specific cache directives;
its own 404 responses for trailing-slash paths can differ from the Worker.
See [Vercel external rewrites](https://vercel.com/docs/rewrites#external-rewrites).

From `app/`, verify proxy fidelity after changes:

```bash
bun scripts/compare-circulation.ts \
  https://analytics.phala.network https://pha-circulation-server.vercel.app
```

The comparator covers all routes, 30 snapshot dates, invalid dates, unknown
routes, HEAD/POST and preflight. Review any proxy-specific differences and
confirm tracker clients receive a plain decimal with no trailing newline.
`no-store` errors must never be cached. Roll back a proxy configuration change
by promoting its previous Vercel deployment; Worker rollback is separate.
Retired functions remain in Git history, not the active source tree.

### API returns 503

Read the configured Ethereum subgraph's `Latest` and `_meta` directly. Confirm
the URL uses the expected `prod` tag, indexing is error-free, the latest
timestamp is within 15 minutes, and `vaultImplementationReviewed` is true. A current
indexing failure or unreviewed implementation also blocks uncached daily
reads. Check Worker logs for the error class and the subgraph for details.

Repair indexing or review the new implementation before moving a tag. The API
does not use RPC or stale fallback data. Invalid or unavailable dates return
400/404 and are not cached. Deploy a previous Worker version only after
checking that its upstream services still exist; versions dependent on
retired squids, RPC or deleted subgraphs cannot restore service.

### Analytics gaps or cache rebuild

Inspect the Worker's refresh errors, upstream availability and last successful
cache checkpoints. Failed requests must not advance a checkpoint. Resume the
refresh after repairing the upstream. Chain-derived rows can be rebuilt from
the Ethereum subgraph; a changed `_meta.deployment` triggers their reload.

Cloud history is not fully recoverable from its upstream API. Preserve
`cloud_daily`, restore it from the latest R2 export when necessary, and verify
the restored row count and latest observation before refreshing. Archived
Phala/Khala circulation and historical Cloud rows come from the preserved
exports, not a fresh chain scan. Follow the Worker README for exact commands.

## Phala L2 voting power

[`l2-indexer`](https://github.com/Phala-Network/l2-indexer) runs in a Phala Cloud
prod7 CVM at
`https://daa34fe16ce7c191bf9e340066866ed2d23e95f6-3000.dstack-pha-prod7.phala.network`.
Snapshot space `phala-network.eth` uses its `api` strategy for the Phala L2 vPHA
token (`0xFdCE…c856`). Goldsky does not support Phala L2, so this remains a
separate service. It is outside the circulation formula and the Ethereum
subgraph. There is no monitoring configured for it.

## Archives and retired services

Dune exports and retired host backups are preserved in the private S3 archive
managed by the Phala operations team. Legacy circulation dumps are also in the
[`legacy-squid-archive-2026-09-23`](https://github.com/Phala-Network/pha-circulation-server/releases/tag/legacy-squid-archive-2026-09-23)
release and were restore-tested. The Dune dashboard is an archive, not the live
analytics data source; the old Grafana service is retired.

All `subsquid.phala.network` squids, including circulation, Sygma, computation,
spore-vault and phat-contract, are retired. The Cloudflare Worker
`subsquid-retired` (maintained in the private scripts-toolbox repository)
returns `410 Gone`; restoring an old consumer does not restore these services.
