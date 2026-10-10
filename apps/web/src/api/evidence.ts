import { sealTraceEvidence } from "@sentinel/worker";
import type { ApiContext } from "../context.js";
import { HttpError, json } from "../http.js";
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
    { alg: "Ed25519", keyId: signer.keyId, publicKey: signer.publicKeyHex, network: ctx.network },
    200,
    { "cache-control": "public, max-age=300" },
  );
}
