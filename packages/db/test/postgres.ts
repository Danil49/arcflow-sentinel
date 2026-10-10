/**
 * Test helper: a throwaway Postgres (testcontainers) with migrations applied.
 * Works with Docker or Podman (via /var/run/docker.sock; Ryuk is disabled for Podman).
 */
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { connect, type DbHandle } from "../src/index.js";
import { runMigrations } from "../src/migrate.js";

process.env.TESTCONTAINERS_RYUK_DISABLED ??= "true";

export interface TestDb extends DbHandle {
  container: StartedPostgreSqlContainer;
  reset(): Promise<void>;
  stop(): Promise<void>;
}

export async function startTestDb(): Promise<TestDb> {
  const container = await new PostgreSqlContainer("postgres:17-alpine").start();
  const handle = connect(container.getConnectionUri());
  await runMigrations(handle.db);
  return {
    ...handle,
    container,
    reset: async () => {
      await handle.db
        .execute(sql`truncate table evidence_bundles, invariant_results, attestation_observations,
        observed_events, webhook_deliveries, transfer_traces, chain_blocks, chain_cursors, jobs restart identity cascade`);
    },
    stop: async () => {
      await handle.close();
      await container.stop();
    },
  };
}
