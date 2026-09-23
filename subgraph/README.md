# phala-vault-state-subgraph

Goldsky subgraph that tracks `vaultUnstakeLocked`: PHA held by the Phala Vault
for pending unstake requests. The
[circulation API](https://github.com/Phala-Network/pha-circulation-server) reads
this value and computes everything else over RPC at the same block.

Vault: `0x21d6eC8fc14CaAcc55aFA23cBa66798DAB3a0ec0` (Ethereum, deployed at
block `21596326`).

## Rules

Starting from zero, in canonical log order:

| Event | Change |
| --- | --- |
| `Withdraw` | `+ assets` |
| `Claimed` | `- assets` |
| `Deposit` with `sender == Vault` | `- assets` (user deposits are ignored) |

These rules match the archived `ethereum-circulation-squid`. The reconstruction
was checked against its database: at block `25390163` both give
`48383275.952282417636691459` PHA from 764 `Withdraw`, 619 `Claimed`, and 73
Vault-sent `Deposit` events.

## Entities

- `VaultState` (`id: "current"`): the latest value and the block it last changed.
- `VaultStateCheckpoint` (immutable): the value after every change, keyed by
  transaction hash and log index.

History is not pruned (`indexerHints.prune: never`), so time-travel queries work
for any block after the Vault deployment.

## Queries

Latest value together with the block it is valid at:

```graphql
{
  vaultState(id: "current") { vaultUnstakeLocked updatedAtBlock updatedAtTimestamp }
  _meta { hasIndexingErrors block { number hash } }
}
```

Value at a historical block:

```graphql
{ vaultState(id: "current", block: { number: 25390163 }) { vaultUnstakeLocked } }
```

## Build and deploy

```bash
bun install
bun run build
goldsky login   # API key of the Phala Goldsky project
goldsky subgraph deploy phala-vault-state/1.0.0 --path .
```

Deploy new versions under a new version tag (for example `1.0.1`), wait until
they are synced with `hasIndexingErrors: false`, then switch the API's
`GOLDSKY_VAULT_STATE_URL` (or move a Goldsky tag) and delete the old version.

## Independent replay

`scripts/replay.ts` rebuilds the value directly from Ethereum logs, without any
indexer. Use it to verify a deployment or as a recovery path:

```bash
RPC_URL=https://... bun run replay 25390163
```

It fetches `eth_getLogs` in `CHUNK_SIZE` block ranges (default `10000`) with
`CONCURRENCY` parallel requests (default `4`); lower `CHUNK_SIZE` for RPC plans
with smaller range limits.
