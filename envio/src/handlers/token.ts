// Port of subgraph/src/token.ts. The subgraph uses two data sources on the
// same PHA Transfer event (TokenFrom: topic1 in S, TokenTo: topic2 in S).
// Here one handler receives each matching log once and applies both sides in
// the same order: From side first, then To side.
import { indexer } from "envio";
import { component, inS, logId, S_ADDRESSES, ZERO } from "../lib/constants";
import {
  type Block,
  chainState,
  closeDaysUpTo,
  refreshLatest,
  type Store,
} from "../lib/state";
import { loadStore, saveStore } from "../lib/store";

function applySide(
  store: Store,
  block: Block,
  address: string,
  delta: bigint,
): void {
  closeDaysUpTo(store, block);
  const state = chainState(store);
  const field = component(address);
  if (field) state[field] += delta;
  if (address === ZERO) state.totalSupply -= delta;
  refreshLatest(store, block);
}

indexer.onEvent(
  {
    contract: "Token",
    event: "Transfer",
    where: { params: [{ from: S_ADDRESSES }, { to: S_ADDRESSES }] },
    fields: { block: ["timestamp"], transaction: ["hash"] },
  },
  async ({ event, context }) => {
    const store = await loadStore(context);
    const block = {
      number: BigInt(event.block.number),
      timestamp: BigInt(event.block.timestamp),
    };
    const { from, to, value } = event.params;
    // Each log is stored once, even S to S.
    if (inS(from) || inS(to)) {
      context.Transfer.set({
        id: logId(event.transaction.hash, event.logIndex),
        from,
        to,
        amount: value,
        blockNumber: block.number,
        timestamp: block.timestamp,
        transactionHash: event.transaction.hash,
        logIndex: BigInt(event.logIndex),
      });
    }
    if (inS(from)) applySide(store, block, from, -value);
    if (inS(to)) applySide(store, block, to, value);
    saveStore(context, store);
  },
);
