/**
 * Independently verify an ArcFlow Sentinel evidence bundle.
 *
 *   pnpm --filter @sentinel/evidence verify-evidence <bundle.json> --public-key <hex>
 *   pnpm --filter @sentinel/evidence verify-evidence <bundle.json> --key-url https://<host>/.well-known/sentinel-key.json
 *
 * Recomputes the RFC 8785 canonical payload, its SHA-256 and keccak256, and checks the Ed25519
 * signature against the operator's published key. Exit code 0 = valid, 1 = invalid, 2 = usage.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { verifyEvidence, type EvidenceBundle } from "./bundle.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "public-key": { type: "string" },
    "key-url": { type: "string" },
    json: { type: "boolean" },
  },
});
const [file] = positionals;
if (!file || (!values["public-key"] && !values["key-url"])) {
  console.error(
    "usage: verify-evidence <bundle.json> (--public-key <hex> | --key-url <url>) [--json]",
  );
  process.exit(2);
}

let publicKey = values["public-key"];
if (!publicKey) {
  const res = await fetch(values["key-url"]!, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    console.error(`could not fetch key: HTTP ${res.status}`);
    process.exit(2);
  }
  publicKey = ((await res.json()) as { publicKey: string }).publicKey;
}

const bundle = JSON.parse(readFileSync(file, "utf8")) as EvidenceBundle;
const result = verifyEvidence(bundle, publicKey);

if (values.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const mark = (ok: boolean) => (ok ? "ok  " : "FAIL");
  console.log(`trace       ${bundle.payload?.trace?.id}`);
  console.log(`verdict     ${bundle.payload?.verdict?.status}`);
  for (const [name, ok] of Object.entries(result.checks)) console.log(`${mark(ok)}  ${name}`);
  console.log(`keccak256   ${result.keccak256}`);
  for (const e of result.errors) console.log(`error       ${e}`);
  console.log(result.ok ? "\nbundle is valid" : "\nbundle is NOT valid");
}
process.exit(result.ok ? 0 : 1);
