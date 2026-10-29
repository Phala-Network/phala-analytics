import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { gql, meta, PRODUCTION_URL, page } from "./verify-graph";
import {
  abs,
  CLAIM_FIELDS,
  claimerExport,
  compareArchive,
  compareClaimers,
  compareSnapshot,
  compareVault,
  compareVaultConsistency,
  dated,
  exportRows,
  type Row,
  record,
  type SnapshotComparison,
  START_DATE,
  text,
  utcDate,
} from "./verify-lib";
import { ENTITIES, expectedFields, upgrade } from "./verify-upgrade";

const fields = (type: string): string => {
  const entity = ENTITIES.find((entity) => entity.type === type);
  assert.ok(entity);
  return entity.fields;
};
const DAY_FIELDS = fields("ChainDay");
const VAULT_FIELDS = fields("VaultDay");
const EVENT_FIELDS = fields("VaultEvent");
const required = (value: string | undefined, label: string): string => {
  assert.ok(value, `Missing ${label}`);
  return value;
};
export function args(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      stage: { type: "string", default: "upgrade" },
      candidate: { type: "string" },
      ethereum: { type: "string" },
      production: { type: "string", default: PRODUCTION_URL },
      "safety-margin": { type: "string", default: "64" },
      "expect-diff": { type: "string" },
      "allow-same-deployment": { type: "boolean", default: false },
      "snapshot-cache": { type: "string" },
      ndjson: { type: "string" },
      results: { type: "string" },
      "old-khala-export": { type: "string" },
      "old-phala-export": { type: "string" },
      output: { type: "string", default: "verification-results.json" },
    },
  });
  assert.ok(
    ["upgrade", "historical"].includes(values.stage),
    "Use --stage upgrade or historical",
  );
  assert.ok(
    !values.candidate ||
      !values.ethereum ||
      values.candidate === values.ethereum,
    "Conflicting --candidate and --ethereum",
  );
  const margin = Number(values["safety-margin"]);
  assert.ok(
    /^\d+$/.test(values["safety-margin"]) &&
      Number.isSafeInteger(margin) &&
      margin >= 0,
    "Invalid --safety-margin",
  );
  const options = {
    ...values,
    candidate: required(
      values.candidate ?? values.ethereum ?? process.env.GOLDSKY_ETHEREUM_URL,
      "--candidate / GOLDSKY_ETHEREUM_URL",
    ),
    margin,
    allowSameDeployment: values["allow-same-deployment"],
    expected: expectedFields(values["expect-diff"]),
    ndjson: values.ndjson ?? process.env.SNAPSHOTS_NDJSON,
    results: values.results ?? process.env.DUNE_RESULTS_JSON,
  };
  if (values.stage === "upgrade") {
    for (const option of [
      "snapshot-cache",
      "ndjson",
      "results",
      "old-khala-export",
      "old-phala-export",
    ] as const)
      assert.equal(
        values[option],
        undefined,
        `--${option} applies only to historical comparisons`,
      );
  } else {
    assert.equal(
      options.allowSameDeployment,
      false,
      "--allow-same-deployment applies only to upgrade comparisons",
    );
    assert.equal(
      options.expected.size,
      0,
      "--expect-diff applies only to upgrade comparisons",
    );
    assert.ok(
      options["snapshot-cache"] ||
        options.ndjson ||
        options.results ||
        options["old-khala-export"] ||
        options["old-phala-export"],
      "Historical mode requires at least one archive input",
    );
    if (options.ndjson || options.results)
      required(
        options["snapshot-cache"],
        "--snapshot-cache from before the API cutover for circulation archives",
      );
  }
  return options;
}
type Options = ReturnType<typeof args>;
interface Evidence {
  ethereum: Row[];
  vault: Row[];
  events: Row[];
  meta: { ethereum?: Row };
  comparisons: Map<string, SnapshotComparison>;
  oldSnapshots: Map<string, Row>;
}
export async function load(options: Options): Promise<Evidence> {
  const evidence: Evidence = {
    ethereum: [],
    vault: [],
    events: [],
    meta: {},
    comparisons: new Map(),
    oldSnapshots: new Map(),
  };
  const cutoffOptions = (metaValue: Row) => ({
    filter: "timestamp_lte:$cutoff",
    declarations: ",$cutoff:BigInt!",
    variables: { cutoff: String(record(metaValue.block).timestamp) },
  });
  const url = options.candidate;
  const indexed = await meta(url);
  evidence.meta.ethereum = indexed;
  assert.ok(
    Number.isSafeInteger(record(indexed.block).timestamp),
    "Missing indexed block timestamp",
  );
  const latest = record(
    (
      await gql(
        url,
        '{latest(id:"current"){timestamp vaultImplementationReviewed accrualMode}}',
      )
    ).latest,
  );
  assert.equal(
    latest.vaultImplementationReviewed,
    true,
    "Unreviewed Vault implementation; review before promotion",
  );
  evidence.ethereum = await page(
    url,
    "chainDays",
    DAY_FIELDS,
    cutoffOptions(indexed),
  );
  assert.ok(
    evidence.ethereum.length > 0,
    "New Ethereum subgraph has no daily entities",
  );
  evidence.vault = await page(
    url,
    "vaultDays",
    VAULT_FIELDS,
    cutoffOptions(indexed),
  );
  evidence.events = await page(url, "vaultEvents", EVENT_FIELDS, {
    bytes: true,
    filter: "blockNumber_lte:$cutoff",
    declarations: ",$cutoff:BigInt!",
    variables: { cutoff: String(record(indexed.block).number) },
  });
  assert.ok(
    evidence.ethereum.every((day) => day.vaultImplementationReviewed === true),
    "Unreviewed historical Vault day; reindex after implementation review",
  );
  return evidence;
}
async function cachedSnapshots(path: string): Promise<Map<string, Row>> {
  const content = await readFile(path, "utf8");
  const result = new Map<string, Row>();
  for (const line of content.split("\n").filter(Boolean)) {
    const value = record(JSON.parse(line));
    const date = utcDate(value.date);
    assert.ok(!result.has(date), `Duplicate archived snapshot ${date}`);
    result.set(date, value);
  }
  assert.ok(result.size > 0, "Empty snapshot archive");
  return result;
}
function snapshot(cache: Map<string, Row>, date: string): Row {
  const value = cache.get(date);
  assert.ok(
    value,
    `Missing pre-cutover snapshot ${date}; historical gates never read the live API`,
  );
  return value;
}
async function atBlock(
  url: string,
  entity: "transfers" | "vaultEvents",
  block: string,
): Promise<Row[]> {
  return page(
    url,
    entity,
    entity === "transfers"
      ? "id from to amount blockNumber timestamp"
      : EVENT_FIELDS,
    {
      bytes: true,
      filter: "blockNumber:$blockNumber",
      declarations: ",$blockNumber:BigInt!",
      variables: { blockNumber: block },
    },
  );
}
async function balances(options: Options, evidence: Evidence): Promise<Row> {
  evidence.oldSnapshots = await cachedSnapshots(
    required(options["snapshot-cache"], "--snapshot-cache"),
  );
  const days = dated(evidence.ethereum);
  const vault = dated(evidence.vault);
  const dates = [...evidence.oldSnapshots.keys()].sort();
  const first = dates[0];
  const last = dates.at(-1);
  assert.ok(first && last);
  assert.equal(
    dates.length,
    (Date.parse(last) - Date.parse(first)) / 86400000 + 1,
    "Missing daily snapshots within deployment range",
  );
  assert.equal(first, START_DATE, "Ethereum must start on deployment date");
  let explainedDates = 0;
  let maxAccrualDelta = 0n;
  let checked = 0;
  for (const date of dates) {
    const oldSnapshot = snapshot(evidence.oldSnapshots, date);
    const day = days.get(date);
    assert.ok(day, `Missing Ethereum day ${date}`);
    const old = record(oldSnapshot.ethereum);
    const transfers = await atBlock(
      options.candidate,
      "transfers",
      text(old.blockNumber),
    );
    const events = evidence.events.filter(
      (event) => event.blockNumber === old.blockNumber,
    );
    const result = compareSnapshot(
      day,
      old,
      transfers,
      events,
      vault.get(date),
    );
    evidence.comparisons.set(date, result);
    if (result.transferExplained) explainedDates++;
    if (abs(result.accrualDelta) > maxAccrualDelta)
      maxAccrualDelta = abs(result.accrualDelta);
    checked++;
    if (checked % 100 === 0)
      console.log(`Snapshot comparisons: ${checked}/${dates.length}`);
  }
  assert.ok(
    explainedDates / dates.length <= 0.01,
    "More than 1% of dates need first-block flow explanations",
  );
  return {
    dates: dates.length,
    explainedDates,
    maxAccrualDeltaWei: maxAccrualDelta.toString(),
    coverage: {
      ethereum:
        "Every exposed old Ethereum component; circulation equals old circulation + old portalBridge, with audited first-block flows and bounded accrual. Khala bridges compared as their merged sum. Raw vaultBalance is not exposed by this archived reference. Derives vault+treasury from vaultReward and audited PHA/locked-asset flows.",
    },
  };
}
async function archives(
  options: Options,
  evidence: Evidence,
  ndjson: string,
  exported: unknown | undefined,
): Promise<Row> {
  const snapshots = ndjson
    .split("\n")
    .filter(Boolean)
    .map((line) => record(JSON.parse(line)));
  if (options.ndjson)
    assert.equal(snapshots.length, 1825, "Expected 1,825 ndjson snapshots");
  const history =
    exported === undefined
      ? []
      : exportRows(exported, "3572546", "updated_time");
  if (exported !== undefined)
    assert.equal(history.length, 365, "Expected 365 History rows");
  const ethereum = dated(evidence.ethereum);
  const differences: Row[] = [];
  for (const row of [...snapshots, ...history]) {
    const date = utcDate(row.updated_time);
    const day = ethereum.get(date);
    assert.ok(day, `Archive Ethereum date missing ${date}`);
    const old = snapshot(evidence.oldSnapshots, date);
    const comparison = evidence.comparisons.get(date);
    assert.ok(comparison, `No gate 1/2 evidence for archive ${date}`);
    differences.push(compareArchive(row, day, old, comparison));
  }
  return {
    ndjson: snapshots.length,
    history: history.length,
    totalSource:
      "New Ethereum ChainDay; archived Base replaced by old Ethereum Portal escrow",
    substrateSource: "Frozen Phala/Khala archive",
    differences,
  };
}

export async function claimers(
  options: Options,
  evidence: Evidence,
): Promise<Row> {
  const newBlock = Number(record(record(evidence.meta.ethereum).block).number);
  const counts: Row = {};
  for (const chain of ["khala", "phala"] as const) {
    const path = options[`old-${chain}-export`];
    if (!path) continue;
    const exported = claimerExport(
      JSON.parse(await readFile(path, "utf8")),
      chain,
    );
    const oldMeta = exported.meta;
    const block = exported.block;
    const entity = chain === "khala" ? "claimeds" : "claimedAndBridgeds";
    const fields = `${CLAIM_FIELDS} ${chain === "khala" ? "receiver" : "l1Receiver l2Receiver"}`;
    assert.ok(
      newBlock >= block,
      `New subgraph has not reached the old ${entity} comparison block`,
    );
    const filter = {
      filter: "block_number_lte:$cutoff",
      declarations: ",$cutoff:BigInt!",
      variables: { cutoff: String(block) },
    };
    const actual = await page(options.candidate, entity, fields, filter);
    compareClaimers(actual, exported.claims);
    counts[entity] = {
      block,
      count: actual.length,
      source: "export",
      deployment: oldMeta.deployment,
    };
  }
  return counts;
}
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = args(argv);
  const report: Row = {
    startedAt: new Date().toISOString(),
    stage: options.stage,
    gates: {},
  };
  const gates = record(report.gates);
  try {
    if (options.stage === "upgrade") {
      await upgrade(options, report);
    } else {
      const evidence = await load(options);
      report.deployments = {
        candidate: record(evidence.meta.ethereum).deployment,
      };
      if (options["snapshot-cache"])
        gates.snapshots = await balances(options, evidence);
      const exported: unknown = options.results
        ? JSON.parse(await readFile(options.results, "utf8"))
        : undefined;
      if (options.ndjson || options.results)
        gates.circulationArchives = await archives(
          options,
          evidence,
          options.ndjson ? await readFile(options.ndjson, "utf8") : "",
          exported,
        );
      if (exported !== undefined)
        gates.duneVault = {
          ...compareVault(
            evidence.vault,
            exportRows(exported, "5154700", "day"),
          ),
          consistency: compareVaultConsistency(evidence.vault, evidence.events),
        };
      if (options["old-khala-export"] || options["old-phala-export"])
        gates.claimers = await claimers(options, evidence);
    }
    report.status = "pass";
    console.log(`Parity gates passed for stage ${options.stage}, Ethereum`);
  } catch (error) {
    report.status = "fail";
    report.error =
      error instanceof assert.AssertionError
        ? error.message
        : "I/O or upstream read failed (endpoint details omitted)";
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
  }
}
if (import.meta.main)
  main().catch(() => {
    // I/O errors can contain private endpoint URLs; never print their details.
    console.error("Parity verification failed.");
    process.exitCode = 1;
  });
