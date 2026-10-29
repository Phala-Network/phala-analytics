import assert from "node:assert/strict";
import { checkedMeta, gql, meta, page } from "./verify-graph";
import { type Row, record, text, utcDate } from "./verify-lib";

const COMPONENTS =
  "totalSupply reward sunsetReward phalaChainBridge khalaLegacyChainBridge khalaChainBridge sygmaBridge portalBridge vaultBalance vaultTotalAssets vaultTreasuryAssets vaultUnstakeLocked vaultReward circulation";
export const ENTITIES = [
  {
    type: "ChainDay",
    entity: "chainDays",
    fields: `id chain date timestamp observedBlockNumber observedBlockTimestamp vaultImplementation vaultImplementationReviewed accrualMode ${COMPONENTS}`,
  },
  {
    type: "VaultDay",
    entity: "vaultDays",
    fields:
      "id date flowDate timestamp observedBlockNumber observedBlockTimestamp totalAssets treasuryAssets shareSupply sharePrice apr stakers unstakeLocked rewardRate treasuryRatio paused dailyRewards dailyTreasuryRewards deposits withdrawRequests claims treasuryClaims depositCount withdrawRequestCount claimCount treasurySettlementCount settlementTotalAssets vaultImplementation vaultImplementationReviewed accrualMode",
  },
  {
    type: "ClaimDay",
    entity: "claimDays",
    fields:
      "id date flowDate timestamp khalaClaimCount khalaFree khalaStaked phalaClaimCount phalaFree phalaStaked",
  },
  {
    type: "VaultEvent",
    entity: "vaultEvents",
    bytes: true,
    fields:
      "id kind assets shares settlementAssets blockNumber timestamp transactionHash logIndex unstakeLockedAfter checkpointTime checkpointTotalAssets checkpointTreasuryAssets rewardRate treasuryRatio shareSupply paused implementation vaultImplementationReviewed accrualMode",
  },
  {
    type: "Transfer",
    entity: "transfers",
    bytes: true,
    fields: "id from to amount blockNumber timestamp transactionHash logIndex",
  },
  {
    type: "Claimed",
    entity: "claimeds",
    fields:
      "id block_number timestamp_ transactionHash_ contractId_ user free staked receiver",
  },
  {
    type: "ClaimedAndBridged",
    entity: "claimedAndBridgeds",
    fields:
      "id block_number timestamp_ transactionHash_ contractId_ user free staked l1Receiver l2Receiver",
  },
  {
    type: "Latest",
    entity: "latests",
    fields: `id chain timestamp observedBlockNumber observedBlockTimestamp ${COMPONENTS} shareSupply sharePrice apr stakers vaultImplementation vaultImplementationReviewed accrualMode`,
  },
  {
    type: "VaultState",
    entity: "vaultStates",
    fields:
      "id implementation checkpointTime checkpointTotalAssets checkpointTreasuryAssets rewardRate treasuryRatio paused shareSupply stakers unstakeLocked dailyRewards dailyTreasuryRewards deposits withdrawRequests claims treasuryClaims depositCount withdrawRequestCount claimCount treasurySettlementCount settlementTotalAssets vaultImplementationReviewed accrualMode",
  },
  { type: "Holder", entity: "holders", bytes: true, fields: "id shares" },
  {
    type: "ChainState",
    entity: "chainStates",
    fields:
      "id chain nextDay observedBlockNumber observedBlockTimestamp claimsStarted totalSupply reward sunsetReward phalaChainBridge khalaLegacyChainBridge khalaChainBridge sygmaBridge portalBridge vaultBalance khalaClaimCount khalaFree khalaStaked phalaClaimCount phalaFree phalaStaked",
  },
];
type Entity = (typeof ENTITIES)[number];

// Only numeric metrics can be exempted. Identity, dates, block provenance,
// implementation review and accrual dispatch must always match.
const METRIC_FIELDS =
  /^(totalSupply|reward|sunsetReward|phalaChainBridge|khalaLegacyChainBridge|khalaChainBridge|sygmaBridge|portalBridge|vaultBalance|vaultTotalAssets|vaultTreasuryAssets|vaultUnstakeLocked|vaultReward|circulation|totalAssets|treasuryAssets|shareSupply|sharePrice|apr|stakers|unstakeLocked|rewardRate|treasuryRatio|dailyRewards|dailyTreasuryRewards|deposits|withdrawRequests|claims|treasuryClaims|depositCount|withdrawRequestCount|claimCount|treasurySettlementCount|settlementTotalAssets|assets|shares|settlementAssets|unstakeLockedAfter|checkpointTotalAssets|checkpointTreasuryAssets|amount|free|staked|khalaClaimCount|khalaFree|khalaStaked|phalaClaimCount|phalaFree|phalaStaked)$/;
export function expectedFields(value: string | undefined): Set<string> {
  const fields = new Set(
    value === undefined ? [] : value.split(",").map((field) => field.trim()),
  );
  for (const field of fields) {
    const entity = ENTITIES.find((item) => field.startsWith(`${item.type}.`));
    const name = field.slice((entity?.type.length ?? 0) + 1);
    assert.ok(
      entity?.fields.split(" ").includes(name),
      `Unknown expected field ${field}; use Entity.field names`,
    );
    assert.ok(
      METRIC_FIELDS.test(name),
      `Cannot exempt identity or safety field ${field}`,
    );
  }
  return fields;
}

export interface Difference {
  entity: string;
  field: string;
  date: string;
  id: string;
  previous: unknown;
  candidate: unknown;
  delta: string | null;
  expected: boolean;
}
export function compareEntities(
  entity: Entity,
  candidate: Row[],
  previous: Row[],
  expected: Set<string>,
): Difference[] {
  assert.equal(
    candidate.length,
    previous.length,
    `${entity.type} count differs`,
  );
  if (["Latest", "VaultState", "ChainState"].includes(entity.type)) {
    assert.equal(candidate.length, 1, `Missing ${entity.type} singleton`);
    assert.equal(
      candidate[0]?.id,
      "current",
      `Invalid ${entity.type} singleton`,
    );
  }
  if (entity.type === "ChainDay")
    assert.ok(candidate.length > 0, "No daily entities at comparison block");
  const differences: Difference[] = [];
  for (let index = 0; index < previous.length; index++) {
    const before = previous[index];
    const after = candidate[index];
    assert.ok(before && after);
    assert.equal(after.id, before.id, `${entity.type} ID set differs`);
    for (const row of [before, after])
      assert.deepEqual(
        Object.keys(row).sort(),
        entity.fields.split(" ").sort(),
        `${entity.type} fields differ`,
      );
    if ("vaultImplementationReviewed" in after)
      assert.equal(
        after.vaultImplementationReviewed,
        true,
        `${entity.type} has an unreviewed Vault implementation`,
      );
    for (const field of entity.fields.split(" ")) {
      if (after[field] === before[field]) continue;
      const oldValue = before[field];
      const newValue = after[field];
      const timestamp = after.timestamp ?? after.timestamp_;
      const date =
        typeof after.date === "string"
          ? utcDate(after.date)
          : typeof timestamp === "string" && /^\d+$/.test(timestamp)
            ? new Date(Number(timestamp) * 1000).toISOString().slice(0, 10)
            : "current";
      differences.push({
        entity: entity.type,
        field,
        date,
        id: text(after.id),
        previous: oldValue,
        candidate: newValue,
        delta:
          typeof oldValue === "string" &&
          typeof newValue === "string" &&
          /^-?\d+$/.test(oldValue) &&
          /^-?\d+$/.test(newValue)
            ? (BigInt(newValue) - BigInt(oldValue)).toString()
            : null,
        expected: expected.has(`${entity.type}.${field}`),
      });
    }
  }
  return differences;
}

function summaries(differences: Difference[]): Row[] {
  const groups = new Map<string, Row>();
  for (const diff of differences) {
    const key = `${diff.date} ${diff.entity}.${diff.field}`;
    const previous = groups.get(key);
    if (previous) {
      previous.count = Number(previous.count) + 1;
      previous.delta =
        previous.delta !== null && diff.delta !== null
          ? (BigInt(text(previous.delta)) + BigInt(diff.delta)).toString()
          : null;
    } else
      groups.set(key, {
        date: diff.date,
        field: `${diff.entity}.${diff.field}`,
        count: 1,
        previous: diff.previous,
        candidate: diff.candidate,
        delta: diff.delta,
        expected: diff.expected,
      });
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => value);
}

export interface UpgradeOptions {
  candidate: string;
  production: string;
  margin: number;
  expected: Set<string>;
}
export async function upgrade(
  options: UpgradeOptions,
  report: Row,
): Promise<void> {
  const previousMeta = await meta(options.production);
  const candidateMeta = await meta(options.candidate);
  const block =
    Math.min(
      Number(record(previousMeta.block).number),
      Number(record(candidateMeta.block).number),
    ) - options.margin;
  assert.ok(block > 0, "Comparison block must be positive");
  report.comparisonBlock = block;
  report.safetyMargin = options.margin;
  report.deployments = {
    production: previousMeta.deployment,
    candidate: candidateMeta.deployment,
  };
  report.heads = {
    production: record(previousMeta.block).number,
    candidate: record(candidateMeta.block).number,
  };
  report.expectedFields = [...options.expected].sort();
  const counts: Row = {};
  report.entities = counts;
  const differences: Difference[] = [];
  report.differences = differences;
  // Probe mutable state first. Never substitute a head query if a fixed block
  // has been pruned; doing so would silently compare different chain states.
  for (const [url, deployment] of [
    [options.production, previousMeta.deployment],
    [options.candidate, candidateMeta.deployment],
  ] as const) {
    let data: Row;
    try {
      data = await gql(
        url,
        'query($block:Int!){_meta(block:{number:$block}){deployment hasIndexingErrors block{number}} latest(id:"current",block:{number:$block}){id vaultImplementationReviewed} vaultState(id:"current",block:{number:$block}){id vaultImplementationReviewed}}',
        { block },
      );
    } catch {
      assert.fail(
        "Common block is unavailable (possibly pruned). Wait for candidate sync, restart near both heads, or reduce --safety-margin after assessing reorg risk; never compare at separate heads.",
      );
    }
    checkedMeta(data._meta, text(deployment), block);
    assert.equal(
      record(data.latest).vaultImplementationReviewed,
      true,
      "Unreviewed Vault implementation at comparison block",
    );
    assert.equal(
      record(data.vaultState).vaultImplementationReviewed,
      true,
      "Unreviewed Vault state at comparison block",
    );
  }
  await reviewedHead(options.candidate, text(candidateMeta.deployment));
  for (const entity of ENTITIES) {
    const candidate = await page(
      options.candidate,
      entity.entity,
      entity.fields,
      {
        bytes: entity.bytes,
        block,
        deployment: text(candidateMeta.deployment),
      },
    );
    const previous = await page(
      options.production,
      entity.entity,
      entity.fields,
      { bytes: entity.bytes, block, deployment: text(previousMeta.deployment) },
    );
    counts[entity.type] = {
      production: previous.length,
      candidate: candidate.length,
    };
    differences.push(
      ...compareEntities(entity, candidate, previous, options.expected),
    );
  }
  // A tag, health or implementation change during paging invalidates the run.
  checkedMeta(await meta(options.production), text(previousMeta.deployment));
  await reviewedHead(options.candidate, text(candidateMeta.deployment));
  const diffSummary = summaries(differences);
  report.diffSummary = diffSummary;
  for (const summary of diffSummary) console.log(JSON.stringify(summary));
  const unexpected = differences.filter((diff) => !diff.expected);
  assert.equal(
    unexpected.length,
    0,
    `Unexpected field differences: ${unexpected.length}; see per-date diff summary`,
  );
}

async function reviewedHead(url: string, deployment: string): Promise<void> {
  const head = await gql(
    url,
    '{_meta{deployment hasIndexingErrors block{number}} latest(id:"current"){vaultImplementationReviewed} vaultState(id:"current"){vaultImplementationReviewed}}',
  );
  checkedMeta(head._meta, deployment);
  assert.equal(
    record(head.latest).vaultImplementationReviewed,
    true,
    "Unreviewed candidate Vault implementation at head",
  );
  assert.equal(
    record(head.vaultState).vaultImplementationReviewed,
    true,
    "Unreviewed candidate Vault state at head",
  );
}
