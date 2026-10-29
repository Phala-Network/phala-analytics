import assert from "node:assert/strict";
import { type Row, record, rows, text } from "./verify-lib";

export const PRODUCTION_URL =
  "https://api.goldsky.com/api/public/project_cmdgxxcewrqdi01wx9e7md0ek/subgraphs/phala-ethereum/prod/gn";

let nextReadAt = 0;
export async function gql(
  url: string,
  query: string,
  variables: Row = {},
): Promise<Row> {
  const wait = Math.max(0, nextReadAt - Date.now());
  if (wait) await Bun.sleep(wait);
  nextReadAt = Date.now() + 250;
  // Never print URLs or upstream errors: endpoints can contain credentials.
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    redirect: "manual",
    signal: AbortSignal.timeout(90_000),
  });
  assert.ok(response.ok, `Upstream HTTP ${response.status}`);
  const value = record(await response.json());
  assert.ok(
    !value.errors,
    variables.block === undefined
      ? "GraphQL returned errors"
      : "GraphQL returned errors at the common block (possibly pruned); restart near both heads or review --safety-margin",
  );
  return record(value.data);
}

export function checkedMeta(
  value: unknown,
  deployment?: string,
  block?: number,
): Row {
  const result = record(value);
  assert.equal(result.hasIndexingErrors, false, "Subgraph has indexing errors");
  assert.ok(text(result.deployment).length > 0, "Missing deployment ID");
  assert.ok(
    Number.isSafeInteger(record(result.block).number),
    "Missing indexed block",
  );
  if (deployment !== undefined)
    assert.equal(
      result.deployment,
      deployment,
      "Deployment changed during verification; restart before moving tags",
    );
  if (block !== undefined)
    assert.equal(
      record(result.block).number,
      block,
      "Query did not use the comparison block",
    );
  return result;
}

export async function meta(url: string): Promise<Row> {
  return checkedMeta(
    (
      await gql(
        url,
        "{_meta{deployment hasIndexingErrors block{number timestamp}}}",
      )
    )._meta,
  );
}

export interface PageOptions {
  bytes?: boolean;
  filter?: string;
  variables?: Row;
  declarations?: string;
  block?: number;
  deployment?: string;
}

export async function page(
  url: string,
  entity: string,
  fields: string,
  options: PageOptions = {},
): Promise<Row[]> {
  const result: Row[] = [];
  let after = options.bytes ? "0x" : "";
  while (true) {
    const pinned = options.block !== undefined;
    const query = `query($after:${options.bytes ? "Bytes" : "ID"}!${pinned ? ",$block:Int!" : ""}${options.declarations ?? ""}){${entity}(first:1000,orderBy:id,orderDirection:asc,${pinned ? "block:{number:$block}," : ""}where:{id_gt:$after${options.filter ? `,${options.filter}` : ""}}){${fields}}${pinned ? " _meta(block:{number:$block}){deployment hasIndexingErrors block{number}}" : ""}}`;
    const data = await gql(url, query, {
      after,
      ...(pinned ? { block: options.block } : {}),
      ...options.variables,
    });
    if (pinned) checkedMeta(data._meta, options.deployment, options.block);
    const batch = rows(data[entity]);
    for (const row of batch) {
      assert.ok(text(row.id) > after, "Unordered or repeated pagination ID");
      after = text(row.id);
      result.push(row);
    }
    if (batch.length < 1000) return result;
  }
}
