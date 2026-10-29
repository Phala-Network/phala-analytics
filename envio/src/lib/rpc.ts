// Contract and block reads the subgraph gets from graph-node's eth_call and
// block data. They go through the Effect API, so each block is fetched once,
// batched during preload, and cached in the database across restarts.
import { createEffect, S } from "envio";
import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  fallback,
  http,
  parseAbi,
} from "viem";
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

const multicall3Abi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  // Declared view (it is payable on-chain) so viem allows it in eth_call.
  "function aggregate3(Call3[] calls) view returns (Result[] returnData)",
]);
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"; // deployed at block 14353601

const GETTERS = [
  "checkpointTime",
  "checkpointTotalAssets",
  "checkpointTreasuryAssets",
  "rewardRate",
  "treasuryRatio",
  "paused",
  "totalSupply",
] as const;

/**
 * Retries transport failures (rate limits, timeouts, non-archive nodes) so
 * they are never mistaken for contract reverts. Gives up after ~2 minutes and
 * throws, which stops the indexer rather than writing wrong data.
 */
async function withRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  let delay = 500;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= 10) throw new Error(`${what} failed after ${attempt} attempts: ${error}`);
      console.warn(`RPC retry ${attempt} for ${what}: ${String(error).split("\n")[0]}`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 20_000);
    }
  }
}

/**
 * The seven Vault getters the subgraph declares on every Vault event, read at
 * the end of the event's block. `ok` is false only when a getter reverted (or
 * returned undecodable data), which the subgraph's try_ calls treat as an
 * unknown implementation. One Multicall3 aggregate3 eth_call per block; a
 * failed RPC request throws and is retried instead.
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
    const results = await withRetry(`vaultReads@${blockNumber}`, () =>
      client.readContract({
        address: MULTICALL3,
        abi: multicall3Abi,
        functionName: "aggregate3",
        args: [
          GETTERS.map((functionName) => ({
            target: VAULT as `0x${string}`,
            allowFailure: true,
            callData: encodeFunctionData({ abi: vaultAbi, functionName }),
          })),
        ],
        blockNumber: BigInt(blockNumber),
      }),
    );
    const values: (bigint | boolean | undefined)[] = GETTERS.map((functionName, i) => {
      const r = results[i];
      if (!r?.success) return undefined;
      try {
        return decodeFunctionResult({ abi: vaultAbi, functionName, data: r.returnData }) as
          | bigint
          | boolean;
      } catch {
        return undefined;
      }
    });
    const ok = values.every((v) => v !== undefined);
    const big = (i: number) => (typeof values[i] === "bigint" ? (values[i] as bigint) : 0n);
    return {
      ok,
      checkpointTime: big(0),
      checkpointTotalAssets: big(1),
      checkpointTreasuryAssets: big(2),
      rewardRate: big(3),
      treasuryRatio: big(4),
      paused: values[5] === true,
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
    const block = await withRetry(`getBlock@${blockNumber}`, () =>
      client.getBlock({ blockNumber: BigInt(blockNumber) }),
    );
    return block.timestamp;
  },
);
