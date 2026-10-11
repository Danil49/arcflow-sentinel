import { enqueueJob, getTrace } from "@sentinel/db";
import { anchorJobKey, EVIDENCE_ANCHOR, sealTraceEvidence } from "@sentinel/worker";
import type { ApiContext } from "../context.js";
import { HttpError, json, requireAuth } from "../http.js";
import { traceId } from "./schemas.js";

const requireSigner = (ctx: ApiContext) => {
  if (!ctx.signer)
    throw new HttpError(503, "Evidence signing is not configured", "set EVIDENCE_SIGNING_KEY");
  return ctx.signer;
};

/**
 * GET /api/traces/{id}/evidence — seals the trace's current evidence (deterministic: unchanged
 * evidence returns byte-identical bundles). `?download=1` serves it as a file.
 */
export async function getEvidence(ctx: ApiContext, req: Request, rawId: string): Promise<Response> {
  const signer = requireSigner(ctx);
  const id = traceId.safeParse(rawId);
  const sealed = id.success ? await sealTraceEvidence(ctx.db, id.data, signer, ctx.network) : null;
  if (!sealed) throw new HttpError(404, "Trace not found");
  const download = new URL(req.url).searchParams.get("download") === "1";
  const headers: Record<string, string> = { etag: `"${sealed.bundle.hashes.sha256}"` };
  if (download) {
    headers["content-disposition"] =
      `attachment; filename="sentinel-evidence-${sealed.row.traceId}-${sealed.bundle.hashes.keccak256.slice(2, 10)}.json"`;
  }
  return new Response(JSON.stringify(sealed.bundle, null, 2), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

/** GET /.well-known/sentinel-key.json — the key verifiers should trust for this deployment. */
export async function getPublicKey(ctx: ApiContext): Promise<Response> {
  const signer = requireSigner(ctx);
  return json(
    {
      alg: "Ed25519",
      keyId: signer.keyId,
      publicKey: signer.publicKeyHex,
      network: ctx.network,
      // Lets `verify-evidence --anchor-tx` check the emitting contract without extra flags.
      anchor: ctx.anchor.registry
        ? {
            network: ctx.anchor.network,
            chainId: ctx.anchor.chainId,
            registry: ctx.anchor.registry,
          }
        : null,
    },
    200,
    { "cache-control": "public, max-age=300" },
  );
}

/**
 * POST /api/traces/{id}/anchor — authenticated. Queues anchoring of the trace's current evidence
 * hash on Arc (deduplicated per trace); the worker signs and sends it.
 */
export async function postAnchor(ctx: ApiContext, req: Request, rawId: string): Promise<Response> {
  requireAuth(ctx, req);
  requireSigner(ctx);
  if (ctx.anchor.mode === "off" || !ctx.anchor.registry) {
    throw new HttpError(
      409,
      "Anchoring is not enabled",
      "set ANCHOR_MODE and deploy or configure the EvidenceRegistry",
    );
  }
  const id = traceId.safeParse(rawId);
  const trace = id.success ? await getTrace(ctx.db, id.data) : undefined;
  if (!trace) throw new HttpError(404, "Trace not found");
  const queued = await enqueueJob(
    ctx.db,
    EVIDENCE_ANCHOR,
    { traceId: trace.id },
    { dedupeKey: anchorJobKey(trace.id) },
  );
  return json(
    {
      traceId: trace.id,
      queued: queued !== null,
      network: ctx.anchor.network,
      chainId: ctx.anchor.chainId,
      registry: ctx.anchor.registry,
    },
    202,
  );
}
