# Envio HyperIndex port of `phala-ethereum`

This directory ports the [`subgraph/`](../subgraph/README.md) indexer to
[Envio HyperIndex](https://docs.envio.dev). It produces the same 11 entities,
with the same names, fields and IDs, from the same contracts and start blocks.
Event logs come from HyperSync. The Vault getter reads and the Clock's block
timestamps come from an Ethereum archive RPC. The project targets
`envio` 3.15.0.

The subgraph is untouched. The port sits beside it so both can run while the
results are compared. It has its own pnpm lockfile, because the Envio CLI
expects pnpm, and is not part of the Bun workspace.

## Run it

You need Node.js 22.15 or later (24.x tested), pnpm 10, Docker (for
`pnpm dev`) and an Envio API token for HyperSync
(<https://envio.dev/app/api-tokens>).

```bash
cd envio
pnpm install
cp .env.example .env          # set ENVIO_API_TOKEN; optionally ENVIO_RPC_URL
pnpm dev                      # starts Postgres and Hasura in Docker, then indexes
```

Hasura serves GraphQL at <http://localhost:8080> (local admin password
`testing`). A full sync from block 9,975,568 to head takes four to six
minutes; see [Benchmark](#benchmark).

To use your own Postgres instead of Docker, set `ENVIO_PG_HOST`,
`ENVIO_PG_PORT`, `ENVIO_PG_USER`, `ENVIO_PG_PASSWORD` and `ENVIO_PG_DATABASE`
(plus `ENVIO_HASURA=false` if you run without Hasura), then `pnpm start -r`.
The `-r` flag wipes the database and re-indexes from scratch.

Other commands:

```bash
pnpm codegen      # regenerate types after editing config.yaml or schema.graphql
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest: IDs, BigDecimal rounding, accrual and day closure
```

### RPC

Each Vault event needs the seven accrual getters as of the end of its block
(4,359 distinct blocks so far). The Clock needs a block timestamp every 25
blocks from block 26,283,000. Both go through the Effect API: one Multicall3
`eth_call` per block, de-duplicated and cached in the database.

`ENVIO_RPC_URL` takes one archive endpoint or a comma-separated list. If it
is unset, the indexer uses public endpoints (`eth.drpc.org`, Tenderly's public
gateway, Blast's public endpoint). These work but are rate-limited and their
speed varies; use a dedicated archive node in production.

A failed RPC request is retried with backoff. After ten failures the indexer
stops. A transport error is never treated as a contract revert, so a flaky
endpoint cannot flip `vaultImplementationReviewed` to `false`.

## What maps to what

| Subgraph (`ethereum.yaml`)                                          | HyperIndex                                                                                                     |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `TokenFrom` and `TokenTo` data sources (`topic1 ∈ S`, `topic2 ∈ S`) | One `Token.Transfer` handler, `where: {params: [{from: S}, {to: S}]}`; applies the From side, then the To side |
| `Vault` data source: 17 events, 7 declared `eth_call`s on each      | 17 `Vault.*` handlers; the getters come from the `vaultReads` effect at the event's block                      |
| `KhalaClaimer.Claimed`, `PhalaClaimer.ClaimedAndBridged`            | The same events and logic                                                                                      |
| `Clock` block handler, `polling every: 25` from block 26,283,000    | `indexer.onBlock` with `_gte: 26283000, _every: 25`; timestamp from the `blockTimestamp` effect                |
| `src/days.ts`, `src/assets.ts`, `src/state.ts`                      | `src/lib/state.ts`: the same functions in the same order                                                       |
| `src/token.ts`, `src/vault.ts`, `src/claimer.ts`, `src/clock.ts`    | `src/handlers/*.ts`                                                                                            |
| `schema.graphql`                                                    | `schema.graphql`: the same entities and fields                                                                 |

Details that matter for exact parity:

- **IDs.** `Transfer` and `VaultEvent` IDs are the transaction hash followed
  by the log index as a little-endian int32, as graph-ts `concatI32` builds
  them. `Holder` IDs are lowercase addresses. Claimer IDs are
  `<tx hash>-<log index>`. Day IDs are `YYYY-MM-DD`.
- **BigDecimal.** graph-node rounds every `BigDecimal` result to 34
  significant digits, half-up. `src/lib/decimal.ts` does the same after each
  step of `sharePrice` and `apr`.
- **End-of-block reads.** As with the subgraph's declared calls, every Vault
  event in a block sees the getter values as of the end of that block.
- **Day closure, observed-block metadata, flow resets and the fallback for an
  unreviewed implementation** follow `subgraph/src` line by line.

## Differences a consumer will notice

The stored data is identical. The API around it is not.

- **Query shape.** HyperIndex serves a Hasura GraphQL API, not graph-node's,
  so the app's queries need small rewrites:

  | Subgraph                                                                               | HyperIndex (Hasura)                                                                                     |
  | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
  | `latest(id: "current") { … }`                                                          | `Latest(where: {id: {_eq: "current"}}) { … }` (returns a list)                                          |
  | `chainDay(id: $date) { … }`                                                            | `ChainDay(where: {id: {_eq: $date}}) { … }`                                                             |
  | `chainDays(first: 1000, orderBy: date, orderDirection: asc, where: {date_gt: $after})` | `ChainDay(limit: 1000, order_by: {date: asc}, where: {date: {_gt: $after}})`                            |
  | `_meta { hasIndexingErrors block { number } }`                                         | `_meta { chainId progressBlock isReady }`; a handler error stops the indexer rather than setting a flag |

- **Decimals.** `sharePrice` and `apr` are stored as `numeric(80,40)`, so
  they come back with trailing zeros (`1.3156…7290000000`). The value is the
  same.
- **Extra column.** Every table has a `chainId` column, always `1`.
- **No time-travel queries** (`block: {number: N}`). Immutable entities keep
  their full history, but `Latest`, `ChainState`, `VaultState` and `Holder`
  hold only their current value.

## Benchmark

Cold full syncs on one laptop (Apple Silicon, Postgres 17 in Docker), from
block 9,975,568 to chain head, each with an empty database and no effect
cache. Time runs from "Starting indexing" to "Ready" in the indexer log.

**envio 3.15.0** (2026-10-29, no other sync running from this project):

| Time    | Final block | Events processed¹ | Blocks/s | Waiting on RPC² | Waiting on HyperSync³ |
| ------- | ----------- | ----------------- | -------- | --------------- | --------------------- |
| 250.0 s | 26,299,407  | 25,588            | 65,300   | 164 s           | 83 s                  |

Earlier runs on **envio 3.14.0**, same code otherwise, with other indexers
syncing on the same machine:

| Run | Time    | Events processed¹ | Blocks/s | Waiting on RPC² | Waiting on HyperSync³ |
| --- | ------- | ----------------- | -------- | --------------- | --------------------- |
| A   | 238.2 s | 25,574            | 68,500   | 88 s            | 148 s                 |
| B   | 212.1 s | 25,574            | 77,000   | 115 s           | 94 s                  |
| C   | 348.6 s | 25,576            | 46,800   | 207 s           | 139 s                 |

¹ 24,931 contract events plus one Clock call per 25 blocks.
² `envio_preload_seconds`: handlers waiting on the Vault and timestamp reads.
³ `envio_processing_stalled_on_fetch_seconds`.

Most of the time is spent waiting on the public RPC, and that wait varies from
run to run: Vault reads took 119 s in the 3.15.0 run and 45-166 s in the
3.14.0 runs. The 3.15.0 run retried one failed RPC request; the 3.14.0 runs
retried none. Database writes took 0.5 s on 3.15.0 against about 16 s on
3.14.0, but with the RPC dominating, total time is about the same. A dedicated
archive RPC would shorten the RPC share.

## Parity

After each run the indexer was stopped and every entity was compared field by
field with the live `phala-ethereum/prod` deployment, queried with
`block: {number: N}` at the indexer's final block N. envio 3.15.0 run, block
26,299,410:

| Entity            | Rows   | Matching |
| ----------------- | ------ | -------- |
| ChainState        | 1      | 1        |
| ChainDay          | 2,374  | 2,374    |
| Latest            | 1      | 1        |
| Transfer          | 11,803 | 11,803   |
| VaultState        | 1      | 1        |
| VaultDay          | 657    | 657      |
| VaultEvent        | 10,950 | 10,950   |
| Holder            | 1,142  | 1,142    |
| Claimed           | 1,687  | 1,687    |
| ClaimedAndBridged | 491    | 491      |
| ClaimDay          | 654    | 654      |

Every ID set was equal, and every field matched exactly: integers as
integers, decimals as exact decimals, about 417,000 values in all. The three
3.14.0 runs matched in the same way at blocks 26,299,053, 26,299,075 and
26,299,121. As a control,
the same comparison against the subgraph 1,000 blocks earlier found
differences in the mutable entities, as it should.
