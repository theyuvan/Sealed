import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

/** Opens (or creates) a SQLite file and runs the schema. Use ":memory:" in tests. */
export function openDb(path: string, schema: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(schema);
  return db;
}

/** JSON with bigint support (bigints become decimal strings). */
export function jsonStringify(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
}
