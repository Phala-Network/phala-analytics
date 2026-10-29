// Mirrors ../../../subgraph/src/constants.ts.
export const ZERO = "0x0000000000000000000000000000000000000000";
export const PHA = "0x6c5ba91642f10282b576d91922ae6448c9d52f4e";
export const VAULT = "0x21d6ec8fc14caacc55afa23cba66798dab3a0ec0";
export const IMPLEMENTATION = "0xc0b39989381d8c88b7ef82a80d4c90540e70862a";
export const DAY = 86400n;
// The deployment date's midnight is the initial, zero-supply snapshot.
export const FIRST_DAY = 1588204800n;
// Clock data source: polling every 25 blocks from this block.
export const CLOCK_START_BLOCK = 26283000;
export const CLOCK_EVERY = 25;

export const COMPONENTS = [
  "totalSupply",
  "reward",
  "sunsetReward",
  "phalaChainBridge",
  "khalaLegacyChainBridge",
  "khalaChainBridge",
  "sygmaBridge",
  "portalBridge",
  "vaultBalance",
] as const;
export const FLOW_FIELDS = [
  "dailyRewards",
  "dailyTreasuryRewards",
  "deposits",
  "withdrawRequests",
  "claims",
  "treasuryClaims",
  "depositCount",
  "withdrawRequestCount",
  "claimCount",
  "treasurySettlementCount",
] as const;
export const CLAIM_FIELDS = [
  "khalaClaimCount",
  "khalaFree",
  "khalaStaked",
  "phalaClaimCount",
  "phalaFree",
  "phalaStaked",
] as const;

export type Component = Exclude<(typeof COMPONENTS)[number], "totalSupply">;

const COMPONENT_BY_ADDRESS: Record<string, Component> = {
  "0x4731bc41b3cca4c2883b8ebb68cb546d5b3b4dd6": "reward",
  "0xcd38b15a419491c7c1238b0659f65c755792e257": "phalaChainBridge",
  "0x6ed3bc069cf4f87de05c04c352e8356492ec6efe": "khalaLegacyChainBridge",
  "0xeec0fb4913119567cdfc0c5fc2bf8f9f9b226c2d": "khalaChainBridge",
  "0xc832588193cd5ed2185dada4a531e0b26ec5b830": "sygmaBridge",
  "0x3ee18b2214aff97000d974cf647e7c347e8fa585": "portalBridge",
  "0x4a396b5c9a6fbc1bc0525f24ac0a246766f3ebef": "sunsetReward",
  [VAULT]: "vaultBalance",
};

export function component(address: string): Component | undefined {
  return COMPONENT_BY_ADDRESS[address.toLowerCase()];
}
export function inS(address: string): boolean {
  return address.toLowerCase() === ZERO || component(address) !== undefined;
}
/** The set S: tracked addresses plus the zero address (mint/burn). */
export const S_ADDRESSES = [
  ZERO,
  ...Object.keys(COMPONENT_BY_ADDRESS),
] as `0x${string}`[];

export function date(timestamp: bigint): string {
  return new Date(Number(timestamp) * 1000).toISOString().slice(0, 10);
}

/** graph-ts `txHash.concatI32(logIndex)`: hash bytes + little-endian i32. */
export function logId(txHash: string, logIndex: number): string {
  const b = Buffer.alloc(4);
  b.writeInt32LE(logIndex);
  return txHash.toLowerCase() + b.toString("hex");
}
