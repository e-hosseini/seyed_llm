import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Status = "pending" | "approved" | "denied" | "revoked";

export interface User {
  telegram_id: number;
  name: string;
  username: string | null;
  status: Status;
  denied_until: number;
  litellm_key: string | null;
  session_id: string;
  session_started: number;
  net_idx: number | null;
  onboarded: number;
  created_at: number;
}

export class Store {
  private db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id     INTEGER PRIMARY KEY,
        name            TEXT NOT NULL,
        username        TEXT,
        status          TEXT NOT NULL,
        denied_until    INTEGER NOT NULL DEFAULT 0,
        litellm_key     TEXT,
        session_id      TEXT NOT NULL,
        session_started INTEGER NOT NULL DEFAULT 0,
        net_idx         INTEGER,
        created_at      INTEGER NOT NULL
      )
    `);
    // Databases created before onboarding existed get the column; their users are onboarded on their next message.
    const cols = this.db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "onboarded")) {
      this.db.exec("ALTER TABLE users ADD COLUMN onboarded INTEGER NOT NULL DEFAULT 0");
    }
  }

  get(id: number): User | undefined {
    return this.db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(id) as User | undefined;
  }

  all(): User[] {
    return this.db.prepare("SELECT * FROM users ORDER BY created_at").all() as User[];
  }

  createPending(id: number, name: string, username: string | null): User {
    this.db
      .prepare(
        "INSERT INTO users (telegram_id, name, username, status, session_id, created_at) VALUES (?, ?, ?, 'pending', ?, ?)",
      )
      .run(id, name, username, randomUUID(), Date.now());
    return this.get(id)!;
  }

  setStatus(id: number, status: Status): void {
    this.db.prepare("UPDATE users SET status = ? WHERE telegram_id = ?").run(status, id);
  }

  setDeniedUntil(id: number, ts: number): void {
    this.db.prepare("UPDATE users SET status = 'denied', denied_until = ? WHERE telegram_id = ?").run(ts, id);
  }

  setKey(id: number, key: string | null): void {
    this.db.prepare("UPDATE users SET litellm_key = ? WHERE telegram_id = ?").run(key, id);
  }

  allocNet(id: number): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(net_idx), 0) + 1 AS n FROM users").get() as { n: number };
    this.db.prepare("UPDATE users SET net_idx = ? WHERE telegram_id = ?").run(row.n, id);
    return row.n;
  }

  markSessionStarted(id: number): void {
    this.db.prepare("UPDATE users SET session_started = 1 WHERE telegram_id = ?").run(id);
  }

  markOnboarded(id: number): void {
    this.db.prepare("UPDATE users SET onboarded = 1 WHERE telegram_id = ?").run(id);
  }

  resetSession(id: number): string {
    const sid = randomUUID();
    this.db.prepare("UPDATE users SET session_id = ?, session_started = 0 WHERE telegram_id = ?").run(sid, id);
    return sid;
  }
}
