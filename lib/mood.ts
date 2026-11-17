/**
 * Her mood, under the names the rest of the app has always used. It lives in lib/heart now: many
 * feelings at once that fade and linger at their own pace, a slow mood under them, what's on her
 * mind and what she's thinking, moved by a model reading each message (lib/mood-appraisal) and by
 * time and her day. `name`, `energy` and `warmth` are worked out from that for her face and the
 * older call sites; nothing sets them directly any more.
 */
import { heartPrompt, type HeartState } from "@/lib/heart";

export {
  MOOD_NAMES, isMoodName, type MoodName,
  initialHeart as initialMood, normalizeHeart as normalizeMood, loadHeart as loadMood, saveHeart as saveMood,
  passTime, arrive, applyAppraisal, mergeVerdict, initiativePrompt, MOOD_RESET_AFTER_MS,
} from "@/lib/heart";

export type MoodState = HeartState;

/** The prompt section for how she feels. Desire only where the prompt stays with her own model. */
export function moodPrompt(state: HeartState, options: { intimate?: boolean; now?: number } = {}) {
  return heartPrompt(state, options);
}

/** A model sometimes copies a hidden "[[mood:x]]" tag from old examples: lifted out of what she says. */
export function extractMoodTag(text: string): { text: string; mood?: string } {
  const match = text.match(/\[\[\s*mood\s*:\s*([a-z]+)\s*\]\]/i);
  if (!match) return { text };
  return { text: text.replace(match[0], "").trim(), mood: match[1].toLowerCase() };
}
