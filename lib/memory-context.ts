/**
 * The memory part of one reply: notes and past-conversation recaps recalled from the store
 * (lib/memory-store) for what they're saying now (lib/memory-recall). Server-only.
 *
 * The browser still sends the notes it holds (older clients, or before the first sync); they
 * are merged by id so nothing is lost or duplicated. Embeddings for items that don't have one
 * yet are filled in after the reply has been sent, a few at a time, so they never slow it down.
 */
import { getMemoryStore, normalizeNotes, type Episode, type StoredNote } from "@/lib/memory-store";
import { recall, type Recalled } from "@/lib/memory-recall";
import { embed, embeddingSetup } from "@/lib/embeddings";

const BACKFILL_PER_TURN = 16;

export type TurnMemory = Recalled & { stored: number };

/** Notes from the store plus any the browser sent that the store hasn't seen yet. */
function mergeNotes(stored: StoredNote[], fromBrowser: StoredNote[]) {
  const ids = new Set(stored.map((note) => note.id));
  return [...stored, ...fromBrowser.filter((note) => !ids.has(note.id))];
}

export async function recallForTurn({ owner, recent, conversationId, browserNotes, openingTurn, signal }: {
  owner: string;
  recent: string[];
  conversationId?: string;
  browserNotes: unknown;
  openingTurn: boolean;
  signal?: AbortSignal;
}): Promise<TurnMemory | null> {
  const store = getMemoryStore();
  if (!store) return null;
  const notes = mergeNotes(store.notes(owner), normalizeNotes(browserNotes));
  const episodes = store.episodes(owner);
  if (!notes.length && !episodes.length) return { notes: [], episodes: [], stored: 0 };

  const setup = embeddingSetup();
  const queryVector = setup ? (await embed([recent.slice(-2).join("\n")], signal))?.[0] : undefined;
  const recalled = recall({
    notes, episodes, recent, conversationId, openingTurn,
    ...(setup && queryVector?.length ? {
      queryVector: { model: setup.model, values: queryVector },
      noteVectors: store.vectors(owner, "notes"),
      episodeVectors: store.vectors(owner, "episodes"),
    } : {}),
  });
  if (recalled.notes.length) store.markUsed(owner, recalled.notes.map((note) => note.id), new Date().toISOString());
  if (setup && queryVector?.length) void backfillVectors(owner, notes, episodes, setup.model);
  return { ...recalled, stored: notes.length + episodes.length };
}

/** Embeds a few items that have no vector for the current model yet. Best effort, never awaited. */
async function backfillVectors(owner: string, notes: StoredNote[], episodes: Episode[], model: string) {
  const store = getMemoryStore();
  if (!store) return;
  const noteVectors = store.vectors(owner, "notes");
  const episodeVectors = store.vectors(owner, "episodes");
  const missing = [
    ...notes.filter((note) => noteVectors.get(note.id)?.model !== model).map((note) => ({ table: "notes" as const, id: note.id, text: note.text })),
    ...episodes.filter((episode) => episodeVectors.get(episode.id)?.model !== model).map((episode) => ({ table: "episodes" as const, id: episode.id, text: `${episode.title}. ${episode.recap}` })),
  ].slice(0, BACKFILL_PER_TURN);
  if (!missing.length) return;
  const vectors = await embed(missing.map((item) => item.text), undefined, 10_000);
  if (!vectors) return;
  missing.forEach((item, index) => { if (vectors[index]?.length) store.setVector(owner, item.table, item.id, { model, values: vectors[index] }); });
}
