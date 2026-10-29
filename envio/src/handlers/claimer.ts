// Port of subgraph/src/claimer.ts (Khala and Phala sunset claimers).
import { indexer } from "envio";
import {
  type Block,
  chainState,
  closeDaysUpTo,
  refreshLatest,
  type Store,
} from "../lib/state";
import { loadStore, saveStore } from "../lib/store";

function addClaim(
  store: Store,
  block: Block,
  chain: "khala" | "phala",
  free: bigint,
  staked: bigint,
) {
  const state = chainState(store);
  state.claimsStarted = true;
  if (chain === "khala") {
    state.khalaClaimCount += 1n;
    state.khalaFree += free;
    state.khalaStaked += staked;
  } else {
    state.phalaClaimCount += 1n;
    state.phalaFree += free;
    state.phalaStaked += staked;
  }
  refreshLatest(store, block);
}

indexer.onEvent(
  {
    contract: "KhalaClaimer",
    event: "Claimed",
    fields: { block: ["timestamp"], transaction: ["hash"] },
  },
  async ({ event, context }) => {
    const store = await loadStore(context);
    const block = {
      number: BigInt(event.block.number),
      timestamp: BigInt(event.block.timestamp),
    };
    closeDaysUpTo(store, block);
    context.Claimed.set({
      id: `${event.transaction.hash}-${event.logIndex}`,
      block_number: block.number,
      timestamp_: block.timestamp,
      transactionHash_: event.transaction.hash,
      contractId_: event.srcAddress.toLowerCase(),
      user: event.params.user,
      free: event.params.free,
      staked: event.params.staked,
      receiver: event.params.receiver,
    });
    addClaim(store, block, "khala", event.params.free, event.params.staked);
    saveStore(context, store);
  },
);

indexer.onEvent(
  {
    contract: "PhalaClaimer",
    event: "ClaimedAndBridged",
    fields: { block: ["timestamp"], transaction: ["hash"] },
  },
  async ({ event, context }) => {
    const store = await loadStore(context);
    const block = {
      number: BigInt(event.block.number),
      timestamp: BigInt(event.block.timestamp),
    };
    closeDaysUpTo(store, block);
    context.ClaimedAndBridged.set({
      id: `${event.transaction.hash}-${event.logIndex}`,
      block_number: block.number,
      timestamp_: block.timestamp,
      transactionHash_: event.transaction.hash,
      contractId_: event.srcAddress.toLowerCase(),
      user: event.params.user,
      free: event.params.free,
      staked: event.params.staked,
      l1Receiver: event.params.l1Receiver,
      l2Receiver: event.params.l2Receiver,
    });
    addClaim(store, block, "phala", event.params.free, event.params.staked);
    saveStore(context, store);
  },
);
