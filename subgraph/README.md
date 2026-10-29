# Phala subgraphs

The `phala-ethereum` Goldsky subgraph indexes Ethereum PHA circulation,
Vault metrics and flows, and Khala/Phala sunset claims. `ethereum.yaml` starts
at PHA deployment block **9975568** (`0x6c5ba91642f10282b576d91922ae6448c9d52f4e`);
the Clock polls every 25 blocks after its configured start block.

Consumers use the `prod` tag:
`https://api.goldsky.com/api/public/project_cmdgxxcewrqdi01wx9e7md0ek/subgraphs/phala-ethereum/prod/gn`.
See the circulation server's
[operations guide](../docs/OPERATIONS.md)
for the wider stack.

## Data reference

[schema.graphql](./schema.graphql) defines the complete GraphQL contract. Token
amounts are integer **wei** (18 decimals); timestamps are Unix seconds.
`sharePrice` and `apr` are `BigDecimal` strings: assets / shares and an annual
fraction, respectively. Both are zero without shares; APR is also zero when
paused, assets are zero, or the implementation is unreviewed.

| Entity                     | Fields and meaning                                                                                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ChainState`, `VaultState` | Mutable accumulators, singleton `current`                                                                                                                                              |
| `Latest`                   | Singleton `current`: circulation components, Vault assets/locked amount, `shareSupply`, `sharePrice`, `apr`, `stakers`, and implementation status; refreshed on events and Clock polls |
| `ChainDay`                 | Immutable midnight circulation components; ID and `date` are `YYYY-MM-DD`                                                                                                              |
| `VaultDay`                 | Immutable midnight Vault metrics and preceding-day flow totals; see below                                                                                                              |
| `ClaimDay`                 | Preceding-day `khalaClaimCount`, `khalaFree`, `khalaStaked`, `phalaClaimCount`, `phalaFree`, `phalaStaked`                                                                             |
| `Transfer`                 | PHA logs touching S: `from`, `to`, `amount`, block/time, transaction hash and log index; each log stored once                                                                          |
| `VaultEvent`               | Vault log kind, assets/shares, raw `settlementAssets`, block/time and transaction/log identity; `unstakeLockedAfter` follows log order, checkpoint fields are end-of-block reads       |
| `Holder`                   | Share balance by address, including zero balances; `stakers` counts positive balances excluding the zero address                                                                       |
| `Claimed`                  | Khala claims only; legacy no-code schema                                                                                                                                               |
| `ClaimedAndBridged`        | Phala claims only; legacy no-code schema                                                                                                                                               |

Claimer entities preserve nullable event parameters, lowercase string addresses,
`contractId_`, `transactionHash_`, `timestamp_`, `block_number`, and string IDs
`<transaction hash>-<block log index>`. Khala uses `receiver`; Phala uses
`l1Receiver` / `l2Receiver`. Apps' `where: {user: $user}` queries retain their
existing shape. The Phala claimer's empty `Claimed` event stream is not mapped.

### Snapshot and flow dates

`ChainDay` evaluates balances and Vault accrual **exactly at 00:00 UTC**, before
events at that timestamp. Deployment-day midnight has zero supply. Each handler
calls `closeDaysUpTo` before applying its event; Clock polls close quiet days.

`observedBlockNumber` / `observedBlockTimestamp` identify the last event or poll
before closure, not the final canonical block before midnight. They are zero
before deployment. Snapshot consumers retain this observed-block meaning and
the requested midnight `date`. The legacy `/api/snapshot` instead reads the
first block at or after midnight, explaining small parity differences.

| VaultDay field                                                 | Meaning                                                                    | Dune equivalent |
| -------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------- |
| `date`, `timestamp`                                            | Midnight snapshot boundary                                                 | —               |
| `totalAssets`, `treasuryAssets`                                | Accrued assets at midnight                                                 | —               |
| `shareSupply`, `sharePrice`, `apr`, `stakers`, `unstakeLocked` | Midnight staking metrics                                                   | —               |
| `flowDate`                                                     | Previous UTC day; flows cover `[flowDate 00:00, date 00:00)`               | `day`           |
| `settlementTotalAssets`                                        | Last `RewardsSettled.totalAssets` in `flowDate`, null without a settlement | `totalAssets`   |
| `dailyRewards`                                                 | Sum of `RewardsSettled.rewards` in `flowDate`                              | `dailyRewards`  |
| `dailyTreasuryRewards`, `treasurySettlementCount`              | Treasury settlement amount and count                                       | —               |
| `deposits`, `withdrawRequests`, `claims`, `treasuryClaims`     | Event asset sums; deposits include cancelled unstake redeposits            | —               |
| `depositCount`, `withdrawRequestCount`, `claimCount`           | Corresponding event counts                                                 | —               |

`ClaimDay` uses the same `date` / `flowDate` convention. Vault days begin at the
first midnight after initialization; claim days begin after the first claim.
Gap days have zero flows and null `settlementTotalAssets`.

### Circulation

Ethereum stores `totalSupply`, the balances below, and `circulation`.
It also exposes `vaultTotalAssets`, `vaultTreasuryAssets`,
`vaultUnstakeLocked` and `vaultReward`.

| Component                | Ethereum address                             |
| ------------------------ | -------------------------------------------- |
| `reward`                 | `0x4731bc41b3cca4c2883b8ebb68cb546d5b3b4dd6` |
| `phalaChainBridge`       | `0xcd38b15a419491c7c1238b0659f65c755792e257` |
| `khalaLegacyChainBridge` | `0x6ed3bc069cf4f87de05c04c352e8356492ec6efe` |
| `khalaChainBridge`       | `0xeec0fb4913119567cdfc0c5fc2bf8f9f9b226c2d` |
| `sygmaBridge`            | `0xc832588193cd5ed2185dada4a531e0b26ec5b830` |
| `portalBridge`           | `0x3ee18b2214aff97000d974cf647e7c347e8fa585` |
| `sunsetReward`           | `0x4a396b5c9a6fbc1bc0525f24ac0a246766f3ebef` |
| `vaultBalance`           | `0x21d6ec8fc14caacc55afa23cba66798dab3a0ec0` |

S contains these addresses plus `0x0000000000000000000000000000000000000000`
for mint/burn supply accounting. Two data sources filter `topic1 ∈ S` and
`topic2 ∈ S`; each updates its own side, while the From handler stores the audit
row when both match. Filtered Transfers also support per-bridge flow queries.

```text
khalaBridge = khalaLegacyChainBridge + khalaChainBridge
vaultReward = vaultBalance - vaultTotalAssets - vaultTreasuryAssets - vaultUnstakeLocked
ethereumCirculation = totalSupply - reward - sunsetReward - phalaChainBridge
                      - khalaBridge - sygmaBridge - vaultReward
```

`portalBridge` remains exposed on `ChainDay` and `Latest`, and its transfers
remain indexed. This Portal escrow backs circulating PHA on Base, so it counts
in Ethereum circulation without a separate Base indexer. Adding Base supply
again would count it twice. Version 1.0.0 subtracted Portal escrow and required
separate Base circulation; version 1.1.0 includes the escrow instead. Historical
totals consequently change by `portalBridge - old Base circulation` per date.

`vaultReward` may be negative when promised rewards exceed funding. Historical
Substrate Phala/Khala circulation remains a frozen archive; Phala L2 vPHA is
outside this formula.

### Vault accrual and upgrades

Every Vault event declares reads of the seven accrual getters. The
[verified implementation](https://sourcify.dev/server/v2/contract/1/0xC0b39989381D8C88b7ef82A80d4C90540E70862A?fields=all)
uses basis points and floors the treasury share first:

```text
rewards = paused || shareSupply == 0 ? 0 : rewardRate * (T - checkpointTime)
treasuryRewards = floor(rewards * treasuryRatio / 10000)
totalAssets(T) = checkpointTotalAssets + rewards - treasuryRewards
treasuryAssets(T) = checkpointTreasuryAssets + treasuryRewards
APR = rewardRate * (1 - treasuryRatio / 10000) * 31536000 / totalAssets
```

`Withdraw` increases locked PHA; `Claimed` decreases it. `Deposit` decreases it
only when `sender == Vault`. `TreasurySettled` and `TreasuryAssetsClaimed` are
separate flows. Contract reads are end-of-block values; locked assets and Holder
balances follow log order.

`vaultImplementation`, `vaultImplementationReviewed` and `accrualMode` appear
on `Latest`, `ChainDay` and `VaultDay` (`VaultState` names the address
`implementation`). The reviewed implementation is
`0xC0b39989381D8C88b7ef82A80d4C90540E70862A`.

Unknown implementations set `vaultImplementationReviewed=false` and
`accrualMode="checkpoint-only"`: assets use checkpoint values, APR is zero,
and token/claimer indexing continues. Missing getters retain the last complete
checkpoint. Future checkpoint times or treasury ratios above 10000 trigger the
same fallback, including logs before `Upgraded` that read the new end-of-block
getters. Before Vault deployment, the implementation is zero,
reviewed is true, and mode is `inactive`.

Consumers should treat an unreviewed implementation as unhealthy;
pha-circulation-server returns 503 for circulation. The parity runner rejects
promotion while the flag is false.

For an upgrade, review the verified ABI and formula, update the ABI and
implementation allowlist/formula dispatch, deploy a new version, verify features
and parity, then move `prod`. Changing a consumer flag does not validate accrual.

## Development

Use Bun **1.4.2** and Node.js **24.x**. Dependencies are exact pins in the
text `bun.lock`.

```bash
bun install --frozen-lockfile
cd subgraph
bun run codegen       # ethereum.yaml bindings
bun run build         # build/ethereum
bun run test          # matchstick 0.6.0
bun run test:verify   # offline parity fixtures
bun run typecheck     # parity scripts; mappings compile during build
bun run check         # Biome CI
```

Matchstick's Linux binary needs `libpq.so.5` (`libpq5` on Ubuntu 22/24); CI
installs it in the runner. Docker is also supported:
`bunx --no-install graph test -d -v 0.6.0`. Biome formats AssemblyScript while
leaving its lint/import checks to the mapping compiler.

## Deploy, tag and rollback

The only deployed subgraph is `phala-ethereum/1.1.0`, tagged `prod`.
`phala-vault-state`, `khala-claimer` and `phala-claimer` have been deleted;
their data is indexed by `phala-ethereum`.

The project is on Starter, whose one-time credit can run out and pause
services; check remaining credits in the dashboard. Scale's free allowance is
**2,250 worker-hours/month** and **~100K entities**, team-wide. Goldsky caps
**deployed subgraphs at three**, including paused versions. Check deployment
slots before an upgrade and storage after sync. Pausing does not free a slot.

1. From `subgraph/`, set `SUBGRAPH_VERSION` to the new version, then build and
   deploy it alongside the current version, leaving `prod` unchanged:

   ```bash
   bun install --frozen-lockfile
   bun run codegen
   bun run build
   goldsky subgraph deploy "phala-ethereum/$SUBGRAPH_VERSION" --path build/ethereum
   ```

2. Wait for full sync and no indexing errors. Verify Clock polling advances
   `Latest.timestamp`, then run the default [upgrade comparison](#parity-verification)
   against the new version endpoint and the current `prod` deployment. Preserve
   the JSON report and review any intentional formula differences before tagging.
   Historical mapping changes require recomputing the affected history rather
   than grafting it from the previous version.
3. After parity passes, move `prod`:

   ```bash
   goldsky subgraph tag create "phala-ethereum/$SUBGRAPH_VERSION" --tag prod
   ```

4. Verify the circulation API, analytics dashboard and apps claim logs on
   `prod`, then delete the superseded version to free its deployment slot.

Before deleting the previous version, rollback moves `prod` back; restore the
matching consumer version if its circulation definition changed. After
deletion, rollback requires a free slot, redeployment and a full sync.
CI does not deploy or move tags. Repository metadata changes do not require
a subgraph redeploy.

## Parity verification

From `subgraph/`, compare the fully synced candidate with the deployment currently
behind `prod`. `upgrade` is the default stage; it needs no API, RPC or legacy
subgraphs:

```bash
bun run verify --candidate "$CANDIDATE_URL" --output upgrade-results.json
# An explicit version URL can pin the reference instead of the default prod tag:
bun run verify --candidate "$CANDIDATE_URL" --production "$CURRENT_VERSION_URL" \
  --output upgrade-results.json
```

`--ethereum` and `GOLDSKY_ETHEREUM_URL` are aliases for the candidate input.
The default reference is
`https://api.goldsky.com/api/public/project_cmdgxxcewrqdi01wx9e7md0ek/subgraphs/phala-ethereum/prod/gn`.
The runner exits nonzero on failure and writes a JSON report with deployment
IDs, head blocks, the comparison block, entity counts and field differences.
It never prints endpoint URLs or upstream error bodies.

The comparison block is `min(candidate head, production head) - 64`;
`--safety-margin N` changes the margin in blocks. Every entity page uses
`block: {number: comparisonBlock}`, `orderBy: id`, ascending order and an
`id_gt` cursor. The gate requires exact full ID sets and all scalar fields for
`ChainDay`, `VaultDay`, `ClaimDay`, `VaultEvent`, `Transfer`, `Claimed` and
`ClaimedAndBridged`. It also compares all fields/IDs and counts of the mutable
`Latest`, `VaultState`, `Holder` and internal `ChainState` entities at that
same block. Integer and decimal strings stay exact; there are no tolerances.
Both deployments must have `_meta.hasIndexingErrors: false`. The candidate's
Vault implementation must be reviewed at its head and at the common block;
historical review flags must also be true. Deployment IDs are checked on
every page and again at the end, so a moved tag invalidates the run.

For a reviewed formula change, name only the numeric fields whose differences
you intend to accept:

```bash
bun run verify --candidate "$CANDIDATE_URL" \
  --expect-diff ChainDay.circulation,Latest.circulation \
  --output upgrade-results.json
```

All other fields and all ID sets/counts still require exact equality. Identity,
block/date provenance, implementation addresses, review flags and accrual mode
cannot be exempted. The report retains every changed entity's before/after
values; stdout and `diffSummary` give counts and integer delta totals per UTC
date and field, with the first before/after pair in each group. Decimal changes
retain their exact strings. Inspect the differences against the intended
formula before moving `prod`; the flag records an operator's exception and
does not prove the new formula correct.

### Comparison blocks and pruning

The manifest uses `indexerHints.prune: auto`. Immutable daily/event entities
remain stored, but old mutable versions and deep time-travel queries are not
retained. Goldsky runs standard graph-node; its
[pruning guidance](https://docs.goldsky.com/subgraphs/guides/performance#prune-history-you-dont-need)
says `auto` retains the minimum history needed. Upstream graph-node maps it to
the operator's `GRAPH_MIN_HISTORY_BLOCKS`, defaulting to twice the reorg
threshold ([manifest handling](https://github.com/graphprotocol/graph-node/blob/master/graph/src/data/subgraph/mod.rs),
[defaults](https://github.com/graphprotocol/graph-node/blob/master/graph/src/env/mod.rs)).
This is not a guaranteed Goldsky retention window, and the public `_meta`
schema exposes no earliest retained block.

Run the gate promptly when both deployments are caught up. The default
64-block margin is deliberately near both heads; the runner probes mutable
queries at that block before paging. If the candidate lags outside the
reference's retained range, wait for sync and restart. If pruning advances
past the fixed block during the run, restart near both heads. A smaller
`--safety-margin` can be chosen after assessing reorg risk; `0` offers no
reorg buffer. The runner fails on unavailable history and never falls back to
queries at different heads. Historical row dates are still compared in full:
a recent comparison block limits the version of state being read, not the
age of immutable rows returned. Numbered `_meta.block.timestamp` may be null;
only its block number is required for the upgrade gate.

### Optional historical archives

`--stage historical` keeps the original migration evidence checks available.
Supply only the gates you need. References must be preserved files, never
live endpoints that now read the same subgraph:

```bash
bun run verify --stage historical --candidate "$CANDIDATE_URL" \
  --snapshot-cache "$PRE_CUTOVER_SNAPSHOTS" \
  --ndjson "$SNAPSHOTS_NDJSON" --results "$DUNE_RESULTS_JSON" \
  --old-khala-export "$KHALA_EXPORT" --old-phala-export "$PHALA_EXPORT" \
  --output historical-results.json
# Claimer exports can also be checked independently:
bun run verify --stage historical --candidate "$CANDIDATE_URL" \
  --old-khala-export "$KHALA_EXPORT" --output historical-claims.json
```

- `--snapshot-cache`: the original pre-cutover `/api/snapshot` NDJSON, one
  complete response per date, continuous from 2020-04-30 through its final
  archived date. Missing files/dates fail without a live API fallback. Every
  archived date compares exposed components, audited first-block transfers
  and bounded Vault accrual. Newer dates outside this archive are covered by
  the upgrade gate.
- `--ndjson` / `SNAPSHOTS_NDJSON`: 1,825 archived circulation rows.
- `--results` / `DUNE_RESULTS_JSON`: 365 Dune History rows and 550 Vault
  settlement days through 2026-10-10. Undated rows are excluded. Rewards are
  available only for 2026-10-10 (`34930.0634765625` PHA); the other 549 dates
  are reported as unavailable. Settlement assets/rewards use `1e-12` relative
  tolerance; event-based flow residuals must be zero.
- `--old-khala-export` / `--old-phala-export`: complete legacy claimer exports
  shaped `{subgraph, block, meta, claimeds?, claimedAndBridgeds?}`. Each file
  uses its own saved block, and the candidate must reach it. All IDs and fields
  compare exactly; the Phala export also requires empty `claimeds`.

Circulation NDJSON/Dune checks require `--snapshot-cache` to explain the old
Ethereum-plus-Base definition using archived Base and Ethereum Portal values.
They make no Base endpoint requests. Archive totals must agree with the old
snapshot within `1e-7` relative tolerance; adjusted totals additionally allow
only audited first-block flows and `rewardRate * delay + 1e-6 PHA` accrual.
All expected/actual definition changes and bounds remain in the report.
The deleted Vault-state checkpoint reference, live old claimers, API-prefetch,
server/cache migration stages and raw-RPC checks have been removed. API and
Worker cache verification use the consumer packages' own checks.
