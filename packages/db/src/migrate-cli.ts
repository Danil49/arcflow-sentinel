import { connect } from "./client.js";
import { runMigrations } from "./migrate.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(2);
}
const handle = connect(url, 1);
try {
  await runMigrations(handle.db);
  console.log("migrations applied");
} finally {
  await handle.close();
}
