// Port of subgraph/src/clock.ts: the Clock data source polls every 25 blocks
// from block 26283000 to close quiet days and refresh Latest.
import { indexer } from "envio";
import { CLOCK_EVERY, CLOCK_START_BLOCK } from "../lib/constants";
import { blockTimestamp } from "../lib/rpc";
import { closeDaysUpTo, refreshLatest } from "../lib/state";
import { loadStore, saveStore } from "../lib/store";

indexer.onBlock(
  {
    name: "Clock",
    where: ({ chain }) => {
      if (chain.id !== 1) return false;
      return {
        block: { number: { _gte: CLOCK_START_BLOCK, _every: CLOCK_EVERY } },
      };
    },
  },
  async ({ block, context }) => {
    const timestamp = await context.effect(blockTimestamp, block.number);
    const store = await loadStore(context);
    const b = { number: BigInt(block.number), timestamp };
    closeDaysUpTo(store, b);
    refreshLatest(store, b);
    saveStore(context, store);
  },
);
