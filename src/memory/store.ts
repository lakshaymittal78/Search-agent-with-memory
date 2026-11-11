/**
 * Durable memory: one SQLite file, using Node's built-in driver (no native build step).
 *
 *   turns    one row per user→assistant exchange, indexed by time (the primary key for
 *            "what did I ask on 3 Nov") and by full text (FTS5) for "the Postgres one".
 *   claims   perishable facts extracted from each answer (price, version, launch...),
 *            so "is that still true?" becomes a per-claim recheck, not a re-read of prose.
 *   searches every query the agent ran, for auditability and debugging.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";

export type Source = { title: string; url: string; published?: string | null };

export type Turn = {
  id: string;
  conversationId: string;
  userText: string;
  assistantText: string;
  createdAt: Date;
  sources: Source[];
};

export type Claim = {
  id: number;
  turnId: string;
  entity: string;
  attribute: string;
  value: string;
  sourceUrl: string | null;
  observedAt: Date;
};

export type ConversationSummary = { id: string; title: string; createdAt: Date; updatedAt: Date; turns: number };

type TurnRow = {
  id: string;
  conversation_id: string;
  user_text: string;
  assistant_text: string;
  created_at: string;
  sources_json: string;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS turns (
  rowid           INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT UNIQUE NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  user_text       TEXT NOT NULL,
  assistant_text  TEXT NOT NULL,
  created_at      TEXT NOT NULL,           -- ISO-8601 UTC; lexical order == time order
  sources_json    TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS turns_created_at ON turns(created_at);
CREATE INDEX IF NOT EXISTS turns_conversation ON turns(conversation_id, created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
  user_text, assistant_text, content='turns', content_rowid='rowid', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
  INSERT INTO turns_fts(rowid, user_text, assistant_text) VALUES (new.rowid, new.user_text, new.assistant_text);
END;

CREATE TABLE IF NOT EXISTS claims (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id     TEXT NOT NULL REFERENCES turns(id),
  entity      TEXT NOT NULL,
  attribute   TEXT NOT NULL,
  value       TEXT NOT NULL,
  source_url  TEXT,
  observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS claims_turn ON claims(turn_id);

CREATE TABLE IF NOT EXISTS searches (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id      TEXT NOT NULL,
  query        TEXT NOT NULL,
  params_json  TEXT NOT NULL,
  result_count INTEGER NOT NULL,
  created_at   TEXT NOT NULL
);
`;

function toTurn(r: TurnRow): Turn {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    userText: r.user_text,
    assistantText: r.assistant_text,
    createdAt: new Date(r.created_at),
    sources: JSON.parse(r.sources_json) as Source[],
  };
}

/** Turn free text into a safe FTS5 OR-query of quoted terms. */
export function ftsQuery(terms: string[]): string | null {
  const tokens = new Set<string>();
  for (const t of terms) {
    for (const w of t.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (w.length >= 2 && !STOP.has(w)) tokens.add(w);
    }
  }
  if (tokens.size === 0) return null;
  return [...tokens].map((w) => `"${w}"`).join(" OR ");
}
const STOP = new Set(["the", "and", "for", "with", "what", "about", "did", "you", "me", "my", "is", "it", "of", "to", "in", "on", "any", "has", "have", "since", "we", "our", "a", "an", "or", "be", "was", "are"]);

export class MemoryStore {
  private db: DatabaseSync;

  constructor(path = config.dbPath) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  ensureConversation(id: string | undefined, firstMessage: string, at: Date): string {
    if (id) {
      const row = this.db.prepare("SELECT id FROM conversations WHERE id = ?").get(id);
      if (row) return id;
    }
    const newId = id ?? randomUUID();
    const title = firstMessage.replace(/\s+/g, " ").trim().slice(0, 80) || "New chat";
    this.db
      .prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(newId, title, at.toISOString(), at.toISOString());
    return newId;
  }

  saveTurn(t: Omit<Turn, "id"> & { id?: string }): string {
    const id = t.id ?? randomUUID();
    this.db
      .prepare(
        "INSERT INTO turns (id, conversation_id, user_text, assistant_text, created_at, sources_json) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, t.conversationId, t.userText, t.assistantText, t.createdAt.toISOString(), JSON.stringify(t.sources));
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(t.createdAt.toISOString(), t.conversationId);
    return id;
  }

  conversationTurns(conversationId: string, limit = 50): Turn[] {
    const rows = this.db
      .prepare("SELECT * FROM (SELECT * FROM turns WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?) ORDER BY created_at ASC")
      .all(conversationId, limit) as TurnRow[];
    return rows.map(toTurn);
  }

  /** Turns in [start, end), best keyword matches first when terms are given, else chronological. */
  turnsInRange(start: Date, end: Date, terms: string[] = [], limit = 8): Turn[] {
    const q = ftsQuery(terms);
    const s = start.toISOString();
    const e = end.toISOString();
    if (q) {
      const matched = this.db
        .prepare(
          `SELECT t.* FROM turns_fts f JOIN turns t ON t.rowid = f.rowid
           WHERE turns_fts MATCH ? AND t.created_at >= ? AND t.created_at < ?
           ORDER BY bm25(turns_fts) LIMIT ?`,
        )
        .all(q, s, e, limit) as TurnRow[];
      if (matched.length) return matched.map(toTurn);
    }
    // Nothing matched the topic words (the user may describe it differently): show the whole day.
    const rows = this.db
      .prepare("SELECT * FROM turns WHERE created_at >= ? AND created_at < ? ORDER BY created_at ASC LIMIT ?")
      .all(s, e, limit) as TurnRow[];
    return rows.map(toTurn);
  }

  /** Keyword search across all history, newest first among the best matches. */
  searchTurns(terms: string[], limit = 5, before?: Date): Turn[] {
    const q = ftsQuery(terms);
    if (!q) return [];
    const rows = this.db
      .prepare(
        `SELECT t.* FROM turns_fts f JOIN turns t ON t.rowid = f.rowid
         WHERE turns_fts MATCH ? AND t.created_at < ?
         ORDER BY bm25(turns_fts) LIMIT ?`,
      )
      .all(q, (before ?? new Date(8.64e15)).toISOString(), limit) as TurnRow[];
    return rows.map(toTurn).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /** The nearest instants with any activity before/after a range: used to say "closest I have is 4 Nov". */
  nearestActivity(start: Date, end: Date): { before: Turn | null; after: Turn | null } {
    const before = this.db.prepare("SELECT * FROM turns WHERE created_at < ? ORDER BY created_at DESC LIMIT 1").get(start.toISOString()) as TurnRow | undefined;
    const after = this.db.prepare("SELECT * FROM turns WHERE created_at >= ? ORDER BY created_at ASC LIMIT 1").get(end.toISOString()) as TurnRow | undefined;
    return { before: before ? toTurn(before) : null, after: after ? toTurn(after) : null };
  }

  saveClaims(turnId: string, observedAt: Date, claims: { entity: string; attribute: string; value: string; sourceUrl: string | null }[]): void {
    const stmt = this.db.prepare(
      "INSERT INTO claims (turn_id, entity, attribute, value, source_url, observed_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const c of claims) stmt.run(turnId, c.entity, c.attribute, c.value, c.sourceUrl, observedAt.toISOString());
  }

  claimsForTurns(turnIds: string[]): Map<string, Claim[]> {
    const out = new Map<string, Claim[]>();
    if (!turnIds.length) return out;
    const rows = this.db
      .prepare(`SELECT * FROM claims WHERE turn_id IN (${turnIds.map(() => "?").join(",")}) ORDER BY id`)
      .all(...turnIds) as { id: number; turn_id: string; entity: string; attribute: string; value: string; source_url: string | null; observed_at: string }[];
    for (const r of rows) {
      const list = out.get(r.turn_id) ?? [];
      list.push({ id: r.id, turnId: r.turn_id, entity: r.entity, attribute: r.attribute, value: r.value, sourceUrl: r.source_url, observedAt: new Date(r.observed_at) });
      out.set(r.turn_id, list);
    }
    return out;
  }

  logSearch(turnId: string, query: string, params: unknown, resultCount: number, at: Date): void {
    this.db
      .prepare("INSERT INTO searches (turn_id, query, params_json, result_count, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(turnId, query, JSON.stringify(params), resultCount, at.toISOString());
  }

  listConversations(limit = 50): ConversationSummary[] {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.title, c.created_at, c.updated_at, COUNT(t.id) AS turns
         FROM conversations c LEFT JOIN turns t ON t.conversation_id = c.id
         GROUP BY c.id ORDER BY c.updated_at DESC LIMIT ?`,
      )
      .all(limit) as { id: string; title: string; created_at: string; updated_at: string; turns: number }[];
    return rows.map((r) => ({ id: r.id, title: r.title, createdAt: new Date(r.created_at), updatedAt: new Date(r.updated_at), turns: Number(r.turns) }));
  }
}

let singleton: MemoryStore | null = null;
export function store(): MemoryStore {
  return (singleton ??= new MemoryStore());
}
