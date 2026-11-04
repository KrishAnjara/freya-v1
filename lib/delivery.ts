/**
 * WhatsApp-style ticks on their messages: ✓ sent, ✓✓ delivered, ✓✓ in colour once she's seen it.
 * Seen is set when she opens the message, just before she starts on her answer (app/page runReply),
 * and from then on the message can't be edited: she's already read it. Before that, a message
 * waiting for her can still be corrected, and she answers the corrected version. Pure.
 */
export type Delivery = "failed" | "sent" | "delivered" | "seen";

type Tracked = { role: string; failed?: boolean; delivered?: boolean; seenAt?: string; command?: string; herReaction?: string };

export function deliveryOf(message: Tracked, index: number, all: Tracked[]): Delivery {
  if (message.failed) return "failed";
  if (message.seenAt) return "seen";
  // Older messages, from before ticks were kept: anything she has answered (or reacted to) was seen.
  if (message.herReaction || all.slice(index + 1).some((item) => item.role === "assistant" && !item.command)) return "seen";
  return message.delivered ? "delivered" : "sent";
}

/** Editable only until she's seen it. */
export function canEdit(message: Tracked, index: number, all: Tracked[]) {
  return message.role === "user" && deliveryOf(message, index, all) !== "seen";
}

/** Something a person would stop and think about before answering. */
export function thoughtful(text: string) {
  return text.trim().length > 140 || /\b(what do you think|why (do|did|would|is|are)|how come|should i|any advice|what would you do|honestly|be honest|your opinion|do you ever)\b/i.test(text);
}
