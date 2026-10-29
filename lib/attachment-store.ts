/**
 * Attachment bytes, kept in IndexedDB.
 *
 * Conversations are saved to localStorage, which holds about 5 MB per site; two photos would
 * fill it. Messages keep only a small thumbnail and metadata, and the bytes live here, keyed
 * by attachment id. When IndexedDB is unavailable (private windows in some browsers) files
 * are kept in memory for the session instead, so sending still works.
 */

export type StoredAttachment = {
  /** Base64 without a data: prefix, for images, PDFs and other binary files. */
  data?: string;
  /** Text and code files, as text. */
  text?: string;
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

export async function putAttachment(id: string, value: StoredAttachment) {
  memory.set(id, value);
  await run("readwrite", (store) => store.put(value, id));
}

export async function getAttachment(id: string): Promise<StoredAttachment | undefined> {
  const cached = memory.get(id);
  if (cached) return cached;
  const stored = await run<StoredAttachment>("readonly", (store) => store.get(id));
  if (stored) memory.set(id, stored);
  return stored;
}

export async function deleteAttachments(ids: string[]) {
  if (!ids.length) return;
  for (const id of ids) memory.delete(id);
  await run("readwrite", (store) => { for (const id of ids) store.delete(id); });
}
