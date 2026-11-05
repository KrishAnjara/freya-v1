/**
 * One long chat with her, like a real thread on a phone, instead of separate conversations.
 *
 *   - Older separate chats are merged into it once, in time order.
 *   - Delete for me: the message is hidden on this side only; she still remembers it.
 *   - Delete for everyone: it reads "This message was deleted" and she forgets it (it leaves her
 *     history), as on WhatsApp.
 *   - Clear chat: everything goes, here and in the cloud.
 *   - Signed in, the chat is kept in Supabase (supabase/freya-messages.sql), so it follows the
 *     account and the whole history is there for her.
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

/** "For everyone": gone for both of them; a placeholder stays where it was, like WhatsApp's. */
export function deleteForEveryone<T extends ChatMessageLike>(messages: T[], id: string): T[] {
  return messages.map((message) => message.id === id
    ? { id: message.id, role: message.role, content: "", at: message.at, deleted: true, ...(message.turn ? { turn: message.turn } : {}) } as unknown as T
    : message);
}

/** What she reads: nothing deleted for everyone. Hidden-for-me messages stay (she still has them). */
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

/** The account's chat from Supabase, oldest first; null when the table isn't there yet or it fails. */
export async function pullChat<T extends ChatMessageLike>(client: SupabaseClient, userId: string): Promise<T[] | null> {
  const rows: { message: T }[] = [];
  for (let from = 0; from < 20_000; from += 1000) {
    const { data, error } = await client.from(TABLE).select("message").eq("user_id", userId).order("at", { ascending: true }).range(from, from + 999);
    if (error) return null;
    rows.push(...(data as { message: T }[]));
    if (!data || data.length < 1000) break;
  }
  return rows.map((row) => row.message).filter((message) => message && typeof message.id === "string");
}

export async function pushChat(client: SupabaseClient, userId: string, messages: ChatMessageLike[], upsert: string[], remove: string[]) {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const rows = upsert.map((id) => byId.get(id)).filter(Boolean).map((message) => ({
    user_id: userId, id: message!.id, at: message!.at ?? new Date().toISOString(), message: message!,
  }));
  for (let index = 0; index < rows.length; index += 200) {
    const { error } = await client.from(TABLE).upsert(rows.slice(index, index + 200), { onConflict: "user_id,id" });
    if (error) return false;
  }
  if (remove.length) {
    const { error } = await client.from(TABLE).delete().eq("user_id", userId).in("id", remove);
    if (error) return false;
  }
  return true;
}

export async function clearCloudChat(client: SupabaseClient, userId: string) {
  const { error } = await client.from(TABLE).delete().eq("user_id", userId);
  return !error;
}
