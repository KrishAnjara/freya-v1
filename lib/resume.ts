/**
 * Replies survive a page refresh. What she owes (the reply she's on, and any waiting) is saved as
 * it changes; when the page opens again it's picked back up: a reply she hadn't started is asked
 * for again, and one cut off part-way carries on from her last message instead of starting over.
 * Her own unprompted texts aren't resumed (the moment has passed), nor anything older than half an
 * hour. Pure apart from the storage helpers.
 */
import type { QueueJob } from "@/lib/reply-queue";

export type Inflight = {
  /** The reply that was running, with how far it got. */
  active: (QueueJob & { posted: number; lastPostedId?: string }) | null;
  waiting: QueueJob[];
  savedAt: number;
};

export const RESUME_WITHIN_MS = 30 * 60_000;
export const CONTINUE_PROMPT = "Continue from exactly where you stopped. Do not repeat anything.";

type Thread = { id: string; messages: { id: string; role: string; command?: string }[] };

/** The jobs to queue again after a reload, in order. */
export function resumeJobs(saved: Inflight | null, conversations: Thread[], now = Date.now()): QueueJob[] {
  if (!saved || now - saved.savedAt > RESUME_WITHIN_MS) return [];
  const jobs: QueueJob[] = [];
  const answered = (job: QueueJob) => {
    const thread = conversations.find((item) => item.id === job.conversationId);
    if (!thread) return true;
    const index = thread.messages.findIndex((message) => message.id === job.targetId);
    if (index < 0) return true;
    // Something of hers after it (other than a command card) means it was answered.
    return thread.messages.slice(index + 1).some((message) => message.role === "assistant" && !message.command);
  };
  const candidates = [...(saved.active ? [saved.active] : []), ...saved.waiting];
  for (const job of candidates) {
    if (job.initiative || job.event) continue;
    const { posted, lastPostedId, ...plain } = job as QueueJob & { posted?: number; lastPostedId?: string };
    if (job === saved.active && posted && lastPostedId) {
      const thread = conversations.find((item) => item.id === job.conversationId);
      if (thread?.messages.some((message) => message.id === lastPostedId)) {
        jobs.push({ conversationId: job.conversationId, targetId: lastPostedId, turn: plain.turn, extraPrompt: CONTINUE_PROMPT });
      }
      continue;
    }
    if (plain.extraPrompt) { jobs.push(plain); continue; }
    if (!answered(plain)) jobs.push({ conversationId: plain.conversationId, targetId: plain.targetId, ...(plain.turn ? { turn: plain.turn } : {}) });
  }
  return jobs;
}

const KEY = "freya.v1.inflight";

export function saveInflight(state: Inflight | null) {
  try {
    if (state && (state.active || state.waiting.length)) localStorage.setItem(KEY, JSON.stringify(state));
    else localStorage.removeItem(KEY);
  } catch { /* a refresh then simply loses it, as before */ }
}

export function loadInflight(): Inflight | null {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null") as Inflight | null;
    if (!raw || typeof raw.savedAt !== "number" || !Array.isArray(raw.waiting)) return null;
    const valid = (job: unknown): job is QueueJob => Boolean(job) && typeof (job as QueueJob).conversationId === "string" && typeof (job as QueueJob).targetId === "string";
    return { active: valid(raw.active) ? raw.active : null, waiting: raw.waiting.filter(valid).slice(0, 20), savedAt: raw.savedAt };
  } catch {
    return null;
  }
}
