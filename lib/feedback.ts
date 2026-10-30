/**
 * Replies marked "not her", with what she should have said when the user wrote it. This is the
 * most valuable training data there is: a person's own judgement of what sounds wrong. Kept in the
 * browser, and exported to training/data/ for the fine-tune (training/train_lora.py).
 *
 * A correction becomes an ordinary training conversation that also carries the rejected reply, for
 * preference training. A reply marked with no correction is exported as rejected only: the fine-tune
 * can't learn from it directly, but it's a record of what to avoid. Pure apart from the storage helpers.
 */
export type FeedbackEntry = {
  at: string;
  /** The conversation up to the reply, oldest first. */
  context: { role: "user" | "assistant"; content: string }[];
  rejected: string;
  better?: string;
};

const FEEDBACK_KEY = "freya.v1.feedback";
const MAX_ENTRIES = 2000;
const MAX_CONTEXT_TURNS = 8;

/** A record for the reply at `index`. The context ends with the message it answered. */
export function feedbackFor(thread: { role: string; content: string }[], index: number, better = "", at = new Date().toISOString()): FeedbackEntry | null {
  const rejected = thread[index]?.content.trim();
  if (!rejected || thread[index].role !== "assistant") return null;
  const context = thread.slice(0, index)
    .filter((message) => message.content.trim() && (message.role === "user" || message.role === "assistant"))
    .slice(-MAX_CONTEXT_TURNS)
    .map((message) => ({ role: message.role as "user" | "assistant", content: message.content.trim() }));
  // Training turns alternate and open with the user, so a reply's own earlier parts are merged.
  const merged = context.reduce<FeedbackEntry["context"]>((turns, turn) => {
    const last = turns[turns.length - 1];
    if (last?.role === turn.role) last.content += `\n\n${turn.content}`;
    else turns.push({ ...turn });
    return turns;
  }, []);
  while (merged[0]?.role === "assistant") merged.shift();
  if (merged.at(-1)?.role !== "user") return null;
  return { at, context: merged, rejected, ...(better.trim() ? { better: better.trim() } : {}) };
}

/** One JSON object per line, in the format training/train_lora.py reads. */
export function feedbackToJsonl(entries: FeedbackEntry[]) {
  return entries.map((entry) => JSON.stringify(entry.better
    ? { messages: [...entry.context, { role: "assistant", content: entry.better }], rejected: entry.rejected }
    : { kind: "rejected", context: entry.context, rejected: entry.rejected })).join("\n") + (entries.length ? "\n" : "");
}

export function loadFeedback(): FeedbackEntry[] {
  try {
    const stored = JSON.parse(localStorage.getItem(FEEDBACK_KEY) || "[]");
    return Array.isArray(stored) ? stored.filter((entry): entry is FeedbackEntry => typeof entry?.rejected === "string" && Array.isArray(entry?.context)) : [];
  } catch {
    return [];
  }
}

export function saveFeedback(entries: FeedbackEntry[]) {
  try { localStorage.setItem(FEEDBACK_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES))); } catch { /* storage full: this one isn't kept */ }
}
