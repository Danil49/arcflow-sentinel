import { enqueueTestWebhook } from "@sentinel/worker";
import type { ApiContext } from "../context.js";
import { HttpError, json, requireAuth } from "../http.js";

/** POST /api/webhooks/test — authenticated; queues a signed test event to every endpoint. */
export async function postWebhookTest(ctx: ApiContext, req: Request): Promise<Response> {
  requireAuth(ctx, req);
  if (!ctx.webhooks)
    throw new HttpError(409, "No webhook endpoints configured", "set WEBHOOK_URLS");
  const config = ctx.webhooks;
  const eventId = await ctx.db.transaction((tx) => enqueueTestWebhook(tx, config));
  return json({ eventId, endpoints: config.urls.length }, 202);
}
