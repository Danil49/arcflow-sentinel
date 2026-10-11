/**
 * Independently verify an ArcFlow Sentinel evidence bundle.
 *
 *   pnpm --filter @sentinel/evidence verify-evidence <bundle.json> --public-key <hex>
 *   pnpm --filter @sentinel/evidence verify-evidence <bundle.json> --key-url https://<host>/.well-known/sentinel-key.json
 *     [--anchor-tx <hash>] [--registry <address>] [--chain-id <id>] [--rpc <url>]
 *
 * Recomputes the RFC 8785 canonical payload, its SHA-256 and keccak256, and checks the Ed25519
 * signature against the operator's published key. With --anchor-tx it also reads the Arc
 * transaction and checks its EvidenceAnchored event (registry, trace id, recomputed hash). The
 * registry and chain come from --key-url's published config unless given explicitly.
 * Exit code 0 = valid, 1 = invalid, 2 = usage.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Address, Hex } from "viem";
import { verifyAnchor } from "./anchor.js";
import { verifyEvidence, type EvidenceBundle } from "./bundle.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "public-key": { type: "string" },
    "key-url": { type: "string" },
    "anchor-tx": { type: "string" },
    registry: { type: "string" },
    submitter: { type: "string" },
    "chain-id": { type: "string" },
    rpc: { type: "string" },
    json: { type: "boolean" },
  },
});
const [file] = positionals;
if (!file || (!values["public-key"] && !values["key-url"])) {
  console.error(
    "usage: verify-evidence <bundle.json> (--public-key <hex> | --key-url <url>) [--anchor-tx <hash> [--registry <addr>] [--chain-id <id>] [--rpc <url>]] [--json]",
  );
  process.exit(2);
}

interface Published {
  publicKey: string;
  anchor?: { network: string; chainId: number; registry: string; submitter?: string | null } | null;
}
let published: Published | null = null;
if (values["key-url"]) {
  const res = await fetch(values["key-url"], { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    console.error(`could not fetch key: HTTP ${res.status}`);
    process.exit(2);
  }
  published = (await res.json()) as Published;
}
const publicKey = values["public-key"] ?? published!.publicKey;

let bundle: EvidenceBundle;
try {
  bundle = JSON.parse(readFileSync(file, "utf8")) as EvidenceBundle;
} catch (e) {
  console.error(`cannot read bundle ${file}: ${(e as Error).message}`);
  process.exit(2);
}
const result = verifyEvidence(bundle, publicKey);

let anchor = null;
if (values["anchor-tx"]) {
  const registry = values.registry ?? published?.anchor?.registry;
  const chainId = values["chain-id"] ? Number(values["chain-id"]) : published?.anchor?.chainId;
  if (!registry) {
    console.error(
      "--anchor-tx needs the registry: pass --registry or a --key-url that publishes it",
    );
    process.exit(2);
  }
  anchor = await verifyAnchor(bundle, {
    txHash: values["anchor-tx"] as Hex,
    registry: registry as Address,
    ...((values.submitter ?? published?.anchor?.submitter)
      ? { submitter: (values.submitter ?? published?.anchor?.submitter) as Address }
      : {}),
    ...(chainId ? { chainId } : {}),
    ...(values.rpc ? { rpcUrl: values.rpc } : {}),
  });
}
const ok = result.ok && (anchor ? anchor.ok : true);

if (values.json) {
  console.log(
    JSON.stringify(
      { ...result, anchor, ok },
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ),
  );
} else {
  const mark = (ok: boolean) => (ok ? "ok  " : "FAIL");
  console.log(`trace       ${bundle.payload?.trace?.id}`);
  console.log(`verdict     ${bundle.payload?.verdict?.status}`);
  for (const [name, ok] of Object.entries(result.checks)) console.log(`${mark(ok)}  ${name}`);
  console.log(`keccak256   ${result.keccak256}`);
  for (const e of result.errors) console.log(`error       ${e}`);
  if (anchor) {
    console.log(`\nanchor      chain ${anchor.chainId}, block ${anchor.blockNumber ?? "-"}`);
    for (const [name, pass] of Object.entries(anchor.checks)) console.log(`${mark(pass)}  ${name}`);
    for (const e of anchor.errors) console.log(`error       ${e}`);
  }
  console.log(
    ok
      ? anchor
        ? "\nbundle is valid and anchored"
        : "\nbundle is valid"
      : "\nbundle is NOT valid",
  );
}
process.exit(ok ? 0 : 1);
