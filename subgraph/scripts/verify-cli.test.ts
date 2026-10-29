import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import fixture from "./fixtures/upgrade.json";
import { args, claimers, load, main } from "./verify";
import { PRODUCTION_URL } from "./verify-graph";
import { type Row, record, rows, text } from "./verify-lib";
import { compareEntities, ENTITIES, expectedFields } from "./verify-upgrade";

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(`${import.meta.dir}/.verify-tests-`);
});
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true });
});
const fixtures = record(fixture);
function entityRows(type: string): Row[] {
  return rows(structuredClone(fixtures[type]));
}

test("upgrade defaults and exemption validation reject obsolete references and safety overrides", () => {
  const options = args(["--candidate", "https://candidate.test"]);
  expect(options.stage).toBe("upgrade");
  expect(options.production).toBe(PRODUCTION_URL);
  expect(options.margin).toBe(64);
  for (const margin of ["-1", "1.5", "NaN", "9007199254740992", ""]) {
    expect(() =>
      args([
        "--candidate",
        "https://candidate.test",
        `--safety-margin=${margin}`,
      ]),
    ).toThrow("Invalid --safety-margin");
  }
  for (const field of [
    "ChainDay.id",
    "ChainDay.timestamp",
    "Latest.vaultImplementationReviewed",
    "VaultState.implementation",
    "Latest.accrualMode",
    "Transfer.transactionHash",
  ]) {
    expect(() => expectedFields(field)).toThrow("Cannot exempt");
  }
  expect(() => expectedFields("ChainDay.typo")).toThrow(
    "Unknown expected field",
  );
  expect(expectedFields("ChainDay.circulation,Latest.circulation").size).toBe(
    2,
  );
  for (const option of [
    "--old-api",
    "--old-vault",
    "--old-khala",
    "--old-phala",
    "--base",
    "--archive-rpc",
    "--prefetch-snapshots",
  ]) {
    expect(() => args([option, "removed"])).toThrow("Unknown option");
  }
  expect(() =>
    args(["--candidate", "https://candidate.test", "--stage", "server"]),
  ).toThrow("Use --stage");
  expect(() =>
    args(["--candidate", "https://candidate.test", "--stage", "historical"]),
  ).toThrow("at least one archive");
});

test("verification queries cover every field of every entity declared in the schema", async () => {
  const schema = await readFile(`${import.meta.dir}/../schema.graphql`, "utf8");
  const entities = [...schema.matchAll(/type (\w+) @entity[^{]+\{([^}]+)\}/g)];
  expect(ENTITIES.map((entity) => entity.type).sort()).toEqual(
    entities.map((entity) => text(entity[1])).sort(),
  );
  for (const entity of ENTITIES) {
    const definition = entities.find((match) => match[1] === entity.type);
    expect(entity.fields.split(" ").sort()).toEqual(
      [...(definition?.[2] ?? "").matchAll(/(\w+):/g)]
        .map((match) => text(match[1]))
        .sort(),
    );
    expect(
      compareEntities(
        entity,
        entityRows(entity.type),
        entityRows(entity.type),
        new Set(),
      ),
    ).toEqual([]);
  }
});

test("exact comparison detects field, ID and count changes including decimals, nulls and event provenance", () => {
  for (const entity of ENTITIES) {
    const previous = entityRows(entity.type);
    const row = previous[0];
    expect(row).toBeDefined();
    for (const field of entity.fields
      .split(" ")
      .filter(
        (field) => !["id", "vaultImplementationReviewed"].includes(field),
      )) {
      const candidate = [
        { ...row, [field]: row?.[field] === null ? "1" : null },
      ];
      const differences = compareEntities(
        entity,
        candidate,
        previous,
        new Set(),
      );
      expect(
        differences.some((diff) => diff.field === field && !diff.expected),
      ).toBe(true);
    }
    expect(() => compareEntities(entity, [], previous, new Set())).toThrow(
      "count differs",
    );
    expect(() =>
      compareEntities(entity, [{ ...row, id: "other" }], previous, new Set()),
    ).toThrow();
    if (row && "vaultImplementationReviewed" in row)
      expect(() =>
        compareEntities(
          entity,
          [{ ...row, vaultImplementationReviewed: false }],
          previous,
          new Set(),
        ),
      ).toThrow("unreviewed");
  }
});

interface RequestRecord {
  path: string;
  query: string;
  variables: Row;
}
function graphFixture() {
  const requests: RequestRecord[] = [];
  const state = {
    pruned: false,
    indexingErrors: false,
    reviewedHead: true,
    changedTag: false,
    repeatedId: false,
    diff: false,
  };
  const transfers = Array.from({ length: 1001 }, (_, index) => ({
    ...entityRows("Transfer")[0],
    id: `0x${(index + 1).toString(16).padStart(8, "0")}`,
  }));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = record(await request.json());
      const query = text(body.query);
      const variables = record(body.variables);
      requests.push({ path, query, variables });
      const candidate = path === "/candidate";
      if (!["/production", "/candidate"].includes(path))
        return new Response(null, { status: 410 });
      if (state.pruned && variables.block !== undefined)
        return Response.json({
          errors: [
            { message: "historical state pruned (private endpoint omitted)" },
          ],
        });
      const data: Row = {
        _meta: {
          deployment:
            state.changedTag && variables.after !== undefined
              ? "changed"
              : candidate
                ? "candidate"
                : "production",
          hasIndexingErrors: state.indexingErrors,
          block: {
            number: variables.block ?? (candidate ? 1100 : 1110),
            timestamp: variables.block === undefined ? 1791590400 : null,
          },
        },
      };
      if (query.includes("latest(id:")) {
        data.latest = {
          id: "current",
          vaultImplementationReviewed:
            variables.block === undefined ? state.reviewedHead : true,
        };
        data.vaultState = { id: "current", vaultImplementationReviewed: true };
      }
      const entity = ENTITIES.find((item) => query.includes(`${item.entity}(`));
      if (entity) {
        let values =
          entity.type === "Transfer" ? transfers : entityRows(entity.type);
        if (candidate && state.diff && entity.type === "VaultDay")
          values = values.map((value) => ({
            ...value,
            dailyRewards: "9007199254740993002",
          }));
        const cursor = text(variables.after);
        data[entity.entity] =
          state.repeatedId && cursor !== "0x" && entity.type === "Transfer"
            ? transfers.slice(0, 1)
            : values.filter((value) => text(value.id) > cursor).slice(0, 1000);
      }
      return Response.json({ data });
    },
  });
  const argv = [
    "--candidate",
    `${server.url}candidate`,
    "--production",
    `${server.url}production`,
    "--output",
    `${directory}/upgrade.json`,
  ];
  return { server, state, requests, argv };
}

test("upgrade pins both deployments and every deterministic page, reports expected per-date diffs, and fails other changes", async () => {
  const { server, state, requests, argv } = graphFixture();
  try {
    await main(argv);
    const report = record(
      JSON.parse(await readFile(`${directory}/upgrade.json`, "utf8")),
    );
    expect(report.status).toBe("pass");
    expect(report.comparisonBlock).toBe(1036);
    expect(record(record(report.entities).Transfer)).toEqual({
      production: 1001,
      candidate: 1001,
    });
    expect(record(record(report.entities).Holder)).toEqual({
      production: 1,
      candidate: 1,
    });
    expect(report.differences).toEqual([]);
    const pages = requests.filter(
      (request) => request.variables.after !== undefined,
    );
    expect(
      pages.every(
        (request) =>
          request.variables.block === 1036 &&
          request.query.includes("block:{number:$block}") &&
          request.query.includes("orderBy:id,orderDirection:asc"),
      ),
    ).toBe(true);
    expect(
      pages
        .filter((request) => request.query.includes("transfers("))
        .map((request) => request.variables.after),
    ).toEqual(["0x", "0x000003e8", "0x", "0x000003e8"]);
    expect(
      pages.find((request) => request.query.includes("chainDays("))?.query,
    ).toContain("$after:ID!");
    expect(
      pages.find((request) => request.query.includes("transfers("))?.query,
    ).toContain("$after:Bytes!");
    state.diff = true;
    await main([...argv, "--expect-diff", "VaultDay.dailyRewards"]);
    const expected = record(
      JSON.parse(await readFile(`${directory}/upgrade.json`, "utf8")),
    );
    expect(expected.status).toBe("pass");
    expect(expected.diffSummary).toEqual([
      {
        date: "2026-10-10",
        field: "VaultDay.dailyRewards",
        count: 1,
        previous: "9007199254740993001",
        candidate: "9007199254740993002",
        delta: "1",
        expected: true,
      },
    ]);
    await expect(
      main([...argv, "--expect-diff", "ChainDay.circulation"]),
    ).rejects.toThrow("Unexpected field differences: 1");
    expect(
      JSON.parse(await readFile(`${directory}/upgrade.json`, "utf8")).status,
    ).toBe("fail");
  } finally {
    await server.stop(true);
  }
}, 40000);

test("upgrade fails closed on pruned blocks, indexing errors, head review changes, tag movement and repeated pagination", async () => {
  const { server, state, argv } = graphFixture();
  try {
    state.pruned = true;
    await expect(main(argv)).rejects.toThrow("possibly pruned");
    state.pruned = false;
    state.indexingErrors = true;
    await expect(main(argv)).rejects.toThrow("indexing errors");
    state.indexingErrors = false;
    state.reviewedHead = false;
    await expect(main(argv)).rejects.toThrow(
      "Unreviewed candidate Vault implementation at head",
    );
    state.reviewedHead = true;
    state.changedTag = true;
    await expect(main(argv)).rejects.toThrow("Deployment changed");
    state.changedTag = false;
    state.repeatedId = true;
    await expect(main(argv)).rejects.toThrow(
      "Unordered or repeated pagination ID",
    );
  } finally {
    await server.stop(true);
  }
}, 30000);

test("historical claimer gates use only supplied exports and their independent cutoffs", async () => {
  const requests: { path: string; query: string; cutoff: unknown }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = record(await request.json());
      const query = text(body.query);
      const variables = record(body.variables);
      requests.push({ path, query, cutoff: variables.cutoff });
      if (path !== "/ethereum") return new Response(null, { status: 410 });
      let data: Row;
      if (query.includes("_meta"))
        data = {
          _meta: {
            deployment: "candidate",
            hasIndexingErrors: false,
            block: { number: 102, timestamp: 1791590400 },
          },
        };
      else if (query.includes("latest"))
        data = { latest: { vaultImplementationReviewed: true } };
      else if (query.includes("chainDays"))
        data = { chainDays: entityRows("ChainDay") };
      else if (query.includes("vaultDays")) data = { vaultDays: [] };
      else if (query.includes("vaultEvents")) data = { vaultEvents: [] };
      else if (query.includes("claimedAndBridgeds"))
        data = { claimedAndBridgeds: [] };
      else if (query.includes("claimeds")) data = { claimeds: [] };
      else return new Response(null, { status: 400 });
      return Response.json({ data });
    },
  });
  try {
    const paths: string[] = [];
    for (const [chain, block] of [
      ["khala", 100],
      ["phala", 101],
    ] as const) {
      const path = `${directory}/${chain}.json`;
      paths.push(`--old-${chain}-export`, path);
      await writeFile(
        path,
        JSON.stringify({
          subgraph: `${chain}-claimer/1.0.0`,
          block,
          meta: {
            block: { number: block },
            hasIndexingErrors: false,
            deployment: chain,
          },
          claimeds: [],
          ...(chain === "phala" ? { claimedAndBridgeds: [] } : {}),
        }),
      );
    }
    const options = args([
      "--stage",
      "historical",
      "--candidate",
      `${server.url}ethereum`,
      ...paths,
    ]);
    const evidence = await load(options);
    const report = await claimers(options, evidence);
    expect(record(report.claimeds).block).toBe(100);
    expect(record(report.claimedAndBridgeds).block).toBe(101);
    expect(requests.every((request) => request.path === "/ethereum")).toBe(
      true,
    );
    expect(
      requests
        .filter((request) => request.query.includes("claimeds("))
        .map((request) => request.cutoff),
    ).toEqual(["100"]);
    expect(
      requests
        .filter((request) => request.query.includes("claimedAndBridgeds("))
        .map((request) => request.cutoff),
    ).toEqual(["101"]);
    evidence.meta.ethereum = { block: { number: 100 } };
    await expect(claimers(options, evidence)).rejects.toThrow(
      "has not reached",
    );
    await expect(
      main([
        "--stage",
        "historical",
        "--candidate",
        `${server.url}ethereum`,
        "--snapshot-cache",
        `${directory}/missing.ndjson`,
        "--output",
        `${directory}/historical-failure.json`,
      ]),
    ).rejects.toThrow();
    expect(
      JSON.parse(await readFile(`${directory}/historical-failure.json`, "utf8"))
        .status,
    ).toBe("fail");
    expect(requests.every((request) => request.path === "/ethereum")).toBe(
      true,
    );
  } finally {
    await server.stop(true);
  }
}, 15000);

test("historical snapshots stop at the archived date and reject gaps without a live API fallback", async () => {
  const day: Row = {
    ...entityRows("ChainDay")[0],
    id: "2020-04-30",
    date: "2020-04-30",
  };
  for (const field of [
    "totalSupply",
    "reward",
    "sunsetReward",
    "phalaChainBridge",
    "khalaLegacyChainBridge",
    "khalaChainBridge",
    "sygmaBridge",
    "portalBridge",
    "vaultBalance",
    "vaultTotalAssets",
    "vaultTreasuryAssets",
    "vaultUnstakeLocked",
    "vaultReward",
    "circulation",
  ])
    day[field] = "0";
  const old = {
    date: "2020-04-30",
    ethereum: { ...day, blockNumber: "12", timestamp: "2020-04-30T00:00:00Z" },
  };
  const cache = `${directory}/old-snapshots.ndjson`;
  await writeFile(cache, `${JSON.stringify(old)}\n`);
  let apiRequests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/ethereum") {
        apiRequests++;
        return new Response(null, { status: 410 });
      }
      const query = text(record(await request.json()).query);
      let data: Row;
      if (query.includes("_meta"))
        data = {
          _meta: {
            deployment: "candidate",
            hasIndexingErrors: false,
            block: { number: 102, timestamp: 1791590400 },
          },
        };
      else if (query.includes("latest"))
        data = { latest: { vaultImplementationReviewed: true } };
      else if (query.includes("chainDays"))
        data = {
          chainDays: [day, { ...day, id: "2020-05-01", date: "2020-05-01" }],
        };
      else if (query.includes("vaultDays")) data = { vaultDays: [] };
      else if (query.includes("vaultEvents")) data = { vaultEvents: [] };
      else if (query.includes("transfers")) data = { transfers: [] };
      else return new Response(null, { status: 400 });
      return Response.json({ data });
    },
  });
  const output = `${directory}/historical-snapshots.json`;
  const argv = [
    "--stage",
    "historical",
    "--candidate",
    `${server.url}ethereum`,
    "--snapshot-cache",
    cache,
    "--output",
    output,
  ];
  try {
    await main(argv);
    expect(record(JSON.parse(await readFile(output, "utf8"))).status).toBe(
      "pass",
    );
    expect(
      record(
        record(record(JSON.parse(await readFile(output, "utf8"))).gates)
          .snapshots,
      ).dates,
    ).toBe(1);
    await writeFile(
      cache,
      `${JSON.stringify(old)}\n${JSON.stringify({ ...old, date: "2020-05-02" })}\n`,
    );
    await expect(main(argv)).rejects.toThrow("Missing daily snapshots");
    expect(apiRequests).toBe(0);
  } finally {
    await server.stop(true);
  }
}, 10000);
