/**
 * FREYA's memory, on disk: notes about the user (semantic + follow-ups) and one recap per
 * conversation (episodic). Outside the model, outside the browser, so it survives cleared site
 * data, a different browser, and the Colab server going away.
 *
 * SQLite through node:sqlite (built into Node 22.5+, no dependency), at data/freya-memory.db or
 * FREYA_MEMORY_PATH (":memory:" in tests). Where node:sqlite isn't available it falls back to a
 * JSON file written atomically. Server-only.
 *
 * It is used only where there is one owner to protect: a self-hosted install
 * (FREYA_SELF_HOSTED=true) or development. A public deployment has anonymous visitors whose
 * notes must not mix, so it keeps using the browser or the signed-in account (Supabase).
 */
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { containsSensitiveCredential } from "@/lib/sensitive-data";
import { MEMORY_KINDS, type MemoryKind } from "@/lib/memory-reflection";

export type StoredNote = {
  id: string;
  text: string;
  kind?: MemoryKind;
  source?: "you" | "freya";
  createdAt: string;
  updatedAt?: string;
  /** How often retrieval has put it in a prompt, and when last. */
  uses?: number;
  lastUsedAt?: string;
};

export type Episode = {
  /** The conversation's id: one recap per conversation. */
  id: string;
  title: string;
  recap: string;
  startedAt?: string;
  updatedAt: string;
  messages?: number;
};

export type Vector = { model: string; values: number[] };

export const MAX_NOTES = 200;
export const MAX_EPISODES = 500;
const MAX_NOTE_TEXT = 240;
const MAX_RECAP_TEXT = 400;

export interface MemoryStore {
  readonly kind: "sqlite" | "json";
  notes(owner: string): StoredNote[];
  replaceNotes(owner: string, notes: StoredNote[]): StoredNote[];
  episodes(owner: string): Episode[];
  upsertEpisode(owner: string, episode: Episode): Episode;
  deleteEpisode(owner: string, id: string): void;
  clear(owner: string, scope: "notes" | "episodes" | "all"): void;
  markUsed(owner: string, noteIds: string[], at: string): void;
  vectors(owner: string, table: "notes" | "episodes"): Map<string, Vector>;
  setVector(owner: string, table: "notes" | "episodes", id: string, vector: Vector): void;
  close(): void;
}

// --- validation (the same rules wherever notes come from) ---------------------------------

const clean = (value: unknown, max: number) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
const isoOr = (value: unknown, fallback: string) => typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : fallback;

/** Notes as the browser sends them: bounded, credential-free, one per id, newest first. */
export function normalizeNotes(input: unknown, now = new Date().toISOString()): StoredNote[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const notes: StoredNote[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const id = clean(raw.id, 64);
    const text = clean(raw.text, MAX_NOTE_TEXT);
    if (!id || !text || seen.has(id) || containsSensitiveCredential(text)) continue;
    seen.add(id);
    notes.push({
      id, text,
      ...(typeof raw.kind === "string" && (MEMORY_KINDS as readonly string[]).includes(raw.kind) ? { kind: raw.kind as MemoryKind } : {}),
      ...(raw.source === "you" || raw.source === "freya" ? { source: raw.source } : {}),
      createdAt: isoOr(raw.createdAt, now),
      ...(raw.updatedAt ? { updatedAt: isoOr(raw.updatedAt, now) } : {}),
    });
    if (notes.length >= MAX_NOTES) break;
  }
  return notes;
}

export function normalizeEpisode(input: unknown, now = new Date().toISOString()): Episode | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const id = clean(raw.id, 64);
  const recap = clean(raw.recap, MAX_RECAP_TEXT);
  if (!id || !recap || containsSensitiveCredential(recap)) return null;
  return {
    id, recap,
    title: clean(raw.title, 80) || "Untitled",
    ...(raw.startedAt ? { startedAt: isoOr(raw.startedAt, now) } : {}),
    updatedAt: isoOr(raw.updatedAt, now),
    ...(Number.isInteger(raw.messages) && (raw.messages as number) >= 0 ? { messages: Math.min(100_000, raw.messages as number) } : {}),
  };
}

// --- SQLite --------------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Statement = { run: (...args: unknown[]) => unknown; all: (...args: unknown[]) => Row[]; get: (...args: unknown[]) => Row | undefined };
type Database = { exec: (sql: string) => void; prepare: (sql: string) => Statement; close: () => void };

function openSqlite(path: string): Database | null {
  try {
    // Loaded at runtime so a Node without node:sqlite falls back instead of failing to start.
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string) => Database };
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS notes (
        owner TEXT NOT NULL, id TEXT NOT NULL, text TEXT NOT NULL, kind TEXT, source TEXT,
        created_at TEXT NOT NULL, updated_at TEXT, uses INTEGER NOT NULL DEFAULT 0, last_used_at TEXT,
        vector TEXT, vector_model TEXT, PRIMARY KEY (owner, id));
      CREATE TABLE IF NOT EXISTS episodes (
        owner TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, recap TEXT NOT NULL,
        started_at TEXT, updated_at TEXT NOT NULL, messages INTEGER,
        vector TEXT, vector_model TEXT, PRIMARY KEY (owner, id));
      CREATE INDEX IF NOT EXISTS episodes_recent ON episodes (owner, updated_at DESC);
    `);
    return db;
  } catch (error) {
    console.warn(`FREYA memory: SQLite unavailable (${error instanceof Error ? error.message.slice(0, 120) : "error"}); using a JSON file.`);
    return null;
  }
}

function sqliteStore(db: Database): MemoryStore {
  const noteFrom = (row: Row): StoredNote => ({
    id: String(row.id), text: String(row.text),
    ...(row.kind ? { kind: row.kind as MemoryKind } : {}),
    ...(row.source ? { source: row.source as "you" | "freya" } : {}),
    createdAt: String(row.created_at),
    ...(row.updated_at ? { updatedAt: String(row.updated_at) } : {}),
    uses: Number(row.uses ?? 0),
    ...(row.last_used_at ? { lastUsedAt: String(row.last_used_at) } : {}),
  });
  const episodeFrom = (row: Row): Episode => ({
    id: String(row.id), title: String(row.title), recap: String(row.recap),
    ...(row.started_at ? { startedAt: String(row.started_at) } : {}),
    updatedAt: String(row.updated_at),
    ...(row.messages !== null && row.messages !== undefined ? { messages: Number(row.messages) } : {}),
  });
  return {
    kind: "sqlite",
    notes: (owner) => db.prepare("SELECT * FROM notes WHERE owner = ? ORDER BY created_at DESC").all(owner).map(noteFrom),
    replaceNotes(owner, notes) {
      // A full replace from the browser, which is where notes are edited. Usage counts and
      // vectors of notes whose text didn't change are kept.
      const previous = new Map(db.prepare("SELECT id, text, uses, last_used_at, vector, vector_model FROM notes WHERE owner = ?").all(owner).map((row) => [String(row.id), row]));
      db.exec("BEGIN");
      try {
        db.prepare("DELETE FROM notes WHERE owner = ?").run(owner);
        const insert = db.prepare("INSERT INTO notes (owner, id, text, kind, source, created_at, updated_at, uses, last_used_at, vector, vector_model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        for (const note of notes.slice(0, MAX_NOTES)) {
          const old = previous.get(note.id);
          const same = old && old.text === note.text;
          insert.run(owner, note.id, note.text, note.kind ?? null, note.source ?? null, note.createdAt, note.updatedAt ?? null,
            Number(old?.uses ?? 0), (old?.last_used_at as string | null) ?? null, same ? (old.vector as string | null) : null, same ? (old.vector_model as string | null) : null);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return this.notes(owner);
    },
    episodes: (owner) => db.prepare("SELECT * FROM episodes WHERE owner = ? ORDER BY updated_at DESC").all(owner).map(episodeFrom),
    upsertEpisode(owner, episode) {
      db.prepare(`INSERT INTO episodes (owner, id, title, recap, started_at, updated_at, messages, vector, vector_model) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
        ON CONFLICT (owner, id) DO UPDATE SET title = excluded.title, recap = excluded.recap, started_at = COALESCE(episodes.started_at, excluded.started_at),
        updated_at = excluded.updated_at, messages = excluded.messages,
        vector = CASE WHEN episodes.recap = excluded.recap THEN episodes.vector ELSE NULL END,
        vector_model = CASE WHEN episodes.recap = excluded.recap THEN episodes.vector_model ELSE NULL END`)
        .run(owner, episode.id, episode.title, episode.recap, episode.startedAt ?? null, episode.updatedAt, episode.messages ?? null);
      // Oldest recaps beyond the cap go first.
      db.prepare("DELETE FROM episodes WHERE owner = ? AND id NOT IN (SELECT id FROM episodes WHERE owner = ? ORDER BY updated_at DESC LIMIT ?)").run(owner, owner, MAX_EPISODES);
      return episode;
    },
    deleteEpisode: (owner, id) => { db.prepare("DELETE FROM episodes WHERE owner = ? AND id = ?").run(owner, id); },
    clear(owner, scope) {
      if (scope !== "episodes") db.prepare("DELETE FROM notes WHERE owner = ?").run(owner);
      if (scope !== "notes") db.prepare("DELETE FROM episodes WHERE owner = ?").run(owner);
    },
    markUsed(owner, noteIds, at) {
      const update = db.prepare("UPDATE notes SET uses = uses + 1, last_used_at = ? WHERE owner = ? AND id = ?");
      for (const id of noteIds) update.run(at, owner, id);
    },
    vectors(owner, table) {
      const rows = db.prepare(`SELECT id, vector, vector_model FROM ${table === "notes" ? "notes" : "episodes"} WHERE owner = ? AND vector IS NOT NULL`).all(owner);
      return new Map(rows.flatMap((row) => {
        try { return [[String(row.id), { model: String(row.vector_model), values: JSON.parse(String(row.vector)) as number[] }]]; } catch { return []; }
      }));
    },
    close: () => db.close(),
    setVector(owner, table, id, vector) {
      db.prepare(`UPDATE ${table === "notes" ? "notes" : "episodes"} SET vector = ?, vector_model = ? WHERE owner = ? AND id = ?`).run(JSON.stringify(vector.values.map((value) => Math.round(value * 1e5) / 1e5)), vector.model, owner, id);
    },
  };
}

// --- JSON file fallback --------------------------------------------------------------------

type JsonShape = Record<string, { notes: (StoredNote & { vector?: Vector })[]; episodes: (Episode & { vector?: Vector })[] }>;

function jsonStore(path: string): MemoryStore {
  const memory = path === ":memory:";
  let data: JsonShape = {};
  if (!memory) {
    try { data = JSON.parse(readFileSync(path, "utf8")) as JsonShape; } catch { data = {}; }
  }
  const save = () => {
    if (memory) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify(data));
    renameSync(`${path}.tmp`, path);
  };
  const of = (owner: string) => (data[owner] ??= { notes: [], episodes: [] });
  const strip = <T extends { vector?: Vector }>({ vector: _vector, ...rest }: T) => rest;
  return {
    kind: "json",
    notes: (owner) => of(owner).notes.map(strip).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    replaceNotes(owner, notes) {
      const previous = new Map(of(owner).notes.map((note) => [note.id, note]));
      of(owner).notes = notes.slice(0, MAX_NOTES).map((note) => {
        const old = previous.get(note.id);
        return { ...note, uses: old?.uses ?? 0, ...(old?.lastUsedAt ? { lastUsedAt: old.lastUsedAt } : {}), ...(old?.vector && old.text === note.text ? { vector: old.vector } : {}) };
      });
      save();
      return this.notes(owner);
    },
    episodes: (owner) => of(owner).episodes.map(strip).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    upsertEpisode(owner, episode) {
      const list = of(owner).episodes;
      const index = list.findIndex((item) => item.id === episode.id);
      const old = index >= 0 ? list[index] : undefined;
      const next = { ...episode, startedAt: old?.startedAt ?? episode.startedAt, ...(old?.vector && old.recap === episode.recap ? { vector: old.vector } : {}) };
      if (index >= 0) list[index] = next; else list.push(next);
      of(owner).episodes = list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_EPISODES);
      save();
      return episode;
    },
    deleteEpisode(owner, id) { of(owner).episodes = of(owner).episodes.filter((item) => item.id !== id); save(); },
    clear(owner, scope) {
      if (scope !== "episodes") of(owner).notes = [];
      if (scope !== "notes") of(owner).episodes = [];
      save();
    },
    markUsed(owner, noteIds, at) {
      const ids = new Set(noteIds);
      for (const note of of(owner).notes) if (ids.has(note.id)) { note.uses = (note.uses ?? 0) + 1; note.lastUsedAt = at; }
      save();
    },
    vectors(owner, table) {
      const list: { id: string; vector?: Vector }[] = table === "notes" ? of(owner).notes : of(owner).episodes;
      return new Map(list.flatMap((item) => item.vector ? [[item.id, item.vector] as const] : []));
    },
    close: () => {},
    setVector(owner, table, id, vector) {
      const list: { id: string; vector?: Vector }[] = table === "notes" ? of(owner).notes : of(owner).episodes;
      const item = list.find((entry) => entry.id === id);
      if (item) { item.vector = vector; save(); }
    },
  };
}

// --- the one store -------------------------------------------------------------------------

const holder = globalThis as typeof globalThis & { __freyaMemoryStore?: { path: string; store: MemoryStore } };

export function memoryStorePath() {
  return process.env.FREYA_MEMORY_PATH?.trim() || join(process.cwd(), "data", "freya-memory.db");
}

/** Whether this install keeps memory on disk: one owner (self-hosted or development), not switched off. */
export function memoryStoreEnabled() {
  if ((process.env.FREYA_MEMORY_STORE || "").trim().toLowerCase() === "off") return false;
  const selfHosted = (process.env.FREYA_SELF_HOSTED || "").trim().toLowerCase() === "true";
  return selfHosted || process.env.NODE_ENV !== "production";
}

/** The store, opened once per process (kept on globalThis so dev hot reloads don't reopen it). */
export function getMemoryStore(): MemoryStore | null {
  if (!memoryStoreEnabled()) return null;
  const path = memoryStorePath();
  if (holder.__freyaMemoryStore?.path === path) return holder.__freyaMemoryStore.store;
  const db = openSqlite(path);
  const store = db ? sqliteStore(db) : jsonStore(path.replace(/\.db$/, ".json"));
  holder.__freyaMemoryStore = { path, store };
  return store;
}

/** For tests: forget the open store so the next call opens FREYA_MEMORY_PATH afresh. */
export function resetMemoryStoreForTests() {
  try { holder.__freyaMemoryStore?.store.close(); } catch { /* already closed */ }
  delete holder.__freyaMemoryStore;
}
