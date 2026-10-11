/** Loads fixtures/ as labelled historical demo traces (no network). Safe to re-run. */
import { fileURLToPath } from "node:url";
import { parseEnv, workerEnvSchema } from "@sentinel/config";
import { connect } from "@sentinel/db";
import { resolveDeadlines, seedDemo } from "../src/index.js";

const env = parseEnv(workerEnvSchema);
const handle = connect(env.DATABASE_URL, 2);
try {
  const seeded = await seedDemo(
    { db: handle.db, deadlines: resolveDeadlines(env.STAGE_DEADLINES_JSON) },
    fileURLToPath(new URL("../../../fixtures/", import.meta.url)),
  );
  for (const s of seeded) console.log(`${s.name.padEnd(24)} ${s.traceId} ${s.status}`);
} finally {
  await handle.close();
}
