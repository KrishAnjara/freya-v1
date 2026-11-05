/**
 * Attachment bytes, kept in IndexedDB.
 *
 * Conversations are saved to localStorage, which holds about 5 MB per site; two photos would
 * fill it. Messages keep only a small thumbnail and metadata, and the bytes live here, keyed
 * by attachment id. When IndexedDB is unavailable (private windows in some browsers) files
 * are kept in memory for the session instead, so sending still works.
 *
 * Signed in, every file also goes to the account's private Supabase bucket (freya-files, from
 * supabase/freya-deleted-messages.sql), at full quality, so pictures she sent and files they sent
 * show on any device. A file missing here is fetched from there.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type StoredAttachment = {
  /** Base64 without a data: prefix, for images, PDFs and other binary files. */
  data?: string;
  /** Text and code files, as text; or the text read from a PDF, document or picture on this device. */
  text?: string;
  /** Where `text` came from when the file isn't plain text: its own text layer, or OCR. */
  read?: "device" | "ocr";
};

const DB_NAME = "freya-attachments";
const STORE = "files";
const memory = new Map<string, StoredAttachment>();
let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  opening ??= new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return open().then((db) => new Promise<T | undefined>((resolve) => {
    if (!db) { resolve(undefined); return; }
    try {
      const transaction = db.transaction(STORE, mode);
      const request = action(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request ? request.result : undefined);
      transaction.onerror = () => resolve(undefined);
      transaction.onabort = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  }));
}

const BUCKET = "freya-files";
let cloud: { client: SupabaseClient; userId: string } | null = null;
let bucketMissing = false;
const cloudPath = (userId: string, id: string) => `${userId}/${id.replace(/[^\w.-]/g, "_")}.json`;

/** The signed-in account's bucket from now on (null: signed out, files stay on this device). */
export function connectCloudFiles(client: SupabaseClient | null, userId: string | null) {
  cloud = client && userId ? { client, userId } : null;
}

async function upload(id: string, value: StoredAttachment) {
  const target = cloud;
  if (!target || bucketMissing) return;
  const body = new Blob([JSON.stringify(value)], { type: "application/json" });
  const { error } = await target.client.storage.from(BUCKET).upload(cloudPath(target.userId, id), body, { upsert: true, contentType: "application/json" });
  if (error && /bucket not found|not found/i.test(error.message)) {
    bucketMissing = true;
    console.info("FREYA: run supabase/freya-deleted-messages.sql to keep pictures and files with your account. Until then they stay on this device.");
  }
}

async function download(id: string): Promise<StoredAttachment | undefined> {
  const target = cloud;
  if (!target || bucketMissing) return undefined;
  const { data, error } = await target.client.storage.from(BUCKET).download(cloudPath(target.userId, id));
  if (error || !data) return undefined;
  const value = await data.text().then((text) => JSON.parse(text) as StoredAttachment).catch(() => undefined);
  return value && (typeof value.data === "string" || typeof value.text === "string") ? value : undefined;
}

export async function putAttachment(id: string, value: StoredAttachment) {
  memory.set(id, value);
  // To the account in the background: a big picture never holds up the chat.
  void upload(id, value).catch(() => undefined);
  await run("readwrite", (store) => store.put(value, id));
}

export async function getAttachment(id: string): Promise<StoredAttachment | undefined> {
  const cached = memory.get(id);
  if (cached) return cached;
  const stored = await run<StoredAttachment>("readonly", (store) => store.get(id));
  if (stored) { memory.set(id, stored); return stored; }
  // Sent from another device, or this browser's copy was cleared: the account has it.
  const fetched = await download(id).catch(() => undefined);
  if (fetched) {
    memory.set(id, fetched);
    await run("readwrite", (store) => store.put(fetched, id));
  }
  return fetched;
}

export async function deleteAttachments(ids: string[]) {
  if (!ids.length) return;
  for (const id of ids) memory.delete(id);
  const target = cloud;
  if (target && !bucketMissing) void target.client.storage.from(BUCKET).remove(ids.map((id) => cloudPath(target.userId, id))).catch(() => undefined);
  await run("readwrite", (store) => { for (const id of ids) store.delete(id); });
}
