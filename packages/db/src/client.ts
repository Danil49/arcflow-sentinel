import { fileURLToPath } from "node:url";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
  close(): Promise<void>;
}

export function connect(connectionString: string, max = 10): DbHandle {
  const pool = new pg.Pool({ connectionString, max });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder });
}
