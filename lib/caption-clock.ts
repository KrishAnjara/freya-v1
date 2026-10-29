/**
 * Drives the spoken caption for every language.
 *
 * `onboundary` is the only timing signal the Web Speech API exposes, and it is unreliable:
 * many engines never fire it for non-Latin scripts, and most remote (neural) voices never
 * fire it at all. Relying on it alone meant subtitles simply did not appear for Hindi,
 * Japanese, Arabic and anything spoken by a cloud voice.
 *
 * So the caption runs on its own clock, estimated from the text, and treats any boundary
 * event that does arrive as a correction to re-sync against. One path covers every language;
 * the events only make it more accurate where they exist.
 */

/** Scripts whose characters each carry about a full syllable, so they take longer per glyph. */
const DENSE_SCRIPT = /[一-鿿぀-ゟ゠-ヿ가-힯]/;

export type CaptionToken = { text: string; start: number; end: number };

/**
 * Splits text into caption tokens. `Intl.Segmenter` handles scripts that do not use spaces
 * (Chinese, Japanese, Thai); the regex fallback covers browsers without it.
 */
export function tokenize(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const Segmenter = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: string }) => { segment(input: string): Iterable<{ segment: string; isWordLike?: boolean }> } }).Segmenter;
  if (Segmenter) {
    try {
      const segmenter = new Segmenter(undefined, { granularity: "word" });
      const words: string[] = [];
      for (const part of segmenter.segment(trimmed)) {
        const segment = part.segment.trim();
        // Keep word-like segments; punctuation and whitespace are not read aloud.
        if (segment && (part.isWordLike ?? /\p{L}|\p{N}/u.test(segment))) words.push(segment);
      }
      if (words.length) return words;
    } catch {
      // Fall through to the regex split.
    }
  }

  return trimmed.split(/\s+/).filter(Boolean);
}

/**
 * Estimates when each token is spoken, in milliseconds from the utterance start.
 * `rate` is the SpeechSynthesisUtterance rate (1 = normal).
 */
export function scheduleTokens(tokens: string[], rate = 1): CaptionToken[] {
  const schedule: CaptionToken[] = [];
  let cursor = 0;
  for (const token of tokens) {
    const dense = DENSE_SCRIPT.test(token);
    // ~13 Latin characters a second at rate 1; dense scripts run nearer 4 glyphs a second.
    const perChar = dense ? 250 : 76;
    const duration = Math.max(dense ? 220 : 150, Math.min(1200, token.length * perChar)) / Math.max(0.25, rate);
    schedule.push({ text: token, start: cursor, end: cursor + duration });
    cursor += duration;
    // A short gap between words keeps the caption from reading as one run-on phrase.
    cursor += 32 / Math.max(0.25, rate);
  }
  return schedule;
}

/** Index of the token being spoken at `elapsed` ms, clamped to the schedule. */
export function indexAt(schedule: CaptionToken[], elapsed: number): number {
  if (!schedule.length) return 0;
  if (elapsed <= 0) return 0;
  const last = schedule.length - 1;
  if (elapsed >= schedule[last].end) return last;
  // Linear scan: a reply is a few hundred tokens at most and this runs a few times a second.
  for (let index = 0; index < schedule.length; index += 1) {
    if (elapsed < schedule[index].end) return index;
  }
  return last;
}

/**
 * Rescales a schedule so `index` is being spoken right now.
 *
 * When a boundary event does arrive it is ground truth: if the estimate has drifted, stretch
 * or compress the remaining tokens to meet it rather than jumping the caption, which would
 * read as a stutter.
 */
export function resync(schedule: CaptionToken[], index: number, elapsed: number): CaptionToken[] {
  if (index < 0 || index >= schedule.length) return schedule;
  const expected = schedule[index].start;
  if (expected <= 0) return schedule;
  const factor = elapsed / expected;
  // Ignore absurd corrections: a bad event should not collapse the whole schedule.
  if (!Number.isFinite(factor) || factor < 0.3 || factor > 3) return schedule;
  return schedule.map((token) => ({
    text: token.text,
    start: token.start * factor,
    end: token.end * factor,
  }));
}
