// Port of ../../../subgraph/src/{state,assets,days}.ts.
//
// graph-node handlers load and save entities synchronously. Here each handler
// loads ChainState and VaultState once into a Store, the ported logic mutates
// that working copy synchronously, and the handler writes it back at the end.
// Day and Latest rows are written as they are produced.
import type {
  BigDecimal,
  ChainDay,
  ChainState,
  ClaimDay,
  Latest,
  VaultDay,
  VaultState,
} from "envio";
import {
  CLAIM_FIELDS,
  COMPONENTS,
  DAY,
  date,
  FIRST_DAY,
  FLOW_FIELDS,
  IMPLEMENTATION,
  ZERO,
} from "./constants";
import { aprOf, ratio, ZERO_DECIMAL } from "./decimal";

export type Mutable<T> = { -readonly [K in keyof T]: T[K] };
export type ChainStateM = Mutable<ChainState>;
export type VaultStateM = Mutable<VaultState>;

export interface Block {
  number: bigint;
  timestamp: bigint;
}

/** Where produced rows go: the handler context, or an array in tests. */
export interface Sink {
  ChainDay(e: ChainDay): void;
  VaultDay(e: VaultDay): void;
  ClaimDay(e: ClaimDay): void;
  Latest(e: Latest): void;
}

export interface Store {
  chain: ChainStateM | undefined;
  /** The saved VaultState. Undefined until the first Vault event finishes. */
  vault: VaultStateM | undefined;
  sink: Sink;
}

export function chainState(store: Store): ChainStateM {
  if (store.chain) return store.chain;
  store.chain = {
    id: "current",
    chain: "ethereum",
    nextDay: FIRST_DAY,
    observedBlockNumber: 0n,
    observedBlockTimestamp: 0n,
    claimsStarted: false,
    totalSupply: 0n,
    reward: 0n,
    sunsetReward: 0n,
    phalaChainBridge: 0n,
    khalaLegacyChainBridge: 0n,
    khalaChainBridge: 0n,
    sygmaBridge: 0n,
    portalBridge: 0n,
    vaultBalance: 0n,
    khalaClaimCount: 0n,
    khalaFree: 0n,
    khalaStaked: 0n,
    phalaClaimCount: 0n,
    phalaFree: 0n,
    phalaStaked: 0n,
  };
  return store.chain;
}

export function newVault(): VaultStateM {
  return {
    id: "current",
    implementation: IMPLEMENTATION,
    vaultImplementationReviewed: true,
    accrualMode: "formula",
    checkpointTime: 0n,
    checkpointTotalAssets: 0n,
    checkpointTreasuryAssets: 0n,
    rewardRate: 0n,
    treasuryRatio: 0n,
    shareSupply: 0n,
    paused: true,
    stakers: 0n,
    unstakeLocked: 0n,
    dailyRewards: 0n,
    dailyTreasuryRewards: 0n,
    deposits: 0n,
    withdrawRequests: 0n,
    claims: 0n,
    treasuryClaims: 0n,
    depositCount: 0n,
    withdrawRequestCount: 0n,
    claimCount: 0n,
    treasurySettlementCount: 0n,
    settlementTotalAssets: undefined,
  };
}

export function markUnreviewed(state: VaultStateM): void {
  state.vaultImplementationReviewed = false;
  state.accrualMode = "checkpoint-only";
}

export interface Assets {
  total: bigint;
  treasury: bigint;
}

// Sourcify Vault._calculateRewards: treasuryRatio is basis points; round
// treasury down first, then give the remainder to shareholders.
// Like the subgraph, this can mark the (saved) state unreviewed as a side effect.
export function assetsAt(state: VaultStateM | undefined, timestamp: bigint): Assets {
  if (!state) return { total: 0n, treasury: 0n };
  if (
    state.vaultImplementationReviewed &&
    (state.checkpointTime > timestamp || state.treasuryRatio > 10000n)
  ) {
    markUnreviewed(state);
  }
  let total = 0n;
  if (state.vaultImplementationReviewed && !state.paused && state.shareSupply > 0n) {
    total = state.rewardRate * (timestamp - state.checkpointTime);
  }
  // BigInt.div truncates toward zero in graph-ts and in JS alike.
  const treasury = (total * state.treasuryRatio) / 10000n;
  return {
    total: state.checkpointTotalAssets + total - treasury,
    treasury: state.checkpointTreasuryAssets + treasury,
  };
}

export function sharePrice(state: VaultStateM | undefined, total: bigint): BigDecimal {
  if (!state || state.shareSupply === 0n) return ZERO_DECIMAL;
  return ratio(total, state.shareSupply);
}

export function apr(state: VaultStateM | undefined, total: bigint): BigDecimal {
  if (
    !state ||
    !state.vaultImplementationReviewed ||
    state.paused ||
    state.shareSupply === 0n ||
    total === 0n
  )
    return ZERO_DECIMAL;
  return aprOf(state.rewardRate, state.treasuryRatio, total);
}

export interface CirculationFields {
  totalSupply: bigint;
  reward: bigint;
  sunsetReward: bigint;
  phalaChainBridge: bigint;
  khalaLegacyChainBridge: bigint;
  khalaChainBridge: bigint;
  sygmaBridge: bigint;
  portalBridge: bigint;
  vaultBalance: bigint;
  vaultTotalAssets: bigint;
  vaultTreasuryAssets: bigint;
  vaultUnstakeLocked: bigint;
  vaultReward: bigint;
  circulation: bigint;
  vaultImplementation: string;
  vaultImplementationReviewed: boolean;
  accrualMode: string;
}

export function circulationFields(
  store: Store,
  state: ChainStateM,
  timestamp: bigint,
): CirculationFields {
  const vault = store.vault;
  const assets = assetsAt(vault, timestamp);
  const locked = vault ? vault.unstakeLocked : 0n;
  // A negative vaultReward is valid when promised rewards exceed funding.
  const reward = state.vaultBalance - assets.total - assets.treasury - locked;
  // Portal escrow backs circulating PHA on Base and remains in circulation.
  const circulation =
    state.totalSupply -
    state.reward -
    state.sunsetReward -
    state.phalaChainBridge -
    state.khalaLegacyChainBridge -
    state.khalaChainBridge -
    state.sygmaBridge -
    reward;
  const out = {} as Record<(typeof COMPONENTS)[number], bigint>;
  for (const f of COMPONENTS) out[f] = state[f];
  return {
    ...out,
    vaultImplementation: vault ? vault.implementation : ZERO,
    vaultImplementationReviewed: !vault || vault.vaultImplementationReviewed,
    accrualMode: vault ? vault.accrualMode : "inactive",
    vaultTotalAssets: assets.total,
    vaultTreasuryAssets: assets.treasury,
    vaultUnstakeLocked: locked,
    vaultReward: reward,
    circulation,
  };
}

// Must precede every mutation: events exactly at midnight belong to the new
// day's flows and cannot change the snapshot at that midnight.
export function closeDaysUpTo(store: Store, block: Block): void {
  const state = chainState(store);
  let boundary = state.nextDay;
  const vault = store.vault;
  while (boundary <= block.timestamp) {
    const id = date(boundary);
    store.sink.ChainDay({
      id,
      chain: state.chain,
      date: id,
      timestamp: boundary,
      observedBlockNumber: state.observedBlockNumber,
      observedBlockTimestamp: state.observedBlockTimestamp,
      ...circulationFields(store, state, boundary),
    });
    if (vault) {
      const amounts = assetsAt(vault, boundary);
      const flows = {} as Record<(typeof FLOW_FIELDS)[number], bigint>;
      for (const f of FLOW_FIELDS) flows[f] = vault[f];
      store.sink.VaultDay({
        id,
        date: id,
        flowDate: date(boundary - DAY),
        timestamp: boundary,
        observedBlockNumber: state.observedBlockNumber,
        observedBlockTimestamp: state.observedBlockTimestamp,
        totalAssets: amounts.total,
        treasuryAssets: amounts.treasury,
        shareSupply: vault.shareSupply,
        sharePrice: sharePrice(vault, amounts.total),
        apr: apr(vault, amounts.total),
        stakers: vault.stakers,
        unstakeLocked: vault.unstakeLocked,
        rewardRate: vault.rewardRate,
        treasuryRatio: vault.treasuryRatio,
        paused: vault.paused,
        vaultImplementation: vault.implementation,
        vaultImplementationReviewed: vault.vaultImplementationReviewed,
        accrualMode: vault.accrualMode,
        ...flows,
        settlementTotalAssets: vault.settlementTotalAssets,
      });
      for (const f of FLOW_FIELDS) vault[f] = 0n;
      vault.settlementTotalAssets = undefined;
    }
    if (state.claimsStarted) {
      const claims = {} as Record<(typeof CLAIM_FIELDS)[number], bigint>;
      for (const f of CLAIM_FIELDS) claims[f] = state[f];
      store.sink.ClaimDay({
        id,
        date: id,
        flowDate: date(boundary - DAY),
        timestamp: boundary,
        ...claims,
      });
      for (const f of CLAIM_FIELDS) state[f] = 0n;
    }
    boundary += DAY;
  }
  state.nextDay = boundary;
}

// Event handlers refresh after mutation; the Clock refreshes after all logs
// in its polled block. Block metadata is last observed, not a midnight lookup.
export function refreshLatest(store: Store, block: Block): void {
  const state = chainState(store);
  state.observedBlockNumber = block.number;
  state.observedBlockTimestamp = block.timestamp;
  const fields = circulationFields(store, state, block.timestamp);
  const vault = store.vault;
  const amounts = assetsAt(vault, block.timestamp);
  store.sink.Latest({
    id: "current",
    chain: state.chain,
    timestamp: block.timestamp,
    observedBlockNumber: block.number,
    observedBlockTimestamp: block.timestamp,
    ...fields,
    shareSupply: vault ? vault.shareSupply : 0n,
    sharePrice: sharePrice(vault, amounts.total),
    apr: apr(vault, amounts.total),
    stakers: vault ? vault.stakers : 0n,
  });
}
