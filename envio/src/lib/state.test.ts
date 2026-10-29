import type { ChainDay, ClaimDay, Latest, VaultDay } from "envio";
import { describe, expect, it } from "vitest";
import { date, inS, logId, S_ADDRESSES } from "./constants";
import { aprOf, ratio } from "./decimal";
import {
  assetsAt,
  closeDaysUpTo,
  newVault,
  refreshLatest,
  type Sink,
  type Store,
} from "./state";

function memoryStore() {
  const rows = {
    ChainDay: [] as ChainDay[],
    VaultDay: [] as VaultDay[],
    ClaimDay: [] as ClaimDay[],
    Latest: [] as Latest[],
  };
  const sink: Sink = {
    ChainDay: (e) => rows.ChainDay.push(e),
    VaultDay: (e) => rows.VaultDay.push(e),
    ClaimDay: (e) => rows.ClaimDay.push(e),
    Latest: (e) => rows.Latest.push(e),
  };
  const store: Store = { chain: undefined, vault: undefined, sink };
  return Object.assign(store, { rows });
}

describe("ids", () => {
  it("matches graph-ts concatI32 (little-endian log index)", () => {
    // Live subgraph row: logIndex 842 -> 0x4a030000
    expect(
      logId(
        "0x780e762e4a66cb0806b87024430589b890aa2955fb404db18e87ef5756281ef0",
        842,
      ),
    ).toBe(
      "0x780e762e4a66cb0806b87024430589b890aa2955fb404db18e87ef5756281ef04a030000",
    );
  });
  it("uses UTC dates", () => {
    expect(date(1588204800n)).toBe("2020-04-30");
  });
  it("S has nine addresses including zero", () => {
    expect(S_ADDRESSES).toHaveLength(9);
    expect(inS("0x0000000000000000000000000000000000000000")).toBe(true);
    expect(inS("0x21D6EC8FC14CAACC55AFA23CBA66798DAB3A0EC0")).toBe(true);
    expect(inS("0x0000000000000000000000000000000000000001")).toBe(false);
  });
});

describe("BigDecimal parity with graph-node (34 significant digits, half-up)", () => {
  // Live subgraph VaultDay 2026-10-29.
  it("sharePrice", () => {
    expect(
      ratio(
        113522437739535819101178989n,
        86306487381056231991539781n,
      ).toFixed(),
    ).toBe("1.315340725643450629643493509225852");
  });
  it("apr", () => {
    expect(
      aprOf(556182861328125000n, 2000n, 113522437739535819101178989n).toFixed(),
    ).toBe("0.1236039892313571684478106234068232");
  });
});

describe("assetsAt", () => {
  it("accrues with the treasury share floored first", () => {
    const v = {
      ...newVault(),
      paused: false,
      shareSupply: 1n,
      rewardRate: 3n,
      treasuryRatio: 3333n,
    };
    v.checkpointTime = 100n;
    v.checkpointTotalAssets = 1000n;
    // rewards = 3 * 10 = 30, treasury = floor(30 * 3333 / 10000) = 9
    expect(assetsAt(v, 110n)).toEqual({ total: 1021n, treasury: 9n });
  });
  it("falls back to checkpoint-only for a future checkpoint", () => {
    const v = {
      ...newVault(),
      paused: false,
      shareSupply: 1n,
      rewardRate: 3n,
      checkpointTime: 200n,
    };
    expect(assetsAt(v, 110n)).toEqual({ total: 0n, treasury: 0n });
    expect(v.vaultImplementationReviewed).toBe(false);
    expect(v.accrualMode).toBe("checkpoint-only");
  });
});

describe("closeDaysUpTo", () => {
  it("writes one ChainDay per midnight, observed block from before closure", () => {
    const store = memoryStore();
    refreshLatest(store, { number: 10n, timestamp: 1588204800n + 3600n });
    closeDaysUpTo(store, { number: 20n, timestamp: 1588204800n + 2n * 86400n });
    expect(store.rows.ChainDay.map((d) => d.id)).toEqual([
      "2020-04-30",
      "2020-05-01",
      "2020-05-02",
    ]);
    // 2020-04-30 is closed by the first call; later days observed block 10.
    expect(store.rows.ChainDay[1]?.observedBlockNumber).toBe(10n);
    expect(store.chain?.nextDay).toBe(1588204800n + 3n * 86400n);
    // No vault and no claims yet: no VaultDay / ClaimDay rows.
    expect(store.rows.VaultDay).toHaveLength(0);
    expect(store.rows.ClaimDay).toHaveLength(0);
  });
  it("resets vault flows after each VaultDay", () => {
    const store = memoryStore();
    store.vault = {
      ...newVault(),
      deposits: 5n,
      depositCount: 1n,
      settlementTotalAssets: 7n,
    };
    closeDaysUpTo(store, { number: 1n, timestamp: 1588204800n + 86400n });
    const [first, second] = store.rows.VaultDay;
    expect(first?.deposits).toBe(5n);
    expect(first?.settlementTotalAssets).toBe(7n);
    expect(second?.deposits).toBe(0n);
    expect(second?.settlementTotalAssets).toBeUndefined();
  });
});
