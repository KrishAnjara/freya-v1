/**
 * WhatsApp-style ticks on their messages: ✓ sent, ✓✓ delivered, ✓✓ blue once she's seen it, which
 * is the moment her typing dots appear (app/page runReply sets seenAt there). Editing locks a little
 * earlier, when she opens the message to start reading (openedAt): before that, a message waiting
 * for her can still be corrected, and she answers the corrected version. Pure.
 */
export type Delivery = "failed" | "sent" | "delivered" | "seen";

type Tracked = { role: string; failed?: boolean; delivered?: boolean; openedAt?: string; seenAt?: string; command?: string; herReaction?: string };

export function deliveryOf(message: Tracked, index: number, all: Tracked[]): Delivery {
  if (message.failed) return "failed";
  if (message.seenAt) return "seen";
  // Older messages, from before ticks were kept: anything she has answered (or reacted to) was seen.
  if (message.herReaction || all.slice(index + 1).some((item) => item.role === "assistant" && !item.command)) return "seen";
  return message.delivered ? "delivered" : "sent";
}

/** Editable only until she's opened it to answer. */
export function canEdit(message: Tracked, index: number, all: Tracked[]) {
  return message.role === "user" && !message.openedAt && deliveryOf(message, index, all) !== "seen";
}

/** Something a person would stop and think about before answering. */
export function thoughtful(text: string) {
  return text.trim().length > 140 || /\b(what do you think|why (do|did|would|is|are)|how come|should i|any advice|what would you do|honestly|be honest|your opinion|do you ever)\b/i.test(text);
}
