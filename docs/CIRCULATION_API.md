# Circulation API

PHA circulating supply API in the `phala-analytics` Cloudflare Worker.
Reads the [`phala-ethereum` Goldsky subgraph](../subgraph/README.md);
no RPC is used.

## API contract

Canonical base URL: `https://analytics.phala.network`.
The existing `https://pha-circulation-server.vercel.app` hostname remains a
Vercel external-rewrite proxy to the same endpoints.
All endpoints allow cross-origin requests (`Access-Control-Allow-Origin: *`).
Amounts are PHA decimal **strings**, calculated with integer wei precision.
`totalCirculation` is Ethereum `circulation`, truncated to 12 decimal places
without trailing zeros. Phala and Khala are zero after their parachain sunsets.

| Request                             | Content type                      | Response                                                                                                                                        |
| ----------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/circulation`              | `text/plain; charset=UTF-8`       | Plain decimal total circulation, with no quotes, JSON wrapper, or newline. This is the supply-tracker endpoint.                                 |
| `GET /api/all`                      | `application/json; charset=UTF-8` | `phala`, `khala`, `ethereum`, `base`, `totalCirculation`, `sources`. Current values come from `Latest(id: "current")`; `base` is always `null`. |
| `GET /api/snapshot?date=YYYY-MM-DD` | `application/json; charset=UTF-8` | `date`, `ethereum`, `base`, `totalCirculation`, from immutable `ChainDay(id: date)` rows. Dates start at `2020-04-30`; `base` is always `null`. |

`/api/all` chain objects retain these string fields:

- `phala` and `khala`: `circulation`, `crowdloan`, `reward`, `sygmaBridge`,
  `timestamp`, `totalIssuance`.
- `ethereum`: `circulation`, `phalaChainBridge`, `khalaChainBridge`, `reward`,
  `sygmaBridge`, `portalBridge`, `timestamp`, `totalSupply`, `vaultReward`.

The snapshot `ethereum` object includes `blockNumber`, `timestamp`,
`circulation`, `totalSupply`, `reward`, `sunsetReward`, `phalaChainBridge`, `khalaChainBridge`, `sygmaBridge`, `portalBridge`,
`vaultReward`, `vaultUnstakeLocked`. All are strings. `date` is midnight in
`YYYY-MM-DDT00:00:00.000000Z` form. Chain timestamps use the same six-digit
fractional precision; the zeroed parachain timestamps use ISO milliseconds.
The two Khala bridge balances are combined into `khalaChainBridge`.

### Circulation definition

Portal escrow backing PHA on Base counts as circulating **on Ethereum**.
The subgraph no longer subtracts `portalBridge` from Ethereum circulation;
`portalBridge` remains visible as a component. The API uses the subgraph's
`circulation` directly and does not add a separate bridged-chain supply.
Compared with the former Ethereum-plus-Base total, this adds the difference
between Portal escrow and bridged supply, approximately **50,000 PHA** at the
time of the definition change. Historical snapshots use this definition too.

Both JSON endpoints retain `base` as `null`, and `/api/all` also retains
`sources.base` as `null`. These replace the former objects; consumers must
accept `null` while the Ethereum keys and types remain unchanged. The tracker
endpoint keeps its plain-number byte format. Deploy with a subgraph version
that includes Portal escrow in circulation.

### Snapshot convention and source metadata

Daily values are evaluated at **exactly 00:00 UTC, before events at that
instant**. The former RPC API used the first block at or after midnight,
including deployment-day balances. This changes historical amounts slightly;
the deployment-date snapshot now has zero supply. Ethereum keys and types stay
the same. `blockNumber` and the chain `timestamp` identify the **last observed
event or Clock poll at or before midnight**, rather than the final canonical block
before midnight. Both are zero (timestamp `1970-01-01T00:00:00.000000Z`) before
the token's deployment. The top-level `date` always identifies the requested
midnight, including on the deployment date.

In `/api/all`, `sources.ethereum` contains string fields `blockNumber`,
`indexedAt`, `lagSeconds`, `vaultUnstakeLocked`. `indexedAt` is the evaluation
time from `Latest.timestamp`, formatted like the chain timestamp;
`lagSeconds` is its nonnegative age when the response is computed. This
**replaces `headBlockNumber` and `lagBlocks`**. The subgraph's `_meta` is checked
for indexing errors and for an indexed block at least as high as the observed
block. `_meta.block.timestamp` is nullable and is not used.
The source block number identifies the last observed event or poll used for
the current values; it does not claim RPC finality.

### Errors

Upstream failures/timeouts, malformed data, indexing errors, a `Latest` older
than 15 minutes, or `vaultImplementationReviewed=false` return **503** with
`Cache-Control: no-store`. Daily reads check both current `Latest` safety and
the requested day's implementation flag. There is no stale fallback.

`/api/circulation` returns plain `Service Unavailable`; `/api/all` returns
`{"error":"circulation_unavailable"}`; snapshots return
`{"error":"snapshot_unavailable"}`. Invalid dates return 400
(`invalid_date`); dates outside the supported range or not indexed yet return
404 (`not_available`). Date errors include a `message` and use `no-store`.
Other paths return plain `404 Not Found`.

## Caching

Public response headers match the former Vercel production wire headers,
including its removal of CDN-only directives:

| Data                              | Public Cache-Control                 | Cache API TTL |
| --------------------------------- | ------------------------------------ | ------------- |
| Latest                            | `public, max-age=60`                 | 60 seconds    |
| Snapshot                          | `public, max-age=3600`               | 30 days       |
| Errors (400/404 date errors, 503) | `no-store`                           | Never stored  |
| Unknown API paths and preflight   | `public, max-age=0, must-revalidate` | Never stored  |

The Worker stores computed JSON under fixed keys (`latest`, `snapshot:<date>`)
using the Cache API, independently of the public response's browser TTL.
`/api/all` and `/api/circulation` share a cache entry; arbitrary query strings do
not bypass it. Concurrent misses within an isolate share one computation.
Entries are local to a Cloudflare location and include the Worker version ID,
so a new release cannot serve data computed by old code. Cache I/O failures
fall through to the subgraph; upstream failures are never stored. Upstream
safety checks run on misses, just as in the former Vercel Runtime Cache.

The old Vercel function used `s-maxage=60, stale-while-revalidate=60` for latest
and `s-maxage=86400` for snapshots, which Vercel consumed before sending the
public headers above. The Worker's internal Cache API supplies the shared
cache instead. Cloudflare's Cache API does not support stale-while-revalidate;
expired entries are recomputed and no stale fallback is introduced.

Deploy a new Worker version after moving a subgraph tag so cached historical
rows from the previous version do not survive the 30-day data TTL. Existing
browser responses can persist for one hour.

Reference: [Cloudflare Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/).

## Configuration and verification

`GOLDSKY_ETHEREUM_URL` is the existing public `/prod/gn` text binding in
`app/cloudflare.config.ts`. `VERSION` is a Worker version-metadata binding.
The circulation reader's default upstream timeout is 8 seconds. No additional
secret or Vercel runtime dependency is needed.

Use Node.js **24.x** and Bun **1.4.2**, with the shared text `bun.lock`.
From the repository root:

```bash
bun install --frozen-lockfile
bun run verify:app
cd app
bun run dev --port 8787
```

Local development uses local D1/R2 and the public Ethereum subgraph. Do not use
`--mode manual`, which opts into remote D1. No Cloud API secret is needed for
circulation-only checks, and scheduled events are not triggered automatically.
In another terminal, from `app/`:

```bash
bun scripts/compare-circulation.ts \
  https://pha-circulation-server.vercel.app http://localhost:8787
```

The optional third argument fixes the reference UTC date (`YYYY-MM-DD`). The
script compares status, body bytes, content type, cache control, CORS, Vary,
Allow and Location. It covers 30 deterministic snapshot dates (deployment,
first/last edges, the 2020-09-01 transition, Base-era cases, today/yesterday,
before-deployment and future dates), malformed/missing dates, unknown API
routes, trailing slashes, HEAD, POST and CORS preflight. All historical and
error bodies must match byte-for-byte; unexpected 503s fail the comparison.

Only successful live responses permit normalization. Both JSON bodies must
first match their compact JSON serialization exactly, preserving key order
and whitespace. The two indexed timestamps may differ by at most 180 seconds.
Only `ethereum.circulation`, `ethereum.vaultReward` and `totalCirculation` may
move, by at most **1 PHA per second of indexed timestamp difference**, plus
one 12-decimal rounding unit. This bounds the current sub-second Vault reward
accrual without masking transfers or changes to other components. Phala/Khala
wall-clock timestamps may differ by 180 seconds; source `indexedAt` must equal
the chain timestamp, `lagSeconds` must be a nonnegative integer within the
API's 900-second health bound, and observed block numbers may differ by at most
one block per second of indexed-time difference. The plain-number endpoint
uses the same drift bound inferred from the preceding `/api/all` pair.
Everything else, including JSON key order and number formatting, stays exact.
An on-chain transfer or a cache rollover between requests can legitimately
fail this strict comparison; inspect the changed fields and rerun, rather
than widening the tolerance.

Tests reuse the earlier production fixtures in
`app/worker/circulation/fixtures/production.json` (recorded before the approved
Ethereum-only formula change) and current production wire fixtures in
`app/worker/circulation/fixtures/worker-production.json`. They cover exact snapshot
bytes, number formatting, errors and recovery, CORS, cache expiry and release
isolation; the workerd regression test also protects the dashboard routes.

See [Operations](OPERATIONS.md) for the stack, automatic deployments and
compatibility proxy.
