/**
 * Creates (or returns the existing) trace for a source tx and queues it for the worker.
 * Stand-in for POST /api/traces until the API exists.
 *
 *   pnpm --filter @sentinel/worker create-trace <sourceTxHash> --from base|arc
 */
import { parseArgs } from "node:util";
import { isHash, type Hex } from "viem";
import { IRIS_BASE_URL } from "@sentinel/chains";
import { parseEnv, workerEnvSchema } from "@sentinel/config";
import { connect } from "@sentinel/db";
import { createIrisClient, createTraces, routeSidesFromEnv } from "../src/index.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { from: { type: "string", default: "base" } },
});
const [txHash] = positionals;
if (!txHash || !isHash(txHash) || (values.from !== "base" && values.from !== "arc")) {
  console.error("usage: create-trace <sourceTxHash> --from base|arc");
  process.exit(2);
}
const env = parseEnv(workerEnvSchema);
const sides = routeSidesFromEnv(env);
const handle = connect(env.DATABASE_URL, 1);
try {
  const [source, destination] =
    values.from === "base" ? [sides.base, sides.arc] : [sides.arc, sides.base];
  const { traces } = await createTraces(
    {
      db: handle.db,
      source,
      destination,
      iris: createIrisClient(env.IRIS_BASE_URL ?? IRIS_BASE_URL[env.CCTP_NETWORK]),
    },
    txHash as Hex,
  );
  for (const tr of traces)
    console.log(
      JSON.stringify({ id: tr.id, status: tr.status, amountAtomic: tr.amountAtomic.toString() }),
    );
} finally {
  await handle.close();
}
