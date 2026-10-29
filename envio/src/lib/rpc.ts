// Contract and block reads the subgraph gets from graph-node's eth_call and
// block data. They go through the Effect API, so each block is fetched once,
// batched during preload, and cached in the database across restarts.
import { createEffect, S } from "envio";
import { createPublicClient, fallback, http, parseAbi } from "viem";
import { mainnet } from "viem/chains";
import { VAULT } from "./constants";

// Archive-capable public endpoints. Set ENVIO_RPC_URL (comma-separated for
// several) to use your own; a paid or self-hosted node is recommended.
const DEFAULT_RPC = [
  "https://eth.drpc.org",
  "https://mainnet.gateway.tenderly.co",
  "https://eth-mainnet.public.blastapi.io",
];
const urls = process.env.ENVIO_RPC_URL
  ? process.env.ENVIO_RPC_URL.split(",").map((u) => u.trim()).filter(Boolean)
  : DEFAULT_RPC;

const client = createPublicClient({
  chain: mainnet,
  transport: fallback(
    urls.map((url) => http(url, { batch: { batchSize: 20 }, retryCount: 5, timeout: 30_000 })),
  ),
});

const vaultAbi = parseAbi([
  "function checkpointTime() view returns (uint256)",
  "function checkpointTotalAssets() view returns (uint256)",
  "function checkpointTreasuryAssets() view returns (uint256)",
  "function rewardRate() view returns (uint256)",
  "function treasuryRatio() view returns (uint256)",
  "function paused() view returns (bool)",
  "function totalSupply() view returns (uint256)",
]);

/**
 * The seven Vault getters the subgraph declares on every Vault event, read at
 * the end of the event's block. `ok` is false when any getter reverted, which
 * the subgraph treats as an unknown implementation (try_ semantics).
 */
export const vaultReads = createEffect(
  {
    name: "vaultReads",
    input: S.number,
    output: S.schema({
      ok: S.boolean,
      checkpointTime: S.bigint,
      checkpointTotalAssets: S.bigint,
      checkpointTreasuryAssets: S.bigint,
      rewardRate: S.bigint,
      treasuryRatio: S.bigint,
      paused: S.boolean,
      totalSupply: S.bigint,
    }),
    cache: true,
    rateLimit: false,
  },
  async ({ input: blockNumber }) => {
    const call = (functionName: (typeof vaultAbi)[number]["name"]) =>
      ({ address: VAULT, abi: vaultAbi, functionName }) as const;
    // One Multicall3 eth_call per block; allowFailure keeps per-getter reverts.
    const r = await client.multicall({
      contracts: [
        call("checkpointTime"),
        call("checkpointTotalAssets"),
        call("checkpointTreasuryAssets"),
        call("rewardRate"),
        call("treasuryRatio"),
        call("paused"),
        call("totalSupply"),
      ],
      blockNumber: BigInt(blockNumber),
      allowFailure: true,
    });
    const ok = r.every((x) => x.status === "success");
    const big = (i: number) => (r[i]?.status === "success" ? (r[i]!.result as bigint) : 0n);
    return {
      ok,
      checkpointTime: big(0),
      checkpointTotalAssets: big(1),
      checkpointTreasuryAssets: big(2),
      rewardRate: big(3),
      treasuryRatio: big(4),
      paused: r[5]?.status === "success" ? (r[5]!.result as boolean) : false,
      totalSupply: big(6),
    };
  },
);

/** Block timestamp for the Clock (onBlock handlers only receive the number). */
export const blockTimestamp = createEffect(
  {
    name: "blockTimestamp",
    input: S.number,
    output: S.bigint,
    cache: true,
    rateLimit: false,
  },
  async ({ input: blockNumber }) => {
    const block = await client.getBlock({ blockNumber: BigInt(blockNumber) });
    return block.timestamp;
  },
);
