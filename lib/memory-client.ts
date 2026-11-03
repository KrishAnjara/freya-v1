/**
 * Browser side of FREYA's memory: where notes live, what a reflection may look at, and how its
 * proposed changes are applied. Framework-free and pure apart from the localStorage helpers,
 * so the rules are tested directly.
 *
 * Where notes live: a signed-in account keeps them in Supabase; otherwise this browser keeps
 * them (and sends them with each chat request). Notes the user deletes are remembered as
 * "forgotten" so a later reflection over an old conversation cannot bring them back.
 */
import { isIntimateTone } from "@/lib/intimacy";
import type { MemoryChanges, MemoryKind } from "@/lib/memory-reflection";

export type StoredMemory = {
  id: string;
  text: string;
  createdAt: string;
  updatedAt?: string;
  kind?: MemoryKind;
  /** Who wrote it: the user, or FREYA's automatic memory. */
  source?: "you" | "freya";
};

export const LOCAL_MEMORY_LIMIT = 60;
export const FORGOTTEN_KEY = "freya.v1.memoryForgotten";
/** When the user last chose "Forget everything"; older conversation isn't brought up again. */
export const MEMORY_RESET_KEY = "freya.v1.memoryResetAt";
const FORGOTTEN_LIMIT = 80;

/** A reflection needs this much new conversation: two user messages, or one substantial one. */
const MIN_NEW_USER_MESSAGES = 2;
const MIN_SINGLE_MESSAGE_CHARS = 160;
/** Earlier messages included so the new ones make sense; they are context, not re-mined. */
const CONTEXT_MESSAGES = 4;

export type ThreadMessage = { role: "user" | "assistant"; content: string };

/**
 * The part of a conversation a reflection should read, or null when there isn't enough new.
 * With intimate mode on, flirtatious turns (and the replies to them) are left out: those turns
 * run on the local model only and must not reach a hosted one this way.
 */
export function reflectionWindow(messages: ThreadMessage[], reflectedCount: number, skipIntimate: boolean) {
  const from = Math.max(0, Math.min(reflectedCount, messages.length));
  const fresh = messages.slice(from);
  const userTexts = fresh.filter((message) => message.role === "user" && message.content.trim()).map((message) => message.content);
  const enough = userTexts.length >= MIN_NEW_USER_MESSAGES || userTexts.some((text) => text.length >= MIN_SINGLE_MESSAGE_CHARS);
  if (!enough) return null;
  const turns: ThreadMessage[] = [];
  let skipping = false;
  for (const message of messages.slice(Math.max(0, from - CONTEXT_MESSAGES))) {
    if (message.role === "user") skipping = skipIntimate && isIntimateTone([message.content]);
    if (!skipping && message.content.trim()) turns.push({ role: message.role, content: message.content });
  }
  if (!turns.some((turn) => turn.role === "user")) return null;
  return { turns, upTo: messages.length };
}

/** Applies validated changes to browser-kept notes. Updates keep the note's id and age. */
export function applyChangesLocally(memories: StoredMemory[], changes: MemoryChanges, now: string, makeId: () => string): StoredMemory[] {
  const removed = new Set(changes.remove.map((item) => item.id));
  const updates = new Map(changes.update.map((item) => [item.id, item]));
  const kept = memories
    .filter((memory) => !removed.has(memory.id))
    .map((memory) => {
      const update = updates.get(memory.id);
      return update ? { ...memory, text: update.text, kind: update.kind, updatedAt: now } : memory;
    });
  const added: StoredMemory[] = changes.add.map((item) => ({ id: makeId(), text: item.text, kind: item.kind, source: "freya", createdAt: now, updatedAt: now }));
  return [...added, ...kept].slice(0, LOCAL_MEMORY_LIMIT);
}

/** A short, honest line about what automatic memory just did. */
export function describeChanges(changes: MemoryChanges): string {
  const { add, update, remove } = changes;
  if (add.length === 1 && !update.length && !remove.length) return `FREYA will remember: "${add[0].text}"`;
  const parts = [
    add.length ? `${add.length} new` : "",
    update.length ? `${update.length} updated` : "",
    remove.length ? `${remove.length} removed` : "",
  ].filter(Boolean);
  return parts.length ? `Memory updated: ${parts.join(", ")}. Review it in Settings → Memory.` : "";
}

export function hasChanges(changes: MemoryChanges) {
  return changes.add.length + changes.update.length + changes.remove.length > 0;
}

export function loadForgotten(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(FORGOTTEN_KEY) || "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, FORGOTTEN_LIMIT) : [];
  } catch {
    return [];
  }
}

/** Remembers what the user deleted, newest first, so it is never re-learned from old chats. */
export function rememberForgotten(texts: string[]) {
  try {
    const next = [...new Set([...texts.map((text) => text.trim()).filter(Boolean), ...loadForgotten()])].slice(0, FORGOTTEN_LIMIT);
    localStorage.setItem(FORGOTTEN_KEY, JSON.stringify(next));
  } catch { /* the deletion itself still happened */ }
}

export function normalizeStoredMemories(value: unknown): StoredMemory[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): StoredMemory[] => {
    if (!item || typeof item !== "object") return [];
    const memory = item as Record<string, unknown>;
    if (typeof memory.id !== "string" || typeof memory.text !== "string" || !memory.text.trim()) return [];
    return [{
      id: memory.id,
      text: memory.text.slice(0, 240),
      createdAt: typeof memory.createdAt === "string" ? memory.createdAt : new Date().toISOString(),
      ...(typeof memory.updatedAt === "string" ? { updatedAt: memory.updatedAt } : {}),
      ...(typeof memory.kind === "string" ? { kind: memory.kind as MemoryKind } : {}),
      ...(memory.source === "you" || memory.source === "freya" ? { source: memory.source as "you" | "freya" } : {}),
    }];
  }).slice(0, LOCAL_MEMORY_LIMIT);
}

// --- memory on this computer (/api/memory, lib/memory-store) --------------------------------

/** A conversation's recap as the memory store keeps it (mirrors lib/memory-store's Episode). */
export type StoredEpisode = { id: string; title: string; recap: string; startedAt?: string; updatedAt: string; messages?: number };

/** The notes and recaps kept on disk, or null when this install doesn't keep memory on disk. */
export async function fetchDiskMemory(): Promise<{ notes: StoredMemory[]; episodes: StoredEpisode[] } | null> {
  try {
    const response = await fetch("/api/memory", { cache: "no-store" });
    if (!response.ok) return null;
    const body = await response.json() as { enabled?: boolean; notes?: unknown; episodes?: unknown };
    if (!body.enabled) return null;
    const episodes = Array.isArray(body.episodes) ? body.episodes.filter((item): item is StoredEpisode => Boolean(item) && typeof item.id === "string" && typeof item.recap === "string") : [];
    return { notes: normalizeStoredMemories(body.notes), episodes };
  } catch {
    return null;
  }
}

const stamp = (memory: StoredMemory) => memory.updatedAt || memory.createdAt || "";

/**
 * This browser's notes and the disk's, as one list: one per id, the newer edit wins, anything
 * the user told FREYA to forget stays out, newest first.
 */
export function mergeMemories(local: StoredMemory[], disk: StoredMemory[], forgotten: string[] = []): StoredMemory[] {
  const gone = new Set(forgotten.map((text) => text.trim().toLowerCase()));
  const byId = new Map<string, StoredMemory>();
  for (const memory of [...disk, ...local]) {
    const current = byId.get(memory.id);
    if (!current || stamp(memory) > stamp(current)) byId.set(memory.id, memory);
  }
  return [...byId.values()]
    .filter((memory) => !gone.has(memory.text.trim().toLowerCase()))
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
    .slice(0, LOCAL_MEMORY_LIMIT);
}

export function sameMemories(a: StoredMemory[], b: StoredMemory[]) {
  if (a.length !== b.length) return false;
  const byId = new Map(b.map((memory) => [memory.id, memory]));
  return a.every((memory) => byId.get(memory.id)?.text === memory.text && stamp(byId.get(memory.id)!) === stamp(memory));
}

/** Writes the whole list to disk. Throws when it didn't save, so the caller can say so. */
export async function pushDiskMemories(notes: StoredMemory[]) {
  const response = await fetch("/api/memory", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notes }) });
  if (!response.ok) throw new Error(`memory sync failed (${response.status})`);
}

export async function forgetOnDisk(query: string) {
  const response = await fetch(`/api/memory?${query}`, { method: "DELETE" });
  if (!response.ok) throw new Error(`memory delete failed (${response.status})`);
}
