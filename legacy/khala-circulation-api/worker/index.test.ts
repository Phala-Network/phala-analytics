import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

// Node runs Miniflare's undici dispatcher; Bun bundles the Worker without files.
const script = execFileSync(
  "bun",
  ["build", "./index.ts", "--target=browser"],
  {
    cwd: import.meta.dirname,
    encoding: "utf8",
  },
);

const runtime = (mode: string) =>
  new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      workers: [
        {
          name: "khala-circulation-api",
          modules: true,
          compatibilityDate: "2026-10-23",
          script,
          serviceBindings: { ANALYTICS: "phala-analytics" },
        },
        {
          name: "phala-analytics",
          modules: true,
          compatibilityDate: "2026-10-23",
          bindings: { MODE: mode },
          script: `export default {async fetch(request, env) {
            if (request.url !== 'https://analytics.phala.network/api/circulation'
                || request.method !== 'GET' || await request.text() !== '') {
              return new Response('Unexpected upstream request', {status: 422})
            }
            if (env.MODE === 'throw') throw new Error('Binding unavailable')
            return new Response(env.MODE === '503' ? 'Upstream unavailable' : '858627000.123456789012', {
              status: env.MODE === '503' ? 503 : 200,
              headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': env.MODE === '503' ? 'no-store' : 'public, max-age=60',
              },
            })
          }}`,
        },
      ],
    }),
  );

test("every path and method reads current supply via the service binding", async () => {
  const worker = runtime("ok");
  try {
    for (const [method, path] of [
      ["GET", "/"],
      ["GET", "/any/path?date=2000-01-01"],
      ["POST", "/api/snapshot"],
      ["PUT", "/api/all"],
      ["DELETE", "/unknown"],
      ["OPTIONS", "/"],
      ["HEAD", "/any/path"],
    ]) {
      const response = await worker.dispatchFetch(`https://alias.test${path}`, {
        method,
        ...(method === "POST" ? { body: "ignored" } : {}),
      });
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get("content-type"),
        "text/plain; charset=utf-8",
      );
      assert.equal(response.headers.get("cache-control"), "public, max-age=60");
      assert.deepEqual(
        new Uint8Array(await response.arrayBuffer()),
        new TextEncoder().encode(
          method === "HEAD" ? "" : "858627000.123456789012",
        ),
      );
    }
  } finally {
    await worker.dispose();
  }
});

test("upstream 503 preserves the status, body and cache policy", async () => {
  const worker = runtime("503");
  try {
    const response = await worker.dispatchFetch("https://alias.test/");
    assert.equal(response.status, 503);
    assert.equal(await response.text(), "Upstream unavailable");
    assert.equal(
      response.headers.get("content-type"),
      "text/plain; charset=utf-8",
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally {
    await worker.dispose();
  }
});

test("a binding failure returns an uncached plain-text 503", async () => {
  const worker = runtime("throw");
  try {
    const response = await worker.dispatchFetch("https://alias.test/");
    assert.equal(response.status, 503);
    assert.equal(await response.text(), "Circulation temporarily unavailable");
    assert.equal(
      response.headers.get("content-type"),
      "text/plain; charset=utf-8",
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally {
    await worker.dispose();
  }
});
