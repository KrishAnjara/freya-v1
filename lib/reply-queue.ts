/**
 * What happens when a new reply is owed, while FREYA may already be replying: the rules that make
 * the conversation feel live instead of queued. Pure, so it is tested directly.
 *
 * - A new message from them while she's replying never interrupts her: she finishes what she was
 *   saying, then answers what they sent meanwhile (several messages together, in one reply).
 *   Nothing is ever shown as "queued".
 * - Messages arriving before she's started on them are answered together, in one reply to the
 *   latest, unless she has spoken in between (then the new one gets its own reply).
 * - She doesn't text first into a conversation that's already going.
 * - Her own follow-ups (continuing a cut-off reply, saying a picture is ready) wait their turn.
 */

export type JobKind = "message" | "continue" | "initiative" | "event";

export type QueueJob = {
  conversationId: string;
  targetId: string;
  turn?: string;
  extraPrompt?: string;
  initiative?: boolean;
  /** Something that happened (a picture started, finished or failed) that she reacts to. */
  event?: { kind: string };
  /** She was in the middle of a reply when this message arrived. */
  interrupted?: boolean;
};

export function jobKind(job: QueueJob): JobKind {
  if (job.event) return "event";
  if (job.initiative) return "initiative";
  if (job.extraPrompt) return "continue";
  return "message";
}

type ThreadMessage = { id: string; role: "user" | "assistant" };

export type EnqueuePlan<T extends QueueJob> = {
  /** Stop the reply in progress (its posted parts stay). */
  abortActive: boolean;
  /** The jobs still to run, in order. */
  waiting: T[];
};

/**
 * @param active the reply running now, if any, and how many parts of it are already on screen
 * @param waiting replies not started yet, in order
 * @param thread the conversation the new job belongs to
 */
export function planEnqueue<T extends QueueJob>(
  job: T,
  active: { job: QueueJob; posted: number } | null,
  waiting: T[],
  thread: ThreadMessage[],
): EnqueuePlan<T> {
  const kind = jobKind(job);
  const sameConversation = (other: QueueJob) => other.conversationId === job.conversationId;

  if (kind === "initiative") {
    // A conversation that's already going doesn't need her to start one.
    if ((active && sameConversation(active.job)) || waiting.some(sameConversation)) return { abortActive: false, waiting };
    return { abortActive: false, waiting: [...waiting, job] };
  }

  if (kind !== "message") return { abortActive: false, waiting: [...waiting, job] };

  // They wrote while she was replying here: she finishes first, and anything she meant to text
  // first in this conversation is moot now. Their messages are answered after, together.
  if (active && sameConversation(active.job)) waiting = waiting.filter((other) => !(sameConversation(other) && jobKind(other) === "initiative"));

  const index = waiting.findIndex((other) => sameConversation(other) && jobKind(other) === "message");
  if (index >= 0) {
    const pending = waiting[index];
    const pendingAt = thread.findIndex((message) => message.id === pending.targetId);
    // Merged only while it's a run of their messages: once she has spoken after it, it's a new turn.
    const spokenSince = pendingAt >= 0 && thread.slice(pendingAt + 1).some((message) => message.role === "assistant");
    if (!spokenSince) {
      const merged = [...waiting];
      merged[index] = { ...pending, targetId: job.targetId, ...(job.interrupted ? { interrupted: true } : {}) };
      return { abortActive: false, waiting: merged.filter((other) => !(sameConversation(other) && jobKind(other) === "initiative")) };
    }
  }
  return { abortActive: false, waiting: [...waiting.filter((other) => !(sameConversation(other) && jobKind(other) === "initiative")), job] };
}
