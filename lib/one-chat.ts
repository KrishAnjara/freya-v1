/**
 * One long chat with her, like a real thread on a phone, instead of separate conversations.
 *
 *   - Older separate chats are merged into it once, in time order.
 *   - Delete for me: the message leaves the chat on every device, into the deleted messages
 *     (freya_deleted_messages); she still remembers it and can answer from it.
 *   - Delete for everyone: it is gone, from the chat and from her; nothing is kept of it.
 *   - Clear chat: every message goes into the deleted messages, as "delete for me" on all of them.
 *   - The chat lives in Supabase only (supabase/freya-messages.sql, freya-deleted-messages.sql),
 *     never in the browser: any device shows the account's active messages, and she reads both.
 *     Only while those tables are missing does it fall back to this browser, so nothing is lost.
 * Pure apart from the Supabase calls, so the rules are tested directly.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type ChatMessageLike = {
  id: string;
  role: "user" | "assistant";
  content: string;
  at?: string;
  hiddenForMe?: boolean;
  deleted?: boolean;
  [key: string]: unknown;
};

const time = (message: { at?: string }) => {
  const parsed = Date.parse(message.at ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Every chat's messages in one thread, oldest first, each message once. Order within a chat is kept. */
export function mergeChats<T extends ChatMessageLike>(chats: { messages: T[] }[]): T[] {
  const seen = new Set<string>();
  const all: { message: T; order: number }[] = [];
  let order = 0;
  for (const chat of chats) {
    for (const message of chat.messages) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      all.push({ message, order: order++ });
    }
  }
  // Undated messages keep their place relative to their neighbours.
  return all.sort((a, b) => (time(a.message) && time(b.message) ? time(a.message) - time(b.message) : 0) || a.order - b.order).map(({ message }) => message);
}

/** "For me": hidden here, still part of what she knows. */
export function deleteForMe<T extends ChatMessageLike>(messages: T[], id: string): T[] {
  return messages.map((message) => message.id === id ? { ...message, hiddenForMe: true } : message);
}

/** "For everyone": gone for both of them, with nothing kept. */
export function deleteForEveryone<T extends ChatMessageLike>(messages: T[], id: string): T[] {
  return messages.filter((message) => message.id !== id);
}

/** Clear chat: every message is deleted for me (she still has them all). */
export function clearForMe<T extends ChatMessageLike>(messages: T[]): T[] {
  return messages.map((message) => message.hiddenForMe ? message : { ...message, hiddenForMe: true });
}

/** What she reads: both tables, the active messages and the deleted-for-me ones. (`deleted` is an older placeholder.) */
export function forHer<T extends ChatMessageLike>(messages: T[]): T[] {
  return messages.filter((message) => !message.deleted);
}

/** What's shown: everything except what was deleted for me. */
export function forMe<T extends ChatMessageLike>(messages: T[]): T[] {
  return messages.filter((message) => !message.hiddenForMe);
}

/** The cloud copy and this browser's, together: each message once, a deletion on either side wins. */
export function mergeCloud<T extends ChatMessageLike>(local: T[], cloud: T[]): T[] {
  const byId = new Map<string, T>();
  for (const message of [...cloud, ...local]) {
    const known = byId.get(message.id);
    if (!known) { byId.set(message.id, message); continue; }
    // A deletion, or hiding, made anywhere sticks; otherwise this browser's copy (it may be newer).
    if (known.deleted || message.deleted) byId.set(message.id, known.deleted ? known : message);
    else byId.set(message.id, { ...message, ...(known.hiddenForMe || message.hiddenForMe ? { hiddenForMe: true } : {}) });
  }
  return mergeChats([{ messages: [...byId.values()] }]);
}

/** What changed since the last sync: rows to write, ids to remove. */
export function chatDiff(previous: Map<string, string>, messages: ChatMessageLike[]) {
  const current = new Map(messages.filter((message) => !message.streaming).map((message) => [message.id, JSON.stringify(message)]));
  const upsert = [...current].filter(([id, json]) => previous.get(id) !== json).map(([id]) => id);
  const remove = [...previous.keys()].filter((id) => !current.has(id));
  return { upsert, remove, current };
}

const TABLE = "freya_messages";
const DELETED = "freya_deleted_messages";

const isMissing = (error: { code?: string; message?: string } | null) =>
  Boolean(error && (error.code === "PGRST205" || error.code === "42P01" || /does not exist|could not find the table/i.test(error.message ?? "")));

/** Set once the deleted-messages table turns out not to be there: hidden messages then stay flagged in freya_messages. */
let deletedMissing = false;

async function pullTable<T extends ChatMessageLike>(client: SupabaseClient, table: string, userId: string): Promise<T[] | null | "missing"> {
  const rows: { message: T }[] = [];
  for (let from = 0; from < 20_000; from += 1000) {
    const { data, error } = await client.from(table).select("message").eq("user_id", userId).order("at", { ascending: true }).range(from, from + 999);
    if (isMissing(error)) return "missing";
    if (error) return null;
    rows.push(...(data as { message: T }[]));
    if (!data || data.length < 1000) break;
  }
  return rows.map((row) => row.message).filter((message) => message && typeof message.id === "string");
}

/**
 * The account's chat, oldest first: the active messages and the deleted-for-me ones (flagged
 * hiddenForMe, so they're for her and not shown). "missing" when the messages table isn't there;
 * null when Supabase couldn't be reached.
 */
export async function pullChat<T extends ChatMessageLike>(client: SupabaseClient, userId: string): Promise<T[] | null | "missing"> {
  const active = await pullTable<T>(client, TABLE, userId);
  if (active === "missing" || active === null) return active;
  const hidden = deletedMissing ? "missing" : await pullTable<T>(client, DELETED, userId);
  if (hidden === "missing") deletedMissing = true;
  else if (hidden === null) return null;
  const gone = Array.isArray(hidden) ? hidden.map((message) => ({ ...message, hiddenForMe: true })) : [];
  // A message in both (a move cut off half way) counts as deleted.
  return mergeChats([{ messages: gone }, { messages: active }]);
}

const rowsOf = (userId: string, messages: ChatMessageLike[], extra: Record<string, unknown> = {}) =>
  messages.map((message) => ({ user_id: userId, id: message.id, at: message.at ?? new Date().toISOString(), message, ...extra }));

async function upsertRows(client: SupabaseClient, table: string, rows: Record<string, unknown>[]) {
  for (let index = 0; index < rows.length; index += 200) {
    const { error } = await client.from(table).upsert(rows.slice(index, index + 200), { onConflict: "user_id,id" });
    if (error) return error;
  }
  return null;
}

/**
 * Writes what changed: shown messages to freya_messages; deleted-for-me ones moved to
 * freya_deleted_messages; deleted-for-everyone ones (gone from the list) removed from both.
 */
export async function pushChat(client: SupabaseClient, userId: string, messages: ChatMessageLike[], upsert: string[], remove: string[]) {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const changed = upsert.map((id) => byId.get(id)).filter((message): message is ChatMessageLike => Boolean(message));
  const shown = changed.filter((message) => !message.hiddenForMe);
  const hidden = changed.filter((message) => message.hiddenForMe);
  if (await upsertRows(client, TABLE, rowsOf(userId, shown))) return false;
  if (hidden.length) {
    if (!deletedMissing) {
      const error = await upsertRows(client, DELETED, rowsOf(userId, hidden, { deleted_at: new Date().toISOString() }));
      if (isMissing(error)) {
        deletedMissing = true;
        console.info("FREYA: run supabase/freya-deleted-messages.sql to keep deleted messages apart. Until then they stay in freya_messages, marked.");
      } else if (error) return false;
    }
    if (deletedMissing) {
      if (await upsertRows(client, TABLE, rowsOf(userId, hidden))) return false;
    } else {
      const { error } = await client.from(TABLE).delete().eq("user_id", userId).in("id", hidden.map((message) => message.id));
      if (error) return false;
    }
  }
  if (remove.length) {
    const { error } = await client.from(TABLE).delete().eq("user_id", userId).in("id", remove);
    if (error) return false;
    if (!deletedMissing) await client.from(DELETED).delete().eq("user_id", userId).in("id", remove);
  }
  return true;
}
