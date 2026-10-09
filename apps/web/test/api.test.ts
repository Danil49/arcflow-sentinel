import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { routeChains } from "@sentinel/chains";
import { getTrace, jobs, webhookDeliveries } from "@sentinel/db";
import { startTestDb, type TestDb } from "@sentinel/db/testing";
import { refreshTrace, type PipelineDeps } from "@sentinel/worker";
import { getLive, getReady, getRoutes, resetRoutesCache } from "../src/api/health.js";
import { openApiDocument } from "../src/api/openapi.js";
import {
  getEvents,
  getInvariants,
  getTraceById,
  getTracesBySource,
  postConfirm,
  postTraces,
} from "../src/api/traces.js";
import { postWebhookTest } from "../src/api/webhooks.js";
import type { ApiContext } from "../src/context.js";
import { handle } from "../src/http.js";
import {
  DST,
  destinationReceipt,
  fakeChain,
  iris,
  logsAt,
  receiptAt,
  SRC,
  sourceReceipt,
  staticIris,
} from "../../worker/test/fakes.js";

const KEY = "test-api-key-0123456789abcdef";
const chains = routeChains("mainnet");
let t: TestDb;
let ctx: ApiContext;

beforeAll(async () => {
  t = await startTestDb();
});
afterAll(async () => t?.stop());
beforeEach(async () => {
  await t.reset();
  resetRoutesCache();
  const base = {
    config: chains.base,
    client: fakeChain({ head: 2_000n, receipts: { [SRC]: receiptAt(sourceReceipt, 1_000n) } })
      .client,
  };
  const arc = {
    config: chains.arc,
    client: fakeChain({
      head: 2_000n,
      receipts: { [DST]: receiptAt(destinationReceipt, 1_050n) },
      logs: logsAt(destinationReceipt, 1_050n),
    }).client,
  };
  const now = () => new Date(1_000_000 + 5 * 60_000);
  const webhooks = {
    urls: ["https://hooks.example.com/x"],
    secret: "s".repeat(32),
    timeoutMs: 1_000,
  };
  ctx = {
    db: t.db,
    sides: { base, arc },
    pipeline: (source): PipelineDeps => ({
      db: t.db,
      iris: staticIris(iris),
      now,
      webhooks,
      source: source === "base" ? base : arc,
      destination: source === "base" ? arc : base,
    }),
    webhooks,
    apiKeys: [KEY],
    irisBaseUrl: "https://iris.invalid",
    now,
  };
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const auth = { authorization: `Bearer ${KEY}` };
const createTrace = handle((req: Request) => postTraces(ctx, req));
const body = (res: Response) => res.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function created(extra = {}, headers = {}) {
  const res = await createTrace(
    post("/api/traces", { sourceTxHash: SRC, sourceChain: "base", ...extra }, headers),
  );
  return { res, json: await body(res) };
}

describe("POST /api/traces", () => {
  it("creates once (201) and then returns the existing trace (200)", async () => {
    const first = await created();
    expect(first.res.status).toBe(201);
    const trace = first.json.traces[0];
    expect(trace).toMatchObject({
      route: {
        sourceChain: "base",
        sourceDomain: 6,
        destinationChain: "arc",
        destinationDomain: 26,
      },
      amountAtomic: "5869596",
      status: "SOURCE_OBSERVED",
      explorer: { source: expect.stringContaining("basescan.org/tx/"), destination: null },
    });
    const second = await created();
    expect(second.res.status).toBe(200);
    expect(second.json.traces[0].id).toBe(trace.id);
    expect((await t.db.select().from(jobs)).length).toBe(1);
  });

  it("validates input as RFC 7807 problems", async () => {
    const bad = await createTrace(
      post("/api/traces", { sourceTxHash: "0x123", sourceChain: "eth" }),
    );
    expect(bad.status).toBe(400);
    expect(bad.headers.get("content-type")).toBe("application/problem+json");
    expect((await body(bad)).errors.map((e: { path: string }) => e.path).sort()).toEqual([
      "sourceChain",
      "sourceTxHash",
    ]);

    expect((await createTrace(post("/api/traces", "{nope"))).status).toBe(400);
    expect(
      (await createTrace(post("/api/traces", { sourceTxHash: SRC, sourceChain: "base", extra: 1 })))
        .status,
    ).toBe(400);
    const wrongType = await createTrace(
      new Request("http://test/api/traces", { method: "POST", body: "x" }),
    );
    expect(wrongType.status).toBe(415);
  });

  it("422 for a tx that is not a CCTP burn on the route", async () => {
    const res = await createTrace(
      post("/api/traces", { sourceTxHash: `0x${"ab".repeat(32)}`, sourceChain: "base" }),
    );
    expect(res.status).toBe(422);
    expect((await body(res)).detail).toMatch(/not found/);
  });

  it("requireAppConfirmation needs an API key, and can upgrade an existing trace", async () => {
    expect((await created({ requireAppConfirmation: true })).res.status).toBe(401);
    expect(
      (
        await created(
          { requireAppConfirmation: true },
          { authorization: "Bearer wrong-key-000000000000000" },
        )
      ).res.status,
    ).toBe(401);
    const plain = await created();
    const upgraded = await created({ requireAppConfirmation: true }, auth);
    expect(upgraded.res.status).toBe(200);
    expect(upgraded.json.traces[0]).toMatchObject({
      id: plain.json.traces[0].id,
      requireAppConfirmation: true,
    });
  });

  it("hides internal error details", async () => {
    const broken = {
      ...ctx,
      sides: { ...ctx.sides, base: { ...ctx.sides.base, config: undefined as never } },
    };
    const res = await handle((req: Request) => postTraces(broken, req))(
      post("/api/traces", { sourceTxHash: SRC, sourceChain: "base" }),
    );
    expect(res.status).toBe(500);
    expect((await body(res)).detail).toMatch(/^error id [0-9a-f-]{36}$/);
  });
});

describe("GET trace resources", () => {
  it("serves the trace, events and invariants after the worker refreshes it", async () => {
    const id = (await created()).json.traces[0].id;
    await refreshTrace(ctx.pipeline("base"), { traceId: id, sourceDomain: 6 });

    const trace = await body(await getTraceById(ctx, id));
    expect(trace).toMatchObject({
      status: "MINT_CONFIRMED",
      nonce: expect.stringMatching(/^0x1f73/),
      destinationTxHash: DST.toLowerCase(),
      explorer: { destination: expect.stringContaining("explorer.arc.io/tx/") },
    });

    const events = await body(await getEvents(ctx, id));
    expect(events.events.map((e: { eventType: string }) => e.eventType).sort()).toEqual([
      "burn",
      "message_received",
      "message_sent",
      "mint",
    ]);
    expect(events.attestations).toHaveLength(1);

    const inv = await body(await getInvariants(ctx, id));
    expect(inv.invariants.every((i: { result: string }) => i.result === "PASS")).toBe(true);

    const lookup = await body(
      await getTracesBySource(
        ctx,
        new Request(`http://test/api/traces?sourceTxHash=${SRC}&sourceChain=base`),
      ),
    );
    expect(lookup.traces[0].id).toBe(id);
  });

  it("404 for unknown or malformed ids", async () => {
    const get = handle((id: string) => getTraceById(ctx, id));
    expect((await get("00000000-0000-0000-0000-000000000000")).status).toBe(404);
    expect((await get("not-a-uuid")).status).toBe(404);
  });
});

describe("POST /api/traces/{id}/confirm", () => {
  const confirm = (id: string, b: unknown, headers: Record<string, string> = auth) =>
    handle(() => postConfirm(ctx, post(`/api/traces/${id}/confirm`, b, headers), id))();

  it("requires auth, requires opt-in, then completes the trace", async () => {
    const plainId = (await created()).json.traces[0].id;
    expect((await confirm(plainId, {}, {})).status).toBe(401);
    expect((await confirm(plainId, {})).status).toBe(409);

    const upgraded = await created({ requireAppConfirmation: true }, auth);
    const id = upgraded.json.traces[0].id;
    await refreshTrace(ctx.pipeline("base"), { traceId: id, sourceDomain: 6 });
    expect((await getTrace(t.db, id))!.status).toBe("MINT_CONFIRMED");

    const res = await confirm(id, { reference: "order-7" });
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({
      status: "APPLICATION_CONFIRMED",
      applicationReference: "order-7",
    });
    expect((await confirm(id, { reference: "x".repeat(201) })).status).toBe(400);
  });
});

describe("webhooks and health", () => {
  it("POST /api/webhooks/test requires auth and queues a delivery per endpoint", async () => {
    const send = (h: Record<string, string>) =>
      handle(() => postWebhookTest(ctx, post("/api/webhooks/test", {}, h)))();
    expect((await send({})).status).toBe(401);
    const res = await send(auth);
    expect(res.status).toBe(202);
    expect((await body(res)).endpoints).toBe(1);
    expect(await t.db.select().from(webhookDeliveries)).toHaveLength(1);
    const none = await handle(() =>
      postWebhookTest({ ...ctx, webhooks: null }, post("/api/webhooks/test", {}, auth)),
    )();
    expect(none.status).toBe(409);
  });

  it("live/ready/routes", async () => {
    expect((await getLive()).status).toBe(200);
    expect(await body(await getReady(ctx))).toMatchObject({
      status: "ok",
      checks: { database: "ok" },
    });
    const routes = await getRoutes(ctx); // Iris points at an invalid host: degraded, no secrets leaked
    expect(routes.status).toBe(503);
    const r = await body(routes);
    expect(
      r.chains.map((c: { chain: string; ok: boolean; headBlock: string }) => [
        c.chain,
        c.ok,
        c.headBlock,
      ]),
    ).toEqual([
      ["base", true, "2000"],
      ["arc", true, "2000"],
    ]);
    expect(r.iris.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("iris.invalid");
  });

  it("openapi document lists every route and component", () => {
    const doc = openApiDocument();
    expect(Object.keys(doc.paths).sort()).toEqual([
      "/api/health/live",
      "/api/health/ready",
      "/api/health/routes",
      "/api/traces",
      "/api/traces/{id}",
      "/api/traces/{id}/confirm",
      "/api/traces/{id}/events",
      "/api/traces/{id}/invariants",
      "/api/webhooks/test",
    ]);
    expect(doc.components.schemas.Trace).toMatchObject({ type: "object" });
    expect(JSON.stringify(doc)).not.toContain('$ref":"#/components/schemas/undefined');
  });
});
