// Port of subgraph/src/vault.ts. Every Vault event reads the seven accrual
// getters at the end of its block (the subgraph's declared eth_calls), so the
// last event in each block leaves a coherent checkpoint.
import { type EvmOnEventContext, indexer } from "envio";
import { IMPLEMENTATION, logId, VAULT, ZERO } from "../lib/constants";
import { vaultReads } from "../lib/rpc";
import {
  type Block,
  closeDaysUpTo,
  markUnreviewed,
  newVault,
  refreshLatest,
  type Store,
  type VaultStateM,
} from "../lib/state";
import { loadStore, saveStore } from "../lib/store";

type Reads = Awaited<ReturnType<typeof prelude>>["reads"];

interface Ev {
  block: Block;
  logIndex: number;
  hash: string;
}

// Daily closure happens BEFORE the checkpoint reads are applied.
function begin(store: Store, ev: Ev, reads: Reads, implementation?: string): VaultStateM {
  closeDaysUpTo(store, ev.block);
  const state = store.vault ?? newVault();
  if (implementation !== undefined) state.implementation = implementation;
  state.vaultImplementationReviewed = state.implementation === IMPLEMENTATION;
  state.accrualMode = state.vaultImplementationReviewed ? "formula" : "checkpoint-only";
  if (reads.ok) {
    state.checkpointTime = reads.checkpointTime;
    state.checkpointTotalAssets = reads.checkpointTotalAssets;
    state.checkpointTreasuryAssets = reads.checkpointTreasuryAssets;
    state.rewardRate = reads.rewardRate;
    state.treasuryRatio = reads.treasuryRatio;
    state.paused = reads.paused;
    state.shareSupply = reads.totalSupply;
  } else {
    // An unknown ABI may remove getters. Retain the last complete checkpoint
    // and keep claimers alive; consumers must reject the unreviewed flag.
    markUnreviewed(state);
  }
  if (state.treasuryRatio > 10000n || state.checkpointTime > ev.block.timestamp)
    markUnreviewed(state);
  return state;
}

function finish(
  context: EvmOnEventContext,
  store: Store,
  ev: Ev,
  state: VaultStateM,
  kind: string,
  assets: bigint,
  shares: bigint,
  settlementAssets?: bigint,
): void {
  if (state.vaultImplementationReviewed && state.unstakeLocked < 0n)
    throw new Error("Negative locked assets");
  store.vault = state;
  context.VaultEvent.set({
    id: logId(ev.hash, ev.logIndex),
    kind,
    settlementAssets,
    assets,
    shares,
    blockNumber: ev.block.number,
    timestamp: ev.block.timestamp,
    transactionHash: ev.hash,
    logIndex: BigInt(ev.logIndex),
    unstakeLockedAfter: state.unstakeLocked,
    checkpointTime: state.checkpointTime,
    checkpointTotalAssets: state.checkpointTotalAssets,
    checkpointTreasuryAssets: state.checkpointTreasuryAssets,
    rewardRate: state.rewardRate,
    treasuryRatio: state.treasuryRatio,
    shareSupply: state.shareSupply,
    paused: state.paused,
    implementation: state.implementation,
    vaultImplementationReviewed: state.vaultImplementationReviewed,
    accrualMode: state.accrualMode,
  });
  refreshLatest(store, ev.block);
}

interface RawEvent {
  block: { number: number; timestamp: number };
  logIndex: number;
  transaction: { hash: string };
}

async function prelude(event: RawEvent, context: EvmOnEventContext) {
  const reads = await context.effect(vaultReads, event.block.number);
  const store = await loadStore(context);
  const ev: Ev = {
    block: { number: BigInt(event.block.number), timestamp: BigInt(event.block.timestamp) },
    logIndex: event.logIndex,
    hash: event.transaction.hash,
  };
  return { reads, store, ev };
}

const fields = { block: ["timestamp"], transaction: ["hash"] } as const;

indexer.onEvent({ contract: "Vault", event: "Withdraw", fields }, async ({ event, context }) => {
  const { reads, store, ev } = await prelude(event, context);
  const state = begin(store, ev, reads);
  state.unstakeLocked += event.params.assets;
  state.withdrawRequests += event.params.assets;
  state.withdrawRequestCount += 1n;
  finish(context, store, ev, state, "Withdraw", event.params.assets, event.params.shares);
  saveStore(context, store);
});

indexer.onEvent({ contract: "Vault", event: "Claimed", fields }, async ({ event, context }) => {
  const { reads, store, ev } = await prelude(event, context);
  const state = begin(store, ev, reads);
  state.unstakeLocked -= event.params.assets;
  state.claims += event.params.assets;
  state.claimCount += 1n;
  finish(context, store, ev, state, "Claimed", event.params.assets, 0n);
  saveStore(context, store);
});

indexer.onEvent({ contract: "Vault", event: "Deposit", fields }, async ({ event, context }) => {
  const { reads, store, ev } = await prelude(event, context);
  const state = begin(store, ev, reads);
  // Cancelled unstake requests redeposit from the Vault itself.
  if (event.params.sender === VAULT) state.unstakeLocked -= event.params.assets;
  state.deposits += event.params.assets;
  state.depositCount += 1n;
  finish(context, store, ev, state, "Deposit", event.params.assets, event.params.shares);
  saveStore(context, store);
});

indexer.onEvent({ contract: "Vault", event: "RewardsSettled", fields }, async ({ event, context }) => {
  const { reads, store, ev } = await prelude(event, context);
  const state = begin(store, ev, reads);
  state.dailyRewards += event.params.rewards;
  state.settlementTotalAssets = event.params.totalAssets;
  finish(context, store, ev, state, "RewardsSettled", event.params.rewards, 0n, event.params.totalAssets);
  saveStore(context, store);
});

indexer.onEvent({ contract: "Vault", event: "TreasurySettled", fields }, async ({ event, context }) => {
  const { reads, store, ev } = await prelude(event, context);
  const state = begin(store, ev, reads);
  state.dailyTreasuryRewards += event.params.treasuryRewards;
  state.treasurySettlementCount += 1n;
  finish(
    context,
    store,
    ev,
    state,
    "TreasurySettled",
    event.params.treasuryRewards,
    0n,
    event.params.treasuryAssets,
  );
  saveStore(context, store);
});

indexer.onEvent(
  { contract: "Vault", event: "TreasuryAssetsClaimed", fields },
  async ({ event, context }) => {
    const { reads, store, ev } = await prelude(event, context);
    const state = begin(store, ev, reads);
    state.treasuryClaims += event.params.assets;
    finish(context, store, ev, state, "TreasuryAssetsClaimed", event.params.assets, 0n);
    saveStore(context, store);
  },
);

async function updateHolder(
  context: EvmOnEventContext,
  state: VaultStateM,
  owner: string,
  delta: bigint,
): Promise<void> {
  if (owner === ZERO) return;
  const existing = await context.Holder.get(owner);
  const holder = existing ? { ...existing } : { id: owner, shares: 0n };
  const wasActive = holder.shares > 0n;
  holder.shares += delta;
  if (state.vaultImplementationReviewed && holder.shares < 0n)
    throw new Error("Negative share balance");
  const active = holder.shares > 0n;
  if (wasActive !== active) state.stakers += active ? 1n : -1n;
  context.Holder.set(holder);
}

// Vault share transfers maintain Holder balances and the staker count.
indexer.onEvent({ contract: "Vault", event: "Transfer", fields }, async ({ event, context }) => {
  const { reads, store, ev } = await prelude(event, context);
  const state = begin(store, ev, reads);
  const { from, to, value } = event.params;
  if (from !== to) {
    await updateHolder(context, state, from, -value);
    await updateHolder(context, state, to, value);
  }
  finish(context, store, ev, state, "Transfer", 0n, value);
  saveStore(context, store);
});

indexer.onEvent({ contract: "Vault", event: "Upgraded", fields }, async ({ event, context }) => {
  const { reads, store, ev } = await prelude(event, context);
  const state = begin(store, ev, reads, event.params.implementation);
  finish(context, store, ev, state, "Upgraded", 0n, 0n);
  saveStore(context, store);
});

// Administration events only record a VaultEvent with fresh checkpoint reads.
const ADMIN_EVENTS = [
  "Approval",
  "Initialized",
  "Paused",
  "Unpaused",
  "RewardRateUpdated",
  "TreasuryRatioUpdated",
  "MaxUnlockRequestsUpdated",
  "UnlockPeriodUpdated",
  "OwnershipTransferred",
] as const;
for (const kind of ADMIN_EVENTS) {
  indexer.onEvent({ contract: "Vault", event: kind, fields }, async ({ event, context }) => {
    const { reads, store, ev } = await prelude(event, context);
    const state = begin(store, ev, reads);
    finish(context, store, ev, state, kind, 0n, 0n);
    saveStore(context, store);
  });
}
