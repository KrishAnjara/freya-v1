/**
 * Shared speech-driven face signal: lip opening, caption, and expression.
 *
 * Browsers do not expose an audio stream for `speechSynthesis`, so there is no waveform to
 * analyse. The caption and the mouth both run on an estimated clock built from the text
 * (see caption-clock), corrected by `onboundary` events where the engine fires them. That
 * keeps every language working, including the many where boundary events never arrive.
 *
 * This is viseme-flavoured approximation, not phoneme alignment.
 */

import { indexAt, resync, scheduleTokens, tokenize, type CaptionToken } from "@/lib/caption-clock";

/** How many words the caption shows at once. */
const CAPTION_WINDOW = 4;

type MouthState = {
  speaking: boolean;
  /** Performance clock reading when the utterance began. */
  startedAt: number;
  /** Estimated per-token timing for the whole utterance. */
  schedule: CaptionToken[];
  /** Index of the token being spoken. */
  index: number;
  /** Bumped on every caption change so subscribers re-render without polling. */
  revision: number;
};

const state: MouthState = { speaking: false, startedAt: 0, schedule: [], index: 0, revision: 0 };

const listeners = new Set<() => void>();
function emit() {
  state.revision += 1;
  for (const listener of listeners) listener();
}

/** Subscribe to caption changes. Returns an unsubscribe function. */
export function subscribeCaption(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export type Caption = { words: string[]; index: number; speaking: boolean };

/** Current caption window: up to CAPTION_WINDOW words with the spoken one marked. */
export function getCaption(): Caption {
  if (!state.speaking || !state.schedule.length) return { words: [], index: 0, speaking: false };
  // Slide a fixed window so the spoken word stays visible with context either side of it.
  const start = Math.max(0, Math.min(state.index - 1, state.schedule.length - CAPTION_WINDOW));
  const words = state.schedule.slice(start, start + CAPTION_WINDOW).map((token) => token.text);
  return { words, index: state.index - start, speaking: true };
}

export function captionRevision() {
  return state.revision;
}

/** Rough openness per vowel: open vowels drop the jaw further than closed ones. */
const VOWEL_OPENNESS: Record<string, number> = {
  a: 1, e: 0.62, i: 0.42, o: 0.82, u: 0.5, y: 0.45,
  // Common non-Latin vowel carriers, so dense scripts still articulate rather than buzz.
  "あ": 1, "ア": 1, "い": 0.42, "イ": 0.42, "う": 0.5, "ウ": 0.5, "え": 0.62, "エ": 0.62, "お": 0.82, "オ": 0.82,
  "ा": 1, "ि": 0.42, "ी": 0.42, "ु": 0.5, "ू": 0.5, "े": 0.62, "ो": 0.82, "ै": 0.9, "ौ": 0.9,
};

/** Splits a word into a per-syllable openness profile. */
function shapeWord(word: string): number[] {
  const shape: number[] = [];
  let lastWasVowel = false;
  for (const letter of word.toLowerCase()) {
    const openness = VOWEL_OPENNESS[letter];
    if (openness === undefined) {
      // Scripts without separable vowels still need a beat per glyph, or they stay shut.
      // Arabic and Hebrew normally omit vowel diacritics entirely, so their consonants have
      // to carry the syllable; CJK and Thai carry roughly one syllable per glyph.
      if (/[一-鿿가-힯฀-๿]/.test(letter)) {
        shape.push(0.72);
        lastWasVowel = true;
        continue;
      }
      if (/[؀-ۿ֐-׿]/.test(letter)) {
        // Every other consonant gets the beat, approximating consonant-vowel alternation.
        if (!lastWasVowel) {
          shape.push(0.6);
          lastWasVowel = true;
          continue;
        }
        lastWasVowel = false;
        continue;
      }
      lastWasVowel = false;
      continue;
    }
    // Consecutive vowels are one sustained opening, not two.
    if (lastWasVowel) shape[shape.length - 1] = Math.max(shape[shape.length - 1], openness);
    else shape.push(openness);
    lastWasVowel = true;
  }
  // Consonant-only words ("hmm", "shh") still part the lips a little.
  return shape.length ? shape : [0.26];
}

/** Starts an utterance: the whole text is scheduled up front so every language is covered. */
export function beginUtterance(text: string, rate = 1) {
  state.speaking = true;
  state.startedAt = performance.now();
  state.schedule = scheduleTokens(tokenize(text), rate);
  state.index = 0;
  emit();
}

export function stopSpeaking() {
  state.speaking = false;
  state.schedule = [];
  state.index = 0;
  emit();
}

/** Back-compat alias; `beginUtterance` carries the text the caption needs. */
export function startSpeaking() {
  if (!state.speaking) {
    state.speaking = true;
    state.startedAt = performance.now();
    emit();
  }
}

/**
 * A real boundary event arrived. Treat it as ground truth and rescale the estimate toward it
 * rather than jumping, which would make the caption stutter.
 */
export function syncBoundary(charIndex: number, text: string) {
  if (!state.speaking || !state.schedule.length) return;
  // Map the character offset onto a token by counting words in the text before it.
  const spokenSoFar = tokenize(text.slice(0, charIndex)).length;
  const index = Math.max(0, Math.min(state.schedule.length - 1, spokenSoFar));
  const elapsed = performance.now() - state.startedAt;
  state.schedule = resync(state.schedule, index, elapsed);
  if (index !== state.index) {
    state.index = index;
    emit();
  }
}

/** Advances the caption from the clock. Called each animation frame by the portrait. */
export function tickCaption(now: number) {
  if (!state.speaking || !state.schedule.length) return;
  const elapsed = now - state.startedAt;
  const index = indexAt(state.schedule, elapsed);
  if (index !== state.index) {
    state.index = index;
    emit();
  }
  // The utterance has run past its estimate; `onend` will close it, but stop advancing.
  if (elapsed > state.schedule[state.schedule.length - 1].end + 2000) state.index = state.schedule.length - 1;
}

/**
 * Current mouth opening, 0 (closed) to 1 (wide), for the given timestamp.
 * Returns 0 when nothing is being spoken, so the portrait falls back to idle breathing.
 */
export function mouthOpening(now: number): number {
  if (!state.speaking || !state.schedule.length) return 0;
  const token = state.schedule[state.index];
  if (!token) return 0;
  const elapsed = now - state.startedAt;
  if (elapsed < token.start || elapsed > token.end) return 0;

  const progress = (elapsed - token.start) / Math.max(1, token.end - token.start);
  const shape = shapeWord(token.text);
  const slot = progress * shape.length;
  const index = Math.min(shape.length - 1, Math.floor(slot));
  const within = slot - index;
  // Each syllable opens and closes, so the jaw articulates instead of hanging open.
  const syllable = Math.sin(within * Math.PI);
  // Ease the whole word in and out so the first and last syllables are not clipped.
  const envelope = Math.sin(Math.min(1, progress) * Math.PI) * 0.35 + 0.65;
  return Math.max(0, Math.min(1, shape[index] * syllable * envelope));
}

/**
 * Speech emphasis, 0 to 1: how strongly the current word is stressed.
 *
 * Longer words, capitals and terminal punctuation all read as emphasis, and the face uses
 * it for brow and cheek movement, so she animates above the mouth as well as at it.
 */
export function speechEmphasis(): number {
  if (!state.speaking || !state.schedule.length) return 0;
  const token = state.schedule[state.index];
  if (!token) return 0;
  const word = token.text;
  let emphasis = Math.min(1, word.length / 9) * 0.6;
  if (/^[A-Z]{2,}$/.test(word)) emphasis += 0.4;
  else if (/^[A-Z]/.test(word)) emphasis += 0.12;
  if (/[!?]$/.test(word)) emphasis += 0.35;
  if (/[.,;:]$/.test(word)) emphasis -= 0.15;
  return Math.max(0, Math.min(1, emphasis));
}

export function isSpeaking() {
  return state.speaking;
}

/** Legacy entry point retained for callers that push one word at a time. */
export function speakWord(word: string, charLength: number, following?: string) {
  if (!state.speaking) beginUtterance([word, following ?? ""].join(" "));
}
