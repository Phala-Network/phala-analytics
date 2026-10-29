# Analytics Worker

This package serves the public Phala analytics dashboard and a
JSON API from one Worker: `worker/` holds the API and hourly sync, `src/` the
dashboard. Goldsky's `phala-ethereum/prod` subgraph provides chain history; D1
is a rebuildable cache of its immutable daily entities.
Historical Substrate Phala/Khala circulation comes from a frozen archive.
Phala Cloud statistics are captured daily and backed up weekly to R2.
See the [operations guide](../docs/OPERATIONS.md) for the wider stack and the
[subgraph schema](../subgraph/schema.graphql) for source definitions.

From `app/`, run `bun run build` and `bunx cf deploy --dry-run`
to verify its bundle.

### Refresh and storage

Cron `17 * * * *` runs at 17 minutes past each hour. Streams run sequentially;
failures are reported independently and fail the invocation. Successful writes
remain retryable. Do not overlap manual invocations with cron.

- The Ethereum subgraph supplies `ChainDay`, `VaultDay` and `ClaimDay`.
  Every invocation starts at `date_gt: MAX(date)` and fetches
  1,000-row pages with `orderBy: date` and ascending order. It advances to the
  last returned date until a page has fewer than 1,000 rows, completing the
  available history in one run. Parameterized multi-row inserts stay below
  D1's 100-parameter limit.
- The subgraph's `_meta.deployment` is persisted. A changed deployment clears
  cached Ethereum circulation, Vault and claim rows.
  The reset, deployment marker and first validated page are one transaction;
  each following page is also atomic. Legacy and Cloud rows are preserved.
- Cloud appends consecutive missing days through yesterday in UTC, requesting
  at most 90 days with a 90-second timeout. Missing or invalid days fail the
  whole window. Seed the archive before refresh: the rolling API cannot
  recover all Cloud history. Existing rows are never overwritten.
- DefiLlama's keyless coins API supplies CoinGecko-sourced hourly USD prices,
  requested in pages of at most 500 hours and averaged by UTC day for Cloud
  rows with null `captured`. Missing days fail the price stream before any
  price updates. Annual revenue in PHA is `total_vcpu * 12 * 50 / price`.
  Existing captured values are preserved.

Outbound requests include a descriptive User-Agent to identify the Worker.
Requests reject redirects and non-2xx responses. GraphQL errors, indexing
errors, malformed or unordered rows, and mismatched deployments fail the
Ethereum stream without advancing the affected page. Unknown Vault
implementations remain visible with `vaultImplementationReviewed: false` and
`accrualMode: "checkpoint-only"`; their values are retained as supplied by the
indexer, and health reports 503.

Cloud archive rows through September 22, 2026 retain the original values,
including captured PHA. New rows use `source='api'` for the just-closed day and
`source='api-backfill'` for older missing days. The Cloud API recomputes past
days from each VM's and user's current status, so those days understate running
VMs and users. The API marks them `backfilled: true`; the page draws them like
any other day.
`running_vcpu` and `active_users` are captured when available; archive rows
have null values for both.

On the first successful backup attempt each Sunday UTC (Saturday evening
Pacific), the hourly invocation writes the complete `cloud_daily` table to
`BACKUP`, the `phala-analytics-backup` R2 bucket, at
`cloud-daily/YYYY-MM-DD.json`. The JSON contains `{exportedAt, rows}`; rows use
the database column names and include prices, captured amounts and source.
Only a completed R2 write advances the backup marker. Retries on the same
Sunday skip an already completed export. Cloud is the only ongoing dataset
that cannot be fully rebuilt from the subgraph or archives.

### JSON API

Only GET and HEAD are accepted (405 otherwise); unknown paths return 404.
`/api/data` uses `Cache-Control: public, max-age=60`. Its complete successful
payload (D1 rows, live data and projection) is cached for 60 seconds with the
version-scoped Workers Cache API. Hits avoid both D1 and live subgraph reads;
concurrent misses within an isolate share one computation. A successful daily-only
fallback (`live: null`) is also cached for 60 seconds. Exceptions and 503s are
never cached.
`/api/data` returns numeric quantities in **PHA**, not wei, with rows in
ascending UTC date order:

```text
{
  generatedAt,
  realtime: { totalCirculation, timestamp },
  live: {
    timestamp, blockNumber, circulation, vaultTotalAssets, sharePrice, apr, stakers,
    claims: { flowDate, khalaClaimCount, khalaFree, khalaStaked, phalaClaimCount, phalaFree, phalaStaked }
  } | null,
  subgraphs: {
    ethereum: { deployment, timestamp, vaultImplementation, vaultImplementationReviewed, accrualMode } | null
  },
  circulation: [{ date, ethereum, phala, khala, total }],
  chainCirculation: [{ date, chain, ...circulationComponents, ...implementationStatus }],
  vault: [{ date, flowDate, ...vaultMetrics, ...implementationStatus }],
  claims: [{ date, flowDate, khalaClaimCount, khalaFree, khalaStaked, phalaClaimCount, phalaFree, phalaStaked }],
  cloud: [{ date, totalUsers, totalVms, runningVms, totalVcpu, runningVcpu, activeUsers, captured, backfilled }],
  projection: { method: "trend" | "trend-claims-only", generatedAt, points: [{ date, total }] }
}
```

| Field group             | Exact fields                                                                                                                                                                                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `circulationComponents` | `totalSupply`, `reward`, `sunsetReward`, `phalaChainBridge`, `khalaLegacyChainBridge`, `khalaChainBridge`, `sygmaBridge`, `portalBridge`, `vaultBalance`, `vaultTotalAssets`, `vaultTreasuryAssets`, `vaultUnstakeLocked`, `vaultReward`, `circulation`                                                                                                |
| `implementationStatus`  | `vaultImplementation`, `vaultImplementationReviewed`, `accrualMode`                                                                                                                                                                                                                                                                                    |
| `vaultMetrics`          | `totalAssets`, `treasuryAssets`, `shareSupply`, `sharePrice`, `apr`, `stakers`, `unstakeLocked`, `rewardRate`, `treasuryRatio`, `paused`, `dailyRewards`, `dailyTreasuryRewards`, `settlementTotalAssets`, `deposits`, `withdrawRequests`, `claims`, `treasuryClaims`, `depositCount`, `withdrawRequestCount`, `claimCount`, `treasurySettlementCount` |

`chain` is `ethereum`. Circulation values are nullable where that chain has no
archived/indexed day; `total` sums Ethereum and available legacy Phala/Khala
values. Base PHA is counted through the Ethereum Portal escrow, which is no
longer subtracted from Ethereum circulation; there is no separate Base series.
The frozen Phala/Khala archive ends after sunset and is not carried forward.
`circulation` and `chainCirculation` start on 2020-09-01
(`CIRCULATION_SERIES_START` in `worker/data.ts`). Through 2020-08-31 the formula
reports the full 1B minted supply as circulating; those rows stay in D1 but are
not served.
`vaultReward` can be negative. `vaultImplementationReviewed` is a boolean.

`ChainDay` and Vault state metrics are evaluated exactly at midnight on
`date`. Vault and claim **flows** belong to the preceding `flowDate`:
`dailyRewards`, `dailyTreasuryRewards`, deposits, withdrawals, claims and their
counts. `settlementTotalAssets` is the last settlement's assets in `flowDate`,
or null without a settlement.
`totalAssets` means accrued midnight assets. Quiet days are included.
`apr` is an annual fraction (0.05 means 5%); `sharePrice` is PHA per share,
`rewardRate` is PHA/second and `treasuryRatio` is basis points. Claim counts and
PHA amounts are daily flows, not cumulative totals.

`live` is read from the subgraph's `Latest` and `ChainState` entities in one
query on each request, alongside the D1 reads, with a 2-second timeout, and cached with the circulation
API's Cache API helper for 60 seconds under the Worker version. It uses the
circulation API's checks: no indexing errors, a reviewed Vault implementation
and `Latest` at most 15 minutes old. Any failure is logged without upstream
details, is not cached, and serves `live: null` with the daily rows.
`live.circulation` equals `/api/circulation`; `live.claims` holds the claims
so far on `flowDate`, the UTC date of `live.timestamp`. `realtime` repeats the
live circulation and timestamp, or falls back to the latest daily `total` at
its midnight.

`projection` extends circulation 12 months past the latest daily row, one point
per day starting with that row's `total`. Sunset claims continue at the average
daily amount over the trailing 90 claim flow days, capped at the latest
`sunsetReward` (the unclaimed pool), and the Vault reward reserve
(`vaultReward`, floored at 0) is paid out at the latest `rewardRate` until
exhausted; no top-ups are assumed. While the latest Vault row is unreviewed,
the Vault component is omitted and `method` is `trend-claims-only`. It is never
mixed into `circulation`.

Cloud's `runningVcpu`, `activeUsers`, and unpriced `captured` can be null.
A D1 error, or no served Ethereum daily row, returns a generic 503.
`/api/health` is uncached and returns
`{ok, generatedAt, ethereum, vault, claims, cloud, vaultImplementationReviewed}`,
where stream values are the latest cached dates. It returns 503 if Ethereum's
daily cache or source timestamp is more than two UTC dates behind,
Vault/Cloud is more than three dates behind, or a current implementation is
unreviewed. `claims` is informational and is not freshness-checked. This
endpoint reports cache freshness, not chain parity. Healthy payloads are cached
internally for 30 seconds; unhealthy payloads and exceptions are never stored.
Its client `Cache-Control: no-store` remains unchanged. Direct monitoring can
therefore lag a new failure by up to 30 seconds; the Vercel proxy can add another
30 seconds. Use the direct Worker endpoint for monitoring.

| Route                                                  | Workers cache                        | Vercel rewrite CDN | Browser Cache-Control                         |
| ------------------------------------------------------ | ------------------------------------ | ------------------ | --------------------------------------------- |
| `/`, `/index.html`                                     | Static Assets, managed by Cloudflare | Not rewritten      | `public, max-age=60`                          |
| `/assets/*` (Vite content hashes)                      | Static Assets, managed by Cloudflare | Not rewritten      | `public, max-age=31536000, immutable`         |
| `/favicon.svg`                                         | Static Assets, managed by Cloudflare | Not rewritten      | Default: `public, max-age=0, must-revalidate` |
| `/api/data`                                            | Complete JSON: 60 s; live read: 60 s | 60 s               | `public, max-age=60`                          |
| `/api/health` (200)                                    | Complete JSON: 30 s                  | 30 s               | `no-store`                                    |
| `/api/circulation`, `/api/all`                         | Shared latest JSON: 60 s             | 60 s               | `public, max-age=60`                          |
| `/api/snapshot?date=YYYY-MM-DD`                        | Per-date JSON: 30 days               | 3600 s             | `public, max-age=3600`                        |
| Errors, unknown routes, unsupported methods, preflight | Not stored                           | No positive TTL    | Existing error/method headers                 |

Successful API responses set `Vercel-CDN-Cache-Control: max-age=<TTL>` so the
external rewrite can cache them without changing client `Cache-Control`.
Vercel consumes and strips this targeted header; direct Worker clients can see
it. Projects created before April 6, 2026 need rewrite-caching opt-in in Vercel.
Cache API entries are local to each Cloudflare location, may be evicted, and
are isolated by Worker version. Concurrent isolates and cache outages can
still repeat work. Independent browser, Cache API and Vercel TTLs can add;
there is no stale-while-revalidate or stale-on-error policy.
See the [operations cache audit](../docs/OPERATIONS.md#caching-and-request-cost)
for upstream costs and rollout verification.

### Dashboard

`src/` is a React single-page app built with Vite and `@cloudflare/vite-plugin`
and served by the same Worker as Workers Static Assets. `cloudflare.config.ts`
sends `/api` and `/api/*` to the Worker first; other paths are static assets,
and paths without a file fall through to the Worker's 404.

The page follows the shadcn/ui `dashboard-01` block (section cards and the
area-chart card; its sidebar and drag-and-drop table are not used) with
shadcn/ui charts (Recharts) and the official blue chart palette. `src/components/ui` is
generated by `shadcn add` from `components.json`; re-add components rather than
editing them. Light and dark follow the system preference through the
template's `ThemeProvider`. Recharts loads as a separate chunk, so figures and
skeletons render first. Every chart has a data table.

Dates are UTC days and numbers use `Intl`. Circulation is stacked by chain.
Vault rewards are summed per ISO week (Monday to Sunday UTC) of their
`flowDate` and drawn as bars. The latest week appears once its Sunday has a
row; the first week may be partial because Vault history starts midweek.
The data table lists each day, including the current week.
Circulating supply, Vault total assets, APR, stakers and the claim totals use
`live` when present, labeled with its UTC time; otherwise they show the latest
daily rows. Live same-day claims are added to the daily totals only when the
latest `claims` row's `date` equals `live.claims.flowDate`, so no day is skipped
or counted twice around midnight. Charts and Phala Cloud stay daily. The
circulation chart draws `projection` as a dashed line with a legend entry and a
one-sentence description of the model; its data table lists actual days only.
Sunset claims are shown as totals. APR is hidden while the latest Vault row is
unreviewed.

All assets, including the Geist font, are bundled; nothing loads from a CDN.
`public/_headers` sets immutable caching for Vite's hashed `/assets/*` files,
60-second caching for HTML, and the CSP on static assets (Worker responses are
unaffected). Other files keep the Workers Static Assets revalidation default.
The CSP allows same-origin scripts, styles, fonts and requests plus the
Cloudflare Web Analytics beacon that the zone injects
(`static.cloudflareinsights.com/beacon.min.js/`; it reports to same-origin
`/cdn-cgi/rum`), and no inline scripts or styles. The zone's Google tag gateway
also injects two inline Google Tag Manager snippets; the CSP intentionally
blocks them, so the browser console reports two CSP errors. Google tag gateway
applies zone-wide and cannot be disabled per subdomain. Two template defaults
would create `<style>` elements that the CSP blocks, so chart colors are set as
`--color-*` properties on the chart container instead of `ChartConfig` colors,
and `ThemeProvider` runs with `disableTransitionOnChange={false}`.

`bun run dev` (`cf dev`) serves the page with hot reload; `_headers` and the
CSP apply only to the build. `worker/assets.test.ts` builds the app and checks
routing, headers and self-hosting through `vite preview`. Local D1 starts
empty: apply `migrations/0001_init.sql` and load rows through the dev server's
local explorer, `POST /cdn-cgi/local/explorer/api/d1/database/<id>/raw` with
`{"sql": ...}` or `{"batch": [{"sql", "params"}]}` (string parameters).

### Seed, verify and deploy

From `app/`, generate parameterized seed batches:

```bash
bun scripts/seed.ts /path/to/snapshots.ndjson /path/to/results.json /tmp/phala-analytics-seed
```

The generator imports only Phala/Khala circulation from the NDJSON archive
and dated Cloud rows from the archived `4614059` export (663 rows). Ethereum, Vault
and claim history come entirely from the subgraph. It rejects conflicting
legacy dates, duplicate Cloud dates and Cloud rows beyond September 22, 2026.
Batches contain at most 100 parameters per statement and output files are
never overwritten. Keep archives, API dumps, batches and credentials out of git.

Apply `migrations/0001_init.sql` to D1
`78cb6688-bd76-4cee-8226-4c1c64ee91dc` and import every seed batch with
`cf d1 query ... --batch @/path/to/batch.json` before enabling refresh. For
local commands, pass `--local --persist-to <directory>`; omitting `--local`
targets the real database. The existing database and the R2 bucket must be
present before deployment with `--provision=false`.

Load `PHALA_CLOUD_API_KEY` from the secret store. The public Goldsky `/prod/gn`
URL is a text binding. Normal local development
uses isolated D1 and R2; `cf dev --mode manual` uses remote D1 and can write live
data through the scheduled endpoint.

Once the cache is fully loaded, compare an API dump or URL against the
Ethereum subgraph and the Cloud export:

```bash
bun scripts/compare.ts /path/to/api-data.json /path/to/results.json \
  https://api.goldsky.com/api/public/project_cmdgxxcewrqdi01wx9e7md0ek/subgraphs/phala-ethereum/prod/gn
```

The comparison exits nonzero unless row counts and date sets match for
Ethereum circulation, Vault and claims, the deployment matches, and latest-day
totals agree within relative `1e-9`, and all 663 archived Cloud rows match exactly, including
captured PHA. Run it only after the subgraph has fully synced.

Production deploys automatically through Cloudflare Workers Builds when an
app or shared-tooling change reaches protected `main`. The ruleset requires a
PR and the `check`, `app` and `subgraph` checks, and blocks force-pushes and
branch deletion. Preview builds are disabled.

Builds runs from `/app`: build `bun install --frozen-lockfile`, then deploy
`bunx cf deploy --provision=false`. Its watch paths are `app/*`, `package.json`,
`bun.lock` and `biome.json`; build variables are `SKIP_DEPENDENCY_INSTALL=1`,
`CLOUDFLARE_ACCOUNT_ID` for the production account and `CF_SEND_TELEMETRY=false`.
The deploy command builds Vite and uploads the Worker and static assets.
The `analytics.phala.network` Custom Domain is declared in `cloudflare.config.ts`;
the zone must not have a conflicting DNS record for that hostname.
Verify the build, cron runs, fresh health and browser rendering after a merge.

See [Operations](../docs/OPERATIONS.md#dashboard-and-api-deployment) for rollback
with `cf workers deployments create --versions`, pausing automatic builds and
the emergency-only manual deploy fallback. Subgraph releases remain manual
behind their upgrade gate.

### Circulation API

The same Worker serves `/api/circulation`, `/api/all`, and `/api/snapshot` from
`worker/circulation/`, using the existing `GOLDSKY_ETHEREUM_URL` binding. The
`/api/data` live block reuses its subgraph checks and Cache API helper. D1-backed dashboard
routes keep their existing response contracts. There is no HTTP call through the
legacy Vercel hostname. `VERSION` is a Worker version-metadata binding used to
isolate circulation Cache API entries across releases.

See [the API contract](../docs/CIRCULATION_API.md) for exact serialization,
CORS, errors, caching, fixtures and the 30-date comparison command. See
[Operations](../docs/OPERATIONS.md#circulation-proxy) for the Vercel
compatibility proxy, verification and rollback.
