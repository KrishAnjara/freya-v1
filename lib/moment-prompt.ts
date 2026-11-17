/**
 * The parts of her prompt that depend on this moment: what she's doing, examples that fit what was
 * just said, and instructions only this message needs. One definition, used by the chat route, the
 * persona evaluation and the fine-tuning corpus, so she's tested and trained on what she really gets.
 */
import type { Closeness } from "@/lib/canon";
import { needsBrief } from "@/lib/brief";
import { herDaySection } from "@/lib/her-day";
import { soundsUpset } from "@/lib/intimacy";
import { mediaSection } from "@/lib/personality";
import { situationsOf, voiceExamplesSection } from "@/lib/voice-examples";

export function momentSections({ text, turn, closeness, now = new Date(), textingFirst = false }: {
  text: string; turn: number; closeness: Closeness; now?: Date; textingFirst?: boolean;
}) {
  return herDaySection(closeness, now)
    + (textingFirst ? "" : voiceExamplesSection(text, turn))
    + mediaSection(text);
}

/** Asking for knowledge or a decision, as opposed to chatting or asking about her. */
export function isRealQuestion(text: string) {
  return situationsOf(text)[0] === "real-question" && needsBrief(text);
}

/**
 * The last thing in her prompt, which a model follows most closely. Without it the 27B stopped at
 * one line ("no"), and met a real question with a quip about the question, whatever the rules said.
 */
export function lastWord(text: string, makingSomething = false) {
  if (soundsUpset(text)) return "";
  // Asked to make something (code, a site, a letter): the reply IS the thing. "NOW: talk" here made
  // her banter ("challenge accepted") and never deliver.
  if (makingSomething) return "\n\nNOW: make it. Write the whole thing in this reply, complete and working: a whole file of code as ```file:name.ext (e.g. ```file:index.html), a letter written out. If something's missing, pick it yourself and say what you picked. Then a line or two your way. No 'i'm typing', no 'challenge accepted' with nothing after it.";
  if (isRealQuestion(text)) return "\n\nNOW: they've asked something real. Answer it first and get it right: the actual reason, in two to four plain sentences in your own voice, not a quip about the question. The exception is real how-to for hurting someone or breaking the law, which you turn down in character.";
  return "\n\nNOW: talk properly. Three to five texts with a blank line between them: react to what they actually said (what's under it, not just the words), then add something real of your own: an honest opinion, a thought it sparked, something from your day or your past, a question you genuinely want answered. No filler, no empty reactions like 'lol' or 'nice' on their own. Sound like a real person texting someone she knows: specific details instead of general ones, your own little stories and memories, contractions, the odd half-finished thought, warmth or bite that's actually meant. Don't stop at one or two lines unless they've really annoyed you.";
}
