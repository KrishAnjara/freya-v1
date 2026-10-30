/**
 * The parts of her prompt that depend on this moment: what she's doing, examples that fit what was
 * just said, and instructions only this message needs. One definition, used by the chat route, the
 * persona evaluation and the fine-tuning corpus, so she's tested and trained on what she really gets.
 */
import type { Closeness } from "@/lib/canon";
import { herDaySection } from "@/lib/her-day";
import { mediaSection } from "@/lib/personality";
import { voiceExamplesSection } from "@/lib/voice-examples";

export function momentSections({ text, turn, closeness, now = new Date(), textingFirst = false }: {
  text: string; turn: number; closeness: Closeness; now?: Date; textingFirst?: boolean;
}) {
  return herDaySection(closeness, now)
    + (textingFirst ? "" : voiceExamplesSection(text, turn))
    + mediaSection(text);
}
