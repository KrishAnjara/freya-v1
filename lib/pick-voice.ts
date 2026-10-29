/**
 * Chooses one voice for FREYA and keeps it for every reply, whatever language it is in.
 *
 * Switching voice per language made her sound like a different person each time. A single
 * pinned voice keeps the character consistent, so selection runs once per voice list and the
 * result is reused until the browser's list actually changes.
 *
 * Preference order is quality first: a genuinely multilingual neural voice, then any
 * neural/"Natural" voice, then a remote voice (almost always neural), then whatever is left.
 */

export type VoiceChoice = {
  voice: SpeechSynthesisVoice;
  /** True when the voice can speak languages beyond its own tag. */
  multilingual: boolean;
};

/** Vendor markers for voices that handle more than their own language tag. */
const MULTILINGUAL = /multiling|multi-ling|polyglot/i;
/** Vendor markers for neural synthesis, which is what makes a voice sound unforced. */
const NEURAL = /natural|neural|online|premium|enhanced|siri|wavenet|journey|studio/i;
/** Formant and novelty voices: intelligible at best, robotic or comic at worst. */
const POOR = /espeak|compact|pico|flite|festival|robot|whisper|zarvox|bells|bubbles|bahh|boing|jester|organ|cellos|trinoids|wobble|superstar|albert|fred\b|junior|ralph|kathy|bad news|good news/i;
/** FREYA is written as "she" throughout the app, so a female voice matches the character. */
const FEMININE = /female|woman|ava|emma|aria|jenny|michelle|nova|sonia|libby|natasha|neerja|swara|samantha|serena|karen|moira|tessa|fiona|victoria|allison|susan|zira|hazel|google uk english female|amelie|anna|alice|ellen|joana|luciana|paulina|milena|yuna|kyoko|ting-ting|sin-ji|nicky/i;

function scoreVoice(voice: SpeechSynthesisVoice) {
  const name = voice.name ?? "";
  const lang = (voice.lang ?? "").toLowerCase();
  let score = 0;

  if (MULTILINGUAL.test(name)) score += 60;
  if (NEURAL.test(name)) score += 40;
  // A remote voice is served by the vendor's cloud engine, which is the neural one.
  if (voice.localService === false) score += 18;
  if (FEMININE.test(name)) score += 14;
  if (POOR.test(name)) score -= 120;
  // English is the app's own language, and English voices have the widest neural coverage.
  if (lang.startsWith("en")) score += 8;
  if (lang === "en-us") score += 4;
  if (voice.default) score += 2;

  return score;
}

let cachedChoice: VoiceChoice | null = null;
let cachedSignature = "";

function signatureOf(voices: SpeechSynthesisVoice[]) {
  return voices.map((voice) => `${voice.name}|${voice.lang}`).join("~");
}

/**
 * Returns the single voice to use for every utterance, or null when none are available yet.
 * `preferredName` pins an explicit choice when the reader has set one.
 */
export function pickConsistentVoice(
  voices: SpeechSynthesisVoice[],
  preferredName?: string,
): VoiceChoice | null {
  if (!voices.length) return null;

  if (preferredName) {
    const exact = voices.find((voice) => voice.name === preferredName);
    if (exact) return { voice: exact, multilingual: MULTILINGUAL.test(exact.name ?? "") };
  }

  const signature = signatureOf(voices);
  if (cachedChoice && cachedSignature === signature) return cachedChoice;

  let best = voices[0];
  let bestScore = -Infinity;
  for (const voice of voices) {
    const score = scoreVoice(voice);
    if (score > bestScore) {
      bestScore = score;
      best = voice;
    }
  }

  cachedChoice = { voice: best, multilingual: MULTILINGUAL.test(best.name ?? "") };
  cachedSignature = signature;
  return cachedChoice;
}

/** Clears the memoised choice; used by tests and when the reader changes the preference. */
export function resetVoiceChoice() {
  cachedChoice = null;
  cachedSignature = "";
}

/** Voices worth offering in a picker: best first, novelty voices dropped. */
export function listSelectableVoices(voices: SpeechSynthesisVoice[]) {
  return voices
    .filter((voice) => !POOR.test(voice.name ?? ""))
    .map((voice) => ({ voice, score: scoreVoice(voice) }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.voice);
}
