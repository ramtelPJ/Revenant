import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { sweepRunFolders } from "@/lib/cases/fs";
import { getEnv } from "@/lib/env";
import * as schema from "./schema";

export type Db = ReturnType<typeof drizzle<typeof schema>>;
export type OpenDatabase = { db: Db; sqlite: Database.Database };

/**
 * Opens (creating if needed) the database under `dataDir`: folder 0700, file 0600,
 * foreign keys on, WAL, migrations applied, and jobs left active by a previous
 * process marked failed.
 */
export function openDatabase(dataDir: string): OpenDatabase {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);

  const file = path.join(dataDir, "revenant.db");
  const sqlite = new Database(file);
  chmodSync(file, 0o600);
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("journal_mode = WAL");

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });

  const now = Date.now();
  sqlite
    .prepare(
      `UPDATE jobs SET status = 'failed', error_code = 'SERVER_RESTARTED',
         error_message = 'This step was interrupted by a restart.', finished_at = ?
       WHERE status IN ('queued', 'running')`,
    )
    .run(now);

  // A check that was running when the process died has no result. It already says "unrunnable"
  // (never a pass or fail), so it cannot be mistaken for evidence; say why, and drop its temp copy.
  sqlite
    .prepare(`UPDATE check_runs SET unrunnable_reason = 'interrupted', finished_at = ? WHERE status = 'unrunnable' AND unrunnable_reason = 'in_progress'`)
    .run(now);
  sweepRunFolders(dataDir);

  return { db, sqlite };
}

// Kept on globalThis so `next dev` hot reloads do not open a second connection.
const holder = globalThis as unknown as { __revenantDb?: OpenDatabase };

export function getDb(): Db {
  return (holder.__revenantDb ??= openDatabase(path.resolve(getEnv().DATA_DIR))).db;
}
