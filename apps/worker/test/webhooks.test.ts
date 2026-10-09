import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claimJobs, jobs, webhookDeliveries } from "@sentinel/db";
import { startTestDb, type TestDb } from "@sentinel/db/testing";
import {
  enqueueTestWebhook,
  runBatch,
  signWebhook,
  verifyWebhook,
  WEBHOOK_DELIVER,
  WEBHOOK_MAX_ATTEMPTS,
  createHandlers,
  type WebhookConfig,
} from "../src/index.js";

const SECRET = "k".repeat(40);
let t: TestDb;
let server: Server;
let url: string;
let respond: (n: number) => number = () => 200;
const received: { headers: IncomingHttpHeaders; body: string }[] = [];

beforeAll(async () => {
  t = await startTestDb();
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      const status = respond(received.length);
      if (status >= 300 && status < 400) res.setHeader("location", "https://elsewhere.example.com");
      res.statusCode = status;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://localhost:${(server.address() as AddressInfo).port}/hook`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await t?.stop();
});
beforeEach(async () => {
  await t.reset();
  received.length = 0;
  respond = () => 200;
});

const config = (): WebhookConfig => ({ urls: [url], secret: SECRET, timeoutMs: 2_000 });
const run = () =>
  runBatch({
    db: t.db,
    workerId: "w",
    handlers: createHandlers({}, { db: t.db, config: config() }),
  });
const delivery = async () => (await t.db.select().from(webhookDeliveries))[0]!;
/** Makes queued retries due now (backoff would otherwise delay them). */
const makeDue = () =>
  t.db
    .update(jobs)
    .set({ runAt: new Date(0) })
    .where(eq(jobs.status, "queued"));

describe("webhook delivery", () => {
  it("POSTs a signed event with id, sequence, timestamp and retry headers", async () => {
    const eventId = await t.db.transaction((tx) => enqueueTestWebhook(tx, config()));
    expect(await run()).toBe(1);
    expect(received).toHaveLength(1);
    const { headers, body } = received[0]!;
    expect(headers["x-sentinel-event-id"]).toBe(eventId);
    expect(headers["x-sentinel-sequence"]).toBe("0");
    expect(headers["x-sentinel-retry"]).toBe("0");
    const ts = Number(headers["x-sentinel-timestamp"]);
    expect(verifyWebhook(SECRET, ts, body, String(headers["x-sentinel-signature"]))).toBe(true);
    expect(
      verifyWebhook("wrong".repeat(8), ts, body, String(headers["x-sentinel-signature"])),
    ).toBe(false);
    expect(JSON.parse(body)).toMatchObject({ id: eventId, type: "webhook.test" });
    expect(await delivery()).toMatchObject({
      status: "delivered",
      attempts: 1,
      lastStatusCode: 200,
    });
  });

  it("retries non-2xx responses with an incrementing retry header, then succeeds", async () => {
    respond = (n) => (n < 3 ? 500 : 204);
    await t.db.transaction((tx) => enqueueTestWebhook(tx, config()));
    await run();
    await makeDue();
    await run();
    await makeDue();
    await run();
    expect(received.map((r) => r.headers["x-sentinel-retry"])).toEqual(["0", "1", "2"]);
    expect(await delivery()).toMatchObject({
      status: "delivered",
      attempts: 3,
      lastStatusCode: 204,
    });
  });

  it("treats redirects as failures (no following to another host)", async () => {
    respond = () => 302;
    await t.db.transaction((tx) => enqueueTestWebhook(tx, config()));
    await run();
    expect(received).toHaveLength(1);
    expect(await delivery()).toMatchObject({
      status: "pending",
      lastStatusCode: 302,
      lastError: "HTTP 302",
    });
  });

  it("marks the delivery dead after the final attempt", async () => {
    respond = () => 503;
    await t.db.transaction((tx) => enqueueTestWebhook(tx, config()));
    for (let i = 0; i < WEBHOOK_MAX_ATTEMPTS; i++) {
      await makeDue();
      await run();
    }
    expect(await delivery()).toMatchObject({ status: "dead", attempts: WEBHOOK_MAX_ATTEMPTS });
    const [job] = await t.db.select().from(jobs);
    expect(job).toMatchObject({ type: WEBHOOK_DELIVER, status: "done" });
    expect(await claimJobs(t.db, "w")).toHaveLength(0);
  });

  it("verifyWebhook rejects stale timestamps", () => {
    const body = "{}";
    const sig = signWebhook(SECRET, 1_000, body);
    expect(verifyWebhook(SECRET, 1_000, body, sig, { now: 1_100 })).toBe(true);
    expect(verifyWebhook(SECRET, 1_000, body, sig, { now: 2_000 })).toBe(false);
  });
});
